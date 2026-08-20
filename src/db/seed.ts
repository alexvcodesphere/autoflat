/**
 * `seed_company` — die Warteschlange für das Vorwärmen (§17).
 *
 * Der Zustand muss in SQLite liegen, nicht in Cowork: jede Cowork-Ausführung
 * ist eine eigene Sitzung ohne Gedächtnis für vorherige Läufe. Sonst werden
 * Firmen doppelt recherchiert oder übersprungen.
 */
import type { Db } from './index.ts';
import { normalizeCompanyName } from '../lib/normalize.ts';

export type SeedOrigin = 'places' | 'listing' | 'vdiv' | 'manual';
export type SeedStatus = 'pending' | 'in_progress' | 'done' | 'skipped';

export interface SeedRow {
  id: number;
  name_raw: string;
  name_canonical: string;
  address: string | null;
  website_hint: string | null;
  rating_count: number | null;
  origin: SeedOrigin;
  priority: number;
  status: SeedStatus;
  attempts: number;
  created_at: string;
}

export interface SeedInput {
  name_raw: string;
  address?: string | null;
  website_hint?: string | null;
  rating_count?: number | null;
  origin: SeedOrigin;
  priority: number;
}

/**
 * Legt einen Eintrag an, wenn er noch nicht existiert.
 *
 * Eine bereits vorhandene Firma wird nicht erneut angelegt; ihre Priorität
 * wird aber verschärft, wenn der neue Anlass dringender ist — eine Firma,
 * die in einem echten Inserat auftaucht, rutscht auf 1, auch wenn sie vorher
 * als Places-Treffer mit Priorität 3 dalag.
 */
export function insertSeed(db: Db, input: SeedInput): { id: number; created: boolean } {
  const canonical = normalizeCompanyName(input.name_raw);
  if (!canonical) throw new Error(`Firmenname ergibt keinen Schlüssel: ${JSON.stringify(input.name_raw)}`);

  const existing = db
    .prepare(`SELECT id, priority, status FROM seed_company WHERE name_canonical = ?`)
    .get(canonical) as { id: number; priority: number; status: SeedStatus } | undefined;

  if (existing) {
    if (input.priority < existing.priority) {
      db.prepare(`UPDATE seed_company SET priority = ?, origin = ? WHERE id = ?`)
        .run(input.priority, input.origin, existing.id);
    }
    return { id: existing.id, created: false };
  }

  const info = db
    .prepare(
      `INSERT INTO seed_company
         (name_raw, name_canonical, address, website_hint, rating_count, origin, priority)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .run(
      input.name_raw, canonical, input.address ?? null, input.website_hint ?? null,
      input.rating_count ?? null, input.origin, input.priority,
    );
  return { id: Number(info.lastInsertRowid), created: true };
}

/**
 * Nächster Batch nach Priorität (§17).
 *
 * Markiert die Zeilen sofort als `in_progress`, damit zwei Exporte nicht
 * dieselben Firmen ausgeben.
 */
export function takeBatch(db: Db, n: number): SeedRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM seed_company WHERE status = 'pending'
       ORDER BY priority ASC, id ASC LIMIT ?`,
    )
    .all(n) as SeedRow[];
  if (rows.length === 0) return [];

  const mark = db.prepare(
    `UPDATE seed_company SET status = 'in_progress', attempts = attempts + 1 WHERE id = ?`,
  );
  const tx = db.transaction((ids: number[]) => { for (const id of ids) mark.run(id); });
  tx(rows.map((r) => r.id));
  return rows;
}

export function findSeedByName(db: Db, nameRaw: string): SeedRow | null {
  const canonical = normalizeCompanyName(nameRaw);
  if (!canonical) return null;
  return (db.prepare(`SELECT * FROM seed_company WHERE name_canonical = ?`).get(canonical) as SeedRow) ?? null;
}

export function markSeed(db: Db, id: number, status: SeedStatus): void {
  db.prepare(`UPDATE seed_company SET status = ? WHERE id = ?`).run(status, id);
}

/**
 * Nicht beantwortete Zeilen eines Batches zurück auf `pending` (§17):
 * "angeforderter Name fehlt in der Antwort -> bleibt pending, kommt in den
 * nächsten Batch".
 */
export function releaseStale(db: Db, ids: number[]): number {
  if (ids.length === 0) return 0;
  const stmt = db.prepare(
    `UPDATE seed_company SET status = 'pending' WHERE id = ? AND status = 'in_progress'`,
  );
  let n = 0;
  const tx = db.transaction((list: number[]) => {
    for (const id of list) n += stmt.run(id).changes;
  });
  tx(ids);
  return n;
}

export interface SeedStats {
  pending: number;
  in_progress: number;
  done: number;
  skipped: number;
  byPriority: Record<number, number>;
}

export function seedStats(db: Db): SeedStats {
  const stats: SeedStats = { pending: 0, in_progress: 0, done: 0, skipped: 0, byPriority: {} };
  for (const row of db
    .prepare(`SELECT status, COUNT(*) AS n FROM seed_company GROUP BY status`)
    .all() as Array<{ status: SeedStatus; n: number }>) {
    stats[row.status] = row.n;
  }
  for (const row of db
    .prepare(`SELECT priority, COUNT(*) AS n FROM seed_company WHERE status='pending' GROUP BY priority`)
    .all() as Array<{ priority: number; n: number }>) {
    stats.byPriority[row.priority] = row.n;
  }
  return stats;
}

// ---------------------------------------------------------------- Quarantäne

export interface QuarantineInput {
  seed_id: number | null;
  name_input: string;
  name_canonical: string | null;
  payload: unknown;
  reasons: string[];
}

export function quarantine(db: Db, input: QuarantineInput): number {
  const info = db
    .prepare(
      `INSERT INTO prewarm_quarantine (seed_id, name_input, name_canonical, payload, reasons)
       VALUES (?,?,?,?,?)`,
    )
    .run(
      input.seed_id, input.name_input, input.name_canonical,
      JSON.stringify(input.payload), JSON.stringify(input.reasons),
    );
  return Number(info.lastInsertRowid);
}

export function openQuarantine(db: Db): Array<{
  id: number; name_input: string; reasons: string[]; payload: unknown; created_at: string;
}> {
  return (
    db.prepare(`SELECT * FROM prewarm_quarantine WHERE status='open' ORDER BY id`).all() as Array<{
      id: number; name_input: string; reasons: string; payload: string; created_at: string;
    }>
  ).map((r) => ({
    id: r.id,
    name_input: r.name_input,
    reasons: JSON.parse(r.reasons) as string[],
    payload: JSON.parse(r.payload) as unknown,
    created_at: r.created_at,
  }));
}

/**
 * §17: "Quarantänezeilen erscheinen in der Firmen-Ansicht zur Sichtprüfung.
 * Erst mein Klick schreibt sie nach `verwaltung`."
 */
export interface QuarantineRow {
  id: number;
  seed_id: number | null;
  name_input: string;
  name_canonical: string | null;
  payload: Record<string, unknown>;
  reasons: string[];
  created_at: string;
}

export function getQuarantine(db: Db, id: number): QuarantineRow | null {
  const row = db.prepare(`SELECT * FROM prewarm_quarantine WHERE id = ?`).get(id) as
    | { id: number; seed_id: number | null; name_input: string; name_canonical: string | null;
        payload: string; reasons: string; created_at: string }
    | undefined;
  if (!row) return null;
  return {
    ...row,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    reasons: JSON.parse(row.reasons) as string[],
  };
}

export function closeQuarantine(db: Db, id: number, status: 'accepted' | 'rejected'): void {
  db.prepare(`UPDATE prewarm_quarantine SET status = ? WHERE id = ?`).run(status, id);
}
