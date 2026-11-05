/**
 * Database access.
 *
 * Uses the SQLite that ships with Node rather than a native module: this
 * avoids compiling on every install and keeps the container as simple as the
 * development environment.
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export type DB = DatabaseSync;

/**
 * Opens the database and applies the schema. Idempotent: it can be called on
 * every start-up without losing data, because the schema uses
 * CREATE IF NOT EXISTS.
 */
export function openDb(path: string): DB {
  mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path);
  // With WAL, NORMAL syncs at checkpoint rather than on every commit. A power
  // cut can lose the last few seconds, never corrupt the database; in exchange
  // it avoids an fsync per write, which on a NAS (Btrfs) is the costly part.
  db.exec('PRAGMA synchronous = NORMAL');
  const schema = readFileSync(join(HERE, 'schema.sql'), 'utf8');
  db.exec(schema);
  migrate(db);

  return db;
}

/**
 * Adds to an existing database the columns that were introduced later.
 *
 * `CREATE TABLE IF NOT EXISTS` leaves an existing table alone, so new columns
 * have to be added by hand. Each one is attempted separately and failure is
 * ignored: if it is already there, nothing needs doing.
 */
function migrate(db: DB): void {
  const newColumns: Array<[string, string, string]> = [
    ['description', 'gramps_id', 'TEXT'],
    ['suggestion', 'name_2', 'TEXT'],
    // To be able to undo a review decision: when it was made, which batch it
    // belongs to and which fields the acceptance copied to the description.
    ['suggestion', 'decided_at', 'TEXT'],
    ['suggestion', 'batch', 'TEXT'],
    ['suggestion', 'copied', 'TEXT'],
  ];

  for (const [table, column, type] of newColumns) {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    } catch {
      /* the column already exists */
    }
  }
}

/** Reads a stored setting. */
export function readSetting(db: DB, key: string): string | null {
  const row = db.prepare('SELECT value FROM setting WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

/** Stores a setting, overwriting the previous one. */
export function writeSetting(db: DB, key: string, value: string): void {
  db.prepare(
    'INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

/**
 * Runs a block inside a transaction. If anything fails, nothing is left half
 * done: this matters in the indexer, where one pass touches thousands of
 * rows.
 */
export function inTransaction<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
