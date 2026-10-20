import type { AppState } from '../entities/index';
import type { BudgetLineInput, CostClassificationInput, FinanceDueDateInput, FinancePlanningSnapshot } from '../domain/finance/index.js';
import type { FinanceCommandContext } from './finance-context';
import type { FinanceCommandResult } from './finance.ts';
import { financeOwnedSnapshot, editFinanceBudgetLine, classifyFinanceContextCosts, setFinanceContextDueDate, type FinancePlanningCommandResult } from './finance-context-planning.ts';

/** Compatibility adapter: storage still saves the revisioned whole-project snapshot. */
export const financePlanningSnapshot = (state: AppState): FinancePlanningSnapshot => ({ projectId: state.project.id, budgetLines: state.budgetLines, budgetMeta: state.budgetMeta, financeEntries: state.financeEntries });
export const applyFinancePlanningResult = (state: AppState, result: FinancePlanningCommandResult): FinanceCommandResult => {
  if (!result.ok) return result;
  if (!result.change) return { ok: true, change: null };
  const change = result.change;
  if (change.projectId !== state.project.id) return { ok: false, error: 'Проект изменился. Откройте финансовую форму заново.' };
  if (change.expectedFinance !== financeOwnedSnapshot(state)) return { ok: false, error: 'Финансовые данные обновились. Повторите действие на свежих данных.' };
  // Deliberate allowlist: a finance result cannot replace tasks, access, documents or other contexts.
  const patch = change.patch;
  return { ok: true, change: { action: change.action, summary: change.summary, state: {
    ...state,
    budgetLines: patch.budgetLines ?? state.budgetLines,
    budgetMeta: patch.budgetMeta ?? state.budgetMeta,
    financeEntries: patch.financeEntries ?? state.financeEntries,
    activity: [change.event, ...state.activity],
  } } };
};
export const editProjectBudgetLine = (state: AppState, input: BudgetLineInput, context: FinanceCommandContext) => applyFinancePlanningResult(state, editFinanceBudgetLine(financePlanningSnapshot(state), input, context));
export const classifyProjectCosts = (state: AppState, input: CostClassificationInput, context: FinanceCommandContext) => applyFinancePlanningResult(state, classifyFinanceContextCosts(financePlanningSnapshot(state), input, context));
export const setProjectPaymentDueDate = (state: AppState, input: FinanceDueDateInput, context: FinanceCommandContext) => applyFinancePlanningResult(state, setFinanceContextDueDate(financePlanningSnapshot(state), input, context));
