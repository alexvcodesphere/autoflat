#!/usr/bin/env node
/**
 * WEGWERF-HARNESS. Gehört zu keiner Bauphase.
 *
 * Entstanden aus der Frage "wie testen wir einen Full Run bis hierher".
 * Die echte Pipeline ist Phase 6 und läuft dann im Fastify-Dienst hinter
 * `POST /capture` — dieses Skript wird dabei gelöscht, nicht portiert.
 *
 *
 * ---
 *
 * Die ganze Kette an einem Inserat — so weit sie gebaut ist.
 *
 *   npm run pipeline -- fixtures/is24-habitare-baumschulenweg.json
 *   npm run pipeline -- <datei> --research     Cache-Miss recherchieren (§8 Flow B)
 *   npm run pipeline -- <datei> --save         Ergebnisse in die DB schreiben
 *   npm run pipeline -- <datei> --cached       extract überspringen, data/payloads/ nutzen
 *
 * Zeigt jede Stufe einzeln mit Dauer und Kosten und vergleicht am Ende mit
 * dem Latenzbudget aus §8.
 *
 * NICHT enthalten, weil noch nicht gebaut:
 *   Phase 7  Versand
 *   Phase 9  t_makler, t0, t_nachmieter
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { loadRegistry, PHASE1_STAGES } from '../src/llm/registry.ts';
import { runGate } from '../src/stages/gate.ts';
import { isSendBranch } from '../src/lib/classify.ts';
import { settleGrounding } from '../src/db/grounding.ts';
import { runExtract, type Payload } from '../src/stages/extract.ts';
import { researchFirma } from '../src/stages/research-firma.ts';
import { loadProfile } from '../src/lib/profile.ts';
import { renderVerwaltung } from '../src/render/verwaltung.ts';
import { openDb } from '../src/db/index.ts';
import { findVerwaltung, upsertVerwaltung, type Verwaltung } from '../src/db/verwaltung.ts';
import { insertSeed } from '../src/db/seed.ts';
import { loadFixture, checkPayload } from '../src/lib/fixtures.ts';
import type { CaptureInput } from '../src/lib/capture.ts';

function fail(message: string): never {
  console.error(`\nFehlgeschlagen:\n  ${message.split('\n').join('\n  ')}\n`);
  process.exit(1);
}
const rule = (label = '') => console.log(`\n${label ? `── ${label} ` : ''}${'─'.repeat(Math.max(0, 74 - label.length - 4))}`);

const argv = process.argv.slice(2);
const doResearch = argv.includes('--research');
const doSave = argv.includes('--save');
const useCached = argv.includes('--cached');
const file = argv.find((a) => !a.startsWith('--'));
if (!file) fail('Aufruf: npm run pipeline -- fixtures/<datei>.json [--research] [--save] [--cached]');
if (!existsSync(file)) fail(`Datei nicht gefunden: ${file}`);

const name = basename(file).replace(/\.json$/, '');
const capture = JSON.parse(readFileSync(file, 'utf8')) as CaptureInput;
const PAYLOAD_DIR = resolve(import.meta.dirname, '../data/payloads');

let totalCost = 0;
let totalMs = 0;
let llmCalls = 0;

console.log(`Inserat: ${name}`);
console.log(`URL:     ${capture.url ?? '—'}`);
console.log(`Quelle:  ${capture.source}  ·  ${capture.page_text.length} Zeichen Seitentext`);

// ---------------------------------------------------------------- 1 extract
rule('1  extract');

let payload: Payload;
if (useCached) {
  const cachedPath = resolve(PAYLOAD_DIR, `${name}.json`);
  if (!existsSync(cachedPath)) fail(`Kein gecachter Payload: ${cachedPath}`);
  payload = JSON.parse(readFileSync(cachedPath, 'utf8')) as Payload;
  console.log(`aus data/payloads/${name}.json (kein Modellaufruf)`);
} else {
  let adapter;
  let timeoutMs: number;
  try {
    const registry = loadRegistry({ stages: PHASE1_STAGES });
    adapter = registry.generate('extract');
    timeoutMs = registry.bindings.extract.timeoutMs;
  } catch (err) {
    fail((err as Error).message);
  }
  const result = await runExtract(adapter, capture, { timeoutMs });
  totalCost += result.llm.costUsd;
  totalMs += result.llm.ms;
  llmCalls++;

  if (!result.ok || !result.payload) {
    console.log(`✖ ${result.llm.error?.kind}: ${result.llm.error?.message}`);
    fail('Ohne Payload endet die Pipeline hier.');
  }
  payload = result.payload;
  console.log(`${adapter.id}  ·  ${result.llm.ms} ms  ·  $${result.llm.costUsd.toFixed(6)}` +
    `  ·  ${result.llm.usage.inputTokens} In / ${result.llm.usage.outputTokens} Out`);
  if (result.issues.length > 0) console.log(`Hinweise: ${result.issues.join(', ')}`);

  mkdirSync(PAYLOAD_DIR, { recursive: true });
  writeFileSync(resolve(PAYLOAD_DIR, `${name}.json`), JSON.stringify(payload, null, 2) + '\n');
}

const l = payload.listing;
console.log(
  `\n  ${l.external_id}  ·  ${l.rooms ?? '?'} Zi.  ·  ${l.living_space ?? '?'} m²  ·  ` +
  `${l.cold_rent ?? '?'} € kalt / ${l.warm_rent ?? '?'} € warm  ·  Kaution ${l.deposit ?? '—'}`,
);
console.log(`  ${[l.street, l.house_number].filter(Boolean).join(' ') || '(keine Straße)'}, ${l.postcode ?? ''} ${l.district ?? ''}`);
console.log(`  features: ${l.features.join(', ') || '—'}`);
console.log(`  Anbieter: ${payload.provider.name_raw ?? '(keiner)'}`);
console.log(`  privat?   ${payload.provider.platform_private_flag}`);
console.log(`  Rolle:    ${payload.provider.self_description ?? '(nichts gefunden)'}`);

// Zusicherungen, falls es zu diesem Fixture welche gibt.
try {
  const fixture = loadFixture(name);
  if (Object.keys(fixture.expected).length > 0) {
    const { passed, failures } = checkPayload(payload, fixture.expected);
    console.log(`\n  Zusicherungen: ${passed} erfüllt, ${failures.length} verletzt`);
    for (const f of failures) console.log(`    ✖ ${f}`);
  }
} catch { /* kein Fixture-Gegenstück, egal */ }

// -------------------------------------------------------- 2 Cache-Lookup
// Muss vor dem Gate laufen: ein Cache-Eintrag ist ein hartes Signal (§7
// Stufe 2) und geht als Kontext in den Gate-Aufruf.
rule('2  Firmen-Cache');

const db = openDb();
const nameRaw = payload.provider.name_raw;
let cached: Verwaltung | null = nameRaw ? findVerwaltung(db, nameRaw) : null;

if (!nameRaw) {
  console.log('Kein Anbietername im Payload — kein Lookup möglich, das wird T0 (§8 Flow B).');
} else if (cached) {
  console.log(`TREFFER (Flow A): ${cached.name_canonical}`);
  console.log(`  ${cached.email_vermietung ?? cached.email_general ?? 'keine Adresse'}  ·  ` +
    `${cached.firm_type}  ·  confidence ${cached.confidence}${cached.portal_only ? '  ·  PORTAL ONLY' : ''}`);
} else {
  console.log(`MISS (Flow B): "${nameRaw}" ist nicht im Cache.`);
  if (!doResearch) {
    console.log('Mit --research wird recherchiert (90 s Budget, Grounding im Freikontingent).');
  } else {
    let adapter;
    let timeoutMs: number;
    try {
      const registry = loadRegistry({ stages: ['research_firma'] });
      adapter = registry.research('research_firma');
      timeoutMs = registry.bindings.research_firma.timeoutMs;
    } catch (err) {
      fail((err as Error).message);
    }
    const hint = [l.street, l.postcode, l.district].filter(Boolean).join(' ') || null;
    const res = await researchFirma(
      adapter,
      {
        name: nameRaw,
        addressHint: hint,
        websiteHint: payload.provider.website_raw,
        contactPerson: payload.provider.contact_person_raw,
      },
      { timeoutMs, allowFallback: true },
    );
    const settled = settleGrounding(db, res.llm.usage.searchQueries ?? 0);
    const echt = res.llm.costUsd - settled.conservativeUsd + settled.groundingUsd;
    totalCost += echt;
    totalMs += res.llm.ms;
    llmCalls++;
    console.log(`${adapter.id}  ·  ${res.llm.ms} ms  ·  $${echt.toFixed(6)}  ·  ` +
      `${res.llm.usage.searchQueries ?? 0} Suchanfragen (${settled.freeRemaining} frei diesen Monat)`);

    if (!res.ok || !res.data) {
      console.log(`✖ ${res.llm.error?.kind}: ${res.llm.error?.message}`);
    } else {
      const d = res.data;
      console.log(`  ${d.email_vermietung ?? d.email_general ?? 'keine Adresse'}  ·  ${d.firm_type}  ·  confidence ${d.confidence}${d.portal_only ? '  ·  PORTAL ONLY' : ''}`);
      if (d.evidence) console.log(`  Beleg: ${d.evidence}`);
      if (doSave) {
        if (d.confidence === 'none' || !(d.email_vermietung ?? d.email_general)) {
          insertSeed(db, { name_raw: nameRaw, address: hint, origin: 'listing', priority: 1 });
          console.log('  -> nichts Belastbares, Firma mit priority=1 in die Warteschlange (§8 Flow B)');
        } else {
          upsertVerwaltung(db, {
            nameRaw, firm_type: d.firm_type, domain: d.domain, impressum_url: d.impressum_url,
            vermietung_url: d.vermietung_url, email_vermietung: d.email_vermietung,
            email_general: d.email_general, contact_persons: d.contact_persons,
            confidence: d.confidence, portal_only: d.portal_only, source: 'listing',
          });
          cached = findVerwaltung(db, nameRaw);
          console.log('  -> in den Cache geschrieben. Das nächste Inserat dieser Firma ist Flow A.');
        }
      }
    }
  }
}

// --------------------------------------------- 3 gate + Klassifikation
rule('3  gate + Klassifikation');

let gateAdapter;
let gateTimeout: number;
try {
  const registry = loadRegistry({ stages: PHASE1_STAGES });
  gateAdapter = registry.generate('gate');
  gateTimeout = registry.bindings.gate.timeoutMs;
} catch (err) {
  fail((err as Error).message);
}

const gate = await runGate(
  gateAdapter,
  { payload, pageText: capture.page_text, source: String(capture.source), cached },
  { timeoutMs: gateTimeout },
);
totalCost += gate.llm.costUsd;
totalMs += gate.llm.ms;
llmCalls++;

console.log(`${gateAdapter.id}  ·  ${gate.llm.ms} ms  ·  $${gate.llm.costUsd.toFixed(6)}`);
if (!gate.ok) {
  console.log(`✖ ${gate.llm.error?.kind}: ${gate.llm.error?.message}`);
  console.log('Rückfall greift: T0, kein Versand (§8).');
} else {
  console.log(`\n  Betrugsrisiko: ${gate.risk}${gate.signals.length ? `  ·  ${gate.signals.join(', ')}` : ''}`);
  console.log(`  Zweig:         ${gate.branch}  (${gate.branchSource}, Konfidenz ${gate.branchConfidence})`);
  console.log(`  firm_type:     ${gate.verdict!.firm_type_guess}`);
  if (gate.hardSignal) {
    console.log(`  hartes Signal: ${gate.hardSignal.reason}${gate.hardSignal.decisive ? ' [entscheidend]' : ''}`);
  }
  console.log(`  Begründung:    ${gate.verdict!.reasoning}`);
}
if (gate.note) console.log(`\n  Hinweis: ${gate.note}`);

const branch = gate.branch;
const wouldSend = isSendBranch(branch) && gate.risk !== 'high';
console.log(`\n  Versandpfad: ${wouldSend ? 'ja' : 'NEIN'}` +
  (branch === 'T0' ? '  (T0 ist kein Versandzweig, §9)' : '') +
  (gate.risk === 'high' ? '  (Betrugsrisiko high, §9: nur Flag)' : ''));

// ------------------------------------------------------- 4 Draft
if (branch !== 'T_VERWALTUNG') {
  rule('4  Draft');
  console.log(`Das Template für ${branch} gibt es noch nicht (Phase ${branch === 'T_PRIVAT' ? 10 : 9}).`);
  console.log('Unten steht trotzdem T_VERWALTUNG, damit die Kette durchläuft.');
}

rule('5  Draft (T_VERWALTUNG, ohne LLM)');

let profile;
try {
  profile = loadProfile();
} catch (err) {
  fail((err as Error).message);
}
const draft = renderVerwaltung(payload, profile);
console.log(`Betreff: ${draft.subject}`);
console.log(`Empfänger: ${cached?.email_vermietung ?? cached?.email_general ?? '(unbekannt — kein Versand möglich)'}`);
console.log(`\n${draft.body}`);
console.log(`${draft.wordCount} Wörter  ·  Merkmal ${draft.usedFeature ?? '—'}  ·  Anrede ${draft.personalSalutation ? 'persönlich' : 'unpersönlich'}`);
for (const b of draft.blockers) console.log(`  ⚠ ${b}`);

// ---------------------------------------------------------------- Bilanz
rule('Bilanz');
// §8 gibt Flow A 3 s und Flow B 25 s. Flow B ist hier bewusst höher: die
// Firmenrecherche darf 90 s (siehe src/llm/registry.ts), weil sie einmal pro
// Firma läuft und ihr Ergebnis dauerhaft im Cache liegt.
const budget = cached ? { flow: 'A', ms: 3_000, spec: 3_000 } : { flow: 'B', ms: 100_000, spec: 25_000 };
console.log(`${llmCalls} Modellaufrufe  ·  ${totalMs} ms  ·  $${totalCost.toFixed(6)}`);
console.log(
  `Flow ${budget.flow}: ${totalMs} ms von ${budget.ms} erlaubten` +
  (budget.ms === budget.spec ? ` (§8)` : ` (§8 nennt ${budget.spec}, bewusst angehoben)`) +
  ` — ${totalMs <= budget.ms ? 'eingehalten' : 'ÜBERSCHRITTEN'}`,
);
const fehlt = ['Undo-Fenster und Versand (Phase 7)'];
if (branch !== 'T_VERWALTUNG') fehlt.push(`Template ${branch} (Phase ${branch === 'T_PRIVAT' ? 10 : 9})`);
if (!cached && isSendBranch(branch)) {
  fehlt.push('ein Empfänger — ohne Cache-Treffer gibt es keine Adresse');
}
console.log(`\nFehlt bis zum echten Versand: ${fehlt.join(', ')}.`);
db.close();
