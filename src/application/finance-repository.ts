import type { FinanceHistorySnapshot } from '../domain/finance/index.js';
import type { FinancePlanningChange } from './finance-context-planning.ts';
import type { FinanceFactsChange } from './finance-context-facts.ts';
import type { FinanceCommitmentChange } from './finance-context-commitment.js';
import type { FinanceHistoryChange } from './finance-context-history.ts';

export interface FinanceReadModel extends FinanceHistorySnapshot {
  project: FinanceHistorySnapshot['project'] & { code: string };
}
export type FinanceMutation =
  | { kind: 'planning'; change: FinancePlanningChange }
  | { kind: 'facts'; change: FinanceFactsChange }
  | { kind: 'commitment'; change: FinanceCommitmentChange; entryId: string }
  | { kind: 'history'; change: FinanceHistoryChange };
export type FinanceFailure = { ok: false; error: string };
export type FinanceReadResult = { ok: true; snapshot: FinanceReadModel } | FinanceFailure;
export type FinanceCommitResult = { ok: true } | FinanceFailure;

/** Project-bound unit of work. A successful commit stages the change for revision-aware
 * synchronization; durable/offline/conflict status remains owned by that workflow. */
export interface FinanceRepository {
  read(): FinanceReadResult;
  commit(mutation: FinanceMutation): FinanceCommitResult;
}
