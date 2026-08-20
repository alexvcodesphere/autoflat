#!/usr/bin/env node
/**
 * Nächsten Cowork-Batch ausgeben (§17, Schritt 1).
 *
 *   npm run prewarm:batch            15 Firmen nach Priorität
 *   npm run prewarm:batch -- -n 12
 *   npm run prewarm:batch -- --stats nur die Warteschlange zeigen
 *
 * Die ausgegebenen Zeilen werden sofort als `in_progress` markiert, damit
 * zwei Exporte nicht dieselben Firmen liefern. Kommt keine Antwort, holt der
 * Import sie automatisch zurück nach `pending`.
 *
 * Phase 6 hängt denselben Aufruf hinter `GET /prewarm/batch?n=15`.
 */
import { openDb } from '../src/db/index.ts';
import { takeBatch, seedStats } from '../src/db/seed.ts';

const argv = process.argv.slice(2);
const nIdx = argv.indexOf('-n');
const n = nIdx >= 0 ? Number(argv[nIdx + 1]) : 15;

const db = openDb();
const stats = seedStats(db);

if (argv.includes('--stats')) {
  console.log(`pending ${stats.pending} · in_progress ${stats.in_progress} · done ${stats.done} · skipped ${stats.skipped}`);
  for (const [prio, count] of Object.entries(stats.byPriority).sort()) {
    console.log(`  Priorität ${prio}: ${count} offen`);
  }
  console.log(`\nNoch ${Math.ceil(stats.pending / 15)} Batches à 15.`);
  db.close();
  process.exit(0);
}

if (!Number.isFinite(n) || n < 1 || n > 30) {
  console.error('-n muss zwischen 1 und 30 liegen. §17: 12–15 pro Batch, darüber fällt die Qualität ab.');
  process.exit(1);
}

const batch = takeBatch(db, n);
if (batch.length === 0) {
  console.log('Warteschlange leer. Erst `npm run seed:places` laufen lassen.');
  db.close();
  process.exit(0);
}

console.log(`# ${batch.length} Firmen, Priorität ${batch[0]!.priority}–${batch[batch.length - 1]!.priority}`);
console.log('# Diesen Block in die Cowork-Aufgabe einfügen (docs/cowork-prewarm-prompt.md).');
console.log('# ---------------------------------------------------------------');
for (const row of batch) {
  console.log(`${row.name_raw} | ${row.address ?? 'Berlin'}${row.website_hint ? ` | ${row.website_hint}` : ''}`);
}
console.log('# ---------------------------------------------------------------');
console.log(`# Danach: npm run prewarm:import -- ergebnis.json`);
console.log(`# Noch offen: ${stats.pending - batch.length}`);
db.close();
