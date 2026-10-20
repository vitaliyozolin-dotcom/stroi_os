import type { ActivityEvent } from '../entities/index';
import type { FinanceCommitmentInput, FinancePlanningSnapshot, FinanceState, FinancePatch } from '../domain/finance/index.js';
import type { FinanceCommandContext } from './finance-context';

export interface FinanceCommitmentSnapshot extends FinancePlanningSnapshot, Pick<FinanceState, 'counterparties' | 'stages'> {}
export type CreateCommitmentInput = Omit<FinanceCommitmentInput, 'id'> & { id?: string };
export interface FinanceCommitmentChange {
  projectId: string;
  expected: string;
  action: string;
  summary: string;
  patch: Pick<FinancePatch, 'budgetLines' | 'financeEntries'>;
  event: ActivityEvent;
}
export type FinanceCommitmentCommandResult = { ok: true; entryId: string; change: FinanceCommitmentChange | null } | { ok: false; error: string };
export function financeCommitmentFingerprint(state: FinanceCommitmentSnapshot): string;
export function createFinanceCommitment(state: FinanceCommitmentSnapshot, input: CreateCommitmentInput, context: FinanceCommandContext): FinanceCommitmentCommandResult;
