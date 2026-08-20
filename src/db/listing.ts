/**
 * `listing_event` — ein Datensatz je erfasstem Inserat (§6).
 *
 * Der Zustandsautomat aus §10 lebt hier: welche Übergänge erlaubt sind und
 * was sie mitschreiben.
 */
import type { Db } from './index.ts';
import type { Payload } from '../stages/extract.ts';
import type { Branch, BranchConfidence } from '../lib/classify.ts';
import type { FraudRisk, FraudSignal } from '../stages/gate.ts';
import type { SendMode } from '../lib/send-mode.ts';

export type ListingState =
  | 'captured' | 'drafted' | 'queued' | 'cancelled' | 'manual'
  | 'sent' | 'bounced' | 'nudged' | 'handoff' | 'dead';

export interface ListingRow {
  id: number;
  external_id: string;
  source: string;
  url: string | null;
  verwaltung_id: number | null;
  branch: string;
  branch_confidence: string | null;
  payload: string;
  fraud_risk: string | null;
  fraud_signals: string;
  draft_subject: string | null;
  draft_body: string | null;
  used_hook: number;
  recipient: string | null;
  send_mode: string | null;
  state: ListingState;
  send_after: string | null;
  gmail_thread_id: string | null;
  cost_usd: number;
  sent_at: string | null;
  replied_at: string | null;
  outcome: string | null;
  created_at: string;
}

export interface Listing extends Omit<ListingRow, 'payload' | 'fraud_signals' | 'used_hook'> {
  payload: Payload;
  fraud_signals: FraudSignal[];
  used_hook: boolean;
}

export function hydrate(row: ListingRow): Listing {
  const { payload, fraud_signals, used_hook, ...rest } = row;
  return {
    ...rest,
    payload: JSON.parse(payload) as Payload,
    fraud_signals: JSON.parse(fraud_signals) as FraudSignal[],
    used_hook: used_hook === 1,
  };
}

/**
 * §4: "Doppelte Erfassung ist der Normalfall, kein Fehler."
 *
 * - weiter als `captured`/`drafted` -> nicht neu laufen lassen
 * - `captured` oder `drafted` -> Payload aktualisieren, Pipeline erneut
 */
export type CaptureDecision = 'created' | 'rerun' | 'existing';

const RERUNNABLE: ReadonlySet<ListingState> = new Set<ListingState>(['captured', 'drafted']);

export function findListing(db: Db, externalId: string, source: string): Listing | null {
  const row = db
    .prepare(`SELECT * FROM listing_event WHERE external_id = ? AND source = ?`)
    .get(externalId, source) as ListingRow | undefined;
  return row ? hydrate(row) : null;
}

export function getListing(db: Db, id: number): Listing | null {
  const row = db.prepare(`SELECT * FROM listing_event WHERE id = ?`).get(id) as ListingRow | undefined;
  return row ? hydrate(row) : null;
}

export interface UpsertCaptureInput {
  externalId: string;
  source: string;
  url: string | null;
  payload: Payload;
}

export function upsertCapture(
  db: Db,
  input: UpsertCaptureInput,
): { id: number; decision: CaptureDecision } {
  const existing = findListing(db, input.externalId, input.source);

  if (!existing) {
    const info = db
      .prepare(
        `INSERT INTO listing_event (external_id, source, url, branch, payload, state)
         VALUES (?,?,?,?,?,'captured')`,
      )
      .run(input.externalId, input.source, input.url, 'unbestimmt', JSON.stringify(input.payload));
    return { id: Number(info.lastInsertRowid), decision: 'created' };
  }

  if (!RERUNNABLE.has(existing.state)) {
    return { id: existing.id, decision: 'existing' };
  }

  db.prepare(`UPDATE listing_event SET payload = ?, url = COALESCE(?, url) WHERE id = ?`)
    .run(JSON.stringify(input.payload), input.url, existing.id);
  return { id: existing.id, decision: 'rerun' };
}

export interface DraftedInput {
  id: number;
  verwaltungId: number | null;
  branch: Branch;
  branchConfidence: BranchConfidence;
  risk: FraudRisk;
  signals: FraudSignal[];
  subject: string | null;
  body: string | null;
  recipient: string | null;
  sendMode: SendMode;
  usedHook: boolean;
  costUsd: number;
}

/**
 * §10: `drafted` — "Klassifikation fertig, in UI-Queue, Modus nach §9".
 *
 * `manual` wird direkt gesetzt, wenn der Zweig T0 ist: §9 sagt, T0 geht "nie
 * in den Versandpfad, sondern direkt in den Zustand manual".
 */
export function markDrafted(db: Db, input: DraftedInput): ListingState {
  const state: ListingState = input.sendMode === 'manual' ? 'manual' : 'drafted';
  db.prepare(
    `UPDATE listing_event SET
       verwaltung_id = ?, branch = ?, branch_confidence = ?, fraud_risk = ?,
       fraud_signals = ?, draft_subject = ?, draft_body = ?, recipient = ?,
       send_mode = ?, used_hook = ?, cost_usd = cost_usd + ?, state = ?
     WHERE id = ?`,
  ).run(
    input.verwaltungId, input.branch, input.branchConfidence, input.risk,
    JSON.stringify(input.signals), input.subject, input.body, input.recipient,
    input.sendMode, input.usedHook ? 1 : 0, input.costUsd, state, input.id,
  );
  return state;
}

/** Kosten mitschreiben, auch wenn die Pipeline unterwegs abbricht (§11). */
export function addCost(db: Db, id: number, costUsd: number): void {
  db.prepare(`UPDATE listing_event SET cost_usd = cost_usd + ? WHERE id = ?`).run(costUsd, id);
}

export function updateDraft(db: Db, id: number, subject: string, body: string): void {
  db.prepare(`UPDATE listing_event SET draft_subject = ?, draft_body = ? WHERE id = ?`)
    .run(subject, body, id);
}

/**
 * Erlaubte Übergänge (§10). Alles andere wird abgelehnt, statt still zu
 * passieren — ein Inserat, das aus `sent` zurück nach `drafted` rutscht,
 * würde eine zweite Mail auslösen.
 */
const ALLOWED: Readonly<Record<ListingState, readonly ListingState[]>> = {
  captured: ['drafted', 'manual', 'dead'],
  drafted: ['queued', 'cancelled', 'manual', 'sent', 'drafted'],
  queued: ['sent', 'cancelled', 'drafted'],
  cancelled: ['drafted'],
  manual: ['dead', 'handoff'],
  sent: ['bounced', 'nudged', 'handoff', 'dead'],
  bounced: ['drafted', 'dead'],
  nudged: ['handoff', 'dead'],
  handoff: [],
  dead: [],
};

export class InvalidTransition extends Error {}

export function transition(db: Db, id: number, to: ListingState, extra: Record<string, unknown> = {}): void {
  const current = getListing(db, id);
  if (!current) throw new InvalidTransition(`Inserat ${id} existiert nicht`);
  if (!ALLOWED[current.state].includes(to)) {
    throw new InvalidTransition(
      `Übergang ${current.state} -> ${to} ist nicht erlaubt (§10). ` +
        `Erlaubt wären: ${ALLOWED[current.state].join(', ') || 'keiner, der Zustand ist terminal'}`,
    );
  }
  const sets = ['state = ?'];
  const values: unknown[] = [to];
  for (const [key, value] of Object.entries(extra)) {
    sets.push(`${key} = ?`);
    values.push(value);
  }
  values.push(id);
  db.prepare(`UPDATE listing_event SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

/** Die offene Queue: alles, was auf mich wartet. */
const OPEN_STATES: readonly ListingState[] = ['captured', 'drafted', 'queued', 'manual'];

export function listOpen(db: Db): Listing[] {
  return (
    db
      .prepare(
        `SELECT * FROM listing_event WHERE state IN (${OPEN_STATES.map(() => '?').join(',')})
         ORDER BY created_at DESC, id DESC`,
      )
      .all(...OPEN_STATES) as ListingRow[]
  ).map(hydrate);
}

export function listAll(db: Db, limit = 200): Listing[] {
  return (
    db.prepare(`SELECT * FROM listing_event ORDER BY id DESC LIMIT ?`).all(limit) as ListingRow[]
  ).map(hydrate);
}

/** §13: Zweitkontakt derselben Firma. */
export function previousContact(db: Db, verwaltungId: number, exceptId: number): Listing | null {
  const row = db
    .prepare(
      `SELECT * FROM listing_event
       WHERE verwaltung_id = ? AND id != ? AND state IN ('sent','nudged','handoff','bounced','dead')
       ORDER BY sent_at DESC, id DESC LIMIT 1`,
    )
    .get(verwaltungId, exceptId) as ListingRow | undefined;
  return row ? hydrate(row) : null;
}

/** §16: Tagesbudget. Warnung bei > $2, harter Stopp bei > $5. */
export function costToday(db: Db): number {
  const { total } = db
    .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS total FROM listing_event WHERE date(created_at) = date('now')`)
    .get() as { total: number };
  return total;
}
