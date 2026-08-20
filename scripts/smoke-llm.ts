#!/usr/bin/env node
/**
 * Akzeptanzkriterium Phase 1: "ein Testaufruf gegen ein Schema liefert
 * validiertes LlmResult mit korrektem costUsd".
 *
 *   npm run llm:smoke -- --mock        ohne API-Key: Kette + Preisrechnung
 *   npm run llm:smoke                  echter Aufruf gegen Gemini
 *   npm run llm:smoke -- --stage gate  andere Stufe (Default: extract)
 */
import { loadRegistry, PHASE1_STAGES, type StageName } from '../src/llm/registry.ts';
import { loadSchema } from '../src/llm/validate.ts';
import { priceCall } from '../src/llm/pricing.ts';
import { createMockGenerateAdapter } from '../src/llm/providers/mock-generate.ts';
import { logLlmCall } from '../src/llm/log.ts';
import type { GenerateAdapter } from '../src/llm/types.ts';

function fail(message: string): never {
  console.error(`\nFehlgeschlagen:\n  ${message.split('\n').join('\n  ')}\n`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const mock = argv.includes('--mock');
const stageIdx = argv.indexOf('--stage');
const stage: StageName = stageIdx >= 0 ? ((argv[stageIdx + 1] ?? '') as StageName) : 'extract';

if (!PHASE1_STAGES.includes(stage)) {
  fail(`Stufe "${stage}" ist in Phase 1 nicht gebunden. Verfügbar: ${PHASE1_STAGES.join(', ')}`);
}

const SYSTEM = [
  'Du extrahierst Fakten aus einer deutschen Wohnungsanzeige.',
  'Antworte ausschließlich mit JSON nach dem vorgegebenen Schema.',
  'Erfinde nichts. Steht ein Wert nicht im Text, gib null zurück.',
].join(' ');

const INPUT = `
Objektnummer 162345678
2-Zimmer-Altbauwohnung mit Balkon in Berlin-Neukölln
Sonnenallee 104, 12045 Berlin
Kaltmiete: 890 EUR | Warmmiete: 1.120 EUR
Wohnfläche: 58,4 m² | 3. OG | Einbauküche vorhanden
Ein WBS ist für diese Wohnung nicht erforderlich.
Anbieter: Meyer & Co. Hausverwaltung GmbH — wir verwalten dieses Objekt seit 2011.
Ansprechpartnerin: Frau S. Kruse, Tel. 030 1234567
`.trim();

const MOCK_ANSWER = {
  external_id: '162345678',
  provider_name: 'Meyer & Co. Hausverwaltung GmbH',
  rooms: 2,
  cold_rent: 890,
  district: 'Neukölln',
  wbs_required: false,
  features: ['Altbau', 'Balkon', 'EBK', '3. OG'],
  firm_type_guess: 'verwaltung',
};

const schema = loadSchema('smoke');

let adapter: GenerateAdapter;
let timeoutMs: number;
try {
  const registry = loadRegistry({ stages: PHASE1_STAGES });

  console.log('Registry-Bindings:');
  for (const s of PHASE1_STAGES) {
    const b = registry.bindings[s];
    console.log(`  ${s.padEnd(14)} ${b.provider}:${b.model}  (timeout ${b.timeoutMs} ms)`);
  }
  console.log();

  const binding = registry.bindings[stage];
  timeoutMs = binding.timeoutMs;
  adapter = mock
    ? createMockGenerateAdapter({
        model: binding.model,
        usage: { inputTokens: 1240, outputTokens: 176, thinkingTokens: 64 },
        response: MOCK_ANSWER,
      })
    : registry.generate(stage);
} catch (err) {
  fail((err as Error).message);
}

console.log(`Adapter: ${adapter.id}${mock ? '  (MOCK — kein Netzaufruf)' : ''}`);
console.log(`Schema:  schemas/smoke.json\n`);

const result = await adapter.generate({ system: SYSTEM, input: INPUT, schema }, timeoutMs);
logLlmCall({ stage, adapter: adapter.id, system: SYSTEM, input: INPUT, result });

console.log(`ok:        ${result.ok}`);
console.log(`provider:  ${result.provider}`);
console.log(`model:     ${result.model}`);
console.log(`ms:        ${result.ms}`);
console.log(`usage:     ${JSON.stringify(result.usage)}`);

const breakdown = priceCall(result.model, result.usage);
console.log(
  `costUsd:   ${result.costUsd.toFixed(8)}\n` +
    `           = input  ${breakdown.inputUsd.toFixed(8)}  (${result.usage.inputTokens} Tok @ $${breakdown.inputPerM}/M)\n` +
    `           + output ${breakdown.outputUsd.toFixed(8)}  (${breakdown.billedOutputTokens} Tok inkl. thinking @ $${breakdown.outputPerM}/M)` +
    (breakdown.groundingUsd > 0
      ? `\n           + search ${breakdown.groundingUsd.toFixed(8)}  (${result.usage.searchQueries} Suchen)`
      : '') +
    (breakdown.provisional ? '\n           [Preis vorläufig — siehe config/pricing.json]' : ''),
);

if (result.ok) {
  console.log('\ndata (gegen schemas/smoke.json validiert):');
  console.log(JSON.stringify(result.data, null, 2));
} else {
  console.log(`\nerror.kind: ${result.error?.kind}`);
  console.log(`error:      ${result.error?.message}`);
  if (result.raw) console.log(`raw:        ${result.raw.slice(0, 800)}`);
  process.exitCode = 1;
}
