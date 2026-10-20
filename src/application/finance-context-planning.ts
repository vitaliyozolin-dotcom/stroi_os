import type { ActivityEvent } from '../entities/index';
import type { FinancePlanningSnapshot, FinanceOwnedState, FinancePatch } from '../domain/finance/index.js';
import { updateBudgetLine, classifyFinanceCosts, setFinanceDueDate, type BudgetLineInput, type CostClassificationInput, type FinanceDueDateInput, type FinancePlanningResult } from '../domain/finance/index.js';
import type { FinanceCommandContext } from './finance-context';
export const financeOwnedSnapshot = (state: FinanceOwnedState) => JSON.stringify([state.budgetLines, state.budgetMeta, state.financeEntries]);
export interface FinancePlanningChange { projectId: string; expectedFinance: string; action: string; summary: string; patch: FinancePatch; event: ActivityEvent }
export type FinancePlanningCommandResult = { ok: true; change: FinancePlanningChange | null } | { ok: false; error: string };

const change = (state: FinancePlanningSnapshot, result: FinancePlanningResult, context: FinanceCommandContext, action: string, summary: string): FinancePlanningCommandResult => {
  if (!result.ok) return result;
  if (!result.changed) return { ok: true, change: null };
  return { ok: true, change: { projectId: state.projectId, expectedFinance: financeOwnedSnapshot(state), action, summary, patch: result.patch,
    event: { id: context.ids.next('activity'), timestamp: context.clock.now(), actor: context.identity.name, text: summary, tone: 'neutral' },
  } };
};

export const editFinanceBudgetLine = (state: FinancePlanningSnapshot, input: BudgetLineInput, context: FinanceCommandContext) => {
  const result = updateBudgetLine(state, input, context.identity, context.clock.now());
  const line = state.budgetLines.find(item => item.id === input.lineId);
  return change(state, result, context, 'budget_line_updated', `Обновлена статья сметы ${line?.name ?? ''}: план ${input.plan.toLocaleString('ru-RU')} ₽`);
};

export const classifyFinanceContextCosts = (state: FinancePlanningSnapshot, input: CostClassificationInput, context: FinanceCommandContext) =>
  change(state, classifyFinanceCosts(state, input, context.identity), context, 'costs_classified', 'Обновлено распределение строительства и накладных');

export const setFinanceContextDueDate = (state: FinancePlanningSnapshot, input: FinanceDueDateInput, context: FinanceCommandContext) => {
  const result = setFinanceDueDate(state, input, context.identity);
  if (!result.ok) return result;
  const entry = state.financeEntries.find(item => item.id === input.entryId);
  const date = input.date ? new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(input.date)) : '';
  return change(state, result, context, 'payment_due_date_updated', `${date ? `Плановая дата ${entry?.kind === 'expense' ? 'выплаты' : 'поступления'}: ${date}` : 'Плановая дата платежа снята'} · ${entry?.description ?? ''}`);
};
