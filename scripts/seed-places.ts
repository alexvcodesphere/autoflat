#!/usr/bin/env node
/**
 * Füllt `seed_company` aus der Google Places API (§17, Quelle 2).
 *
 *   npm run seed:places -- --demo        6 erfundene Firmen, ohne Google
 *   npm run seed:places -- --dry-run     nichts schreiben, nur zeigen
 *   npm run seed:places                  Lauf und Import
 *   npm run seed:places -- --max 50      Anfragen deckeln
 *
 * Text Search (New) gibt höchstens 60 Treffer je Anfrage zurück, deshalb
 * wird nach Bezirk und Suchbegriff aufgeteilt (config/places-queries.json).
 * Dedupliziert wird über `name_canonical` (§6).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDb } from '../src/db/index.ts';
import { insertSeed, seedStats } from '../src/db/seed.ts';
import { normalizeCompanyName } from '../src/lib/normalize.ts';

const ENDPOINT = 'https://places.googleapis.com/v1/places:searchText';
const FIELD_MASK = [
  'places.displayName', 'places.formattedAddress', 'places.websiteUri',
  'places.userRatingCount', 'places.primaryType', 'nextPageToken',
].join(',');

interface PlacesConfig { terms: string[]; areas: string[] }
interface Place {
  displayName?: { text?: string };
  formattedAddress?: string;
  websiteUri?: string;
  userRatingCount?: number;
  primaryType?: string;
}

interface Candidate {
  name: string;
  address: string | null;
  website: string | null;
  ratingCount: number;
  canonical: string;
}

function fail(message: string): never {
  console.error(`\nFehlgeschlagen:\n  ${message.split('\n').join('\n  ')}\n`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const maxIdx = argv.indexOf('--max');
const maxRequests = maxIdx >= 0 ? Number(argv[maxIdx + 1]) : 200;

/**
 * --demo füllt die Warteschlange mit erfundenen Firmen, damit sich die
 * Prewarm-Schleife einmal durchspielen lässt, bevor ein Google-Key da ist.
 * Bewusst dieselben Namen wie in den Fixtures — die sind erkennbar erfunden
 * und können nicht mit echten Leads verwechselt werden.
 */
if (argv.includes('--demo')) {
  const demo: Array<[string, string, string | null, number, number]> = [
    ['Meyer & Co. Hausverwaltung GmbH', 'Sonnenallee 104, 12045 Berlin', 'https://meyer-hv.example', 48, 2],
    ['Kranz Immobilienverwaltung GmbH', 'Müllerstraße 156a, 13353 Berlin', 'https://kranz-immobilien.example', 31, 2],
    ['Berger Immobilien GmbH', 'Kurfürstendamm 21, 10719 Berlin', 'https://berger-immo.example', 12, 3],
    ['Hausverwaltung Schmidt', 'Danziger Straße 12, 10435 Berlin', null, 3, 4],
    ['Nowak Grundbesitzverwaltung e.K.', 'Turmstraße 7, 10559 Berlin', 'https://nowak-gbv.example', 21, 3],
    ['Aus Inserat Verwaltung GmbH', 'Berlin', null, 0, 1],
  ];
  const demoDb = openDb();
  let n = 0;
  for (const [name, address, website, ratings, priority] of demo) {
    if (insertSeed(demoDb, {
      name_raw: name, address, website_hint: website, rating_count: ratings,
      origin: website ? 'places' : 'manual', priority,
    }).created) n++;
  }
  const s = seedStats(demoDb);
  console.log(`[DEMO] ${n} erfundene Firmen angelegt, ${demo.length - n} waren schon da.`);
  console.log(`Warteschlange: ${s.pending} offen.`);
  console.log(`\nWeiter mit: npm run prewarm:batch -- -n 3`);
  console.log(`Aufräumen mit: npm run db:reset`);
  demoDb.close();
  process.exit(0);
}

const apiKey = process.env['GOOGLE_PLACES_API_KEY'] ?? '';
if (!apiKey) {
  fail(
    'GOOGLE_PLACES_API_KEY fehlt in .env.\n' +
      'Anlegen unter console.cloud.google.com, dann "Places API (New)" aktivieren.',
  );
}

const config = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../config/places-queries.json'), 'utf8'),
) as PlacesConfig;

const queries: string[] = [];
for (const area of config.areas) for (const term of config.terms) queries.push(`${term} ${area}`);

console.log(`${queries.length} Suchanfragen geplant (je bis zu 3 Seiten à 20 Treffer).`);
console.log(`Deckel: ${maxRequests} HTTP-Anfragen.${dryRun ? '  [DRY RUN]' : ''}\n`);

async function searchPage(textQuery: string, pageToken?: string): Promise<{ places: Place[]; next?: string }> {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': FIELD_MASK,
    },
    body: JSON.stringify({
      textQuery,
      languageCode: 'de',
      regionCode: 'DE',
      pageSize: 20,
      ...(pageToken ? { pageToken } : {}),
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Places API ${response.status}: ${text.slice(0, 400)}`);
  }
  const body = (await response.json()) as { places?: Place[]; nextPageToken?: string };
  return { places: body.places ?? [], next: body.nextPageToken };
}

const byCanonical = new Map<string, Candidate>();
let requests = 0;

for (const query of queries) {
  let pageToken: string | undefined;
  for (let page = 0; page < 3; page++) {
    if (requests >= maxRequests) {
      console.log(`\nDeckel von ${maxRequests} Anfragen erreicht — Rest übersprungen.`);
      break;
    }
    let result;
    try {
      result = await searchPage(query, pageToken);
      requests++;
    } catch (err) {
      console.error(`  ✖ ${query}: ${(err as Error).message}`);
      break;
    }

    for (const place of result.places) {
      const name = place.displayName?.text?.trim();
      if (!name) continue;
      const canonical = normalizeCompanyName(name);
      if (!canonical) continue;
      const existing = byCanonical.get(canonical);
      const candidate: Candidate = {
        name,
        address: place.formattedAddress ?? null,
        website: place.websiteUri ?? null,
        ratingCount: place.userRatingCount ?? 0,
        canonical,
      };
      // Bei Dubletten den Eintrag mit mehr Information behalten.
      if (!existing || (!existing.website && candidate.website)) byCanonical.set(canonical, candidate);
    }

    if (!result.next) break;
    pageToken = result.next;
  }
  if (requests >= maxRequests) break;
  process.stdout.write('.');
}

const candidates = [...byCanonical.values()];
console.log(`\n\n${requests} Anfragen, ${candidates.length} eindeutige Firmen.\n`);

if (candidates.length === 0) fail('Keine Treffer. Prüfe den API-Key und ob "Places API (New)" aktiviert ist.');

/**
 * Priorisierung (§17). Wichtiger als die Beschaffung: Places liefert
 * überwiegend Zwei-Mann-Verwaltungen mit zwei Vermietungen im Jahr. Alle
 * vorzuwärmen wären ~80 Batches.
 *
 * Priorität 1 vergibt dieses Skript nicht — die bekommt eine Firma nur, wenn
 * sie in einem echten Inserat auftaucht.
 */
const withRatings = candidates.map((c) => c.ratingCount).sort((a, b) => a - b);
const median = withRatings.length > 0 ? withRatings[Math.floor(withRatings.length / 2)]! : 0;

function priorityOf(c: Candidate): number {
  if (!c.website) return 4;
  return c.ratingCount > median ? 2 : 3;
}

const counts: Record<number, number> = { 2: 0, 3: 0, 4: 0 };
for (const c of candidates) counts[priorityOf(c)] = (counts[priorityOf(c)] ?? 0) + 1;

console.log(`Median der Bewertungszahl: ${median}`);
console.log(`  Priorität 2 (Website, überdurchschnittlich bewertet): ${counts[2]}`);
console.log(`  Priorität 3 (Website, wenige Bewertungen):            ${counts[3]}`);
console.log(`  Priorität 4 (keine Website):                          ${counts[4]}`);
console.log(`\nPriorität 2 sind ~${Math.ceil((counts[2] ?? 0) / 15)} Batches, 2+3 ~${Math.ceil(((counts[2] ?? 0) + (counts[3] ?? 0)) / 15)}.`);

if (dryRun) {
  console.log('\n[DRY RUN] Nichts geschrieben. Beispiele:');
  for (const c of candidates.slice(0, 10)) {
    console.log(`  P${priorityOf(c)}  ${c.name}  ·  ${c.ratingCount} Bewertungen  ·  ${c.website ?? 'keine Website'}`);
  }
  process.exit(0);
}

const db = openDb();
let created = 0;
const tx = db.transaction(() => {
  for (const c of candidates) {
    const { created: isNew } = insertSeed(db, {
      name_raw: c.name,
      address: c.address,
      website_hint: c.website,
      rating_count: c.ratingCount,
      origin: 'places',
      priority: priorityOf(c),
    });
    if (isNew) created++;
  }
});
tx();

const stats = seedStats(db);
console.log(`\n${created} neu angelegt, ${candidates.length - created} waren schon da.`);
console.log(`Warteschlange: ${stats.pending} offen.`);
console.log(`\nNächster Schritt: npm run prewarm:batch`);
db.close();
