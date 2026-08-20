/**
 * Liest prompts/profil.md (§16). Geht nie an ein Modell.
 */
import { readFileSync } from 'node:fs';
import { fromRoot } from './paths.ts';

const PROFILE_PATH = fromRoot('prompts', 'profil.md');

export interface ProfileLink {
  label: string;
  url: string;
}

export interface Profile {
  status: 'beispiel' | 'echt';
  name: string;
  adresse: string;
  telefon: string;
  email: string;
  beruf: string;
  /** Optional — wird weggelassen, wenn leer. */
  arbeitgeber: string | null;
  anstellung: string;
  nettoeinkommenEur: number;
  nebeneinkommenEur: number;
  nebeneinkommenArt: string | null;
  schufa: string;
  familienstand: string | null;
  haushalt: string;
  nichtraucher: boolean;
  haustiere: string;
  einzugAb: string;
  wbs: boolean;
  /** Erklärt eine auswärtige Absenderadresse. Optional. */
  hinweisAdresse: string | null;
  besichtigung: string;
  unterlagen: string[];
  links: ProfileLink[];
}

/** Ohne diese Angaben ist keine Mail sinnvoll. */
const REQUIRED = [
  'name', 'adresse', 'telefon', 'email', 'beruf', 'anstellung',
  'nettoeinkommen_eur', 'schufa', 'haushalt', 'nichtraucher', 'haustiere',
  'einzug_ab', 'wbs', 'unterlagen', 'besichtigung',
] as const;

interface ParsedLines {
  single: Record<string, string>;
  repeated: Record<string, string[]>;
}

function parseLines(text: string): ParsedLines {
  const single: Record<string, string> = {};
  const repeated: Record<string, string[]> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('<!--')) continue;
    const match = /^([a-z_]+):\s*(.*)$/.exec(trimmed);
    if (!match) continue;
    const [, key, value] = match as unknown as [string, string, string];
    (repeated[key] ??= []).push(value.trim());
    single[key] = value.trim();
  }
  return { single, repeated };
}

export function parseProfileText(text: string): Profile {
  const { single: raw, repeated } = parseLines(text);

  const missing = REQUIRED.filter((k) => !raw[k]);
  const placeholders = REQUIRED.filter((k) => /^TODO/i.test(raw[k] ?? ''));
  if (missing.length > 0 || placeholders.length > 0) {
    throw new Error(
      `prompts/profil.md unvollständig.` +
        (missing.length ? `\n  fehlt: ${missing.join(', ')}` : '') +
        (placeholders.length ? `\n  noch TODO: ${placeholders.join(', ')}` : ''),
    );
  }

  const euro = (key: string, fallback = 0): number => {
    const value = raw[key];
    if (value === undefined || value === '') return fallback;
    const n = Number(value.replace(/[^\d]/g, ''));
    if (!Number.isFinite(n)) throw new Error(`prompts/profil.md: ${key} ist keine Zahl: ${value}`);
    return n;
  };

  const income = euro('nettoeinkommen_eur');
  if (income <= 0) throw new Error('prompts/profil.md: nettoeinkommen_eur fehlt oder ist 0');

  const einzug = raw['einzug_ab']!;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(einzug)) {
    throw new Error(`prompts/profil.md: einzug_ab muss YYYY-MM-DD sein, ist "${einzug}"`);
  }

  const yes = (v: string) => /^(ja|yes|true|1)$/i.test(v.trim());
  const optional = (key: string): string | null => (raw[key] ? raw[key]! : null);

  const links: ProfileLink[] = (repeated['link'] ?? [])
    .map((entry) => {
      const [label, url] = entry.split('|').map((s) => s.trim());
      return label && url ? { label, url } : null;
    })
    .filter((l): l is ProfileLink => l !== null);

  return {
    status: raw['profil_status'] === 'echt' ? 'echt' : 'beispiel',
    name: raw['name']!,
    adresse: raw['adresse']!,
    telefon: raw['telefon']!,
    email: raw['email']!,
    beruf: raw['beruf']!,
    arbeitgeber: optional('arbeitgeber'),
    anstellung: raw['anstellung']!,
    nettoeinkommenEur: income,
    nebeneinkommenEur: euro('nebeneinkommen_eur'),
    nebeneinkommenArt: optional('nebeneinkommen_art'),
    schufa: raw['schufa']!,
    familienstand: optional('familienstand'),
    haushalt: raw['haushalt']!,
    nichtraucher: yes(raw['nichtraucher']!),
    haustiere: raw['haustiere']!,
    einzugAb: einzug,
    wbs: yes(raw['wbs']!),
    hinweisAdresse: optional('hinweis_adresse'),
    besichtigung: raw['besichtigung']!,
    unterlagen: raw['unterlagen']!.split(',').map((s) => s.trim()).filter(Boolean),
    links,
  };
}

let cached: Profile | null = null;
export function loadProfile(path: string = PROFILE_PATH): Profile {
  if (path === PROFILE_PATH && cached) return cached;
  const profile = parseProfileText(readFileSync(path, 'utf8'));
  if (path === PROFILE_PATH) cached = profile;
  return profile;
}
