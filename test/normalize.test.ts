import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCompanyName, normalizeLoose } from '../src/lib/normalize.ts';

test('strippt Rechtsformen', () => {
  assert.equal(normalizeCompanyName('Meyer GmbH'), 'meyer');
  assert.equal(normalizeCompanyName('Meyer mbH'), 'meyer');
  assert.equal(normalizeCompanyName('Meyer AG'), 'meyer');
  assert.equal(normalizeCompanyName('Meyer e.K.'), 'meyer');
  assert.equal(normalizeCompanyName('Meyer eG'), 'meyer');
  assert.equal(normalizeCompanyName('Meyer GmbH & Co. KG'), 'meyer');
  assert.equal(normalizeCompanyName('Meyer UG (haftungsbeschränkt)'), 'meyer');
});

test('entfernt Branchenwörter', () => {
  assert.equal(normalizeCompanyName('Meyer Hausverwaltung'), 'meyer');
  assert.equal(normalizeCompanyName('Meyer Immobilien'), 'meyer');
  assert.equal(normalizeCompanyName('Meyer Verwaltung'), 'meyer');
  assert.equal(normalizeCompanyName('Meyer Immobilienverwaltung GmbH'), 'meyer');
});

test('& wird zu und, dangling und faellt weg', () => {
  assert.equal(normalizeCompanyName('Meyer & Schulze'), 'meyer und schulze');
  assert.equal(normalizeCompanyName('Meyer und Schulze'), 'meyer und schulze');
  assert.equal(normalizeCompanyName('Meyer&Schulze'), 'meyer und schulze');
  // "& Co." -> "und co" -> co ist Rechtsform -> dangling "und" muss weg
  assert.equal(normalizeCompanyName('Meyer & Co.'), 'meyer');
});

test('loest Umlaute auf', () => {
  assert.equal(normalizeCompanyName('Müller'), 'mueller');
  assert.equal(normalizeCompanyName('Schröder & Käthe'), 'schroeder und kaethe');
  assert.equal(normalizeCompanyName('Weiß'), 'weiss');
  assert.equal(normalizeCompanyName('Ährenfeld'), 'aehrenfeld');
});

test('loest sonstige Diakritika auf', () => {
  assert.equal(normalizeCompanyName('Société Réal'), 'societe real');
});

test('Satzzeichen und Whitespace', () => {
  assert.equal(normalizeCompanyName('  Meyer   -  Schulze  '), 'meyer schulze');
  assert.equal(normalizeCompanyName('Meyer, Schulze & Partner'), 'meyer schulze und partner');
  assert.equal(normalizeCompanyName('Meyer/Schulze'), 'meyer schulze');
});

test('Schreibweisen derselben Firma kollabieren auf einen Schluessel', () => {
  const variants = [
    'Meyer & Co. Hausverwaltung GmbH',
    'Meyer und Co. Hausverwaltung GmbH',
    'MEYER & CO. HAUSVERWALTUNG GMBH',
    'Meyer & Co Hausverwaltung',
    'meyer&co. hausverwaltung gmbh',
  ];
  const keys = new Set(variants.map(normalizeCompanyName));
  assert.equal(keys.size, 1, `erwartet 1 Schluessel, bekommen: ${[...keys].join(' | ')}`);
  assert.equal([...keys][0], 'meyer');
});

test('gibt nie leer zurueck, wenn der Input nicht leer ist', () => {
  // Nur Rausch-Tokens: wuerde das "" ergeben, kollabierten alle solchen
  // Firmen auf eine einzige Cache-Zeile.
  assert.equal(normalizeCompanyName('Hausverwaltung GmbH'), 'hausverwaltung');
  assert.equal(normalizeCompanyName('Immobilien Verwaltung'), 'immobilien verwaltung');
  assert.equal(normalizeCompanyName('GmbH'), 'gmbh');
  assert.notEqual(
    normalizeCompanyName('Hausverwaltung GmbH'),
    normalizeCompanyName('Immobilien Verwaltung'),
  );
});

test('leere und ungueltige Eingaben', () => {
  assert.equal(normalizeCompanyName(''), '');
  assert.equal(normalizeCompanyName('   '), '');
  assert.equal(normalizeCompanyName(null), '');
  assert.equal(normalizeCompanyName(undefined), '');
  assert.equal(normalizeCompanyName('...'), '');
});

test('behaelt Ziffern', () => {
  assert.equal(normalizeCompanyName('Hausverwaltung 24 GmbH'), '24');
  assert.equal(normalizeCompanyName('Berlin 1892 eG'), 'berlin 1892');
});

test('unterscheidet echte Firmen weiterhin', () => {
  const a = normalizeCompanyName('Berger Immobilien GmbH');
  const b = normalizeCompanyName('Berger Hausverwaltung GmbH');
  const c = normalizeCompanyName('Bergmann Immobilien GmbH');
  assert.equal(a, 'berger');
  assert.equal(b, 'berger'); // gewollt: dieselbe Firma, zwei Auftritte
  assert.notEqual(a, c);
});

test('normalizeLoose entfernt auch Leerzeichen', () => {
  assert.equal(normalizeLoose('Meyer & Schulze'), 'meyerundschulze');
  assert.equal(normalizeLoose('Meyer  Schulze'), 'meyerschulze');
});

test('ist idempotent', () => {
  for (const name of ['Meyer & Co. Hausverwaltung GmbH', 'Müller e.K.', 'Berlin 1892 eG']) {
    const once = normalizeCompanyName(name);
    assert.equal(normalizeCompanyName(once), once, `nicht idempotent fuer ${name}`);
  }
});
