#!/usr/bin/env node
/**
 * Akzeptanzkriterium Phase 2: "3 gespeicherte page_text-Fixtures (IS24,
 * Kleinanzeigen, Verwaltungs-Website) -> korrekter Payload, keine erfundenen
 * Felder".
 *
 *   npm run extract:fixtures                alle Fixtures
 *   npm run extract:fixtures -- is24        nur passende Namen
 *   npm run extract:fixtures -- --json      voller Payload je Fixture
 */
import { loadRegistry, PHASE1_STAGES } from '../src/llm/registry.ts';
import { runExtract } from '../src/stages/extract.ts';
import { listFixtures, loadFixture, checkPayload } from '../src/lib/fixtures.ts';

function fail(message: string): never {
  console.error(`\nFehlgeschlagen:\n  ${message.split('\n').join('\n  ')}\n`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const showJson = argv.includes('--json');
const filters = argv.filter((a) => !a.startsWith('--'));

const names = listFixtures().filter((n) => filters.length === 0 || filters.some((f) => n.includes(f)));
if (names.length === 0) fail(`Keine Fixtures gefunden${filters.length ? ` fuer: ${filters.join(', ')}` : ''}.`);

let adapter;
let timeoutMs: number;
try {
  const registry = loadRegistry({ stages: PHASE1_STAGES });
  adapter = registry.generate('extract');
  timeoutMs = registry.bindings.extract.timeoutMs;
} catch (err) {
  fail((err as Error).message);
}

console.log(`Stufe extract via ${adapter.id}\n`);

let totalCost = 0;
let totalFailures = 0;
const rows: string[] = [];

for (const name of names) {
  const fixture = loadFixture(name);
  const result = await runExtract(adapter, fixture.capture, { timeoutMs });
  totalCost += result.llm.costUsd;

  if (!result.ok || !result.payload) {
    totalFailures++;
    console.log(`✖ ${name}`);
    console.log(`  Stufe fehlgeschlagen: ${result.llm.error?.kind} — ${result.llm.error?.message}`);
    if (result.llm.raw) console.log(`  raw: ${result.llm.raw.slice(0, 400)}`);
    console.log();
    rows.push(`${name.padEnd(34)} FEHLER`);
    continue;
  }

  const { passed, failures } = checkPayload(result.payload, fixture.expected);
  totalFailures += failures.length;

  console.log(`${failures.length === 0 ? '✔' : '✖'} ${name}`);
  console.log(
    `  ${passed} Zusicherungen erfuellt, ${failures.length} verletzt` +
      `  ·  ${result.llm.ms} ms  ·  $${result.llm.costUsd.toFixed(6)}` +
      `  ·  ${result.llm.usage.inputTokens} In / ${result.llm.usage.outputTokens} Out`,
  );
  for (const f of failures) console.log(`    - ${f}`);
  if (result.issues.length > 0) console.log(`    Hinweise: ${result.issues.join(', ')}`);
  if (showJson) console.log(`\n${JSON.stringify(result.payload, null, 2)}\n`);
  console.log();

  rows.push(
    `${name.padEnd(34)} ${String(passed).padStart(2)} ok / ${String(failures.length).padStart(2)} fail` +
      `  ${String(result.llm.ms).padStart(5)} ms  $${result.llm.costUsd.toFixed(6)}`,
  );
}

console.log('─'.repeat(72));
for (const r of rows) console.log(r);
console.log('─'.repeat(72));
console.log(`Gesamt: $${totalCost.toFixed(6)} fuer ${names.length} Fixtures`);

if (totalFailures > 0) {
  console.log(`\n${totalFailures} verletzte Zusicherungen.`);
  process.exitCode = 1;
} else {
  console.log('\nAlle Zusicherungen erfuellt.');
}
