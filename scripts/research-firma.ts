#!/usr/bin/env node
/**
 * Firmenrecherche zur Laufzeit (§8 Flow B). Prüft den Grounding-Adapter.
 *
 *   npm run research:firma -- "Kranz Immobilienverwaltung GmbH"
 *   npm run research:firma -- "Meyer Hausverwaltung" --adresse "Sonnenallee 104"
 *   npm run research:firma -- "..." --website habitare-immobilien.de --person "Björn Tölken"
 *   npm run research:firma -- "..." --save     Ergebnis in den Cache schreiben
 *   npm run research:firma -- "..." --debug    Grounding-Metadaten zeigen
 *   npm run research:firma -- "..." --search-only   ohne urlContext-Werkzeug
 *   npm run research:firma -- "..." --allow-ungrounded   Schutz aus (nur Diagnose)
 *
 * Flow B hat 25 s Budget. Kommt nichts Belastbares zurück, gehört das
 * Inserat nach T0 und die Firma mit priority=1 in die Warteschlange.
 */
import { loadRegistry, setResearchOverrides } from '../src/llm/registry.ts';
import type { GroundingInfo } from '../src/llm/providers/gemini-research.ts';
import { researchFirma } from '../src/stages/research-firma.ts';
import { openDb } from '../src/db/index.ts';
import { upsertVerwaltung, findVerwaltung } from '../src/db/verwaltung.ts';
import { insertSeed } from '../src/db/seed.ts';
import { settleGrounding } from '../src/db/grounding.ts';

function fail(message: string): never {
  console.error(`\nFehlgeschlagen:\n  ${message.split('\n').join('\n  ')}\n`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const save = argv.includes('--save');
const debug = argv.includes('--debug');
const searchOnly = argv.includes('--search-only');
// Nur für die Diagnose: sonst gilt "keine Suche => Fehlschlag".
const allowUngrounded = argv.includes('--allow-ungrounded');

let grounding: GroundingInfo | null = null;
setResearchOverrides({
  tools: searchOnly ? 'search' : 'search+url',
  requireGrounding: !allowUngrounded,
  onGroundingInfo: (info) => { grounding = info; },
});
const adrIdx = argv.indexOf('--adresse');
const addressHint = adrIdx >= 0 ? (argv[adrIdx + 1] ?? null) : null;
const webIdx = argv.indexOf('--website');
const websiteHint = webIdx >= 0 ? (argv[webIdx + 1] ?? null) : null;
const personIdx = argv.indexOf('--person');
const contactPerson = personIdx >= 0 ? (argv[personIdx + 1] ?? null) : null;
const FLAGS_WITH_VALUE = new Set(['--adresse', '--website', '--person']);
const name = argv.find((a, i) => !a.startsWith('--') && !FLAGS_WITH_VALUE.has(argv[i - 1] ?? ''));

if (!name) fail('Aufruf: npm run research:firma -- "Firmenname" [--adresse "Straße"] [--save]');

const db = openDb();
const cached = findVerwaltung(db, name);
if (cached) {
  console.log(`Cache-Treffer — keine Recherche nötig (§3):`);
  console.log(JSON.stringify(cached, null, 2));
  console.log('\nDas ist Flow A. Erneut recherchieren nur, wenn der Eintrag falsch ist.');
  db.close();
  process.exit(0);
}

let adapter;
let timeoutMs: number;
try {
  const registry = loadRegistry({ stages: ['research_firma'] });
  adapter = registry.research('research_firma');
  timeoutMs = registry.bindings.research_firma.timeoutMs;
} catch (err) {
  fail((err as Error).message);
}

console.log(`Adapter: ${adapter.id}  (Grounding: ${adapter.supportsGrounding}, Timeout ${timeoutMs} ms)`);
console.log(`Suche:   ${name}${addressHint ? `  ·  ${addressHint}` : ''}\n`);

const result = await researchFirma(
  adapter,
  { name, addressHint, websiteHint, contactPerson },
  { timeoutMs, allowFallback: true },
);

console.log(`ok:      ${result.ok}`);
console.log(`ms:      ${result.llm.ms}`);
console.log(`usage:   ${JSON.stringify(result.llm.usage)}`);
// Der Adapter rechnet jede Suchanfrage voll ab, weil er das Kontingent nicht
// kennen kann. Hier wird es gegengerechnet (§11: 5.000 frei pro Monat).
const searches = result.llm.usage.searchQueries ?? 0;
const settled = settleGrounding(db, searches);
const echteKosten = result.llm.costUsd - settled.conservativeUsd + settled.groundingUsd;
console.log(
  `costUsd: ${echteKosten.toFixed(6)}` +
    (searches > 0
      ? `   (Tokens ${(result.llm.costUsd - settled.conservativeUsd).toFixed(6)} + ` +
        `Suche ${settled.groundingUsd.toFixed(6)} für ${settled.billableQueries}/${searches} ` +
        `berechnete Anfragen; noch ${settled.freeRemaining} frei diesen Monat)`
      : ''),
);
const g = grounding as GroundingInfo | null;
if (debug || (result.ok && (result.llm.usage.searchQueries ?? 0) === 0)) {
  console.log('\n── Grounding-Diagnose ─────────────────────────────────');
  if (!g) {
    console.log('  Keine Metadaten erfasst — der Aufruf kam nicht bis zur Antwort.');
  } else {
    console.log(`  gesendete Werkzeuge:   ${g.toolsSent.join(', ')}`);
    console.log(`  groundingMetadata da:  ${g.hasGroundingMetadata}`);
    console.log(`  webSearchQueries:      ${g.webSearchQueries.length}${g.webSearchQueries.length ? ` — ${g.webSearchQueries.join(' | ')}` : ''}`);
    console.log(`  groundingChunks:       ${g.groundingChunkCount}`);
    console.log(`  searchEntryPoint:      ${g.hasSearchEntryPoint}`);
    console.log(`  per urlContext geholt: ${g.urlContextUrls.length}${g.urlContextUrls.length ? `\n    ${g.urlContextUrls.join('\n    ')}` : ''}`);
    console.log(`  finishReason:          ${g.finishReason || '-'}`);
    if (g.report) {
      console.log(`\n  ── Recherchebericht (Aufruf 1) ──`);
      for (const line of g.report.trim().split('\n')) console.log(`  ${line}`);
    }
    console.log();
    if (!g.hasGroundingMetadata && g.urlContextUrls.length === 0) {
      console.log('  BEFUND: Keinerlei Werkzeugspur. Das Modell hat aus dem Gedächtnis');
      console.log('  geantwortet, nicht aus dem Netz. Die Angaben sind unbelegt —');
      console.log('  confidence "high" wäre dann nicht gerechtfertigt.');
    } else if (g.webSearchQueries.length === 0) {
      console.log('  BEFUND: Werkzeugspur vorhanden, aber keine gezählte Suchanfrage.');
      console.log('  Für die Abrechnung wird mit 1 gerechnet.');
    } else {
      console.log(`  BEFUND: ${g.webSearchQueries.length} Suchanfragen, ${g.groundingChunkCount} Belegstellen.`);
      if (g.urlContextUrls.length === 0) {
        console.log('  Hinweis: keine Seite per urlContext geöffnet, gelesen wurden nur');
        console.log('  Suchtreffer. Reicht oft — prüfe im Bericht, ob echte URLs und');
        console.log('  Inhalte genannt sind oder nur Behauptungen.');
      }
    }
  }
  console.log('───────────────────────────────────────────────────────');
}

if (!result.ok || !result.data) {
  console.log(`\nerror.kind: ${result.llm.error?.kind}`);
  console.log(`error:      ${result.llm.error?.message}`);
  if (result.llm.raw) console.log(`raw:        ${result.llm.raw.slice(0, 600)}`);
  db.close();
  process.exit(1);
}

console.log(`\n${JSON.stringify(result.data, null, 2)}`);

const data = result.data;
const email = data.email_vermietung ?? data.email_general;
console.log(
  `\nErgebnis: ${email ?? 'keine Adresse'}  ·  ${data.firm_type}  ·  confidence ${data.confidence}` +
    (data.portal_only ? '  ·  PORTAL ONLY (§15: respektieren)' : ''),
);

if (save) {
  if (data.confidence === 'none' || !email) {
    insertSeed(db, { name_raw: name, address: addressHint, origin: 'listing', priority: 1 });
    console.log('\nNichts Belastbares — Firma mit priority=1 in die Warteschlange gelegt (§8 Flow B).');
  } else {
    const { id, skipped } = upsertVerwaltung(db, {
      nameRaw: name,
      firm_type: data.firm_type,
      domain: data.domain,
      impressum_url: data.impressum_url,
      vermietung_url: data.vermietung_url,
      email_vermietung: data.email_vermietung,
      email_general: data.email_general,
      contact_persons: data.contact_persons,
      confidence: data.confidence,
      portal_only: data.portal_only,
      source: 'listing',
    });
    console.log(skipped ? '\nBestehender Eintrag war stärker — nicht überschrieben.' : `\nIn den Cache geschrieben (verwaltung #${id}).`);
  }
}
db.close();
