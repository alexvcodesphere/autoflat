import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, applySchema, getSchemaVersion, SCHEMA_VERSION } from '../src/db/index.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'wobo-'));
  const db = openDb(join(dir, 'test.db'));
  applySchema(db);
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('legt alle Tabellen aus §6 und §17 an', () => {
  const { db, cleanup } = freshDb();
  try {
    const names = (db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
    ).all() as Array<{ name: string }>).map((r) => r.name).sort();
    assert.deepEqual(names, [
      'grounding_usage', 'listing_event', 'meta', 'prewarm_quarantine',
      'seed_company', 'verwaltung',
    ]);
    assert.equal(getSchemaVersion(db), SCHEMA_VERSION);
  } finally { cleanup(); }
});

test('applySchema ist idempotent', () => {
  const { db, cleanup } = freshDb();
  try {
    assert.doesNotThrow(() => applySchema(db));
    assert.equal(getSchemaVersion(db), SCHEMA_VERSION);
  } finally { cleanup(); }
});

test('CHECK-Constraints greifen', () => {
  const { db, cleanup } = freshDb();
  try {
    const ins = db.prepare(`INSERT INTO verwaltung (name_canonical, firm_type) VALUES (?, ?)`);
    assert.doesNotThrow(() => ins.run('meyer', 'verwaltung'));
    assert.throws(() => ins.run('schulze', 'bauherr'), /CHECK/);

    const conf = db.prepare(`INSERT INTO verwaltung (name_canonical, confidence) VALUES (?, ?)`);
    assert.doesNotThrow(() => conf.run('a', 'verified'));
    assert.throws(() => conf.run('b', 'sehr sicher'), /CHECK/);

    const st = db.prepare(
      `INSERT INTO listing_event (external_id, source, branch, payload, state) VALUES (?,?,?,?,?)`,
    );
    assert.doesNotThrow(() => st.run('1', 'is24', 'T_VERWALTUNG', '{}', 'captured'));
    assert.throws(() => st.run('2', 'is24', 'T_VERWALTUNG', '{}', 'irgendwas'), /CHECK/);
  } finally { cleanup(); }
});

test('UNIQUE(external_id, source) verhindert Doppelerfassung', () => {
  const { db, cleanup } = freshDb();
  try {
    const ins = db.prepare(
      `INSERT INTO listing_event (external_id, source, branch, payload) VALUES (?,?,?,?)`,
    );
    ins.run('162345678', 'is24', 'T_VERWALTUNG', '{}');
    assert.throws(() => ins.run('162345678', 'is24', 'T_VERWALTUNG', '{}'), /UNIQUE/);
    // dieselbe ID auf einem anderen Portal ist ein anderes Inserat
    assert.doesNotThrow(() => ins.run('162345678', 'immowelt', 'T_VERWALTUNG', '{}'));
  } finally { cleanup(); }
});

test('name_canonical ist eindeutig', () => {
  const { db, cleanup } = freshDb();
  try {
    const ins = db.prepare(`INSERT INTO verwaltung (name_canonical) VALUES (?)`);
    ins.run('meyer');
    assert.throws(() => ins.run('meyer'), /UNIQUE/);
  } finally { cleanup(); }
});

test('Defaults entsprechen §6', () => {
  const { db, cleanup } = freshDb();
  try {
    db.prepare(`INSERT INTO verwaltung (name_canonical) VALUES ('meyer')`).run();
    const v = db.prepare(`SELECT * FROM verwaltung WHERE name_canonical='meyer'`).get() as Record<string, unknown>;
    assert.equal(v['firm_type'], 'unknown');
    assert.equal(v['confidence'], 'none');
    assert.equal(v['portal_only'], 0);
    assert.equal(v['bounce_count'], 0);
    assert.equal(v['name_variants'], '[]');
    assert.equal(v['contact_persons'], '[]');
    assert.match(String(v['created_at']), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    db.prepare(`INSERT INTO listing_event (external_id, source, branch, payload) VALUES ('1','is24','T0','{}')`).run();
    const l = db.prepare(`SELECT * FROM listing_event WHERE external_id='1'`).get() as Record<string, unknown>;
    assert.equal(l['state'], 'captured');
    assert.equal(l['cost_usd'], 0);
    assert.equal(l['used_hook'], 0);
  } finally { cleanup(); }
});

test('Zeitstempel sind UTC (§16)', () => {
  const { db, cleanup } = freshDb();
  try {
    db.prepare(`INSERT INTO verwaltung (name_canonical) VALUES ('meyer')`).run();
    const { created_at } = db.prepare(
      `SELECT created_at FROM verwaltung WHERE name_canonical='meyer'`,
    ).get() as { created_at: string };
    const stored = new Date(created_at.replace(' ', 'T') + 'Z').getTime();
    assert.ok(Math.abs(Date.now() - stored) < 60_000, `created_at ${created_at} sieht nicht nach UTC aus`);
  } finally { cleanup(); }
});
