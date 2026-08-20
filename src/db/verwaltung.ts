/**
 * Der Firmen-Cache (§3). Die einzige teure Operation im System ist
 * Firmenname -> verifizierte Vermietungsadresse; hier liegt ihr Ergebnis.
 */
import type { Db } from './index.ts';
import { normalizeCompanyName, normalizeLoose } from '../lib/normalize.ts';

export type FirmType = 'verwaltung' | 'makler' | 'gesellschaft' | 'genossenschaft' | 'privat' | 'unknown';
export type Confidence = 'verified' | 'high' | 'medium' | 'low' | 'none';

/** §6: verbindliche Ordnung. `verified` steht über jedem Recherche-Ergebnis. */
export const CONFIDENCE_RANK: Readonly<Record<Confidence, number>> = {
  verified: 4, high: 3, medium: 2, low: 1, none: 0,
};

export function isWeakerThan(a: Confidence, b: Confidence): boolean {
  return CONFIDENCE_RANK[a] < CONFIDENCE_RANK[b];
}

export interface VerwaltungRow {
  id: number;
  name_canonical: string;
  name_variants: string;
  firm_type: FirmType;
  domain: string | null;
  impressum_url: string | null;
  vermietung_url: string | null;
  email_vermietung: string | null;
  email_general: string | null;
  contact_persons: string;
  confidence: Confidence;
  portal_only: number;
  bounce_count: number;
  source: string | null;
  last_verified_at: string | null;
  created_at: string;
}

export interface Verwaltung extends Omit<VerwaltungRow, 'name_variants' | 'contact_persons' | 'portal_only'> {
  name_variants: string[];
  contact_persons: string[];
  portal_only: boolean;
}

function hydrate(row: VerwaltungRow): Verwaltung {
  const { name_variants, contact_persons, portal_only, ...rest } = row;
  return {
    ...rest,
    name_variants: JSON.parse(name_variants) as string[],
    contact_persons: JSON.parse(contact_persons) as string[],
    portal_only: portal_only === 1,
  };
}

/**
 * Cache-Lookup (§6): exakter Match auf `name_canonical`, sonst über die
 * gesammelten Schreibvarianten. Bei ~300 Zeilen genügt das.
 */
export function findVerwaltung(db: Db, nameRaw: string): Verwaltung | null {
  const canonical = normalizeCompanyName(nameRaw);
  if (!canonical) return null;

  const exact = db
    .prepare(`SELECT * FROM verwaltung WHERE name_canonical = ?`)
    .get(canonical) as VerwaltungRow | undefined;
  if (exact) return hydrate(exact);

  const loose = normalizeLoose(nameRaw);
  const candidates = db.prepare(`SELECT * FROM verwaltung`).all() as VerwaltungRow[];
  for (const row of candidates) {
    const variants = JSON.parse(row.name_variants) as string[];
    if (variants.some((v) => normalizeLoose(v) === loose)) return hydrate(row);
  }
  return null;
}

export interface VerwaltungUpsert {
  nameRaw: string;
  firm_type?: FirmType;
  domain?: string | null;
  impressum_url?: string | null;
  vermietung_url?: string | null;
  email_vermietung?: string | null;
  email_general?: string | null;
  contact_persons?: string[];
  confidence?: Confidence;
  portal_only?: boolean;
  source?: string | null;
}

/**
 * Anlegen oder aktualisieren.
 *
 * Ein bestehender Eintrag mit stärkerer Konfidenz wird **nicht**
 * überschrieben (§17): `verified` bedeutet, dass eine echte Antwort von der
 * Adresse kam oder ich sie von Hand bestätigt habe. Kein Recherchelauf darf
 * das zurückstufen.
 */
export function upsertVerwaltung(db: Db, input: VerwaltungUpsert): { id: number; skipped: boolean } {
  const canonical = normalizeCompanyName(input.nameRaw);
  if (!canonical) throw new Error(`Firmenname ergibt keinen Schlüssel: ${JSON.stringify(input.nameRaw)}`);

  const existing = db
    .prepare(`SELECT * FROM verwaltung WHERE name_canonical = ?`)
    .get(canonical) as VerwaltungRow | undefined;

  const incoming = input.confidence ?? 'none';

  if (!existing) {
    const info = db
      .prepare(
        `INSERT INTO verwaltung
           (name_canonical, name_variants, firm_type, domain, impressum_url, vermietung_url,
            email_vermietung, email_general, contact_persons, confidence, portal_only, source)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        canonical,
        JSON.stringify([input.nameRaw]),
        input.firm_type ?? 'unknown',
        input.domain ?? null,
        input.impressum_url ?? null,
        input.vermietung_url ?? null,
        input.email_vermietung ?? null,
        input.email_general ?? null,
        JSON.stringify(input.contact_persons ?? []),
        incoming,
        input.portal_only ? 1 : 0,
        input.source ?? null,
      );
    return { id: Number(info.lastInsertRowid), skipped: false };
  }

  // Schreibvariante immer mitnehmen, auch wenn sonst nichts übernommen wird.
  const variants = new Set(JSON.parse(existing.name_variants) as string[]);
  variants.add(input.nameRaw);
  db.prepare(`UPDATE verwaltung SET name_variants = ? WHERE id = ?`)
    .run(JSON.stringify([...variants]), existing.id);

  if (isWeakerThan(incoming, existing.confidence) || existing.confidence === 'verified') {
    return { id: existing.id, skipped: true };
  }

  db.prepare(
    `UPDATE verwaltung SET
       firm_type = ?, domain = ?, impressum_url = ?, vermietung_url = ?,
       email_vermietung = ?, email_general = ?, contact_persons = ?,
       confidence = ?, portal_only = ?, source = COALESCE(?, source),
       last_verified_at = datetime('now')
     WHERE id = ?`,
  ).run(
    input.firm_type ?? existing.firm_type,
    input.domain ?? existing.domain,
    input.impressum_url ?? existing.impressum_url,
    input.vermietung_url ?? existing.vermietung_url,
    input.email_vermietung ?? existing.email_vermietung,
    input.email_general ?? existing.email_general,
    JSON.stringify(input.contact_persons ?? (JSON.parse(existing.contact_persons) as string[])),
    incoming,
    input.portal_only === undefined ? existing.portal_only : input.portal_only ? 1 : 0,
    input.source ?? null,
    existing.id,
  );
  return { id: existing.id, skipped: false };
}

/**
 * Handkorrektur aus der Firmen-Ansicht (§12).
 *
 * Setzt `confidence = 'verified'` — die stärkste Stufe, die kein
 * Recherchelauf mehr überschreibt (§6). Das ist der einzige Weg, einen
 * falschen Cache-Eintrag dauerhaft zu reparieren, und deshalb geht er
 * bewusst nicht über `upsertVerwaltung`: dort würde die Konfidenzprüfung
 * greifen, die hier gerade nicht gelten soll.
 */
export interface ManualFix {
  firm_type?: FirmType;
  email_vermietung?: string | null;
  email_general?: string | null;
  domain?: string | null;
  vermietung_url?: string | null;
  portal_only?: boolean;
}

export function correctVerwaltung(db: Db, id: number, fix: ManualFix): Verwaltung | null {
  const existing = db.prepare(`SELECT * FROM verwaltung WHERE id = ?`).get(id) as
    | VerwaltungRow
    | undefined;
  if (!existing) return null;

  db.prepare(
    `UPDATE verwaltung SET
       firm_type = ?, email_vermietung = ?, email_general = ?, domain = ?,
       vermietung_url = ?, portal_only = ?,
       confidence = 'verified', last_verified_at = datetime('now')
     WHERE id = ?`,
  ).run(
    fix.firm_type ?? existing.firm_type,
    fix.email_vermietung === undefined ? existing.email_vermietung : fix.email_vermietung,
    fix.email_general === undefined ? existing.email_general : fix.email_general,
    fix.domain === undefined ? existing.domain : fix.domain,
    fix.vermietung_url === undefined ? existing.vermietung_url : fix.vermietung_url,
    fix.portal_only === undefined ? existing.portal_only : fix.portal_only ? 1 : 0,
    id,
  );

  const row = db.prepare(`SELECT * FROM verwaltung WHERE id = ?`).get(id) as VerwaltungRow;
  return hydrate(row);
}

export function listVerwaltung(db: Db, limit = 500): Verwaltung[] {
  return (
    db.prepare(`SELECT * FROM verwaltung ORDER BY name_canonical LIMIT ?`).all(limit) as VerwaltungRow[]
  ).map(hydrate);
}

/**
 * §10: "Eine eingegangene Antwort setzt confidence = 'verified' für die
 * Firma, auch bei Absage. Nachrichten stoppen, der Cache lernt weiter."
 */
export function markVerified(db: Db, id: number): void {
  db.prepare(
    `UPDATE verwaltung SET confidence = 'verified', last_verified_at = datetime('now') WHERE id = ?`,
  ).run(id);
}

/** §10: Bounce — bounce_count++, Konfidenz zurückstufen. */
export function recordBounce(db: Db, id: number): void {
  db.prepare(
    `UPDATE verwaltung SET bounce_count = bounce_count + 1,
       confidence = CASE confidence WHEN 'verified' THEN 'low' WHEN 'high' THEN 'low' ELSE 'none' END
     WHERE id = ?`,
  ).run(id);
}
