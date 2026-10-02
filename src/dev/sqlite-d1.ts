// A D1DatabaseLike shim over node:sqlite for tests and local tooling only. Production code never
// imports it: Workers use the real D1 binding (env.DB), and migrations are applied there by
// `wrangler d1 migrations apply DB`.
//
// Not emulated: D1's 50-byte LIKE/GLOB pattern limit, its SQL function authorizer (for example
// sqlite_version() is rejected) and its PRAGMA restrictions. tests/repository.test.ts guards the
// pattern limit statically; keep SQL within D1's limits.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync, type SQLInputValue, type SQLOutputValue, type StatementSync } from 'node:sqlite';
import type { D1DatabaseLike, D1PreparedStatementLike, D1ResultLike, D1Value } from '../server/cloudflare-types';

interface BoundStatement { query: string; values: readonly SQLInputValue[] }

/**
 * Opens a node:sqlite database behind the D1 statement API. Like D1, statements compile lazily
 * (errors surface as rejected promises), each statement is atomic, foreign keys are enforced,
 * `run()` is an alias of `all()`, and `batch()` runs its statements in one transaction.
 */
export function createSqliteD1(filename = ':memory:'): D1DatabaseLike & { close(): void } {
  const handle = new DatabaseSync(filename);
  handle.exec('PRAGMA foreign_keys = ON');
  const compiled = new Map<string, StatementSync>();
  const bound = new WeakMap<D1PreparedStatementLike, BoundStatement>();

  function compile(query: string) {
    let statement = compiled.get(query);
    if (!statement) {
      statement = handle.prepare(query);
      compiled.set(query, statement);
    }
    return statement;
  }

  function execute({ query, values }: BoundStatement): D1ResultLike {
    const statement = compile(query);
    const before = Number(compile('SELECT total_changes() AS n').get()?.n ?? 0);
    const results = statement.all(...values).map(row => {
      const plain: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(row)) plain[name] = output(value);
      return plain;
    });
    const changes = Number(compile('SELECT total_changes() AS n').get()?.n ?? 0) - before;
    const lastRowId = Number(compile('SELECT last_insert_rowid() AS id').get()?.id ?? 0);
    return { results, success: true, meta: { changes, last_row_id: lastRowId } };
  }

  function statement(query: string, values: readonly SQLInputValue[]): D1PreparedStatementLike {
    const prepared: D1PreparedStatementLike = {
      bind: (...next: D1Value[]) => statement(query, next.map(input)),
      async all<T = Record<string, unknown>>() { return execute({ query, values }) as unknown as D1ResultLike<T>; },
      async first<T = Record<string, unknown>>() { return (execute({ query, values }).results[0] ?? null) as T | null; },
      async run() { return execute({ query, values }); },
    };
    bound.set(prepared, { query, values });
    return prepared;
  }

  return {
    prepare: query => statement(query, []),
    async batch(statements) {
      const work = statements.map(entry => {
        const found = bound.get(entry);
        if (!found) throw new TypeError('batch() only accepts statements prepared by this database.');
        return found;
      });
      handle.exec('BEGIN');
      try {
        const results = work.map(execute);
        handle.exec('COMMIT');
        return results;
      } catch (error) {
        if (handle.isTransaction) handle.exec('ROLLBACK');
        throw error;
      }
    },
    close() {
      compiled.clear();
      handle.close();
    },
  };
}

function input(value: D1Value | boolean | undefined): SQLInputValue {
  // D1 rejects undefined; mirror that instead of silently binding NULL.
  if (value === undefined) throw new TypeError("D1_TYPE_ERROR: Type 'undefined' not supported for a bound value.");
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value === null || typeof value === 'string' || typeof value === 'number') return value;
  throw new TypeError(`D1_TYPE_ERROR: Type '${typeof value}' not supported for a bound value.`);
}

function output(value: SQLOutputValue): D1Value {
  if (value instanceof Uint8Array) return value.slice().buffer;
  if (typeof value === 'bigint') return Number(value);
  return value;
}

/**
 * Applies every *.sql file in `directory` in lexical order, once. Applied names are tracked in
 * `d1_migrations`, the table wrangler uses, and each file runs atomically through `batch()` when
 * the database provides it.
 */
export async function applyMigrations(db: D1DatabaseLike, directory: URL | string): Promise<void> {
  const path = typeof directory === 'string' ? directory : fileURLToPath(directory);
  await db.prepare(`CREATE TABLE IF NOT EXISTS d1_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  )`).run();
  const applied = new Set((await db.prepare('SELECT name FROM d1_migrations').all<{ name: string }>()).results.map(row => row.name));
  for (const name of (await readdir(path)).filter(entry => entry.endsWith('.sql')).sort()) {
    if (applied.has(name)) continue;
    const statements = splitSqlStatements(await readFile(join(path, name), 'utf8')).map(sql => db.prepare(sql));
    statements.push(db.prepare('INSERT INTO d1_migrations (name) VALUES (?1)').bind(name));
    if (db.batch) await db.batch(statements);
    else for (const statement of statements) await statement.run();
  }
}

/**
 * Splits a SQL script into statements at top-level semicolons. Quoted strings and identifiers are
 * preserved, comments are dropped, and semicolons inside CASE ... END or a CREATE TRIGGER body
 * (BEGIN ... END) do not split.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let words: string[] = [];
  let depth = 0;
  const flush = () => {
    const text = current.trim();
    if (text) statements.push(text);
    current = '';
    words = [];
    depth = 0;
  };
  const isTrigger = () => words[0] === 'CREATE' && (words[1] === 'TRIGGER' || ((words[1] === 'TEMP' || words[1] === 'TEMPORARY') && words[2] === 'TRIGGER'));
  let index = 0;
  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];
    if (char === '-' && next === '-') {
      const end = sql.indexOf('\n', index);
      index = end === -1 ? sql.length : end;
      current += ' ';
    } else if (char === '/' && next === '*') {
      const end = sql.indexOf('*/', index + 2);
      if (end === -1) throw new SyntaxError('Unterminated block comment in SQL.');
      index = end + 2;
      current += ' ';
    } else if (char === "'" || char === '"' || char === '`' || char === '[') {
      const close = char === '[' ? ']' : char;
      let end = index + 1;
      for (;;) {
        if (end >= sql.length) throw new SyntaxError(`Unterminated ${char} quote in SQL.`);
        if (sql[end] === close) {
          if (close !== ']' && sql[end + 1] === close) { end += 2; continue; }
          break;
        }
        end++;
      }
      current += sql.slice(index, end + 1);
      index = end + 1;
    } else if (/[A-Za-z_]/.test(char)) {
      let end = index;
      while (end < sql.length && /[A-Za-z0-9_$]/.test(sql[end])) end++;
      const word = sql.slice(index, end).toUpperCase();
      if (words.length < 3) words.push(word);
      if (word === 'CASE' || (word === 'BEGIN' && isTrigger())) depth++;
      else if (word === 'END' && depth > 0) depth--;
      current += sql.slice(index, end);
      index = end;
    } else if (char === ';' && depth === 0) {
      flush();
      index++;
    } else {
      current += char;
      index++;
    }
  }
  flush();
  return statements;
}
