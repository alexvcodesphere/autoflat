/**
 * Liest prompts/profil.md (§16). Geht nie an ein Modell.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PROFILE_PATH = resolve(import.meta.dirname, '../../prompts/profil.md');

export interface Profile {
  status: 'beispiel' | 'echt';
  name: string;
  adresse: string;
  telefon: string;
  email: string;
  beruf: string;
  arbeitgeber: string;
  anstellung: string;
  nettoeinkommenEur: number;
  schufa: string;
  haushalt: string;
  nichtraucher: boolean;
  haustiere: string;
  einzugAb: string;
  wbs: boolean;
  unterlagen: string[];
}

const REQUIRED = [
  'name', 'adresse', 'telefon', 'email', 'beruf', 'arbeitgeber', 'anstellung',
  'nettoeinkommen_eur', 'schufa', 'haushalt', 'nichtraucher', 'haustiere',
  'einzug_ab', 'wbs', 'unterlagen',
] as const;

export function parseProfileText(text: string): Profile {
  const raw: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('<!--')) continue;
    const match = /^([a-z_]+):\s*(.*)$/.exec(trimmed);
    if (match) raw[match[1]!] = match[2]!.trim();
  }

  const missing = REQUIRED.filter((k) => !raw[k]);
  const placeholders = REQUIRED.filter((k) => /^TODO/i.test(raw[k] ?? ''));
  if (missing.length > 0 || placeholders.length > 0) {
    throw new Error(
      `prompts/profil.md unvollständig.` +
        (missing.length ? `\n  fehlt: ${missing.join(', ')}` : '') +
        (placeholders.length ? `\n  noch TODO: ${placeholders.join(', ')}` : ''),
    );
  }

  const income = Number(raw['nettoeinkommen_eur']!.replace(/[^\d]/g, ''));
  if (!Number.isFinite(income) || income <= 0) {
    throw new Error(`prompts/profil.md: nettoeinkommen_eur ist keine Zahl: ${raw['nettoeinkommen_eur']}`);
  }
  const einzug = raw['einzug_ab']!;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(einzug)) {
    throw new Error(`prompts/profil.md: einzug_ab muss YYYY-MM-DD sein, ist "${einzug}"`);
  }

  const yes = (v: string) => /^(ja|yes|true|1)$/i.test(v.trim());

  return {
    status: raw['profil_status'] === 'echt' ? 'echt' : 'beispiel',
    name: raw['name']!,
    adresse: raw['adresse']!,
    telefon: raw['telefon']!,
    email: raw['email']!,
    beruf: raw['beruf']!,
    arbeitgeber: raw['arbeitgeber']!,
    anstellung: raw['anstellung']!,
    nettoeinkommenEur: income,
    schufa: raw['schufa']!,
    haushalt: raw['haushalt']!,
    nichtraucher: yes(raw['nichtraucher']!),
    haustiere: raw['haustiere']!,
    einzugAb: einzug,
    wbs: yes(raw['wbs']!),
    unterlagen: raw['unterlagen']!.split(',').map((s) => s.trim()).filter(Boolean),
  };
}

let cached: Profile | null = null;
export function loadProfile(path: string = PROFILE_PATH): Profile {
  if (path === PROFILE_PATH && cached) return cached;
  const profile = parseProfileText(readFileSync(path, 'utf8'));
  if (path === PROFILE_PATH) cached = profile;
  return profile;
}
