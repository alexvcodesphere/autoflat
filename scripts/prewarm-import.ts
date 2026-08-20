#!/usr/bin/env node
/**
 * Cowork-Ergebnis einlesen (§17, Schritt 3).
 *
 *   npm run prewarm:import -- ergebnis.json
 *   npm run prewarm:import -- --quarantine    offene Quarantäne zeigen
 *
 * Phase 6 hängt denselben Aufruf hinter `POST /prewarm/import`.
 */
import { readFileSync } from 'node:fs';
import { openDb } from '../src/db/index.ts';
import { openQuarantine, type SeedRow } from '../src/db/seed.ts';
import { importPrewarm, summarize, ImportRejected } from '../src/lib/prewarm-import.ts';

const argv = process.argv.slice(2);
const db = openDb();

if (argv.includes('--quarantine')) {
  const rows = openQuarantine(db);
  if (rows.length === 0) console.log('Quarantäne leer.');
  for (const row of rows) {
    console.log(`\n#${row.id}  ${row.name_input}   (${row.created_at})`);
    for (const reason of row.reasons) console.log(`  - ${reason}`);
    console.log(`  ${JSON.stringify(row.payload)}`);
  }
  db.close();
  process.exit(0);
}

const file = argv.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('Aufruf: npm run prewarm:import -- <datei.json>');
  process.exit(1);
}

const requested = db
  .prepare(`SELECT * FROM seed_company WHERE status = 'in_progress' ORDER BY id`)
  .all() as SeedRow[];

if (requested.length === 0) {
  console.error(
    'Kein offener Batch: keine Zeile steht auf "in_progress".\n' +
      'Erst `npm run prewarm:batch` ausführen, dann Cowork laufen lassen.',
  );
  process.exit(1);
}

let outcome;
try {
  outcome = importPrewarm(db, readFileSync(file, 'utf8'), requested);
} catch (err) {
  if (err instanceof ImportRejected) {
    // §17: ganzen Import ablehnen, Rohtext zum Nachbessern anzeigen.
    console.error(`\nImport abgelehnt: ${err.message}\n`);
    console.error('Rohtext zum Nachbessern:\n');
    console.error(readFileSync(file, 'utf8').slice(0, 2000));
    process.exit(1);
  }
  throw err;
}

console.log(summarize(outcome));
console.log();

for (const a of outcome.accepted) console.log(`  ✔ ${a.name}  (${a.confidence})`);
for (const s of outcome.skippedVerified) console.log(`  = ${s}  — bestehender Eintrag ist "verified", nicht überschrieben`);
for (const c of outcome.coerced) console.log(`  ~ ${c.name}: ${c.note}`);
for (const q of outcome.quarantined) {
  console.log(`  ⚠ ${q.name}`);
  for (const r of q.reasons) console.log(`      ${r}`);
}
for (const m of outcome.missing) console.log(`  … ${m} — keine Antwort, bleibt in der Warteschlange`);

if (outcome.quarantined.length > 0) {
  console.log(`\nQuarantäne ansehen: npm run prewarm:import -- --quarantine`);
}
db.close();
