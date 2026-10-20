import type { AppState } from '../entities/index';
import type { FinanceCommandContext } from './finance-context';
import type { FinanceCommandResult } from './finance.ts';
import { financePlanningSnapshot, applyFinancePlanningResult } from './finance-planning.ts';
import { financeAcceptanceSnapshot, approveFinanceExpense, acceptFinanceExpense, recordFinancePayment, recordFinanceReceipt, type FinanceFactsSnapshot, type FinanceFactsCommandResult, type FactCommand } from './finance-context-facts.ts';

export const financeFactsSnapshot = (state: AppState): FinanceFactsSnapshot => ({
  ...financePlanningSnapshot(state), projectCode: state.project.code,
  procurement: state.procurement, checkpoints: state.checkpoints, stages: state.stages,
});

/** Append a finance document without replacing the document registry or unrelated contexts. */
export const applyFinanceFactsResult = (state: AppState, result: FinanceFactsCommandResult): FinanceCommandResult => {
  if (!result.ok) return result;
  if (!result.change) return { ok: true, change: null };
  if (result.change.expectedReferences !== financeAcceptanceSnapshot(state)) return { ok: false, error: 'Основания приёмки обновились. Повторите действие на свежих данных.' };
  const applied = applyFinancePlanningResult(state, result);
  if (!applied.ok || !applied.change) return applied;
  const document = result.change.appendDocument;
  if (!document) return applied;
  return { ok: true, change: { ...applied.change, state: { ...applied.change.state, documents: [document, ...state.documents] } } };
};

export const approveProjectExpense = (state: AppState, entryId: string, context: FinanceCommandContext) => applyFinanceFactsResult(state, approveFinanceExpense(financeFactsSnapshot(state), entryId, context));
export const acceptProjectExpense = (state: AppState, input: FactCommand, context: FinanceCommandContext) => applyFinanceFactsResult(state, acceptFinanceExpense(financeFactsSnapshot(state), input, context));
export const recordProjectPayment = (state: AppState, input: FactCommand, context: FinanceCommandContext) => applyFinanceFactsResult(state, recordFinancePayment(financeFactsSnapshot(state), input, context));
export const recordProjectReceipt = (state: AppState, input: FactCommand, context: FinanceCommandContext) => applyFinanceFactsResult(state, recordFinanceReceipt(financeFactsSnapshot(state), input, context));
