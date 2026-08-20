/**
 * Die Erwartungsdateien selbst prüfen.
 *
 * Ein Tippfehler in `<name>.expected.json` — falsche Objektnummer, ein Feld
 * als `must_be_null` markiert, das sehr wohl auf der Seite steht — sähe im
 * echten Lauf aus wie ein Modellfehler und kostet eine Runde Fehlersuche am
 * falschen Ende. Hier steht deshalb je Fixture der von Hand gelesene
 * Soll-Payload, und der muss seine eigenen Zusicherungen erfüllen.
 *
 * Das prüft die Erwartungen, nicht das Modell. Das Modell prüft
 * `npm run extract:fixtures`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFixture, checkPayload, listFixtures } from '../src/lib/fixtures.ts';
import { finalizePayload, type Payload } from '../src/stages/extract.ts';
import { loadSchema, validateAgainst } from '../src/llm/validate.ts';

const NOTHING: Payload = {
  listing: {
    external_id: null, url: null, street: null, house_number: null, postcode: null,
    district: null, rooms: null, living_space: null, cold_rent: null, warm_rent: null,
    deposit: null, available_from: null, wbs_required: null, features: [],
    description_excerpt: null,
  },
  provider: {
    name_raw: null, contact_person_raw: null, phone_raw: null, email_raw: null,
    website_raw: null, platform_private_flag: null, self_description: null,
  },
};

function build(over: {
  listing?: Partial<Payload['listing']>;
  provider?: Partial<Payload['provider']>;
}): Payload {
  return {
    listing: { ...NOTHING.listing, ...over.listing },
    provider: { ...NOTHING.provider, ...over.provider },
  };
}

/** Von Hand aus dem jeweiligen page_text gelesen. */
const HANDGELESEN: Record<string, Payload> = {
  'is24-neukoelln': build({
    listing: {
      external_id: '162345678',
      street: 'Sonnenallee',
      house_number: '104',
      postcode: '12045',
      district: 'Neukölln',
      rooms: 2,
      living_space: 58.4,
      cold_rent: 890,
      warm_rent: 1120,
      deposit: 2670,
      available_from: '2026-10-01',
      wbs_required: false,
      features: ['Altbau', 'Balkon', 'Einbauküche', '3. OG', 'Kelleranteil', 'Badewanne'],
      description_excerpt:
        'Diese gepflegte Altbauwohnung im dritten Obergeschoss eines gut erhaltenen Vorderhauses überzeugt durch hohe Decken, Stuck im Wohnzimmer und einen nach Süden ausgerichteten Balkon zum begrünten Innenhof.',
    },
    provider: {
      name_raw: 'Meyer & Co. Hausverwaltung GmbH',
      contact_person_raw: 'Frau S. Kruse',
      phone_raw: '030 1234567',
      self_description: 'Wir verwalten dieses Objekt seit 2011 im Auftrag der Eigentümergemeinschaft.',
    },
  }),

  'kleinanzeigen-friedrichshain': build({
    listing: {
      external_id: '2947183055',
      postcode: '10245',
      district: 'Friedrichshain',
      rooms: 2,
      living_space: 54,
      cold_rent: 650,
      deposit: 1300,
      features: ['Altbau', 'Einbauküche', 'Dielenboden', '2. Etage', 'Haustiere nach Absprache'],
      description_excerpt:
        'Hallo zusammen, ich ziehe Ende des Monats aus beruflichen Gründen nach Leipzig und suche daher einen Nachmieter für meine Wohnung.',
    },
    provider: {
      name_raw: 'Tobias',
      platform_private_flag: true,
      self_description: 'ich ziehe Ende des Monats aus beruflichen Gründen nach Leipzig und suche daher einen Nachmieter für meine Wohnung',
    },
  }),

  'website-kranz-wedding': build({
    // Diese Seite weist keine Objektnummer aus — external_id bleibt beim
    // Modell null und wird von finalizePayload aus der URL gebildet.
    listing: {
      street: 'Nazarethkirchstraße',
      postcode: '13347',
      district: 'Wedding',
      rooms: 3,
      living_space: 71.5,
      cold_rent: 742,
      warm_rent: 1022,
      deposit: 2226,
      available_from: '2026-11-15',
      wbs_required: true,
      features: ['Fahrstuhl', 'Kellerabteil', 'Laminat', 'Fernwärme', '1. Obergeschoss', 'barrierearm'],
      description_excerpt:
        'Die Wohnung befindet sich in einem 1968 errichteten Wohnhaus in ruhiger Seitenstraße.',
    },
    provider: {
      name_raw: 'Kranz Immobilienverwaltung GmbH',
      contact_person_raw: 'Frau Andrea Kranz',
      phone_raw: '030 45 60 89 12',
      email_raw: 'vermietung@kranz-immobilien.de',
      website_raw: 'www.kranz-immobilien.de',
      self_description: 'Wir betreuen dieses Objekt als WEG-Verwaltung seit 2004 und vermieten ausschließlich im eigenen Bestand',
    },
  }),
  'is24-realexample-1': build({
    // Echtes Inserat. Die Seite nennt keine Straße, nur "Pankow (Ortsteil),
    // 13189 Berlin" — street und house_number bleiben deshalb null.
    listing: {
      external_id: '169730902',
      postcode: '13189',
      district: 'Pankow',
      rooms: 2,
      living_space: 81,
      cold_rent: 685,
      warm_rent: 950,
      deposit: 2055,
      features: ['Altbau', '2. OG', 'Balkon', 'Einbauküche', 'Keller', 'WG-geeignet'],
      description_excerpt:
        'Diese 2-Zimmer-Altbauwohnung hat eine Wohnfläche von 81 Quadratmetern inklusive Balkon.',
    },
    provider: {
      name_raw: 'Frau Nadine Ebenau',
      contact_person_raw: 'Frau Nadine Ebenau',
      platform_private_flag: true,
      self_description: 'Nachmieter für wunderschöne 2-Zimmer-Altbauwohnung in Berlin-Pankow gesucht',
    },
  }),

  'is24-realexample-2': build({
    listing: {
      external_id: '170104954',
      street: 'Behringstraße',
      house_number: '33',
      postcode: '12437',
      district: 'Baumschulenweg',
      rooms: 2,
      living_space: 63,
      cold_rent: 865,
      warm_rent: 1130,
      deposit: 2595,
      // Die Beschreibung nennt nur "ab 01.09." — das Jahr ergänzt der
      // Dienst über das heutige Datum im Input.
      available_from: '2026-09-01',
      features: ['Altbau', '2. OG', 'Keller', 'Laminat', 'Dusche'],
      description_excerpt: 'Nachmieter für 2-Zimmer-Altbauwohnung ab 01.09. gesucht.',
    },
    provider: {
      name_raw: 'Katja Scheremetjew',
      platform_private_flag: true,
      self_description: 'Nachmieter für 2-Zimmer-Altbauwohnung ab 01.09. gesucht.',
    },
  }),
  'is24-habitare-baumschulenweg': build({
    // Makler-Inserat. Die Straße steht NUR im Beschreibungstext
    // ("Die Wohnung befindet sich in der Scheiblerstraße"), nicht im
    // Adressfeld — und Balkon wie Aufzug werden ausdrücklich verneint.
    listing: {
      external_id: '169608740',
      street: 'Scheiblerstraße',
      postcode: '12437',
      district: 'Baumschulenweg',
      rooms: 4,
      living_space: 88.3,
      cold_rent: 688.74,
      warm_rent: 904.24,
      deposit: 2066.22,
      features: ['Altbau', '2. OG', 'WG-geeignet', 'Wintergarten', 'Badewanne', 'Dielen', 'Zentralheizung'],
      description_excerpt:
        'Ihre neue Altbauwohnung befindet sich in einem gepflegten Berliner Mehrfamilienhaus aus dem Jahr 1930.',
    },
    provider: {
      name_raw: 'habitare Immobilien IVD, Immobilienmanagement & Standortberatung, Inhaber: Christian Kurtz',
      contact_person_raw: 'Herr Björn Tölken',
      website_raw: 'www.habitare-immobilien.de',
      platform_private_flag: false,
      self_description: 'Mieten Sie direkt beim Spezialisten: wir sind geprüftes IVD-Verbandsmitglied',
    },
  }),
};

for (const [name, handgelesen] of Object.entries(HANDGELESEN)) {
  test(`${name}: der von Hand gelesene Payload erfuellt die Erwartungen`, () => {
    const fixture = loadFixture(name);
    const { payload } = finalizePayload(handgelesen, fixture.capture);
    const { failures } = checkPayload(payload, fixture.expected);
    assert.deepEqual(
      failures,
      [],
      `Die Erwartungsdatei widerspricht dem Seitentext:\n  ${failures.join('\n  ')}`,
    );
  });

  test(`${name}: der von Hand gelesene Payload ist schemagueltig`, () => {
    const fixture = loadFixture(name);
    const { payload } = finalizePayload(handgelesen, fixture.capture);
    const { valid, errors } = validateAgainst(loadSchema('payload'), payload);
    assert.equal(valid, true, errors.join('; '));
  });
}

test('jedes Fixture MIT Extraktions-Erwartung hat einen von Hand gelesenen Gegenpart', () => {
  for (const name of listFixtures()) {
    const { expected } = loadFixture(name);
    const hasExtractExpectation = Object.keys(expected).length > 0;
    if (!hasExtractExpectation) continue;   // reine Gate-Fixtures
    assert.ok(name in HANDGELESEN, `Fixture ${name} fehlt in HANDGELESEN`);
  }
});
