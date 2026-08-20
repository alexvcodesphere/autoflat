/**
 * Klassifikation (§7).
 *
 * §7 warnt ausdrücklich: "Baue keinen Regex-Klassifikator." Rechtsform-Regex
 * trennt Firma von Person, aber **nicht Makler von Verwaltung** — und genau
 * darauf kommt es an, weil die beiden Anschreiben gegensätzlich sind.
 *
 * Hier stehen deshalb nur die Signale, die tatsächlich hart sind: ein
 * Cache-Eintrag, eine Portal-Kennzeichnung, eine Liste namentlich bekannter
 * Gesellschaften. Alles Urteilhafte macht das Gate.
 */
import type { Payload } from '../stages/extract.ts';
import type { Verwaltung } from '../db/verwaltung.ts';
import { normalizeCompanyName } from './normalize.ts';

export type Branch = 'T_VERWALTUNG' | 'T_MAKLER' | 'T_NACHMIETER' | 'T_PRIVAT' | 'T0';
export type BranchConfidence = 'high' | 'medium' | 'low';

/**
 * §9: "T0 ist kein Versandzweig." T0 erzeugt Text für ein Portalformular,
 * nicht für eine E-Mail — es gibt keinen Empfänger. Ein T0 mit gesetztem
 * recipient ist ein Bug.
 */
export const SEND_BRANCHES: ReadonlySet<Branch> = new Set<Branch>([
  'T_VERWALTUNG', 'T_MAKLER', 'T_NACHMIETER', 'T_PRIVAT',
]);

export function isSendBranch(branch: Branch): boolean {
  return SEND_BRANCHES.has(branch);
}

/**
 * Kommunale Wohnungsbaugesellschaften (§7 Stufe 1).
 *
 * Die haben Pflichtformulare ohne Freitextfeld, teils WBS-Prüfung — es gibt
 * nichts zu formulieren (§8 Flow E). Kanonisiert, damit Schreibweisen wie
 * "HOWOGE Wohnungsbaugesellschaft mbH" treffen.
 */
export const GESELLSCHAFTEN: readonly string[] = [
  'Howoge', 'Gewobag', 'Degewo', 'WBM', 'Gesobau', 'Berlinovo',
  'Stadt und Land', 'Wohnungsbaugesellschaft Berlin-Mitte',
];

const GESELLSCHAFT_KEYS: readonly string[] = GESELLSCHAFTEN
  .map((n) => normalizeCompanyName(n))
  .filter(Boolean);

/**
 * Wortweise enthalten, nicht als Teilzeichenkette.
 *
 * "Howoge Wohnungsbaugesellschaft mbH" normalisiert zu
 * "howoge wohnungsbaugesellschaft" — ein exakter Vergleich gegen "howoge"
 * greift also nicht. Eine reine `includes`-Prüfung wiederum würde "wbm" in
 * "schwbmeier" finden.
 */
function containsWords(haystack: string, needle: string): boolean {
  if (haystack === needle) return true;
  const words = haystack.split(' ');
  const parts = needle.split(' ');
  for (let i = 0; i + parts.length <= words.length; i++) {
    if (parts.every((part, k) => words[i + k] === part)) return true;
  }
  return false;
}

export function isGesellschaft(nameRaw: string): boolean {
  const key = normalizeCompanyName(nameRaw);
  return key !== '' && GESELLSCHAFT_KEYS.some((k) => containsWords(key, k));
}

/** Genossenschaft: Mitgliedschaft mit Geschäftsanteilen im Voraus (§8 Flow E). */
const GENOSSENSCHAFT_RE = /\b(eG|e\.\s?G\.|Genossenschaft|Baugenossenschaft|Wohnungsgenossenschaft)\b/i;

export interface HardSignalInput {
  payload: Payload;
  source: string;
  /** Cache-Eintrag zur Firma, falls vorhanden. */
  cached?: Verwaltung | null;
}

export interface HardSignal {
  branch: Branch;
  confidence: BranchConfidence;
  reason: string;
  /**
   * true = die Klassifikation ist damit erledigt, das Gate-Urteil zum Zweig
   * wird verworfen. false = starkes Indiz, das Gate darf widersprechen.
   */
  decisive: boolean;
  /** Zusatzhinweis für die UI, etwa die Registrierungs-Checkliste bei Flow E. */
  note?: string;
}

const FIRM_TYPE_TO_BRANCH: Readonly<Record<string, Branch>> = {
  verwaltung: 'T_VERWALTUNG',
  makler: 'T_MAKLER',
  gesellschaft: 'T0',
  genossenschaft: 'T0',
  privat: 'T_PRIVAT',
};

/**
 * §7 Stufe 1. Gibt null zurück, wenn kein hartes Signal greift — dann
 * entscheidet allein das Gate.
 */
export function hardSignal(input: HardSignalInput): HardSignal | null {
  const { payload, source, cached } = input;
  const nameRaw = payload.provider.name_raw;

  // Reihenfolge ist Absicht: portal_only schlägt alles, denn §15 sagt
  // "portal_only respektieren, ausnahmslos".
  if (cached?.portal_only) {
    return {
      branch: 'T0',
      confidence: 'high',
      reason: `${cached.name_canonical} ist im Cache als portal_only markiert`,
      decisive: true,
    };
  }

  if (cached && cached.firm_type !== 'unknown') {
    const branch = FIRM_TYPE_TO_BRANCH[cached.firm_type];
    if (branch) {
      return {
        branch,
        confidence: 'high',
        reason: `Cache: ${cached.name_canonical} ist ${cached.firm_type}`,
        decisive: true,
        ...(branch === 'T0'
          ? { note: 'Registrierung und Unterlagen laufen außerhalb des Systems (§8 Flow E).' }
          : {}),
      };
    }
  }

  if (nameRaw) {
    if (isGesellschaft(nameRaw)) {
      return {
        branch: 'T0',
        confidence: 'high',
        reason: `${nameRaw} ist eine kommunale Wohnungsbaugesellschaft`,
        decisive: true,
        note: 'Pflichtformular ohne Freitextfeld, teils WBS-Prüfung. Rechtzeitig registrieren (§8 Flow E).',
      };
    }
    if (GENOSSENSCHAFT_RE.test(nameRaw)) {
      return {
        branch: 'T0',
        confidence: 'high',
        reason: `${nameRaw} ist eine Genossenschaft`,
        decisive: true,
        note: 'Mitgliedschaft mit Geschäftsanteilen im Voraus nötig (§8 Flow E).',
      };
    }
  }

  // Ab hier: starke Indizien, aber das Gate darf widersprechen. Ein Portal
  // kennzeichnet Privatanbieter zuverlässig — es kann aber der Mieter sein,
  // der einen Nachmieter sucht, und das ist ein anderer Zweig.
  if (payload.provider.platform_private_flag === true) {
    return {
      branch: 'T_PRIVAT',
      confidence: 'medium',
      reason: 'Portal kennzeichnet den Anbieter als privat',
      decisive: false,
    };
  }

  if (source === 'wg_gesucht') {
    return {
      branch: 'T_NACHMIETER',
      confidence: 'medium',
      reason: 'Quelle wg-gesucht.de',
      decisive: false,
    };
  }

  if (!nameRaw) {
    return {
      branch: 'T0',
      confidence: 'high',
      reason: 'Kein Anbietername im Inserat — kein Cache-Lookup, kein Empfänger',
      decisive: true,
    };
  }

  return null;
}
