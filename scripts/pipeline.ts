#!/usr/bin/env node
/**
 * WEGWERF-HARNESS. Gehört zu keiner Bauphase.
 *
 * Entstanden aus der Frage "wie testen wir einen Full Run bis hierher".
 * Die echte Pipeline ist Phase 6 und läuft dann im Fastify-Dienst hinter
 * `POST /capture` — dieses Skript wird dabei gelöscht, nicht portiert.
 *
 * ACHTUNG bei `guessBranch()` weiter unten: das ist KEIN Gate. Es kennt nur
 * die harten Signale aus §7 Stufe 1 und rät im Rest. Phase 5 baut das Gate
 * gegen die Spec, nicht gegen diese Funktion — sonst zementiert ein
 * Behelfsstück die Klassifikation, die das teuerste Detail des Systems ist.
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
 *   Phase 5  gate + Klassifikation  -> der Zweig wird geraten, nicht bestimmt
 *   Phase 7  Versand
 *   Phase 9  t_makler, t0, t_nachmieter
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { loadRegistry, PHASE1_STAGES } from '../src/llm/registry.ts';
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

// ------------------------------------------------------------------ 2 gate
rule('2  gate + Klassifikation');
console.log('NICHT GEBAUT (Phase 5). Der Zweig wird unten aus harten Signalen geraten,');
console.log('nicht bestimmt — und Betrugssignale werden gar nicht geprüft.');

// -------------------------------------------------------- 3 Cache / research
rule('3  Firmen-Cache');

const db = openDb();
const nameRaw = payload.provider.name_raw;
let cached: Verwaltung | null = nameRaw ? findVerwaltung(db, nameRaw) : null;

if (!nameRaw) {
  console.log('Kein Anbietername im Payload — kein Lookup möglich, das wäre T0 (§8 Flow B).');
} else if (cached) {
  console.log(`TREFFER (Flow A): ${cached.name_canonical}`);
  console.log(`  ${cached.email_vermietung ?? cached.email_general ?? 'keine Adresse'}  ·  ` +
    `${cached.firm_type}  ·  confidence ${cached.confidence}${cached.portal_only ? '  ·  PORTAL ONLY' : ''}`);
} else {
  console.log(`MISS (Flow B): "${nameRaw}" ist nicht im Cache.`);
  if (!doResearch) {
    console.log('Mit --research wird jetzt recherchiert (20 s Budget, kostet Grounding).');
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
    totalCost += res.llm.costUsd;
    totalMs += res.llm.ms;
    llmCalls++;
    console.log(`${adapter.id}  ·  ${res.llm.ms} ms  ·  $${res.llm.costUsd.toFixed(6)}  ·  ${res.llm.usage.searchQueries ?? 0} Suchanfragen`);

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

// ----------------------------------------------------------------- 4 Zweig
rule('4  Zweig');

/**
 * Nur die harten Signale aus §7 Stufe 1, die reiner Code sind. Die
 * eigentliche Klassifikation macht das Gate (Phase 5) — bis dahin ist alles
 * hier eine Vermutung.
 */
function guessBranch(): { branch: string; why: string } {
  if (cached?.portal_only) return { branch: 'T0', why: 'Cache: portal_only' };
  if (cached && cached.firm_type !== 'unknown') {
    const map: Record<string, string> = {
      verwaltung: 'T_VERWALTUNG', makler: 'T_MAKLER',
      gesellschaft: 'T0', genossenschaft: 'T0', privat: 'T_PRIVAT',
    };
    return { branch: map[cached.firm_type] ?? 'T_VERWALTUNG', why: `Cache: firm_type=${cached.firm_type}` };
  }
  if (payload.provider.platform_private_flag === true) return { branch: 'T_PRIVAT', why: 'Portal kennzeichnet privat' };
  if (capture.source === 'wg_gesucht') return { branch: 'T_NACHMIETER', why: 'Quelle wg_gesucht' };
  if (!nameRaw) return { branch: 'T0', why: 'kein Anbietername' };
  return { branch: 'T_VERWALTUNG', why: 'Rückfall — ohne Gate nicht bestimmbar' };
}

const { branch, why } = guessBranch();
console.log(`${branch}   (${why})`);
if (branch !== 'T_VERWALTUNG') {
  console.log(`\n⚠ Das Template für ${branch} gibt es noch nicht (Phase 9 bzw. 10).`);
  console.log('  Unten steht trotzdem T_VERWALTUNG, damit die Kette durchläuft.');
}

// ----------------------------------------------------------------- 5 Draft
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
const budget = cached ? { flow: 'A', ms: 3000 } : { flow: 'B', ms: 25000 };
console.log(`${llmCalls} Modellaufrufe  ·  ${totalMs} ms  ·  $${totalCost.toFixed(6)}`);
console.log(`Flow ${budget.flow} erlaubt ${budget.ms} ms (§8) — ${totalMs <= budget.ms ? 'eingehalten' : 'ÜBERSCHRITTEN'}`);
const fehlt = ['Gate (Phase 5)', 'Undo-Fenster und Versand (Phase 7)'];
if (branch !== 'T_VERWALTUNG') fehlt.push(`Template ${branch} (Phase ${branch === 'T_PRIVAT' ? 10 : 9})`);
if (!cached) fehlt.push('ein Empfänger — ohne Cache-Treffer gibt es keine Adresse');
console.log(`\nFehlt bis zum echten Versand: ${fehlt.join(', ')}.`);
db.close();
