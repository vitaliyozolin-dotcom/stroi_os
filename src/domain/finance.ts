import type { AppState, BudgetLine, ExpenseStatus } from '../entities/index';

export const acceptedAmountFor = (entry: AppState['financeEntries'][number]) =>
  entry.acceptedAmount ?? (entry.status === 'accepted' || entry.status === 'paid' ? entry.amount : 0);

export const paidAmountFor = (entry: AppState['financeEntries'][number]) =>
  entry.paidAmount ?? (entry.status === 'paid' ? entry.amount : 0);

export const financeTotals = (state: AppState) => {
  const expenses = state.financeEntries.filter((entry) => entry.kind === 'expense');
  const income = state.financeEntries.filter((entry) => entry.kind === 'income');
  const hasStatus = (current: ExpenseStatus, accepted: ExpenseStatus[]) => accepted.includes(current);

  return {
    plan: state.budgetLines.reduce((sum, line) => sum + line.plan, 0),
    forecast: state.budgetLines.reduce((sum, line) => sum + line.forecast, 0),
    committed: expenses.filter((entry) => hasStatus(entry.status, ['committed', 'accepted', 'paid'])).reduce((sum, entry) => sum + entry.amount, 0),
    accepted: expenses.reduce((sum, entry) => sum + acceptedAmountFor(entry), 0),
    paid: expenses.reduce((sum, entry) => sum + paidAmountFor(entry), 0),
    received: income.reduce((sum, entry) => sum + paidAmountFor(entry), 0),
    contractedIncome: income.reduce((sum, entry) => sum + entry.amount, 0),
  };
};

export const lineTotals = (state: AppState, line: BudgetLine) => {
  const entries = state.financeEntries.filter((entry) => entry.kind === 'expense' && entry.budgetLineId === line.id);
  return {
    committed: entries.reduce((sum, entry) => sum + entry.amount, 0),
    accepted: entries.reduce((sum, entry) => sum + acceptedAmountFor(entry), 0),
    paid: entries.reduce((sum, entry) => sum + paidAmountFor(entry), 0),
  };
};

export const stageFinanceTotals = (state: AppState, stageId: string) => {
  const budgetLines = state.budgetLines.filter((line) => line.stageIds.includes(stageId));
  const entries = state.financeEntries.filter((entry) => entry.stageId === stageId);
  const expenses = entries.filter((entry) => entry.kind === 'expense');
  const income = entries.filter((entry) => entry.kind === 'income');

  return {
    plan: budgetLines.reduce((sum, line) => sum + line.plan / Math.max(1, line.stageIds.length), 0),
    forecast: budgetLines.reduce((sum, line) => sum + line.forecast / Math.max(1, line.stageIds.length), 0),
    committed: expenses.reduce((sum, entry) => sum + entry.amount, 0),
    accepted: expenses.reduce((sum, entry) => sum + acceptedAmountFor(entry), 0),
    paid: expenses.reduce((sum, entry) => sum + paidAmountFor(entry), 0),
    billed: income.reduce((sum, entry) => sum + entry.amount, 0),
    received: income.reduce((sum, entry) => sum + paidAmountFor(entry), 0),
  };
};
