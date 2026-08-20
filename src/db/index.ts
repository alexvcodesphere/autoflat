import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { env } from '../config/env.ts';

export type Db = Database.Database;

export const SCHEMA_VERSION = 3;

const SCHEMA_PATH = resolve(import.meta.dirname, '../../db/schema.sql');

/**
 * Öffnet die DB und legt sie beim ersten Aufruf an. Das Schema ist
 * idempotent (CREATE TABLE IF NOT EXISTS), ein Aufruf auf eine bestehende
 * DB ist also folgenlos.
 */
export function openDb(path: string = env.dbPath): Db {
  const abs = resolve(path);
  mkdirSync(dirname(abs), { recursive: true });
  const db = new Database(abs);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

export function applySchema(db: Db): void {
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  db.prepare(
    `INSERT INTO meta (key, value) VALUES ('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(String(SCHEMA_VERSION));
}

export function getSchemaVersion(db: Db): number | null {
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
    | { value: string }
    | undefined;
  return row ? Number(row.value) : null;
}
