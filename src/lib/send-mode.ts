/**
 * Versandmodus (§9).
 *
 * "Das System versendet, aber nie ohne mich." Diese Funktion entscheidet
 * nur, *wie* die Freigabe aussieht — gesendet wird in Phase 7.
 *
 * Reine Logik, damit die Tabelle aus §9 einmal an einer Stelle steht und
 * prüfbar ist.
 */
import type { Branch, BranchConfidence } from './classify.ts';
import { isSendBranch } from './classify.ts';
import { isWeakerThan, type Confidence } from '../db/verwaltung.ts';
import type { FraudRisk } from '../stages/gate.ts';

export type SendMode =
  /** 60-Sekunden-Fenster, dann geht sie raus. */
  | 'undo'
  /** Expliziter Klick, kein Timer. */
  | 'approve'
  /** Betrugsrisiko high: nur Flag, kein Versand. */
  | 'blocked'
  /** T0: kein Empfänger, Text zum Kopieren. */
  | 'manual';

export interface SendModeInput {
  branch: Branch;
  risk: FraudRisk;
  branchConfidence: BranchConfidence;
  /** Konfidenz des Cache-Eintrags, aus dem der Empfänger stammt. */
  recipientConfidence: Confidence | null;
  /** Ist überhaupt eine Adresse da? */
  hasRecipient: boolean;
}

export interface SendModeDecision {
  mode: SendMode;
  /** Warum — gehört in die UI, damit die Entscheidung nachvollziehbar ist. */
  reasons: string[];
}

/**
 * Reihenfolge ist Absicht: die sperrenden Gründe zuerst, dann die
 * verschärfenden. Ein `T0` mit gesetztem Empfänger ist laut §9 ein Bug —
 * deshalb wird `manual` nicht durch spätere Regeln aufgeweicht.
 */
export function decideSendMode(input: SendModeInput): SendModeDecision {
  const reasons: string[] = [];

  if (!isSendBranch(input.branch)) {
    return {
      mode: 'manual',
      reasons: [`${input.branch} ist kein Versandzweig — Text zum Kopieren, Bewerbung übers Portal`],
    };
  }
  if (input.risk === 'high') {
    return { mode: 'blocked', reasons: ['Betrugsrisiko high — kein Versand, nur Flag'] };
  }
  if (!input.hasRecipient) {
    return { mode: 'blocked', reasons: ['Keine Empfängeradresse — Recherche hat nichts geliefert'] };
  }

  // Ab hier wird gesendet. Die Frage ist nur: Timer oder Klick?
  if (input.branch === 'T_PRIVAT') {
    reasons.push('T_PRIVAT geht immer über expliziten Klick (§9)');
  }
  if (input.risk === 'medium') {
    reasons.push('Betrugsrisiko medium');
  }
  if (input.branchConfidence === 'low') {
    reasons.push('Zweig unsicher — die UI fragt lieber nach, als zu raten');
  }
  if (input.recipientConfidence && isWeakerThan(input.recipientConfidence, 'high')) {
    reasons.push(`Empfänger nur mit confidence "${input.recipientConfidence}" belegt`);
  }

  if (reasons.length > 0) return { mode: 'approve', reasons };
  return { mode: 'undo', reasons: ['nichts Auffälliges — 60-Sekunden-Fenster'] };
}
