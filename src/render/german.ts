/**
 * Die sprachlichen Kleinteile, aus denen die Templates zusammengesetzt werden.
 *
 * Bewusst hier und nicht im Template: "Frau S. Kruse" zu "Sehr geehrte Frau
 * Kruse" zu machen ist Logik, keine Formatierung.
 */
import type { Listing, Provider } from '../stages/extract.ts';

export const FALLBACK_SALUTATION = 'Sehr geehrte Damen und Herren';

/**
 * Anrede aus der Ansprechperson.
 *
 * Nur wenn "Frau" oder "Herr" wörtlich dasteht, wird persönlich angeredet.
 * Aus einem bloßen Namen das Geschlecht zu erschließen geht regelmäßig
 * schief, und eine falsche Anrede kostet mehr, als die persönliche einbringt.
 */
export function salutation(contactPersonRaw: string | null): string {
  if (!contactPersonRaw) return FALLBACK_SALUTATION;
  const text = contactPersonRaw.trim().replace(/\s+/g, ' ');

  const match = /^(Frau|Herr|Herrn)\b\s*(.*)$/i.exec(text);
  if (!match) return FALLBACK_SALUTATION;

  const anrede = /^frau$/i.test(match[1]!) ? 'Frau' : 'Herrn';
  const geehrte = anrede === 'Frau' ? 'Sehr geehrte' : 'Sehr geehrter';

  // Titel behalten, Initialen ("S.") verwerfen, Nachname ist das letzte Wort.
  const rest = match[2]!.replace(/[,;].*$/, '').trim();
  const parts = rest.split(' ').filter(Boolean);
  const titles = parts.filter((p) => /^(Dr\.|Prof\.|Dipl\.-?\w*\.?)$/i.test(p));
  const names = parts.filter((p) => !titles.includes(p) && !/^[A-ZÄÖÜ]\.$/.test(p));
  const surname = names[names.length - 1];

  if (!surname) return FALLBACK_SALUTATION;
  const anredeWort = anrede === 'Frau' ? 'Frau' : 'Herr';
  return `${geehrte} ${anredeWort} ${[...titles, surname].join(' ')}`;
}

/** 2 -> "2", 2.5 -> "2,5" */
export function formatRooms(rooms: number | null): string | null {
  if (rooms === null || !Number.isFinite(rooms)) return null;
  return Number.isInteger(rooms) ? String(rooms) : String(rooms).replace('.', ',');
}

export function formatEuro(amount: number): string {
  return `${amount.toLocaleString('de-DE')} €`;
}

const MONTHS = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

/** "2026-10-01" -> "1. Oktober 2026" */
export function formatDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return `${Number(m[3])}. ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

/**
 * Ein Merkmal aus `features`, nach Aussagekraft geordnet.
 *
 * Warum überhaupt eines: Es beweist in vier Wörtern, dass ich das Exposé
 * gelesen habe. Warum nur eines: Mehr klingt nach Aufzählung, und §13
 * verbietet Adjektive zur Wohnung.
 */
/**
 * Nur Merkmale, die nach "Wohnung mit …" natürlich klingen und der Wohnung
 * selbst gehören. Aufzug, Keller und Stellplatz gehören zum Haus — "die
 * 3-Zimmer-Wohnung mit Fahrstuhl" liest sich falsch. Findet sich nichts aus
 * dieser Liste, bleibt der Satz ohne Merkmal: kein Merkmal ist besser als
 * ein schiefes.
 */
const AMENITY_PRIORITY = [
  'Balkon', 'Terrasse', 'Loggia', 'Garten',
  'Einbauküche', 'EBK',
  'Gäste-WC',
];

const BUILDING_TYPES = ['Altbau', 'Neubau'];

export function pickAmenity(features: string[]): string | null {
  for (const wanted of AMENITY_PRIORITY) {
    const hit = features.find((f) => f.toLowerCase().includes(wanted.toLowerCase()));
    if (hit) return wanted === 'EBK' ? 'Einbauküche' : wanted;
  }
  return null;
}

export function pickBuildingType(features: string[]): string | null {
  for (const wanted of BUILDING_TYPES) {
    if (features.some((f) => f.toLowerCase().includes(wanted.toLowerCase()))) return wanted;
  }
  return null;
}

/**
 * "2-Zimmer-Altbauwohnung mit Balkon" — rein beschreibend, kein Adjektiv.
 */
export function describeObject(listing: Listing): string {
  const rooms = formatRooms(listing.rooms);
  const type = pickBuildingType(listing.features);
  const amenity = pickAmenity(listing.features);

  const noun = type ? `${type}wohnung` : 'Wohnung';
  const head = rooms ? `${rooms}-Zimmer-${noun}` : noun;
  return amenity ? `${head} mit ${amenity}` : head;
}

/** " in der Sonnenallee 104" / " in Neukölln" / "" */
export function locationPhrase(listing: Listing): string {
  if (listing.street) {
    const nr = listing.house_number ? ` ${listing.house_number}` : '';
    return ` in der ${listing.street}${nr}`;
  }
  if (listing.district) return ` in ${listing.district}`;
  return '';
}

/** Ein Ersatzschlüssel (§4) ist keine Objektnummer, die man zitieren kann. */
export function isRealExternalId(externalId: string | null): boolean {
  return Boolean(externalId) && !externalId!.startsWith('url:');
}

/**
 * Betreff (§13): `Anfrage {external_id} – {street} {hnr}, {rooms} Zi.`
 *
 * "Die Betreffzeile leistet mehr als der Fließtext — sie macht mich in einem
 * überlaufenen Postfach in einer Sekunde ablegbar." Deshalb fallen fehlende
 * Teile ersatzlos weg, statt durch Platzhalter ersetzt zu werden.
 */
export function buildSubject(listing: Listing): string {
  const parts: string[] = ['Anfrage'];
  if (isRealExternalId(listing.external_id)) parts.push(listing.external_id!);

  const ort = listing.street
    ? `${listing.street}${listing.house_number ? ` ${listing.house_number}` : ''}`
    : listing.district;

  const rooms = formatRooms(listing.rooms);
  const tail = [ort, rooms ? `${rooms} Zi.` : null].filter(Boolean).join(', ');

  const head = parts.join(' ');
  return tail ? `${head} – ${tail}` : head;
}

/** "Frau Kruse" für den Fließtext, oder null. */
export function shortContactName(provider: Provider): string | null {
  const s = salutation(provider.contact_person_raw);
  return s === FALLBACK_SALUTATION ? null : s.replace(/^Sehr geehrter? /, '');
}
