import type { AppState } from '../entities/index';
import { updateBudgetLine, classifyFinanceCosts, setFinanceDueDate, type BudgetLineInput, type CostClassificationInput, type FinanceDueDateInput, type FinancePlanningResult } from '../domain/finance/index.js';
import type { FinanceCommandContext, FinanceCommandResult } from './finance.ts';

const change = (state: AppState, result: FinancePlanningResult, context: FinanceCommandContext, action: string, summary: string): FinanceCommandResult => {
  if (!result.ok) return result;
  if (!result.changed) return { ok: true, change: null };
  return { ok: true, change: { action, summary, state: {
    ...state, ...result.patch,
    activity: [{ id: context.ids.next('activity'), timestamp: context.clock.now(), actor: context.identity.name, text: summary, tone: 'neutral' }, ...state.activity],
  } } };
};

export const editProjectBudgetLine = (state: AppState, input: BudgetLineInput, context: FinanceCommandContext) => {
  const result = updateBudgetLine(state, input, context.identity, context.clock.now());
  const line = state.budgetLines.find(item => item.id === input.lineId);
  return change(state, result, context, 'budget_line_updated', `Обновлена статья сметы ${line?.name ?? ''}: план ${input.plan.toLocaleString('ru-RU')} ₽`);
};

export const classifyProjectCosts = (state: AppState, input: CostClassificationInput, context: FinanceCommandContext) =>
  change(state, classifyFinanceCosts(state, input, context.identity), context, 'costs_classified', 'Обновлено распределение строительства и накладных');

export const setProjectPaymentDueDate = (state: AppState, input: FinanceDueDateInput, context: FinanceCommandContext) => {
  const result = setFinanceDueDate(state, input, context.identity);
  if (!result.ok) return result;
  const entry = state.financeEntries.find(item => item.id === input.entryId);
  const date = input.date ? new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(input.date)) : '';
  return change(state, result, context, 'payment_due_date_updated', `${date ? `Плановая дата ${entry?.kind === 'expense' ? 'выплаты' : 'поступления'}: ${date}` : 'Плановая дата платежа снята'} · ${entry?.description ?? ''}`);
};
