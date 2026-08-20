import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, applySchema } from '../src/db/index.ts';
import { insertSeed, takeBatch, seedStats, openQuarantine, type SeedRow } from '../src/db/seed.ts';
import { findVerwaltung, upsertVerwaltung, isWeakerThan, CONFIDENCE_RANK } from '../src/db/verwaltung.ts';
import { importPrewarm, summarize, ImportRejected, isValidEmail, domainsMatch } from '../src/lib/prewarm-import.ts';

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'wobo-pw-'));
  const db = openDb(join(dir, 'test.db'));
  applySchema(db);
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const ROW = {
  name_input: 'Meyer & Co. Hausverwaltung GmbH',
  domain: 'meyer-hv.de',
  impressum_url: 'https://meyer-hv.de/impressum',
  vermietung_url: null,
  email_vermietung: 'vermietung@meyer-hv.de',
  email_general: 'info@meyer-hv.de',
  contact_persons: ['Frau S. Kruse'],
  firm_type: 'verwaltung',
  portal_only: false,
  confidence: 'high',
  evidence: 'mailto im Impressum',
};

function withBatch(db: ReturnType<typeof openDb>, names: string[]): SeedRow[] {
  for (const name of names) insertSeed(db, { name_raw: name, origin: 'places', priority: 2 });
  return takeBatch(db, names.length);
}

// ---------------------------------------------------------------- Konfidenz

test('Konfidenz-Ordnung ist die aus §6', () => {
  assert.deepEqual(CONFIDENCE_RANK, { verified: 4, high: 3, medium: 2, low: 1, none: 0 });
  assert.equal(isWeakerThan('medium', 'high'), true);
  assert.equal(isWeakerThan('high', 'verified'), true);
  assert.equal(isWeakerThan('high', 'high'), false);
});

// ---------------------------------------------------------------- Cache

test('Cache findet ueber Schreibvarianten', () => {
  const { db, cleanup } = fresh();
  try {
    upsertVerwaltung(db, { nameRaw: 'Meyer & Co. Hausverwaltung GmbH', confidence: 'high' });
    assert.ok(findVerwaltung(db, 'Meyer und Co. Hausverwaltung GmbH'));
    assert.ok(findVerwaltung(db, 'MEYER & CO HAUSVERWALTUNG'));
    assert.equal(findVerwaltung(db, 'Bergmann Immobilien'), null);
  } finally { cleanup(); }
});

test('verified wird von keiner Recherche ueberschrieben (§17)', () => {
  const { db, cleanup } = fresh();
  try {
    upsertVerwaltung(db, {
      nameRaw: 'Meyer Hausverwaltung', email_vermietung: 'echt@meyer.de', confidence: 'verified',
    });
    const { skipped } = upsertVerwaltung(db, {
      nameRaw: 'Meyer Hausverwaltung', email_vermietung: 'geraten@meyer.de', confidence: 'high',
    });
    assert.equal(skipped, true);
    assert.equal(findVerwaltung(db, 'Meyer Hausverwaltung')!.email_vermietung, 'echt@meyer.de');
  } finally { cleanup(); }
});

test('schwaechere Konfidenz ueberschreibt nicht, staerkere schon', () => {
  const { db, cleanup } = fresh();
  try {
    upsertVerwaltung(db, { nameRaw: 'Meyer', email_general: 'a@meyer.de', confidence: 'medium' });
    upsertVerwaltung(db, { nameRaw: 'Meyer', email_general: 'b@meyer.de', confidence: 'low' });
    assert.equal(findVerwaltung(db, 'Meyer')!.email_general, 'a@meyer.de');
    upsertVerwaltung(db, { nameRaw: 'Meyer', email_general: 'c@meyer.de', confidence: 'high' });
    assert.equal(findVerwaltung(db, 'Meyer')!.email_general, 'c@meyer.de');
  } finally { cleanup(); }
});

test('Schreibvariante wird auch dann gemerkt, wenn sonst nichts uebernommen wird', () => {
  const { db, cleanup } = fresh();
  try {
    upsertVerwaltung(db, { nameRaw: 'Meyer Hausverwaltung GmbH', confidence: 'verified' });
    upsertVerwaltung(db, { nameRaw: 'Meyer Hausverwaltung', confidence: 'low' });
    const v = findVerwaltung(db, 'Meyer Hausverwaltung')!;
    assert.ok(v.name_variants.includes('Meyer Hausverwaltung'));
    assert.ok(v.name_variants.includes('Meyer Hausverwaltung GmbH'));
  } finally { cleanup(); }
});

// ---------------------------------------------------------------- seed_company

test('insertSeed dedupliziert ueber name_canonical', () => {
  const { db, cleanup } = fresh();
  try {
    assert.equal(insertSeed(db, { name_raw: 'Meyer & Co. Hausverwaltung GmbH', origin: 'places', priority: 3 }).created, true);
    assert.equal(insertSeed(db, { name_raw: 'Meyer und Co Hausverwaltung', origin: 'places', priority: 3 }).created, false);
    assert.equal(seedStats(db).pending, 1);
  } finally { cleanup(); }
});

test('ein echtes Inserat verschaerft die Prioritaet (§17)', () => {
  const { db, cleanup } = fresh();
  try {
    insertSeed(db, { name_raw: 'Meyer Hausverwaltung', origin: 'places', priority: 3 });
    insertSeed(db, { name_raw: 'Meyer Hausverwaltung', origin: 'listing', priority: 1 });
    assert.deepEqual(seedStats(db).byPriority, { 1: 1 });
    // Zurueckstufen darf sie niemand.
    insertSeed(db, { name_raw: 'Meyer Hausverwaltung', origin: 'places', priority: 4 });
    assert.deepEqual(seedStats(db).byPriority, { 1: 1 });
  } finally { cleanup(); }
});

test('takeBatch liefert nach Prioritaet und markiert in_progress', () => {
  const { db, cleanup } = fresh();
  try {
    insertSeed(db, { name_raw: 'Drei', origin: 'places', priority: 3 });
    insertSeed(db, { name_raw: 'Eins', origin: 'listing', priority: 1 });
    insertSeed(db, { name_raw: 'Zwei', origin: 'places', priority: 2 });
    const batch = takeBatch(db, 2);
    assert.deepEqual(batch.map((r) => r.name_raw), ['Eins', 'Zwei']);
    const stats = seedStats(db);
    assert.equal(stats.in_progress, 2);
    assert.equal(stats.pending, 1);
    // Ein zweiter Export darf dieselben Firmen nicht noch einmal ausgeben.
    assert.deepEqual(takeBatch(db, 5).map((r) => r.name_raw), ['Drei']);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------- Hilfen

test('E-Mail-Syntax', () => {
  assert.equal(isValidEmail('vermietung@meyer-hv.de'), true);
  assert.equal(isValidEmail('a.b+c@sub.meyer-hv.de'), true);
  assert.equal(isValidEmail('vermietung(at)meyer-hv.de'), false);
  assert.equal(isValidEmail('vermietung@meyer'), false);
  assert.equal(isValidEmail('kein text'), false);
  assert.equal(isValidEmail('a@b.de, c@d.de'), false);
});

test('Domainabgleich erlaubt Subdomains', () => {
  assert.equal(domainsMatch('meyer-hv.de', 'meyer-hv.de'), true);
  assert.equal(domainsMatch('mail.meyer-hv.de', 'meyer-hv.de'), true);
  assert.equal(domainsMatch('meyer-hv.de', 'www.meyer-hv.de'), true);
  assert.equal(domainsMatch('meyer-hv.de', 'https://www.meyer-hv.de/impressum'), true);
  assert.equal(domainsMatch('gmail.com', 'meyer-hv.de'), false);
});

// ---------------------------------------------------------------- Import

test('sauberer Import landet in verwaltung', () => {
  const { db, cleanup } = fresh();
  try {
    const batch = withBatch(db, [ROW.name_input]);
    const out = importPrewarm(db, JSON.stringify([ROW]), batch);
    assert.equal(out.accepted.length, 1);
    assert.deepEqual(out.quarantined, []);
    assert.deepEqual(out.missing, []);
    const v = findVerwaltung(db, ROW.name_input)!;
    assert.equal(v.email_vermietung, 'vermietung@meyer-hv.de');
    assert.equal(v.firm_type, 'verwaltung');
    assert.equal(v.confidence, 'high');
    assert.equal(v.source, 'prewarm');
    assert.equal(seedStats(db).done, 1);
  } finally { cleanup(); }
});

test('kein JSON-Array => ganzer Import abgelehnt (§17)', () => {
  const { db, cleanup } = fresh();
  try {
    const batch = withBatch(db, ['Meyer']);
    assert.throws(() => importPrewarm(db, 'kaputt', batch), ImportRejected);
    assert.throws(() => importPrewarm(db, '{"a":1}', batch), /Array/);
    // Nichts darf geschrieben worden sein.
    assert.equal(findVerwaltung(db, 'Meyer'), null);
  } finally { cleanup(); }
});

test('ungueltige E-Mail => Quarantaene statt verwaltung', () => {
  const { db, cleanup } = fresh();
  try {
    const batch = withBatch(db, [ROW.name_input]);
    const out = importPrewarm(db, JSON.stringify([{ ...ROW, email_vermietung: 'vermietung(at)meyer-hv.de' }]), batch);
    assert.equal(out.accepted.length, 0);
    assert.equal(out.quarantined.length, 1);
    assert.match(out.quarantined[0]!.reasons[0]!, /gültige E-Mail/);
    assert.equal(findVerwaltung(db, ROW.name_input), null);
    assert.equal(openQuarantine(db).length, 1);
  } finally { cleanup(); }
});

test('Domain passt nicht zur E-Mail => Quarantaene', () => {
  const { db, cleanup } = fresh();
  try {
    const batch = withBatch(db, [ROW.name_input]);
    const out = importPrewarm(db, JSON.stringify([{ ...ROW, email_vermietung: 'vermietung@ganz-andere.de' }]), batch);
    assert.equal(out.quarantined.length, 1);
    assert.match(out.quarantined[0]!.reasons[0]!, /passt nicht zur Domain/);
  } finally { cleanup(); }
});

test('E-Mail vorhanden aber confidence none => widerspruechlich, Quarantaene', () => {
  const { db, cleanup } = fresh();
  try {
    const batch = withBatch(db, [ROW.name_input]);
    const out = importPrewarm(db, JSON.stringify([{ ...ROW, confidence: 'none' }]), batch);
    assert.equal(out.quarantined.length, 1);
    assert.match(out.quarantined[0]!.reasons.join(' '), /widersprüchlich/);
  } finally { cleanup(); }
});

test('unbekannter firm_type wird korrigiert statt abgelehnt', () => {
  const { db, cleanup } = fresh();
  try {
    const batch = withBatch(db, [ROW.name_input]);
    const out = importPrewarm(db, JSON.stringify([{ ...ROW, firm_type: 'bauherr' }]), batch);
    assert.equal(out.accepted.length, 1);
    assert.equal(out.coerced.length, 1);
    assert.equal(findVerwaltung(db, ROW.name_input)!.firm_type, 'unknown');
  } finally { cleanup(); }
});

test('unbekannte confidence wird zu none — und macht die Zeile dadurch widerspruechlich', () => {
  const { db, cleanup } = fresh();
  try {
    const batch = withBatch(db, [ROW.name_input]);
    const out = importPrewarm(db, JSON.stringify([{ ...ROW, confidence: 'ziemlich sicher' }]), batch);
    assert.equal(out.coerced.length, 1);
    assert.equal(out.quarantined.length, 1);
  } finally { cleanup(); }
});

test('nicht angeforderte Firma => Quarantaene, nicht stiller Cache-Eintrag', () => {
  const { db, cleanup } = fresh();
  try {
    const batch = withBatch(db, ['Meyer Hausverwaltung']);
    const out = importPrewarm(db, JSON.stringify([{ ...ROW, name_input: 'Ganz Andere GmbH' }]), batch);
    assert.equal(out.quarantined.length, 1);
    assert.match(out.quarantined[0]!.reasons[0]!, /keiner angeforderten Firma/);
    assert.equal(findVerwaltung(db, 'Ganz Andere GmbH'), null);
  } finally { cleanup(); }
});

test('fehlende Antwort bleibt pending und kommt in den naechsten Batch (§17)', () => {
  const { db, cleanup } = fresh();
  try {
    const batch = withBatch(db, [ROW.name_input, 'Vergessene Verwaltung GmbH']);
    const out = importPrewarm(db, JSON.stringify([ROW]), batch);
    assert.equal(out.accepted.length, 1);
    assert.deepEqual(out.missing, ['Vergessene Verwaltung GmbH']);
    assert.equal(seedStats(db).pending, 1);
    assert.deepEqual(takeBatch(db, 5).map((r) => r.name_raw), ['Vergessene Verwaltung GmbH']);
  } finally { cleanup(); }
});

test('Import ist zeilenweise, nicht alles-oder-nichts (§17)', () => {
  const { db, cleanup } = fresh();
  try {
    const batch = withBatch(db, ['Gut GmbH', 'Kaputt GmbH', 'Fehlt GmbH']);
    const out = importPrewarm(db, JSON.stringify([
      { ...ROW, name_input: 'Gut GmbH', domain: 'gut.de', email_vermietung: 'v@gut.de', email_general: null },
      { ...ROW, name_input: 'Kaputt GmbH', domain: 'kaputt.de', email_vermietung: 'nicht-mal-eine-mail', email_general: null },
    ]), batch);
    assert.equal(out.accepted.length, 1);
    assert.equal(out.quarantined.length, 1);
    assert.deepEqual(out.missing, ['Fehlt GmbH']);
    assert.equal(summarize(out), '1 übernommen, 1 in Quarantäne, 1 fehlt');
    assert.ok(findVerwaltung(db, 'Gut GmbH'));
  } finally { cleanup(); }
});

test('name_canonical kommt aus dem Dienst, nicht aus der Cowork-Ausgabe (§17)', () => {
  const { db, cleanup } = fresh();
  try {
    const batch = withBatch(db, ['Meyer & Co. Hausverwaltung GmbH']);
    // Cowork antwortet mit einer anderen Schreibweise und schmuggelt ein
    // eigenes name_canonical mit. Beides darf nichts aendern.
    const out = importPrewarm(db, JSON.stringify([
      { ...ROW, name_input: 'Meyer und Co Hausverwaltung', name_canonical: 'voellig-falsch' },
    ]), batch);
    assert.equal(out.accepted.length, 1);
    assert.equal(findVerwaltung(db, 'Meyer & Co. Hausverwaltung GmbH')!.name_canonical, 'meyer');
  } finally { cleanup(); }
});

test('bestehender verified-Eintrag wird gemeldet, nicht ueberschrieben', () => {
  const { db, cleanup } = fresh();
  try {
    upsertVerwaltung(db, {
      nameRaw: ROW.name_input, email_vermietung: 'echt@meyer-hv.de', confidence: 'verified',
    });
    const batch = withBatch(db, [ROW.name_input]);
    const out = importPrewarm(db, JSON.stringify([ROW]), batch);
    assert.deepEqual(out.skippedVerified, [ROW.name_input]);
    assert.equal(out.accepted.length, 0);
    assert.equal(findVerwaltung(db, ROW.name_input)!.email_vermietung, 'echt@meyer-hv.de');
  } finally { cleanup(); }
});

test('Zeile ohne name_input geht in Quarantaene', () => {
  const { db, cleanup } = fresh();
  try {
    const batch = withBatch(db, ['Meyer']);
    const out = importPrewarm(db, JSON.stringify([{ email_general: 'a@b.de' }]), batch);
    assert.equal(out.quarantined.length, 1);
    assert.match(out.quarantined[0]!.reasons[0]!, /name_input/);
  } finally { cleanup(); }
});

test('Firma ohne Fund wird sauber uebernommen (alles null, confidence none)', () => {
  const { db, cleanup } = fresh();
  try {
    const batch = withBatch(db, ['Unauffindbar GmbH']);
    const out = importPrewarm(db, JSON.stringify([{
      name_input: 'Unauffindbar GmbH', domain: null, impressum_url: null, vermietung_url: null,
      email_vermietung: null, email_general: null, contact_persons: [],
      firm_type: 'unknown', portal_only: false, confidence: 'none', evidence: 'keine Website gefunden',
    }]), batch);
    assert.equal(out.accepted.length, 1);
    assert.deepEqual(out.quarantined, []);
    assert.equal(findVerwaltung(db, 'Unauffindbar GmbH')!.confidence, 'none');
  } finally { cleanup(); }
});

// ---------------------------------------------------------- Grounding-Quote

test('Freikontingent wird verbraucht, dann wird abgerechnet (§11)', async () => {
  const { settleGrounding, groundingStats } = await import('../src/db/grounding.ts');
  const { db, cleanup } = fresh();
  try {
    const at = new Date('2026-08-20T12:00:00Z');
    // 5.000 frei pro Monat auf der 3.x-Familie.
    const first = settleGrounding(db, 5, { at });
    assert.equal(first.billableQueries, 0, 'die ersten Anfragen sind frei');
    assert.equal(first.groundingUsd, 0);
    assert.ok(first.conservativeUsd > 0, 'die konservative Schätzung liegt darüber');
    assert.equal(first.freeRemaining, 4995);

    // Kontingent aufbrauchen.
    settleGrounding(db, 4990, { at });
    assert.equal(groundingStats(db, { at }).freeRemaining, 5);

    // Jetzt liegt ein Teil darüber.
    const straddle = settleGrounding(db, 8, { at });
    assert.equal(straddle.billableQueries, 3);
    assert.ok(Math.abs(straddle.groundingUsd - (3 / 1000) * 14) < 1e-12);
    assert.equal(straddle.freeRemaining, 0);

    // Danach kostet alles.
    assert.equal(settleGrounding(db, 10, { at }).billableQueries, 10);
  } finally { cleanup(); }
});

test('das Kontingent gilt pro Monat', async () => {
  const { settleGrounding, groundingStats } = await import('../src/db/grounding.ts');
  const { db, cleanup } = fresh();
  try {
    settleGrounding(db, 5000, { at: new Date('2026-08-20T12:00:00Z') });
    assert.equal(groundingStats(db, { at: new Date('2026-08-31T23:00:00Z') }).freeRemaining, 0);
    assert.equal(groundingStats(db, { at: new Date('2026-09-01T00:00:00Z') }).freeRemaining, 5000);
  } finally { cleanup(); }
});

test('ein realer Recherchelauf kostet unter Kontingent fast nichts', async () => {
  const { settleGrounding } = await import('../src/db/grounding.ts');
  const { priceCall } = await import('../src/llm/pricing.ts');
  const { db, cleanup } = fresh();
  try {
    // Gemessener Lauf vom 2026-08-20 gegen habitare.
    const usage = {
      inputTokens: 2014, outputTokens: 1005, thinkingTokens: 1158,
      cachedInputTokens: 456, searchQueries: 5,
    };
    const konservativ = priceCall('gemini-3.7-flash', usage, { at: new Date('2026-08-20') });
    const ohneSuche = priceCall('gemini-3.7-flash', usage, {
      at: new Date('2026-08-20'), groundingBillable: false,
    });
    const settle = settleGrounding(db, 5, { at: new Date('2026-08-20') });

    assert.ok(konservativ.totalUsd > 0.07, 'konservativ sind es ~$0,08');
    assert.ok(ohneSuche.totalUsd < 0.011, 'ohne Suchkosten ~$0,0096');
    assert.equal(settle.billableQueries, 0, 'im Kontingent kostet die Suche nichts');
  } finally { cleanup(); }
});

// ------------------------------------------------- Recherche-Aufgabe bauen

test('keine geratenen Pfade in der Rechercheaufgabe', async () => {
  const { buildFirmaTask, knownSiteUrl, bareDomain } = await import('../src/stages/research-firma.ts');
  const task = buildFirmaTask({
    name: 'habitare Immobilien IVD',
    websiteHint: 'www.habitare-immobilien.de',
    contactPerson: 'Herr Björn Tölken',
  });

  // Genau eine URL, und die ist bekannt — nicht geraten.
  const urls = task.match(/https:\/\/\S+/g) ?? [];
  assert.deepEqual(urls, ['https://www.habitare-immobilien.de']);
  for (const geraten of ['/team', '/impressum', '/unternehmen', '/ueber-uns']) {
    assert.equal(task.includes(`de${geraten}`), false, `geratener Pfad ${geraten} im Task`);
  }

  // Stattdessen site:-Suchen, inklusive der Person aus dem Inserat.
  assert.match(task, /site:habitare-immobilien\.de Impressum/);
  assert.match(task, /site:habitare-immobilien\.de Team OR Mitarbeiter/);
  assert.match(task, /"Björn Tölken" habitare-immobilien\.de/);
  assert.equal(task.includes('Herr Björn Tölken" habitare'), false, 'Anrede gehoert nicht in die Suche');

  assert.equal(knownSiteUrl('https://www.x.de/pfad?a=1'), 'https://www.x.de');
  assert.equal(bareDomain('https://www.x.de/pfad'), 'x.de');
  assert.equal(knownSiteUrl('kein host'), null);
  assert.equal(knownSiteUrl(null), null);
});

test('website_raw kommt aus Seitentext und ist unsauber', async () => {
  const { knownSiteUrl } = await import('../src/stages/research-firma.ts');

  // Der Fall, der es in einen echten Lauf geschafft hat: ein Markdown-Link.
  // Die alte Fassung machte daraus "https://[www.habitare-immobilien.de](https:",
  // das urlContext-Werkzeug verwarf ihn still, und im Protokoll stand nur
  // "per urlContext geholt: 0".
  assert.equal(
    knownSiteUrl('[www.habitare-immobilien.de](https://www.habitare-immobilien.de)'),
    'https://www.habitare-immobilien.de',
  );

  for (const [input, want] of [
    ['Web: habitare-immobilien.de.', 'https://habitare-immobilien.de'],
    ['Homepage www.firma.de', 'https://www.firma.de'],
    ['Unsere Seite: firma.de!', 'https://firma.de'],
    ['<https://firma.de>', 'https://firma.de'],
    ['https://firma.de/angebote?x=1#top', 'https://firma.de'],
  ] as Array<[string, string]>) {
    assert.equal(knownSiteUrl(input), want, `fuer ${JSON.stringify(input)}`);
  }

  // Was keine Website ist, muss null bleiben — sonst baut der Task eine
  // site:-Suche auf Unsinn und verschenkt den Versuch.
  for (const input of [
    'Besuchen Sie unsere Website!', 'info@firma.de', 'firma', 'firma.d', '', '   ', 'keine Angabe',
  ]) {
    assert.equal(knownSiteUrl(input), null, `fuer ${JSON.stringify(input)}`);
  }
});

test('eine Muell-Website erzeugt keine site:-Suche', async () => {
  const { buildFirmaTask } = await import('../src/stages/research-firma.ts');
  const task = buildFirmaTask({ name: 'Firma X', websiteHint: 'Besuchen Sie unsere Website!' });
  // Kein site: auf eine konkrete Domain — der Platzhalter site:<domain> im
  // Anweisungstext ist erlaubt und gewollt.
  assert.equal(/site:[a-z0-9-]+\.[a-z]/.test(task), false, task);
  assert.equal(task.includes('https://'), false);
  assert.match(task, /Website dieser Firma ist nicht bekannt/);
});

test('ohne bekannte Website wird zuerst die Website gesucht', async () => {
  const { buildFirmaTask } = await import('../src/stages/research-firma.ts');
  const task = buildFirmaTask({
    name: 'Hausverwaltung Schmidt',
    addressHint: 'Danziger Str. 12, 10435 Berlin',
    contactPerson: 'Frau Kruse',
  });
  // Keine erfundene URL, keine site:-Suche auf eine unbekannte Domain.
  assert.equal(task.includes('https://'), false);
  assert.equal(/site:\S+\./.test(task), false);
  // Stattdessen: Strategie zum Auffinden der Seite.
  assert.match(task, /Website dieser Firma ist nicht bekannt/);
  assert.match(task, /"Hausverwaltung Schmidt" Impressum/);
  assert.match(task, /"Kruse" "Hausverwaltung Schmidt"/);
  assert.match(task, /Branchenverzeichnissen/);
  assert.match(task, /höchstens confidence "low"/);
});

test('Timeouts sind per .env überschreibbar', async () => {
  const { stageTimeoutMs } = await import('../src/llm/registry.ts');
  assert.equal(stageTimeoutMs('research_firma', {}), 90_000);
  assert.equal(stageTimeoutMs('research_firma', { STAGE_TIMEOUT_RESEARCH_FIRMA: '150000' }), 150_000);
  assert.throws(
    () => stageTimeoutMs('research_firma', { STAGE_TIMEOUT_RESEARCH_FIRMA: '500' }),
    /Millisekunden/,
  );
  assert.throws(
    () => stageTimeoutMs('research_firma', { STAGE_TIMEOUT_RESEARCH_FIRMA: 'lang' }),
    /Millisekunden/,
  );
});

test('die Recherche bekommt mehr Zeit als §8 vorsieht — bewusst', async () => {
  const { stageTimeoutMs } = await import('../src/llm/registry.ts');
  // §8 nennt 20 s. Die Recherche laeuft einmal pro Firma und ihr Ergebnis
  // liegt danach dauerhaft im Cache — Qualitaet schlaegt hier Tempo.
  assert.ok(stageTimeoutMs('research_firma', {}) > 20_000);
  assert.ok(stageTimeoutMs('research_person', {}) > stageTimeoutMs('research_firma', {}));
  // Der Extract bleibt schnell: der steckt im 3-s-Budget von Flow A.
  assert.ok(stageTimeoutMs('extract', {}) <= 8_000);
});
