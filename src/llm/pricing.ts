/**
 * Kostenrechnung (§11). Preise kommen aus config/pricing.json, nie aus dem
 * Adaptercode.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { LlmUsage } from './types.ts';

const PRICING_PATH = resolve(import.meta.dirname, '../../config/pricing.json');

interface Tier {
  upToInputTokens: number | null;
  inputPerM: number;
  outputPerM: number;
}
interface Period {
  from: string;
  until: string | null;
  provisional?: boolean;
  note?: string;
  tiers: Tier[];
}
interface ModelPricing {
  provider: string;
  groundingGroup?: string;
  periods: Period[];
}
interface GroundingGroup {
  freeQueries: number;
  freePeriod: 'day' | 'month';
  usdPer1000Queries: number;
}
interface PricingFile {
  currency: string;
  verifiedAt: string;
  groundingGroups: Record<string, GroundingGroup>;
  models: Record<string, ModelPricing>;
}

let cache: PricingFile | null = null;

export function loadPricing(): PricingFile {
  cache ??= JSON.parse(readFileSync(PRICING_PATH, 'utf8')) as PricingFile;
  return cache;
}

export function knownModels(): string[] {
  return Object.keys(loadPricing().models).sort();
}

export function hasPricing(model: string): boolean {
  return model in loadPricing().models;
}

export interface CostBreakdown {
  model: string;
  inputUsd: number;
  outputUsd: number;
  groundingUsd: number;
  totalUsd: number;
  /** Effektiv angewandte Sätze — macht die Zahl in der UI nachvollziehbar. */
  inputPerM: number;
  outputPerM: number;
  /** Abgerechnete Output-Tokens inkl. thinking. */
  billedOutputTokens: number;
  provisional: boolean;
}

export interface PriceOptions {
  /** Zeitpunkt für die Periodenwahl. Default: jetzt. */
  at?: Date;
  /**
   * Grounding-Suchen abrechnen? Default true (konservativ). Das monatliche
   * Freikontingent (§11) braucht einen Zähler in der DB — Phase 4.
   */
  groundingBillable?: boolean;
}

function pickPeriod(periods: Period[], at: Date): Period {
  const day = at.toISOString().slice(0, 10);
  const hit = periods.find((p) => p.from <= day && (p.until === null || day <= p.until));
  if (hit) return hit;
  const last = periods[periods.length - 1];
  if (!last) throw new Error('pricing.json: Modell ohne periods');
  return last;
}

function pickTier(tiers: Tier[], inputTokens: number): Tier {
  const hit = tiers.find((t) => t.upToInputTokens === null || inputTokens <= t.upToInputTokens);
  const tier = hit ?? tiers[tiers.length - 1];
  if (!tier) throw new Error('pricing.json: Periode ohne tiers');
  return tier;
}

/**
 * Rechnet eine Nutzung in USD um.
 *
 * Thinking-Tokens werden zum Output-Satz abgerechnet und sind in Geminis
 * `candidatesTokenCount` NICHT enthalten — deshalb hier addiert, nicht
 * ersetzt.
 */
export function priceCall(model: string, usage: LlmUsage, opts: PriceOptions = {}): CostBreakdown {
  const pricing = loadPricing();
  const entry = pricing.models[model];
  if (!entry) {
    throw new Error(
      `Kein Preis für Modell ${JSON.stringify(model)} in config/pricing.json. ` +
        `Bekannt: ${knownModels().join(', ')}`,
    );
  }

  const period = pickPeriod(entry.periods, opts.at ?? new Date());
  const tier = pickTier(period.tiers, usage.inputTokens);

  const billedOutputTokens = usage.outputTokens + (usage.thinkingTokens ?? 0);
  const inputUsd = (usage.inputTokens / 1_000_000) * tier.inputPerM;
  const outputUsd = (billedOutputTokens / 1_000_000) * tier.outputPerM;

  let groundingUsd = 0;
  const queries = usage.searchQueries ?? 0;
  if (queries > 0 && (opts.groundingBillable ?? true)) {
    const group = entry.groundingGroup ? pricing.groundingGroups[entry.groundingGroup] : undefined;
    if (group) groundingUsd = (queries / 1000) * group.usdPer1000Queries;
  }

  return {
    model,
    inputUsd,
    outputUsd,
    groundingUsd,
    totalUsd: inputUsd + outputUsd + groundingUsd,
    inputPerM: tier.inputPerM,
    outputPerM: tier.outputPerM,
    billedOutputTokens,
    provisional: period.provisional === true,
  };
}
