import type { FinanceState, FinanceOwnedState, FinancePatch } from './context';
export type { FinanceState, FinanceOwnedState, FinancePatch, FinancePlanningSnapshot, FinanceHistorySnapshot } from './context';
import type { FinanceEntry, UserRole } from '../../entities/index';

export interface FinanceActor { name: string; role: UserRole }
/** Explicit module context: tasks, marketing, settings and UI state stay outside finance. */
export type FinanceAcceptanceContext = Pick<FinanceState, 'procurement' | 'checkpoints' | 'stages'>;
export interface FinanceFactInput { amount: number; date: string; document: string; source?: string }
export type FinanceEntryResult = { ok: true; entry: FinanceEntry; changed: boolean } | { ok: false; error: string };
export type FinanceAction = 'accept' | 'pay' | 'receive';
export interface FinanceCommitmentInput {
  id: string; kind: 'expense' | 'income'; amount: number; date: string;
  description: string; counterpartyId: string; budgetLineId?: string; stageId?: string; sourceDraftId?: string;
}
export type FinanceCommitmentResult = { ok: true; entry: FinanceEntry; budgetLines: FinanceOwnedState['budgetLines']; changed: boolean } | { ok: false; error: string };
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
export interface BudgetLineInput { lineId: string; plan: number; forecast: number; version: string; source: string; expected: string }
export interface CostClassificationInput { lines: Record<string, import('../../entities/index').CostGroup>; entries: Record<string, import('../../entities/index').CostGroup | ''>; expected: string }
export interface FinanceDueDateInput { entryId: string; date: string; expected: string }
export type FinancePlanningResult = { ok: true; changed: boolean; patch: FinancePatch } | { ok: false; error: string };
export function budgetLineSnapshot(state: Pick<FinanceOwnedState, 'budgetLines' | 'budgetMeta'>, lineId: string): string;
export function classificationSnapshot(state: Pick<FinanceOwnedState, 'budgetLines' | 'financeEntries'>): string;
export function updateBudgetLine(state: FinanceOwnedState, input: BudgetLineInput, identity: FinanceActor, timestamp: string): FinancePlanningResult;
export function classifyFinanceCosts(state: FinanceOwnedState, input: CostClassificationInput, identity: FinanceActor): FinancePlanningResult;
export function setFinanceDueDate(state: FinanceOwnedState, input: FinanceDueDateInput, identity: FinanceActor): FinancePlanningResult;
export function validateBudgetPlanningChanges(previous: FinanceOwnedState | null, state: FinanceOwnedState, identity: FinanceActor): string;
