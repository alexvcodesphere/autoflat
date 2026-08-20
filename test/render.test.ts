import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderTemplate, countWords, TemplateError } from '../src/render/template.ts';
import {
  salutation, describeObject, locationPhrase, buildSubject, formatDate,
  formatEuro, formatRooms, pickAmenity, isRealExternalId, FALLBACK_SALUTATION,
} from '../src/render/german.ts';
import { parseProfileText, loadProfile } from '../src/lib/profile.ts';
import { renderVerwaltung, WORD_LIMIT } from '../src/render/verwaltung.ts';
import type { Payload, Listing } from '../src/stages/extract.ts';

// ---------------------------------------------------------------- Template

test('setzt Variablen ein', () => {
  assert.equal(renderTemplate('Hallo {{name}}!', { name: 'Welt' }), 'Hallo Welt!\n');
});

test('unaufgeloeste Platzhalter sind ein Fehler, kein leerer String', () => {
  // Ein "{{beruf}}" mitten in einer Mail an eine Hausverwaltung waere peinlich.
  assert.throws(() => renderTemplate('Hallo {{name}}', {}), TemplateError);
  assert.throws(() => renderTemplate('Hallo {{name}}', {}), /name/);
});

test('if und unless', () => {
  const t = '{{#if a}}JA{{/if}}{{#unless a}}NEIN{{/unless}}';
  assert.equal(renderTemplate(t, { a: true }).trim(), 'JA');
  assert.equal(renderTemplate(t, { a: false }).trim(), 'NEIN');
  assert.equal(renderTemplate(t, { a: '' }).trim(), 'NEIN');
  assert.equal(renderTemplate(t, { a: null }).trim(), 'NEIN');
});

test('kollabiert Leerzeilen, die durch weggefallene Bloecke entstehen', () => {
  const out = renderTemplate('A\n{{#if x}}\nB\n{{/if}}\n\n\nC', { x: false });
  assert.equal(out.includes('\n\n\n'), false);
});

test('countWords ignoriert Trennzeichen', () => {
  assert.equal(countWords('eins zwei · drei'), 3);
  assert.equal(countWords('a – b'), 2);
});

// ---------------------------------------------------------------- Anrede

test('persoenliche Anrede nur bei ausgeschriebenem Frau/Herr', () => {
  assert.equal(salutation('Frau S. Kruse'), 'Sehr geehrte Frau Kruse');
  assert.equal(salutation('Frau Andrea Kranz'), 'Sehr geehrte Frau Kranz');
  assert.equal(salutation('Herr Meyer'), 'Sehr geehrter Herr Meyer');
  assert.equal(salutation('Herrn Dr. Meyer'), 'Sehr geehrter Herr Dr. Meyer');
});

test('ohne Frau/Herr wird nicht geraten', () => {
  // Aus einem blossen Namen das Geschlecht zu erschliessen geht regelmaessig
  // schief; eine falsche Anrede kostet mehr als die persoenliche einbringt.
  assert.equal(salutation('Tobias'), FALLBACK_SALUTATION);
  assert.equal(salutation('Andrea Kranz'), FALLBACK_SALUTATION);
  assert.equal(salutation('A. Schmidt'), FALLBACK_SALUTATION);
  assert.equal(salutation(null), FALLBACK_SALUTATION);
  assert.equal(salutation(''), FALLBACK_SALUTATION);
});

// ---------------------------------------------------------------- Objekt

function listing(over: Partial<Listing> = {}): Listing {
  return {
    external_id: '162345678', url: null, street: null, house_number: null,
    postcode: null, district: null, rooms: null, living_space: null,
    cold_rent: null, warm_rent: null, deposit: null, available_from: null,
    wbs_required: null, features: [], description_excerpt: null, ...over,
  };
}

test('Objektbezeichnung ohne Adjektive', () => {
  assert.equal(
    describeObject(listing({ rooms: 2, features: ['Altbau', 'Balkon', 'EBK'] })),
    '2-Zimmer-Altbauwohnung mit Balkon',
  );
  assert.equal(describeObject(listing({ rooms: 3, features: [] })), '3-Zimmer-Wohnung');
  assert.equal(describeObject(listing({ rooms: null, features: [] })), 'Wohnung');
  assert.equal(describeObject(listing({ rooms: 2.5, features: ['Neubau'] })), '2,5-Zimmer-Neubauwohnung');
});

test('nur Merkmale, die der Wohnung gehoeren', () => {
  // "die 3-Zimmer-Wohnung mit Fahrstuhl" liest sich falsch — der Aufzug
  // gehoert zum Haus. Dann lieber gar kein Merkmal.
  assert.equal(pickAmenity(['Fahrstuhl im Haus', 'Kellerabteil', 'Laminat']), null);
  assert.equal(pickAmenity(['Balkon', 'Einbauküche']), 'Balkon');
  assert.equal(pickAmenity(['EBK']), 'Einbauküche');
});

test('Ortsangabe faellt zurueck auf den Ortsteil', () => {
  assert.equal(locationPhrase(listing({ street: 'Sonnenallee', house_number: '104' })), ' in der Sonnenallee 104');
  assert.equal(locationPhrase(listing({ street: 'Nazarethkirchstraße' })), ' in der Nazarethkirchstraße');
  assert.equal(locationPhrase(listing({ district: 'Pankow' })), ' in Pankow');
  assert.equal(locationPhrase(listing()), '');
});

// ---------------------------------------------------------------- Betreff

test('Betreff nach §13', () => {
  assert.equal(
    buildSubject(listing({ external_id: '162345678', street: 'Sonnenallee', house_number: '104', rooms: 2 })),
    'Anfrage 162345678 – Sonnenallee 104, 2 Zi.',
  );
});

test('Betreff nennt keinen URL-Ersatzschluessel', () => {
  // "Anfrage url:kranz-immobilien.de/angebote/… " waere unbrauchbar.
  const s = buildSubject(listing({
    external_id: 'url:kranz-immobilien.de/angebote/3-zimmer-wedding',
    street: 'Nazarethkirchstraße', rooms: 3,
  }));
  assert.equal(s, 'Anfrage – Nazarethkirchstraße, 3 Zi.');
  assert.equal(s.includes('url:'), false);
});

test('Betreff kommt ohne Strasse und ohne Zimmerzahl aus', () => {
  assert.equal(buildSubject(listing({ external_id: '1', district: 'Pankow', rooms: 2 })), 'Anfrage 1 – Pankow, 2 Zi.');
  assert.equal(buildSubject(listing({ external_id: '1' })), 'Anfrage 1');
});

test('isRealExternalId', () => {
  assert.equal(isRealExternalId('162345678'), true);
  assert.equal(isRealExternalId('url:x.de/y'), false);
  assert.equal(isRealExternalId(null), false);
});

// ---------------------------------------------------------------- Formate

test('Zahlen und Datum deutsch', () => {
  assert.equal(formatEuro(3800), '3.800 €');
  assert.equal(formatDate('2026-10-01'), '1. Oktober 2026');
  assert.equal(formatRooms(2), '2');
  assert.equal(formatRooms(2.5), '2,5');
  assert.equal(formatRooms(null), null);
});

// ---------------------------------------------------------------- Profil

const MINIMAL_PROFILE = `
profil_status: echt
name: Test Person
adresse: Teststraße 1, 10000 Berlin
telefon: 0170 000
email: t@example.de
beruf: Entwickler
anstellung: unbefristet
nettoeinkommen_eur: 3000
schufa: ohne negative Einträge
haushalt: Ein-Personen-Haushalt
nichtraucher: ja
haustiere: keine
einzug_ab: 2026-10-01
wbs: nein
unterlagen: SCHUFA, Gehaltsnachweise
besichtigung: Für eine Besichtigung komme ich jederzeit nach Berlin.
`;

test('Profil wird geparst', () => {
  const p = parseProfileText(MINIMAL_PROFILE);
  assert.equal(p.status, 'echt');
  assert.equal(p.nettoeinkommenEur, 3000);
  assert.equal(p.nichtraucher, true);
  assert.equal(p.wbs, false);
  assert.deepEqual(p.unterlagen, ['SCHUFA', 'Gehaltsnachweise']);
});

test('optionale Felder duerfen fehlen', () => {
  const p = parseProfileText(MINIMAL_PROFILE);
  assert.equal(p.arbeitgeber, null);
  assert.equal(p.nebeneinkommenEur, 0);
  assert.equal(p.hinweisAdresse, null);
  assert.deepEqual(p.links, []);
});

test('link darf mehrfach vorkommen', () => {
  const p = parseProfileText(
    MINIMAL_PROFILE +
      'link: LinkedIn | https://example.com/a\nlink: Gesuch | https://example.com/b\n',
  );
  assert.deepEqual(p.links, [
    { label: 'LinkedIn', url: 'https://example.com/a' },
    { label: 'Gesuch', url: 'https://example.com/b' },
  ]);
});

test('kaputte link-Zeilen werden verworfen statt halb gerendert', () => {
  const p = parseProfileText(MINIMAL_PROFILE + 'link: nur ein Text ohne URL\n');
  assert.deepEqual(p.links, []);
});

test('unvollstaendiges Profil wirft', () => {
  assert.throws(() => parseProfileText('name: X'), /unvollständig/);
  assert.throws(() => parseProfileText(MINIMAL_PROFILE.replace('beruf: Entwickler', 'beruf: TODO ausfüllen')), /TODO/);
});

test('kaputte Zahlen und Daten werfen', () => {
  assert.throws(() => parseProfileText(MINIMAL_PROFILE.replace('3000', 'viel')), /nettoeinkommen/);
  assert.throws(() => parseProfileText(MINIMAL_PROFILE.replace('2026-10-01', '1.10.2026')), /einzug_ab/);
});

test('die ausgelieferte profil.md ist vollstaendig und parsebar', () => {
  const p = loadProfile();
  assert.ok(p.name.length > 0);
  assert.ok(p.nettoeinkommenEur > 0);
  assert.ok(p.unterlagen.length > 0);
  assert.ok(['echt', 'beispiel'].includes(p.status));
});

test('mit echtem Profil bleibt ein normaler Draft ohne Sperre', () => {
  const p = loadProfile();
  const d = renderVerwaltung(payload({ rooms: 2, street: 'Sonnenallee', house_number: '104' }), p);
  const erwartet = p.status === 'echt' ? 0 : 1;
  assert.equal(d.blockers.length, erwartet, d.blockers.join('; '));
});

// ---------------------------------------------------------------- Draft

const PAYLOAD_DIR = resolve(import.meta.dirname, '../data/payloads');
const echtesProfil = parseProfileText(MINIMAL_PROFILE);

function payload(over: Partial<Listing> = {}, contact: string | null = 'Frau S. Kruse'): Payload {
  return {
    listing: listing(over),
    provider: {
      name_raw: 'Meyer & Co. Hausverwaltung GmbH', contact_person_raw: contact,
      phone_raw: null, email_raw: null, website_raw: null,
      platform_private_flag: null, self_description: null,
    },
  };
}

test('Draft enthaelt Betreff, Anrede, Objektnummer und Gruss', () => {
  const d = renderVerwaltung(
    payload({ rooms: 2, street: 'Sonnenallee', house_number: '104', features: ['Altbau', 'Balkon'] }),
    echtesProfil,
  );
  assert.match(d.subject, /^Anfrage 162345678 – Sonnenallee 104, 2 Zi\.$/);
  assert.match(d.body, /^Sehr geehrte Frau Kruse,/);
  assert.match(d.body, /Objektnummer 162345678/);
  assert.match(d.body, /Mit freundlichen Grüßen/);
  assert.equal(d.blockers.length, 0);
});

test('Wortgrenze aus §13 wird eingehalten', () => {
  const d = renderVerwaltung(payload({ rooms: 2, street: 'Sonnenallee', house_number: '104' }), echtesProfil);
  assert.ok(d.wordCount <= WORD_LIMIT, `${d.wordCount} Wörter`);
});

test('keine Adjektive zur Wohnung (§13)', () => {
  const d = renderVerwaltung(
    payload({ rooms: 2, features: ['Altbau', 'Balkon'], description_excerpt: 'Traumhaft schöne Wohnung!' }),
    echtesProfil,
  );
  for (const verboten of ['schön', 'traumhaft', 'gepflegt', 'charmant', 'hell', 'ideal', 'perfekt']) {
    assert.equal(
      d.body.toLowerCase().includes(verboten),
      false,
      `"${verboten}" darf nicht im Draft stehen`,
    );
  }
});

test('Zweitkontakt nennt den Vorkontakt UND wiederholt alle Angaben', () => {
  // Abweichung von §13, das die Selbstvorstellung weglassen will: der
  // Empfaenger soll nicht in einer alten Mail nachsehen muessen.
  const p = payload({ rooms: 2 });
  const erst = renderVerwaltung(p, echtesProfil);
  const zweit = renderVerwaltung(p, echtesProfil, {
    previousContact: { sentAt: '2026-08-04', externalId: '161002345' },
  });
  assert.match(erst.body, /Kurz zu mir/);
  assert.match(zweit.body, /Kurz zu mir/);
  assert.match(zweit.body, /Einkommen:/);
  assert.match(zweit.body, /bereits um das Objekt 161002345 beworben/);
  assert.match(zweit.body, /4\. August 2026/);
});

test('Zweitkontakt ohne echte Vor-Objektnummer bleibt allgemein', () => {
  const d = renderVerwaltung(payload(), echtesProfil, {
    previousContact: { sentAt: '2026-08-04', externalId: 'url:x.de/y' },
  });
  assert.equal(d.body.includes('url:'), false);
  assert.match(d.body, /bereits um eine andere Wohnung beworben/);
});

test('Einkommen wird aufgeschluesselt, wenn es einen Nebenverdienst gibt', () => {
  const mitNeben = renderVerwaltung(payload(), {
    ...echtesProfil, nettoeinkommenEur: 3500, nebeneinkommenEur: 400,
    nebeneinkommenArt: 'freiberuflicher Tätigkeit',
  });
  assert.match(mitNeben.body, /ca\. 3\.900 € netto monatlich/);
  assert.match(mitNeben.body, /3\.500 € aus fester Anstellung/);
  assert.match(mitNeben.body, /400 € aus freiberuflicher Tätigkeit/);

  const ohne = renderVerwaltung(payload(), { ...echtesProfil, nebeneinkommenEur: 0 });
  assert.match(ohne.body, /3\.000 € netto monatlich aus fester Anstellung/);
  assert.equal(ohne.body.includes('dazu ca.'), false);
});

test('Arbeitgeber wird nur genannt, wenn er im Profil steht', () => {
  const ohne = renderVerwaltung(payload(), echtesProfil);
  assert.equal(ohne.body.includes(' bei '), false);
  const mit = renderVerwaltung(payload(), { ...echtesProfil, arbeitgeber: 'Firma GmbH' });
  assert.match(mit.body, /Entwickler bei Firma GmbH, unbefristet/);
});

test('Adresshinweis und Links erscheinen nur, wenn gesetzt', () => {
  const ohne = renderVerwaltung(payload(), echtesProfil);
  assert.equal(ohne.body.includes('Zur Adresse'), false);
  assert.equal(ohne.body.includes('persönlichen Eindruck'), false);

  const mit = renderVerwaltung(payload(), {
    ...echtesProfil,
    hinweisAdresse: 'Ich ziehe aus München zurück nach Berlin.',
    links: [{ label: 'LinkedIn', url: 'https://example.com/a' }],
  });
  assert.match(mit.body, /- Zur Adresse: Ich ziehe aus München/);
  assert.match(mit.body, /- LinkedIn: https:\/\/example\.com\/a/);
});

test('ein eingesetzter Block reisst keine Leerzeile in die Liste', () => {
  const d = renderVerwaltung(payload(), {
    ...echtesProfil, hinweisAdresse: 'Umzug aus München.',
  });
  assert.equal(
    /- Einzug: [^\n]*\n\n- Zur Adresse/.test(d.body),
    false,
    'zwischen zwei Listenpunkten steht eine Leerzeile',
  );
  assert.match(d.body, /- Einzug: [^\n]*\n- Zur Adresse/);
});

test('Beispielprofil blockiert den Versand', () => {
  const d = renderVerwaltung(payload(), { ...echtesProfil, status: 'beispiel' });
  assert.ok(d.blockers.some((b) => /beispiel/i.test(b)));
});

test('WBS-Pflicht ohne WBS blockiert', () => {
  const d = renderVerwaltung(payload({ wbs_required: true }), echtesProfil);
  assert.ok(d.blockers.some((b) => /WBS/.test(b)));
  const ok = renderVerwaltung(payload({ wbs_required: true }), { ...echtesProfil, wbs: true });
  assert.equal(ok.blockers.length, 0);
});

test('unpersoenliche Anrede, wenn keine Ansprechperson dasteht', () => {
  const d = renderVerwaltung(payload({}, null), echtesProfil);
  assert.match(d.body, /^Sehr geehrte Damen und Herren,/);
  assert.equal(d.personalSalutation, false);
});

test('kein Draft enthaelt einen unaufgeloesten Platzhalter', () => {
  const d = renderVerwaltung(payload({ rooms: 2 }), echtesProfil);
  assert.equal(/\{\{|\}\}/.test(d.body), false);
  assert.equal(/\{\{|\}\}/.test(d.subject), false);
});

// Gegen echte, gecachte Extraktionen — nur wenn vorhanden.
test('alle gecachten Payloads ergeben einen gueltigen Draft', { skip: !existsSync(PAYLOAD_DIR) }, () => {
  const files = readdirSync(PAYLOAD_DIR).filter((f) => f.endsWith('.json'));
  assert.ok(files.length > 0, 'keine Payloads in data/payloads/');
  for (const file of files) {
    const p = JSON.parse(readFileSync(resolve(PAYLOAD_DIR, file), 'utf8')) as Payload;
    const d = renderVerwaltung(p, echtesProfil);
    assert.ok(d.wordCount <= WORD_LIMIT, `${file}: ${d.wordCount} Wörter`);
    assert.equal(/\{\{/.test(d.body), false, `${file}: Platzhalter uebrig`);
    assert.equal(d.subject.includes('url:'), false, `${file}: Ersatzschluessel im Betreff`);
    assert.match(d.body, /Mit freundlichen Grüßen/, `${file}: kein Gruss`);
  }
});
