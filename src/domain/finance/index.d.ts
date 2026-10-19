import type { AppState, FinanceEntry, UserRole } from '../../entities/index';

export interface FinanceActor { name: string; role: UserRole }
/** Explicit module context: tasks, marketing, settings and UI state stay outside finance. */
export type FinanceState = Pick<AppState, 'project' | 'financeEntries' | 'budgetLines' | 'documents' | 'procurement' | 'checkpoints' | 'stages' | 'counterparties'>;
export type FinanceAcceptanceContext = Pick<FinanceState, 'procurement' | 'checkpoints' | 'stages'>;
export interface FinanceFactInput { amount: number; date: string; document: string; source?: string }
export type FinanceEntryResult = { ok: true; entry: FinanceEntry; changed: boolean } | { ok: false; error: string };
export type FinanceAction = 'accept' | 'pay' | 'receive';
export interface FinanceCommitmentInput {
  id: string; kind: 'expense' | 'income'; amount: number; date: string;
  description: string; counterpartyId: string; budgetLineId?: string; stageId?: string; sourceDraftId?: string;
}
export type FinanceCommitmentResult = { ok: true; entry: FinanceEntry; budgetLines: AppState['budgetLines']; changed: boolean } | { ok: false; error: string };
export function createCommitment(state: Pick<FinanceState, 'financeEntries' | 'budgetLines' | 'counterparties' | 'stages'>, input: FinanceCommitmentInput, identity: FinanceActor): FinanceCommitmentResult;
export function financeMoney(value: number): number;
export function needsExpenseApproval(entry: FinanceEntry): boolean;
export function expenseAcceptanceSources(state: FinanceAcceptanceContext, entry: FinanceEntry): { id: string; label: string }[];
export function hasFinanceAcceptanceSource(state: FinanceAcceptanceContext, entry: FinanceEntry): boolean;
export function financeActionError(state: FinanceAcceptanceContext, entry: FinanceEntry, kind: FinanceAction, amount: number, date: string, document: string, source: string): string;
export function approveExpenseEntry(entry: FinanceEntry, identity: FinanceActor, timestamp: string): FinanceEntryResult;
export function acceptExpenseEntry(state: FinanceAcceptanceContext, entry: FinanceEntry, input: FinanceFactInput, identity: FinanceActor): FinanceEntryResult;
export function recordPaymentEntry(state: FinanceAcceptanceContext, entry: FinanceEntry, input: FinanceFactInput, identity: FinanceActor): FinanceEntryResult;
export function recordReceiptEntry(state: FinanceAcceptanceContext, entry: FinanceEntry, input: FinanceFactInput, identity: FinanceActor): FinanceEntryResult;
/** Validates a private candidate snapshot and stamps authoritative financial facts in place. */
export function validateFinanceChanges(previous: FinanceState | null, candidate: FinanceState, identity: FinanceActor, timestamp: string): string;
