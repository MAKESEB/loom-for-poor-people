// Imported only by Vite and tests. Hosted requests use OHMYHOST_DATABASE.
import { PGlite } from '@electric-sql/pglite';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRepository, type QueryClient } from '../server/repository';

export async function createLocalRepository(directory = resolve('.local/database')) {
  const database = new PGlite(directory);
  await database.waitReady;
  await database.exec('CREATE TABLE IF NOT EXISTS slop_local_migrations (name text PRIMARY KEY)');
  const migrations = new URL('../../migrations/', import.meta.url);
  for (const name of (await readdir(migrations)).filter(name => /^\d{14}_[a-z0-9_]+\.sql$/.test(name)).sort()) {
    if ((await database.query('SELECT name FROM slop_local_migrations WHERE name = $1', [name])).rows.length) continue;
    const sql = await readFile(new URL(name, migrations), 'utf8');
    await database.transaction(async transaction => {
      await transaction.exec(sql);
      await transaction.query('INSERT INTO slop_local_migrations (name) VALUES ($1)', [name]);
    });
  }
  const client: QueryClient = {
    async query({ text, values }) {
      const result = await database.query<Record<string, unknown>>(text, [...values]);
      return { rows: result.rows, rowCount: result.affectedRows ?? null, command: text.trim().split(/\s+/)[0].toUpperCase() };
    },
  };
  return { repository: createRepository(client), database, close: () => database.close() };
}
