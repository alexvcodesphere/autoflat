/**
 * Namensnormalisierung (§6).
 *
 * Genau eine Funktion, überall dieselbe: `verwaltung.name_canonical`,
 * `seed_company.name_canonical` und jeder Cache-Lookup gehen hier durch.
 * Wenn diese Funktion zwei Schreibweisen unterschiedlich abbildet, entsteht
 * eine Karteileiche im Firmen-Cache — deshalb die Tests in test/normalize.test.ts.
 */

/** Rechtsformen. Nach dem Zerlegen in Tokens, also ohne Punkte. */
export const LEGAL_FORM_TOKENS: ReadonlySet<string> = new Set([
  'gmbh', 'mbh', 'ug', 'ag', 'se', 'kg', 'kgaa', 'ohg', 'gbr', 'gmbhco',
  'eg', 'ev', 'ek', 'kd', 'partg', 'mbb', 'llp', 'ltd', 'inc',
  'co', 'cie', 'compagnie',
  'haftungsbeschraenkt', 'gemeinnuetzige', 'gemeinnuetzig',
]);

/**
 * Branchenwörter. Die trennen keine zwei Firmen voneinander — fast jede
 * Verwaltung heißt "… Hausverwaltung" oder "… Immobilien".
 */
export const INDUSTRY_TOKENS: ReadonlySet<string> = new Set([
  'hausverwaltung', 'hausverwaltungen',
  'immobilien', 'immobilie', 'immobilienverwaltung', 'immobilienverwaltungen',
  'verwaltung', 'verwaltungen', 'verwaltungs',
  'grundstuecksverwaltung', 'grundstuecksverwaltungen',
  'wohnungsverwaltung', 'wohnungsverwaltungen',
]);

const UMLAUTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/ä/g, 'ae'],
  [/ö/g, 'oe'],
  [/ü/g, 'ue'],
  [/ß/g, 'ss'],
];

/** Tokenfolgen, die zusammen eine Rechtsform bilden ("e.K." -> ["e","k"]). */
const LEGAL_FORM_SEQUENCES: ReadonlyArray<readonly string[]> = [
  ['e', 'k'],
  ['e', 'kfm'],
  ['e', 'kfr'],
  ['g', 'mbh'],
];

function stripSequences(tokens: string[]): string[] {
  const out: string[] = [];
  outer: for (let i = 0; i < tokens.length; i++) {
    for (const seq of LEGAL_FORM_SEQUENCES) {
      if (seq.every((part, k) => tokens[i + k] === part)) {
        i += seq.length - 1;
        continue outer;
      }
    }
    out.push(tokens[i]!);
  }
  return out;
}

/** Führende/abschließende und doppelte "und" nach dem Filtern aufräumen. */
function tidyConjunctions(tokens: string[]): string[] {
  const out: string[] = [];
  for (const token of tokens) {
    if (token === 'und' && (out.length === 0 || out[out.length - 1] === 'und')) continue;
    out.push(token);
  }
  while (out.length > 0 && out[out.length - 1] === 'und') out.pop();
  return out;
}

/**
 * Firmenname -> kanonischer Cache-Schlüssel.
 *
 * "Meyer & Co. Hausverwaltung GmbH" -> "meyer und"? Nein: "co" und
 * "hausverwaltung" und "gmbh" fallen raus, das dangling "und" ebenfalls
 * -> "meyer".
 *
 * Wichtig: das Ergebnis ist nie leer, solange der Input nicht leer ist.
 * "Hausverwaltung GmbH" bestünde nur aus Rausch-Tokens; würde das zu ""
 * normalisieren, kollabierten alle solchen Firmen auf eine Cache-Zeile.
 * Deshalb die gestufte Rückfallebene unten.
 */
export function normalizeCompanyName(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return '';

  let s = raw.normalize('NFC').toLowerCase();
  for (const [pattern, replacement] of UMLAUTS) s = s.replace(pattern, replacement);
  // Verbleibende Diakritika (é, ç, ...) auflösen.
  s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  s = s.replace(/&/g, ' und ');
  // Alles außer a-z0-9 wird Trenner. Erledigt auch Punkte, Bindestriche, Slashes.
  s = s.replace(/[^a-z0-9]+/g, ' ');

  const tokens = stripSequences(s.split(' ').filter(Boolean));
  if (tokens.length === 0) return '';

  const withoutLegal = tokens.filter((t) => !LEGAL_FORM_TOKENS.has(t));
  const withoutIndustry = withoutLegal.filter((t) => !INDUSTRY_TOKENS.has(t));

  // Gestufte Rückfallebene: erst so scharf wie möglich, dann weicher, damit
  // nie ein leerer Schlüssel entsteht.
  for (const candidate of [withoutIndustry, withoutLegal, tokens]) {
    const tidied = tidyConjunctions(candidate);
    if (tidied.length > 0) return tidied.join(' ');
  }
  return '';
}

/**
 * Kandidat für den LIKE-Lookup gegen `name_variants` (§6). Reduziert weiter
 * auf reine Buchstabenfolge — fängt "Meyer&Co" vs "Meyer & Co" ab.
 */
export function normalizeLoose(raw: string | null | undefined): string {
  return normalizeCompanyName(raw).replace(/[^a-z0-9]/g, '');
}
