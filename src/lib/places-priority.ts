/**
 * Priorisierung der Places-Treffer (§17).
 *
 * Steht bewusst als eigenes Modul da und nicht im Skript: Das Kriterium hat
 * beim ersten echten Lauf nicht getragen und musste geändert werden — solche
 * Logik gehört unter Test.
 *
 * §17 schlägt für Priorität 2 vor: "Website vorhanden und rating_count über
 * Median". Gemessen am 2026-08-20 über 1.185 Berliner Firmen lag der Median
 * bei 12 Bewertungen, wodurch 557 Firmen in P2 fielen — 38 Batches statt der
 * in §17 selbst genannten ~18.
 *
 * Ein Median beschreibt die Verteilung, nicht die verfügbare Zeit. Deshalb
 * wird an einer Zielgröße geschnitten: die N bestbewerteten Firmen mit
 * Website kommen nach P2. Damit steuert die Konfiguration direkt, wie viele
 * Abende das Vorwärmen dauert.
 *
 * Warum die Bewertungszahl: Sie ist der beste verfügbare Näherungswert für
 * Portfoliogröße. Viele Google-Bewertungen bei einer Hausverwaltung heißt
 * viele Mieter, heißt viele Inserate — und genau die Firmen sollen im Cache
 * liegen, bevor das erste Inserat kommt.
 */

export interface PrioritizableCompany {
  canonical: string;
  website: string | null;
  ratingCount: number;
}

export interface PriorityAssignment<T> {
  /** 2 = Website + Zielgruppe, 3 = Website, 4 = keine Website. */
  priorityOf: (company: T) => number;
  counts: Record<number, number>;
  /** Ab wie vielen Bewertungen P2 beginnt. 0, wenn alle hineinpassen. */
  p2Cut: number;
  median: number;
  max: number;
  batchesP2: number;
  batchesP2P3: number;
}

export const BATCH_SIZE = 15;

export function assignPriorities<T extends PrioritizableCompany>(
  companies: readonly T[],
  p2Target: number,
): PriorityAssignment<T> {
  const withSite = companies
    .filter((c) => c.website)
    .slice()
    .sort((a, b) => b.ratingCount - a.ratingCount);

  const inTarget = new Set(withSite.slice(0, p2Target).map((c) => c.canonical));
  const p2Cut = withSite.length > p2Target ? (withSite[p2Target - 1]?.ratingCount ?? 0) : 0;

  const priorityOf = (company: T): number => {
    if (!company.website) return 4;
    return inTarget.has(company.canonical) ? 2 : 3;
  };

  const counts: Record<number, number> = { 2: 0, 3: 0, 4: 0 };
  for (const c of companies) counts[priorityOf(c)] = (counts[priorityOf(c)] ?? 0) + 1;

  const ratings = companies.map((c) => c.ratingCount).sort((a, b) => a - b);

  return {
    priorityOf,
    counts,
    p2Cut,
    median: ratings.length > 0 ? (ratings[Math.floor(ratings.length / 2)] ?? 0) : 0,
    max: ratings.length > 0 ? (ratings[ratings.length - 1] ?? 0) : 0,
    batchesP2: Math.ceil((counts[2] ?? 0) / BATCH_SIZE),
    batchesP2P3: Math.ceil(((counts[2] ?? 0) + (counts[3] ?? 0)) / BATCH_SIZE),
  };
}
