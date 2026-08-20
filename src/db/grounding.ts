/**
 * Zähler für das Grounding-Freikontingent (§11).
 *
 * Der Adapter kann das nicht selbst: Er kennt die Datenbank nicht und darf
 * sie nicht kennen. Er meldet deshalb `searchQueries` und rechnet
 * konservativ jede Anfrage voll ab — hier wird die Rechnung nachträglich
 * korrigiert.
 */
import type { Db } from './index.ts';
import { loadPricing } from '../llm/pricing.ts';

export interface GroundingSettlement {
  /** Wie viele der gemeldeten Anfragen tatsächlich Geld kosten. */
  billableQueries: number;
  usedThisMonth: number;
  freeRemaining: number;
  /** Was die Anfragen wirklich kosten, nach Freikontingent. */
  groundingUsd: number;
  /** Was der Adapter konservativ veranschlagt hatte. */
  conservativeUsd: number;
}

function currentMonth(at: Date): string {
  return at.toISOString().slice(0, 7);
}

function quotaFor(group: string): { free: number; usdPer1000: number } {
  const g = loadPricing().groundingGroups[group];
  if (!g) throw new Error(`Unbekannte Grounding-Gruppe: ${group}`);
  return { free: g.freeQueries, usdPer1000: g.usdPer1000Queries };
}

/**
 * Bucht `queries` Suchanfragen auf den laufenden Monat und sagt, was davon
 * berechnet wird.
 *
 * Der Zähler zählt hoch, auch wenn das Kontingent schon erschöpft ist — sonst
 * wüsste man nie, wie weit man drüber liegt.
 */
export function settleGrounding(
  db: Db,
  queries: number,
  opts: { at?: Date; group?: string } = {},
): GroundingSettlement {
  const group = opts.group ?? 'gemini-3.x';
  const { free, usdPer1000 } = quotaFor(group);
  const month = currentMonth(opts.at ?? new Date());

  const before = (db
    .prepare(`SELECT queries FROM grounding_usage WHERE month = ?`)
    .get(month) as { queries: number } | undefined)?.queries ?? 0;

  if (queries > 0) {
    db.prepare(
      `INSERT INTO grounding_usage (month, queries) VALUES (?, ?)
       ON CONFLICT(month) DO UPDATE SET queries = queries + excluded.queries`,
    ).run(month, queries);
  }

  const freeLeftBefore = Math.max(0, free - before);
  const billableQueries = Math.max(0, queries - freeLeftBefore);
  const usedThisMonth = before + queries;

  return {
    billableQueries,
    usedThisMonth,
    freeRemaining: Math.max(0, free - usedThisMonth),
    groundingUsd: (billableQueries / 1000) * usdPer1000,
    conservativeUsd: (queries / 1000) * usdPer1000,
  };
}

/** Nur lesen, ohne zu buchen. */
export function groundingStats(
  db: Db,
  opts: { at?: Date; group?: string } = {},
): { usedThisMonth: number; freeRemaining: number } {
  const { free } = quotaFor(opts.group ?? 'gemini-3.x');
  const month = currentMonth(opts.at ?? new Date());
  const used = (db
    .prepare(`SELECT queries FROM grounding_usage WHERE month = ?`)
    .get(month) as { queries: number } | undefined)?.queries ?? 0;
  return { usedThisMonth: used, freeRemaining: Math.max(0, free - used) };
}
