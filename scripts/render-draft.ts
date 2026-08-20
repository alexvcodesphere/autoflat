#!/usr/bin/env node
/**
 * Akzeptanzkriterium Phase 3: "Fixture -> Mail, die ich ohne Änderung senden
 * würde". Ohne Modell, ohne Netz.
 *
 *   npm run draft:render                       alle gecachten Payloads
 *   npm run draft:render -- is24-neukoelln     nur einer
 *   npm run draft:render -- --zweitkontakt     Variante mit Vorkontakt (§13)
 *
 * Die Payloads liegen unter data/payloads/ und entstehen bei
 * `npm run extract:fixtures`.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadProfile } from '../src/lib/profile.ts';
import { renderVerwaltung, WORD_LIMIT } from '../src/render/verwaltung.ts';
import type { Payload } from '../src/stages/extract.ts';

const PAYLOAD_DIR = resolve(import.meta.dirname, '../data/payloads');

function fail(message: string): never {
  console.error(`\nFehlgeschlagen:\n  ${message.split('\n').join('\n  ')}\n`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const zweitkontakt = argv.includes('--zweitkontakt');
const filters = argv.filter((a) => !a.startsWith('--'));

if (!existsSync(PAYLOAD_DIR)) {
  fail('Keine Payloads unter data/payloads/. Erst `npm run extract:fixtures` laufen lassen.');
}
const names = readdirSync(PAYLOAD_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.slice(0, -5))
  .filter((n) => filters.length === 0 || filters.some((f) => n.includes(f)))
  .sort();
if (names.length === 0) fail(`Keine passenden Payloads${filters.length ? ` fuer: ${filters.join(', ')}` : ''}.`);

let profile;
try {
  profile = loadProfile();
} catch (err) {
  fail((err as Error).message);
}

if (profile.status !== 'echt') {
  console.log('⚠  prompts/profil.md steht auf "beispiel" — die Zahlen unten sind erfunden.');
  console.log('   Jeder Draft ist deshalb als nicht sendebereit markiert.\n');
}

for (const name of names) {
  const payload = JSON.parse(readFileSync(resolve(PAYLOAD_DIR, `${name}.json`), 'utf8')) as Payload;
  const draft = renderVerwaltung(payload, profile, {
    previousContact: zweitkontakt
      ? { sentAt: '2026-08-04', externalId: '161002345' }
      : undefined,
  });

  console.log('═'.repeat(74));
  console.log(`${name}${zweitkontakt ? '  [Zweitkontakt]' : ''}`);
  console.log('═'.repeat(74));
  console.log(`Betreff: ${draft.subject}`);
  console.log('─'.repeat(74));
  console.log(draft.body);
  console.log('─'.repeat(74));
  console.log(
    `${draft.wordCount}/${WORD_LIMIT} Wörter` +
      `  ·  Anrede ${draft.personalSalutation ? 'persönlich' : 'unpersönlich'}` +
      `  ·  Merkmal ${draft.usedFeature ?? '—'}`,
  );
  for (const b of draft.blockers) console.log(`  ⚠ ${b}`);
  console.log();
}
