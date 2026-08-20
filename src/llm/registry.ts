/**
 * Stufen-Registry (§11).
 *
 * Stufe -> Anbieter/Modell kommt aus .env im Format `provider:model`.
 * Unbekannter Anbieter oder fehlender Adapter => Startfehler, kein stiller
 * Fallback. Ein stiller Fallback hieße: die Personenrecherche läuft
 * unbemerkt auf Flash-Lite und ich wundere mich über erfundene Hooks.
 */
import { requireGeminiApiKey } from '../config/env.ts';
import { hasPricing, knownModels } from './pricing.ts';
import type { GenerateAdapter, ResearchAdapter } from './types.ts';
import { createGeminiGenerateAdapter } from './providers/gemini-generate.ts';
import { createGeminiResearchAdapter, type GeminiResearchOptions } from './providers/gemini-research.ts';

export type Capability = 'generate' | 'research';

export type StageName =
  | 'extract'
  | 'gate'
  | 'draft'
  | 'draft_privat'
  | 'research_firma'
  | 'research_person';

export const STAGES: readonly StageName[] = [
  'extract',
  'gate',
  'draft',
  'draft_privat',
  'research_firma',
  'research_person',
];

const STAGE_ENV_KEY: Record<StageName, string> = {
  extract: 'STAGE_EXTRACT',
  gate: 'STAGE_GATE',
  draft: 'STAGE_DRAFT',
  draft_privat: 'STAGE_DRAFT_PRIVAT',
  research_firma: 'STAGE_RESEARCH_FIRMA',
  research_person: 'STAGE_RESEARCH_PERSON',
};

const STAGE_CAPABILITY: Record<StageName, Capability> = {
  extract: 'generate',
  gate: 'generate',
  draft: 'generate',
  draft_privat: 'generate',
  research_firma: 'research',
  research_person: 'research',
};

/**
 * Timeouts je Stufe. Überschreibbar per .env, z. B.
 * `STAGE_TIMEOUT_RESEARCH_FIRMA=120000`.
 *
 * ABWEICHUNG VON §8: Dort bekommt Flow B 25 s und die Firmenrecherche 20 s.
 * Das ist zu knapp und aus dem falschen Motiv abgeleitet.
 *
 * Der Portal-Wettlauf rechtfertigt Eile beim *Senden*, nicht beim
 * Recherchieren. Die Firmenrecherche läuft **einmal pro Firma, für immer** —
 * ihr Ergebnis liegt danach im Cache und bedient jedes weitere Inserat
 * derselben Firma in Flow A. Eine falsche oder fehlende Adresse kostet den
 * ganzen Kanal: dann bleibt das Portalformular, wo ich Platz 200 bin. Und
 * selbst zwei Minuten bis zur Direktmail schlagen das Formular haushoch.
 *
 * §8 argumentiert für Flow C übrigens selbst so: "Budget in Minuten, nicht
 * Sekunden. Nicht auf 20 s herunteroptimieren — dabei ginge genau die
 * Qualität verloren, die den Zweig lohnend macht."
 *
 * Zur Einordnung: ein gegroundeter Lauf mit 5 Suchanfragen brauchte 10,7 s.
 * Das Budget ist keine Zielvorgabe, sondern eine Obergrenze — mehr Zeit
 * nutzt das Modell nur, wenn der Prompt Gründlichkeit verlangt.
 */
const DEFAULT_STAGE_TIMEOUT_MS: Record<StageName, number> = {
  extract: 8_000,
  gate: 8_000,
  draft: 10_000,
  draft_privat: 45_000,
  research_firma: 90_000,
  research_person: 180_000,
};

const TIMEOUT_ENV_KEY: Record<StageName, string> = {
  extract: 'STAGE_TIMEOUT_EXTRACT',
  gate: 'STAGE_TIMEOUT_GATE',
  draft: 'STAGE_TIMEOUT_DRAFT',
  draft_privat: 'STAGE_TIMEOUT_DRAFT_PRIVAT',
  research_firma: 'STAGE_TIMEOUT_RESEARCH_FIRMA',
  research_person: 'STAGE_TIMEOUT_RESEARCH_PERSON',
};

export function stageTimeoutMs(stage: StageName, source: NodeJS.ProcessEnv = process.env): number {
  const raw = source[TIMEOUT_ENV_KEY[stage]];
  if (raw === undefined || raw.trim() === '') return DEFAULT_STAGE_TIMEOUT_MS[stage];
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1000) {
    throw new Error(`${TIMEOUT_ENV_KEY[stage]}=${JSON.stringify(raw)}: erwartet Millisekunden >= 1000.`);
  }
  return parsed;
}

export const STAGE_TIMEOUT_MS: Record<StageName, number> = DEFAULT_STAGE_TIMEOUT_MS;

type GenerateFactory = (model: string) => GenerateAdapter;
type ResearchFactory = (model: string) => ResearchAdapter;

const GENERATE_FACTORIES: Record<string, GenerateFactory> = {
  gemini: (model) => createGeminiGenerateAdapter({ apiKey: requireGeminiApiKey(), model }),
};

// Phase >= 10 ggf. claude-code-research, falls die Eval es verlangt (§11).
const RESEARCH_FACTORIES: Record<string, ResearchFactory> = {
  gemini: (model) =>
    createGeminiResearchAdapter({ apiKey: requireGeminiApiKey(), model, ...researchOverrides }),
};

/**
 * Nur für Diagnose-Skripte: Werkzeugauswahl und Grounding-Callback setzen,
 * bevor die Registry den Adapter baut. Die Pipeline fasst das nicht an.
 */
let researchOverrides: Partial<GeminiResearchOptions> = {};
export function setResearchOverrides(overrides: Partial<GeminiResearchOptions>): void {
  researchOverrides = overrides;
}

const KNOWN_PROVIDERS = new Set([
  ...Object.keys(GENERATE_FACTORIES),
  ...Object.keys(RESEARCH_FACTORIES),
  'anthropic',
  'claude-code',
]);

export interface StageBinding {
  stage: StageName;
  capability: Capability;
  provider: string;
  model: string;
  timeoutMs: number;
}

export function parseStageSpec(stage: StageName, spec: string): StageBinding {
  const envKey = STAGE_ENV_KEY[stage];
  const trimmed = spec.trim();
  const sep = trimmed.indexOf(':');
  if (sep <= 0 || sep === trimmed.length - 1) {
    throw new Error(`${envKey}=${JSON.stringify(spec)}: erwartet Format "provider:model".`);
  }
  const provider = trimmed.slice(0, sep).trim();
  const model = trimmed.slice(sep + 1).trim();
  if (!KNOWN_PROVIDERS.has(provider)) {
    throw new Error(
      `${envKey}: unbekannter Anbieter ${JSON.stringify(provider)}. ` +
        `Bekannt: ${[...KNOWN_PROVIDERS].sort().join(', ')}`,
    );
  }
  return {
    stage,
    capability: STAGE_CAPABILITY[stage],
    provider,
    model,
    timeoutMs: stageTimeoutMs(stage),
  };
}

export interface Registry {
  bindings: Record<StageName, StageBinding>;
  generate(stage: StageName): GenerateAdapter;
  research(stage: StageName): ResearchAdapter;
}

export interface LoadRegistryOptions {
  env?: NodeJS.ProcessEnv;
  /**
   * Nur die Stufen prüfen/binden, die jetzt schon gebraucht werden. In
   * Phase 1 existiert noch kein research-Adapter; ohne diese Einschränkung
   * würde jeder Start daran scheitern.
   */
  stages?: readonly StageName[];
  /** Adapter sofort bauen statt beim ersten Zugriff. Deckt fehlende Keys früh auf. */
  eager?: boolean;
}

export function loadRegistry(opts: LoadRegistryOptions = {}): Registry {
  const source = opts.env ?? process.env;
  const stages = opts.stages ?? STAGES;
  const bindings = {} as Record<StageName, StageBinding>;
  const problems: string[] = [];

  for (const stage of stages) {
    const envKey = STAGE_ENV_KEY[stage];
    const spec = source[envKey];
    if (spec === undefined || spec.trim() === '') {
      problems.push(`${envKey} fehlt in .env (Vorlage: .env.example).`);
      continue;
    }
    let binding: StageBinding;
    try {
      binding = parseStageSpec(stage, spec);
    } catch (err) {
      problems.push((err as Error).message);
      continue;
    }

    const factories = binding.capability === 'generate' ? GENERATE_FACTORIES : RESEARCH_FACTORIES;
    if (!(binding.provider in factories)) {
      problems.push(
        `${envKey}: für Anbieter "${binding.provider}" existiert kein ` +
          `${binding.capability}-Adapter. Vorhanden: ` +
          `${Object.keys(factories).join(', ') || '(keiner)'}`,
      );
      continue;
    }
    if (!hasPricing(binding.model)) {
      problems.push(
        `${envKey}: Modell "${binding.model}" steht nicht in config/pricing.json — ` +
          `costUsd bliebe 0. Bekannt: ${knownModels().join(', ')}`,
      );
      continue;
    }
    bindings[stage] = binding;
  }

  if (problems.length > 0) {
    throw new Error(`Modell-Registry ungültig:\n  - ${problems.join('\n  - ')}`);
  }

  const cache = new Map<StageName, GenerateAdapter | ResearchAdapter>();

  function build(stage: StageName): GenerateAdapter | ResearchAdapter {
    let adapter = cache.get(stage);
    if (!adapter) {
      const binding = bindings[stage];
      adapter =
        binding.capability === 'generate'
          ? GENERATE_FACTORIES[binding.provider]!(binding.model)
          : RESEARCH_FACTORIES[binding.provider]!(binding.model);
      cache.set(stage, adapter);
    }
    return adapter;
  }

  const registry: Registry = {
    bindings,
    generate(stage) {
      if (STAGE_CAPABILITY[stage] !== 'generate') {
        throw new Error(`Stufe ${stage} ist keine generate-Stufe.`);
      }
      return build(stage) as GenerateAdapter;
    },
    research(stage) {
      if (STAGE_CAPABILITY[stage] !== 'research') {
        throw new Error(`Stufe ${stage} ist keine research-Stufe.`);
      }
      return build(stage) as ResearchAdapter;
    },
  };

  if (opts.eager) for (const stage of stages) build(stage);
  return registry;
}

/**
 * Stufen mit vorhandenem Adapter.
 *
 * PHASE1_STAGES bleibt als Name bestehen, weil Skripte darauf verweisen; seit
 * Phase 4 sind auch die research-Stufen gebunden.
 */
export const PHASE1_STAGES: readonly StageName[] = ['extract', 'gate', 'draft', 'draft_privat'];

export const AVAILABLE_STAGES: readonly StageName[] = STAGES;
