/**
 * T_VERWALTUNG (§13). Ohne Modell.
 *
 * "Das ist ein Serienbrief, kein Denkproblem" (§8 Flow A). Zwei LLM-Aufrufe
 * pro Inserat sind extract und gate; der Draft entsteht hier deterministisch.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Payload } from '../stages/extract.ts';
import type { Profile } from '../lib/profile.ts';
import { renderTemplate, countWords } from './template.ts';
import {
  salutation, describeObject, locationPhrase, buildSubject,
  formatEuro, formatDate, isRealExternalId,
} from './german.ts';

const TEMPLATE_PATH = resolve(import.meta.dirname, '../../prompts/t_verwaltung.md');

/**
 * ABWEICHUNG VON §13: dort stehen 100 Wörter.
 *
 * Die Referenzmail, mit der Alexander in München erfolgreich war, liegt bei
 * rund 200 — und die 100-Wort-Fassung wurde als "zu nackt" verworfen. Der
 * Zugewinn steckt in den Teilen, die Vertrauen herstellen: die aufgeschlüsselte
 * Einkommensangabe, der Link auf ein echtes Profil, die Erklärung der
 * auswärtigen Adresse. Nichts davon geht in 100 Wörter.
 *
 * Die Grenze bleibt trotzdem hart, damit das Template nicht unbemerkt
 * ausufert.
 */
export const WORD_LIMIT = 230;

export interface PreviousContact {
  /** ISO-Datum der ersten Anfrage. */
  sentAt: string;
  /** Objektnummer von damals, falls es eine echte war. */
  externalId: string | null;
}

export interface DraftOptions {
  /** §13 Zweitkontakt: Selbstvorstellung weglassen, Bezug herstellen. */
  previousContact?: PreviousContact;
}

export interface Draft {
  subject: string;
  body: string;
  wordCount: number;
  /** Warum dieser Draft (noch) nicht sendebereit ist. */
  blockers: string[];
  usedFeature: string | null;
  personalSalutation: boolean;
}

function joinGerman(list: string[]): string {
  if (list.length <= 1) return list[0] ?? '';
  return `${list.slice(0, -1).join(', ')} und ${list[list.length - 1]!}`;
}

function unterlagenSatz(profile: Profile): string {
  if (profile.unterlagen.length === 0) {
    return 'Alle üblichen Unterlagen sende ich Ihnen selbstverständlich gerne auf Nachfrage zu.';
  }
  return `${joinGerman(profile.unterlagen)} sende ich Ihnen selbstverständlich gerne auf Nachfrage zu.`;
}

function berufZeile(profile: Profile): string {
  const rolle = profile.arbeitgeber ? `${profile.beruf} bei ${profile.arbeitgeber}` : profile.beruf;
  return [rolle, profile.anstellung].filter(Boolean).join(', ');
}

/**
 * "ca. 3.900 € netto monatlich – 3.500 € aus fester Anstellung, dazu ca.
 * 400 € aus freiberuflicher Tätigkeit"
 *
 * Die Aufschlüsselung ist der Punkt: eine nackte Summe wirkt behauptet, die
 * Herkunft macht sie prüfbar.
 */
function einkommenZeile(profile: Profile): string {
  const haupt = formatEuro(profile.nettoeinkommenEur);
  if (profile.nebeneinkommenEur <= 0) {
    return `${haupt} netto monatlich aus fester Anstellung`;
  }
  const summe = formatEuro(profile.nettoeinkommenEur + profile.nebeneinkommenEur);
  const art = profile.nebeneinkommenArt ?? 'selbstständiger Tätigkeit';
  return (
    `ca. ${summe} netto monatlich – ${haupt} aus fester Anstellung, ` +
    `dazu ca. ${formatEuro(profile.nebeneinkommenEur)} aus ${art}`
  );
}

function statusZeile(profile: Profile): string {
  return [
    profile.familienstand,
    profile.haushalt,
    profile.nichtraucher ? 'Nichtraucher' : null,
    profile.haustiere.toLowerCase() === 'keine' ? 'keine Haustiere' : `Haustiere: ${profile.haustiere}`,
  ].filter(Boolean).join(', ');
}

function zweitkontaktSatz(prev: PreviousContact): string {
  const wann = formatDate(prev.sentAt);
  return prev.externalId && isRealExternalId(prev.externalId)
    ? `am ${wann} hatte ich mich bei Ihnen bereits um das Objekt ${prev.externalId} beworben.`
    : `am ${wann} hatte ich mich bei Ihnen bereits um eine andere Wohnung beworben.`;
}

export function renderVerwaltung(
  payload: Payload,
  profile: Profile,
  opts: DraftOptions = {},
): Draft {
  const { listing, provider } = payload;
  const template = readFileSync(TEMPLATE_PATH, 'utf8');

  const anrede = salutation(provider.contact_person_raw);
  const objekt = describeObject(listing);
  const zweitkontakt = Boolean(opts.previousContact);

  const body = renderTemplate(template, {
    salutation: anrede,
    zweitkontakt,
    zweitkontakt_satz: opts.previousContact ? zweitkontaktSatz(opts.previousContact) : null,
    objekt,
    ort: locationPhrase(listing),
    objektnummer_klammer: isRealExternalId(listing.external_id)
      ? ` (Objektnummer ${listing.external_id})`
      : '',
    name: profile.name,
    beruf_zeile: berufZeile(profile),
    einkommen_zeile: einkommenZeile(profile),
    schufa: profile.schufa,
    status_zeile: statusZeile(profile),
    einzug_ab: formatDate(profile.einzugAb),
    hinweis_adresse: profile.hinweisAdresse,
    hat_links: profile.links.length > 0,
    links_block: profile.links.map((l) => `- ${l.label}: ${l.url}`).join('\n'),
    unterlagen_satz: unterlagenSatz(profile),
    besichtigung: profile.besichtigung,
    telefon: profile.telefon,
    email: profile.email,
  });

  const blockers: string[] = [];
  if (profile.status !== 'echt') {
    blockers.push('prompts/profil.md steht auf "beispiel" — enthält keine echten Daten');
  }
  if (listing.wbs_required === true && !profile.wbs) {
    blockers.push('Inserat verlangt einen WBS, das Profil hat keinen');
  }
  const wordCount = countWords(body);
  if (wordCount > WORD_LIMIT) {
    blockers.push(`${wordCount} Wörter, erlaubt sind ${WORD_LIMIT} (§13)`);
  }

  return {
    subject: buildSubject(listing),
    body,
    wordCount,
    blockers,
    usedFeature: (() => {
      const m = / mit ([^,]+)$/.exec(objekt);
      return m ? m[1]! : null;
    })(),
    personalSalutation: anrede !== 'Sehr geehrte Damen und Herren',
  };
}
