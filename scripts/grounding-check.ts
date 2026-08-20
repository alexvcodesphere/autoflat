#!/usr/bin/env node
/**
 * Warum feuert die Google-Suche nicht?
 *
 *   npm run grounding:check
 *
 * Drei Varianten desselben Aufrufs, nur die Ausgabesteuerung unterscheidet
 * sich. Die Frage ist so gewählt, dass sie ohne Suche nicht beantwortbar ist.
 *
 * A  googleSearch + responseJsonSchema   (was der Adapter heute tut)
 * B  googleSearch, freier Text           (Kontrolle: geht Grounding überhaupt?)
 * C  googleSearch + JSON-Modus ohne Schema
 *
 * Zeigt A keine Werkzeugspur und B eine, ist das strikte Schema die Ursache
 * und der Adapter braucht zwei Aufrufe: erst gegroundet recherchieren, dann
 * strukturieren.
 */
import { GoogleGenAI } from '@google/genai';
import { requireGeminiApiKey } from '../src/config/env.ts';
import { loadRegistry } from '../src/llm/registry.ts';

const FRAGE =
  'Welche E-Mail-Adresse nennt das Impressum von habitare-immobilien.de, ' +
  'und wer ist dort als zuständig für Vermietung aufgeführt? ' +
  'Nenne die URLs, die du tatsächlich geöffnet hast.';

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['email', 'quellen'],
  properties: {
    email: { type: ['string', 'null'] },
    quellen: { type: 'array', items: { type: 'string' } },
  },
};

let model = 'gemini-3.7-flash';
try {
  model = loadRegistry({ stages: ['research_firma'] }).bindings.research_firma.model;
} catch { /* Registry nicht nötig, Default reicht */ }

const client = new GoogleGenAI({ apiKey: requireGeminiApiKey() });

interface Variant {
  label: string;
  config: Record<string, unknown>;
}

const VARIANTEN: Variant[] = [
  {
    label: 'A  googleSearch + responseJsonSchema',
    config: {
      tools: [{ googleSearch: {} }],
      responseMimeType: 'application/json',
      responseJsonSchema: SCHEMA,
    },
  },
  {
    label: 'B  googleSearch, freier Text',
    config: { tools: [{ googleSearch: {} }] },
  },
  {
    label: 'C  googleSearch + JSON-Modus ohne Schema',
    config: { tools: [{ googleSearch: {} }], responseMimeType: 'application/json' },
  },
];

console.log(`Modell: ${model}\nFrage:  ${FRAGE.slice(0, 70)}…\n`);
console.log('Variante                                  Such-  Chunks  Entry  Input  Antwort');
console.log('                                          anfr.                  Tok.');
console.log('─'.repeat(88));

for (const variant of VARIANTEN) {
  try {
    const response = await client.models.generateContent({
      model,
      contents: FRAGE,
      config: variant.config,
    });
    const c = response.candidates?.[0] as
      | {
          groundingMetadata?: {
            webSearchQueries?: string[];
            groundingChunks?: unknown[];
            searchEntryPoint?: unknown;
          };
        }
      | undefined;
    const meta = c?.groundingMetadata;
    const queries = meta?.webSearchQueries?.length ?? 0;
    const chunks = meta?.groundingChunks?.length ?? 0;
    const entry = meta?.searchEntryPoint ? 'ja' : 'nein';
    const inTok = response.usageMetadata?.promptTokenCount ?? 0;
    const text = (response.text ?? '').replace(/\s+/g, ' ').slice(0, 60);

    console.log(
      `${variant.label.padEnd(41)} ${String(queries).padStart(4)}  ${String(chunks).padStart(6)}  ` +
        `${entry.padStart(5)}  ${String(inTok).padStart(5)}  ${text}`,
    );
    if (meta?.webSearchQueries?.length) {
      console.log(`${' '.repeat(43)}Suchen: ${meta.webSearchQueries.join(' | ')}`);
    }
  } catch (err) {
    console.log(`${variant.label.padEnd(41)} FEHLER: ${(err as Error).message.slice(0, 90)}`);
  }
}

console.log('─'.repeat(88));
console.log(
  '\nLesart:\n' +
    '  B hat Werkzeugspur, A nicht  -> das strikte Schema schaltet die Suche ab.\n' +
    '                                  Der Adapter braucht zwei Aufrufe.\n' +
    '  C hat Spur, A nicht          -> nur responseJsonSchema stört, JSON-Modus geht.\n' +
    '                                  Dann Schema aus dem Prompt statt aus dem Feld.\n' +
    '  keine Variante hat Spur      -> Grounding ist für diesen Key/dieses Projekt\n' +
    '                                  gar nicht aktiv. Dann liegt es nicht am Code.\n' +
    '\nEin deutlich höherer Input-Tokenwert ist das zweite Indiz: eingespeiste\n' +
    'Suchergebnisse schlagen dort mit Tausenden Tokens zu Buche.',
);
