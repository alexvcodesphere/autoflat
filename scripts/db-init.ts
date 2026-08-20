#!/usr/bin/env node
/**
 * npm run db:init          -> legt data/autoflat.db an (idempotent)
 * npm run db:reset         -> löscht die DB vorher (fragt nicht nach)
 */
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { env } from '../src/config/env.ts';
import { openDb, applySchema, getSchemaVersion } from '../src/db/index.ts';

const force = process.argv.includes('--force');
const abs = resolve(env.dbPath);

if (force && existsSync(abs)) {
  for (const suffix of ['', '-wal', '-shm']) rmSync(abs + suffix, { force: true });
  console.log(`gelöscht: ${abs}`);
}

const existed = existsSync(abs);
const db = openDb(abs);
applySchema(db);

const tables = (
  db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all() as Array<{ name: string }>
).map((r) => r.name);

console.log(`${existed && !force ? 'aktualisiert' : 'angelegt'}: ${abs}`);
console.log(`schema_version: ${getSchemaVersion(db)}`);
console.log(`Tabellen: ${tables.join(', ')}`);
for (const t of tables) {
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number };
  console.log(`  ${t.padEnd(16)} ${n} Zeilen`);
}
db.close();
