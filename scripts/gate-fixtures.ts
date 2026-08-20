#!/usr/bin/env node
/**
 * Akzeptanzkriterium Phase 5: "3 konstruierte Betrugs-Fixtures -> high;
 * Makler und Verwaltung werden korrekt getrennt".
 *
 *   npm run gate:fixtures                alle Fixtures mit .gate.json
 *   npm run gate:fixtures -- fraud       nur passende Namen
 *   npm run gate:fixtures -- --fresh     Payloads neu extrahieren
 *   npm run gate:fixtures -- --json      volles Urteil je Fixture
 *
 * Nutzt gecachte Payloads aus data/payloads/, wo vorhanden — dann kostet der
 * Lauf nur den Gate-Aufruf.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadRegistry, PHASE1_STAGES } from '../src/llm/registry.ts';
import { runExtract, type Payload } from '../src/stages/extract.ts';
import { runGate } from '../src/stages/gate.ts';
import { isSendBranch } from '../src/lib/classify.ts';
import { listFixtures, loadFixture, loadGateExpectation, checkGate } from '../src/lib/fixtures.ts';
import { openDb } from '../src/db/index.ts';
import { findVerwaltung } from '../src/db/verwaltung.ts';

function fail(message: string): never {
  console.error(`\nFehlgeschlagen:\n  ${message.split('\n').join('\n  ')}\n`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const fresh = argv.includes('--fresh');
const showJson = argv.includes('--json');
const filters = argv.filter((a) => !a.startsWith('--'));
const PAYLOAD_DIR = resolve(import.meta.dirname, '../data/payloads');

const names = listFixtures()
  .filter((n) => loadGateExpectation(n) !== null)
  .filter((n) => filters.length === 0 || filters.some((f) => n.includes(f)));
if (names.length === 0) fail('Keine Fixtures mit .gate.json gefunden.');

let extractAdapter;
let gateAdapter;
let extractTimeout: number;
let gateTimeout: number;
try {
  const registry = loadRegistry({ stages: PHASE1_STAGES });
  extractAdapter = registry.generate('extract');
  gateAdapter = registry.generate('gate');
  extractTimeout = registry.bindings.extract.timeoutMs;
  gateTimeout = registry.bindings.gate.timeoutMs;
} catch (err) {
  fail((err as Error).message);
}

console.log(`gate via ${gateAdapter.id}, extract via ${extractAdapter.id}\n`);

const db = openDb();
let totalCost = 0;
let totalFailures = 0;
const rows: string[] = [];

for (const name of names) {
  const fixture = loadFixture(name);
  const expected = loadGateExpectation(name)!;
  const cachedPath = resolve(PAYLOAD_DIR, `${name}.json`);

  // ------------------------------------------------------------- Payload
  let payload: Payload;
  if (!fresh && existsSync(cachedPath)) {
    payload = JSON.parse(readFileSync(cachedPath, 'utf8')) as Payload;
  } else {
    const ex = await runExtract(extractAdapter, fixture.capture, { timeoutMs: extractTimeout });
    totalCost += ex.llm.costUsd;
    if (!ex.ok || !ex.payload) {
      console.log(`✖ ${name}\n  extract fehlgeschlagen: ${ex.llm.error?.kind} — ${ex.llm.error?.message}\n`);
      totalFailures++;
      rows.push(`${name.padEnd(32)} EXTRACT-FEHLER`);
      continue;
    }
    payload = ex.payload;
    mkdirSync(PAYLOAD_DIR, { recursive: true });
    writeFileSync(cachedPath, JSON.stringify(payload, null, 2) + '\n');
  }

  // ---------------------------------------------------------------- Gate
  const cached = payload.provider.name_raw ? findVerwaltung(db, payload.provider.name_raw) : null;
  const gate = await runGate(
    gateAdapter,
    { payload, pageText: fixture.capture.page_text, source: String(fixture.capture.source), cached },
    { timeoutMs: gateTimeout },
  );
  totalCost += gate.llm.costUsd;

  if (!gate.ok || !gate.verdict) {
    console.log(`✖ ${name}\n  gate fehlgeschlagen: ${gate.llm.error?.kind} — ${gate.llm.error?.message}\n`);
    totalFailures++;
    rows.push(`${name.padEnd(32)} GATE-FEHLER`);
    continue;
  }

  // §9: high-Risiko und T0 gehen nie in den Versandpfad.
  const wouldSend = isSendBranch(gate.branch) && gate.risk !== 'high';
  const { passed, failures } = checkGate(
    {
      risk: gate.risk,
      signals: gate.signals,
      branch: gate.branch,
      firmTypeGuess: gate.verdict.firm_type_guess,
      wouldSend,
    },
    expected,
  );
  totalFailures += failures.length;

  console.log(`${failures.length === 0 ? '✔' : '✖'} ${name}`);
  console.log(
    `  risk ${gate.risk.padEnd(6)} branch ${gate.branch.padEnd(14)} ` +
    `(${gate.branchSource}, ${gate.branchConfidence})  firm_type ${gate.verdict.firm_type_guess}`,
  );
  console.log(`  Signale: ${gate.signals.join(', ') || '—'}`);
  if (gate.hardSignal) {
    console.log(`  hartes Signal: ${gate.hardSignal.reason}${gate.hardSignal.decisive ? ' [entscheidend]' : ''}`);
  }
  console.log(`  Versand: ${wouldSend ? 'JA' : 'nein'}   ·  ${gate.llm.ms} ms  ·  $${gate.llm.costUsd.toFixed(6)}`);
  console.log(`  ${gate.verdict.reasoning}`);
  for (const f of failures) console.log(`    ✖ ${f}`);
  if (showJson) console.log(`\n${JSON.stringify(gate.verdict, null, 2)}`);
  console.log();

  rows.push(
    `${name.padEnd(32)} ${gate.risk.padEnd(6)} ${gate.branch.padEnd(14)} ` +
    `${String(passed).padStart(2)} ok / ${String(failures.length).padStart(2)} fail`,
  );
}

console.log('─'.repeat(78));
for (const r of rows) console.log(r);
console.log('─'.repeat(78));
console.log(`Gesamt: $${totalCost.toFixed(6)}`);
console.log(totalFailures === 0 ? '\nAlle Zusicherungen erfüllt.' : `\n${totalFailures} verletzte Zusicherungen.`);
if (totalFailures > 0) process.exitCode = 1;
db.close();
