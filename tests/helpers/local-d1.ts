// Imported only by tests. Hosted requests use the Worker's D1 binding env.DB.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { applyMigrations, createSqliteD1 } from '../../src/dev/sqlite-d1';
import type { D1DatabaseLike } from '../../src/server/cloudflare-types';
import { createD1Repository } from '../../src/server/d1-repository';
import type { Repository } from '../../src/server/types';

export const D1_MIGRATIONS = new URL('../../migrations-d1/', import.meta.url);
const DATABASE_FILE = 'slop-rooster.sqlite';

/**
 * Opens a node:sqlite database with the same migrations D1 runs. `directory` of 'memory://' or
 * undefined keeps the database in memory; otherwise it is stored as `slop-rooster.sqlite` there.
 */
export async function createLocalD1Repository(directory?: string): Promise<{ repository: Repository; database: D1DatabaseLike; close(): void }> {
  let filename = ':memory:';
  if (directory !== undefined && directory !== 'memory://') {
    await mkdir(directory, { recursive: true });
    filename = join(directory, DATABASE_FILE);
  }
  const database = createSqliteD1(filename);
  try {
    // D1 always enforces foreign keys; keep local databases equally strict.
    await database.prepare('PRAGMA foreign_keys = ON').run();
    await applyMigrations(database, D1_MIGRATIONS);
  } catch (error) {
    database.close();
    throw error;
  }
  return { repository: createD1Repository(database), database, close: () => database.close() };
}
