/**
 * gemini-research — Fähigkeit `research` (§11).
 *
 * ZWEI Aufrufe, nicht einer. Gemessen am 2026-08-20 mit
 * `npm run grounding:check` gegen gemini-3.7-flash:
 *
 *   googleSearch + responseJsonSchema   -> 0 Suchanfragen
 *   googleSearch, freier Text           -> 3 Suchanfragen
 *   googleSearch + JSON-Modus o. Schema -> 0 Suchanfragen
 *
 * Sobald irgendeine JSON-Ausgabe verlangt wird, fällt das Suchwerkzeug
 * **still** weg — kein Fehler, kein Hinweis, nur eine selbstbewusst
 * erfundene Antwort aus dem Trainingswissen. Drei Läufe gegen dieselbe Firma
 * lieferten drei verschiedene E-Mail-Adressen samt frei erfundener
 * Belegprosa über Seiten, die nie geöffnet wurden.
 *
 * Deshalb:
 *   1. gegroundeter Aufruf, freier Text -> Rechercheb ericht mit URLs
 *   2. Aufruf ohne Werkzeuge -> Bericht in das Schema übertragen
 *
 * Nach außen bleibt es ein `LlmResult` (§11): "Die Implementierungen
 * dahinter sind grundverschieden. Nach außen liefern beide dieselbe Form."
 */
import { GoogleGenAI } from '@google/genai';
import type { ResearchAdapter, ResearchRequest, LlmResult, LlmUsage } from '../types.ts';
import { priceCall, hasPricing } from '../pricing.ts';
import { validateAgainst } from '../validate.ts';
import { toGeminiJsonSchema } from './gemini-schema.ts';
import {
  PROVIDER, mapUsage, checkUsageConsistency, classifyError, REFUSAL_FINISH_REASONS,
} from './gemini-common.ts';

/**
 * Was Gemini über den Werkzeugeinsatz zurückmeldet.
 *
 * Bleibt bewusst außerhalb von `LlmResult` — §11 verbietet, dass
 * anbieterspezifische Felder durchsickern. Wer es braucht (der Rauchtest),
 * hängt sich per Callback dran.
 */
export interface GroundingInfo {
  toolsSent: string[];
  /** Der Prosabericht aus Aufruf 1 — die eigentliche Recherche. */
  report?: string;
  hasGroundingMetadata: boolean;
  webSearchQueries: string[];
  groundingChunkCount: number;
  hasSearchEntryPoint: boolean;
  urlContextUrls: string[];
  finishReason: string;
}

export type ResearchTools = 'search' | 'search+url';

/**
 * Systemprompt für Aufruf 2. Rein mechanisch: übertragen, nicht ergänzen.
 *
 * Der gefährliche Fall ist, dass dieser Schritt Lücken des Berichts aus
 * eigenem Wissen auffüllt — dann wäre die Trennung wertlos und wir hätten
 * die Konfabulation nur eine Stufe später.
 */
const STRUCTURE_SYSTEM = [
  'Du überträgst einen Recherchebericht in JSON nach dem vorgegebenen Schema.',
  '',
  'Übernimm ausschließlich, was im Bericht steht. Ergänze nichts aus eigenem',
  'Wissen, auch wenn dir die Firma bekannt vorkommt. Was der Bericht nicht',
  'hergibt, ist null beziehungsweise "unknown" oder "none".',
  '',
  'Sagt der Bericht, dass nichts gefunden wurde oder die Identität unklar ist,',
  'gehört das so ins Ergebnis — eine erfundene Adresse ist schlechter als keine.',
  '',
  'Antworte ausschließlich mit JSON, ohne Fließtext davor oder danach.',
].join('\n');

/** Anhang an den Systemprompt des Aufrufs 1. */
const REPORT_INSTRUCTION = [
  '',
  '# Ausgabe dieses Schritts',
  '',
  'Antworte in Prosa, nicht in JSON. Nenne ausdrücklich:',
  '- welche Seiten du tatsächlich geöffnet hast, mit URL',
  '- welche Angabe du auf welcher Seite gefunden hast',
  '- woran du erkannt hast, dass es die gesuchte Firma ist',
  '',
  'Hast du nichts gefunden, schreib das hin. Erfinde keine Adresse und keine',
  'Quelle. Ein ehrliches "nicht gefunden" ist ein brauchbares Ergebnis.',
].join('\n');

export interface GeminiResearchOptions {
  apiKey: string;
  model: string;
  /** Zum A/B-Testen: manche Werkzeugkombinationen vertragen sich nicht. */
  tools?: ResearchTools;
  /**
   * Ohne Werkzeugspur den Aufruf als fehlgeschlagen werten. Default: an.
   *
   * Eine Recherche ohne Suche ist keine Recherche, sondern Erinnerung — und
   * die kam in der Messung dreimal mit drei verschiedenen Adressen und frei
   * erfundenen Quellenangaben zurück. Lieber ein sauberer Fehlschlag, den
   * die Stufe nach T0 leitet (§8 Flow B), als eine erfundene Adresse mit
   * confidence "medium" im Cache.
   */
  requireGrounding?: boolean;
  onGroundingInfo?: (info: GroundingInfo) => void;
}

/**
 * Zählt die tatsächlich abgesetzten Suchanfragen.
 *
 * Ein Request kann mehrere auslösen (§11), und abgerechnet wird pro Anfrage,
 * nicht pro Request. Ohne diesen Zähler wäre die Grounding-Rechnung geraten.
 *
 * Bekannte Einschränkung: In Kombination mit strukturierter Ausgabe liefert
 * Gemini `groundingChunks` und `groundingSupports` leer, `webSearchQueries`
 * aber gefüllt. Für die Abrechnung reicht das; für Quellen-URLs (§13,
 * hook_source_url) nicht — die muss das Modell selbst ins JSON schreiben.
 */
interface CandidateLike {
  finishReason?: unknown;
  groundingMetadata?: {
    webSearchQueries?: string[];
    groundingChunks?: unknown[];
    searchEntryPoint?: unknown;
  };
  urlContextMetadata?: { urlMetadata?: Array<{ retrievedUrl?: string }> };
}

function collectGroundingInfo(
  response: { candidates?: CandidateLike[] },
  toolsSent: string[],
): GroundingInfo {
  const candidate = response.candidates?.[0];
  const meta = candidate?.groundingMetadata;
  return {
    toolsSent,
    hasGroundingMetadata: meta !== undefined && meta !== null,
    webSearchQueries: meta?.webSearchQueries ?? [],
    groundingChunkCount: meta?.groundingChunks?.length ?? 0,
    hasSearchEntryPoint: Boolean(meta?.searchEntryPoint),
    urlContextUrls: (candidate?.urlContextMetadata?.urlMetadata ?? [])
      .map((u) => u.retrievedUrl ?? '')
      .filter(Boolean),
    finishReason: String(candidate?.finishReason ?? ''),
  };
}

/**
 * Abgerechnet wird pro Suchanfrage, nicht pro Request (§11).
 *
 * `webSearchQueries` ist die verlässliche Quelle. Kommt es leer zurück,
 * obwohl Grounding-Metadaten da sind, wird mit 1 gerechnet statt mit 0 —
 * eine zu niedrige Schätzung wäre schlimmer, weil sie das Tagesbudget (§16)
 * blind machte.
 */
function countSearchQueries(info: GroundingInfo): number {
  if (info.webSearchQueries.length > 0) return info.webSearchQueries.length;
  if (info.hasGroundingMetadata && (info.groundingChunkCount > 0 || info.hasSearchEntryPoint)) return 1;
  return 0;
}

export function createGeminiResearchAdapter(opts: GeminiResearchOptions): ResearchAdapter {
  const { apiKey, model } = opts;
  if (!hasPricing(model)) {
    throw new Error(
      `gemini-research: kein Preis für ${model} in config/pricing.json — ` +
        `costUsd wäre still 0 und das Tagesbudget (§16) wirkungslos.`,
    );
  }
  const client = new GoogleGenAI({ apiKey });

  return {
    id: `gemini-research:${model}`,
    supportsGrounding: true,

    async research<T>(req: ResearchRequest, timeoutMs: number): Promise<LlmResult<T>> {
      const startedAt = performance.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      // Aufruf 1 trägt die Arbeit und bekommt den Löwenanteil der Zeit.
      const searchBudget = Math.max(5_000, Math.floor(timeoutMs * 0.75));

      let usage: LlmUsage = { inputTokens: 0, outputTokens: 0, thinkingTokens: 0, searchQueries: 0 };
      let report = '';

      const addUsage = (meta: Parameters<typeof mapUsage>[0], searchQueries: number): void => {
        const u = mapUsage(meta, searchQueries);
        usage = {
          inputTokens: usage.inputTokens + u.inputTokens,
          outputTokens: usage.outputTokens + u.outputTokens,
          thinkingTokens: (usage.thinkingTokens ?? 0) + (u.thinkingTokens ?? 0),
          cachedInputTokens: (usage.cachedInputTokens ?? 0) + (u.cachedInputTokens ?? 0),
          searchQueries: (usage.searchQueries ?? 0) + (u.searchQueries ?? 0),
        };
      };

      const base = (raw: string): Omit<LlmResult<T>, 'ok' | 'data' | 'error'> => ({
        raw,
        usage,
        costUsd: priceCall(model, usage).totalUsd,
        ms: Math.round(performance.now() - startedAt),
        provider: PROVIDER,
        model,
      });

      try {
        // ---------------------------------------------------------- Aufruf 1
        // Gegroundet, freier Text. KEINE JSON-Ausgabe verlangen — das
        // schaltet das Suchwerkzeug still ab (siehe Dateikopf).
        const withUrlContext = (opts.tools ?? 'search+url') === 'search+url' && req.allowFetch !== false;
        const tools = withUrlContext
          ? [{ googleSearch: {} }, { urlContext: {} }]
          : [{ googleSearch: {} }];
        const toolsSent = withUrlContext ? ['googleSearch', 'urlContext'] : ['googleSearch'];

        const searchTimer = setTimeout(() => controller.abort(), searchBudget);
        let searchResponse;
        try {
          searchResponse = await client.models.generateContent({
            model,
            contents: req.task,
            config: {
              systemInstruction: `${req.system}${REPORT_INSTRUCTION}`,
              tools,
              abortSignal: controller.signal,
            },
          });
        } finally {
          clearTimeout(searchTimer);
        }

        checkUsageConsistency(searchResponse.usageMetadata, model);
        const groundingInfo = collectGroundingInfo(searchResponse, toolsSent);
        report = searchResponse.text ?? '';
        groundingInfo.report = report;
        opts.onGroundingInfo?.(groundingInfo);
        addUsage(searchResponse.usageMetadata, countSearchQueries(groundingInfo));

        const searchFinish = String(searchResponse.candidates?.[0]?.finishReason ?? '');
        const searchBlock = String(searchResponse.promptFeedback?.blockReason ?? '');
        if (searchBlock || REFUSAL_FINISH_REASONS.has(searchFinish)) {
          return {
            ...base(report),
            ok: false,
            data: null,
            error: {
              kind: 'refusal',
              message: `Recherche abgelehnt (finishReason=${searchFinish || '-'}, blockReason=${searchBlock || '-'})`,
            },
          };
        }
        if ((opts.requireGrounding ?? true) && !groundingInfo.hasGroundingMetadata) {
          return {
            ...base(report),
            ok: false,
            data: null,
            error: {
              kind: 'unknown',
              message:
                'Keine Werkzeugspur: das Suchwerkzeug hat nicht gefeuert, die Antwort ' +
                'stammt aus dem Trainingswissen. Verworfen, weil sie unbelegt ist. ' +
                'Prüfen mit `npm run grounding:check`.',
            },
          };
        }
        if (report.trim() === '') {
          return {
            ...base(report),
            ok: false,
            data: null,
            error: { kind: 'unknown', message: `Recherche lieferte keinen Text (finishReason=${searchFinish || '-'})` },
          };
        }

        // ---------------------------------------------------------- Aufruf 2
        // Ohne Werkzeuge, dafür mit Schema. Überträgt nur, was im Bericht steht.
        const structureResponse = await client.models.generateContent({
          model,
          contents: `# Recherchebericht\n\n${report}`,
          config: {
            systemInstruction: STRUCTURE_SYSTEM,
            responseMimeType: 'application/json',
            responseJsonSchema: toGeminiJsonSchema(req.schema),
            temperature: 0,
            abortSignal: controller.signal,
          },
        });

        addUsage(structureResponse.usageMetadata, 0);
        const json = structureResponse.text ?? '';
        // raw trägt beide Schritte — ohne den Bericht wäre ein Fehlschlag
        // nicht nachvollziehbar (§11: "raw immer mitschreiben").
        const raw = `${report}\n\n----- STRUKTURIERT -----\n${json}`;

        if (json.trim() === '') {
          return {
            ...base(raw),
            ok: false,
            data: null,
            error: { kind: 'schema', message: 'Strukturierungsschritt lieferte keinen Text.' },
          };
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(json);
        } catch (parseErr) {
          return {
            ...base(raw),
            ok: false,
            data: null,
            error: { kind: 'schema', message: `Strukturierung ist kein JSON: ${(parseErr as Error).message}` },
          };
        }

        const validation = validateAgainst<T>(req.schema, parsed);
        if (!validation.valid) {
          return {
            ...base(raw),
            ok: false,
            data: null,
            error: { kind: 'schema', message: `Schemaverletzung: ${validation.errors.join('; ')}` },
          };
        }

        return { ...base(raw), ok: true, data: validation.data };
      } catch (err) {
        return { ...base(report), ok: false, data: null, error: classifyError(err) };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
