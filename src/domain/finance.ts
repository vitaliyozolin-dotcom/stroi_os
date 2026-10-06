import type { AppState, BudgetLine, ExpenseStatus } from '../entities/index';

export const acceptedAmountFor = (entry: AppState['financeEntries'][number]) =>
  entry.acceptedAmount ?? (entry.status === 'accepted' || entry.status === 'paid' ? entry.amount : 0);

export const paidAmountFor = (entry: AppState['financeEntries'][number]) =>
  entry.paidAmount ?? (entry.status === 'paid' ? entry.amount : 0);

const roundMoney = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

// A calculated safety floor, not a rewrite or approval of the stored estimate.
export const lineForecast = (state: AppState, line: BudgetLine) => {
  const values = lineTotals(state, line);
  return roundMoney(Math.max(line.forecast, values.committed, values.accepted, values.paid));
};

export const unallocatedExpenses = (state: AppState) => {
  const ids = new Set(state.budgetLines.map(line => line.id));
  return state.financeEntries.filter(entry => entry.kind === 'expense' && (!entry.budgetLineId || !ids.has(entry.budgetLineId)));
};

export const unallocatedExpenseTotals = (state: AppState) => {
  const entries = unallocatedExpenses(state);
  const committed = roundMoney(entries.reduce((sum, entry) => sum + entry.amount, 0));
  const accepted = roundMoney(entries.reduce((sum, entry) => sum + acceptedAmountFor(entry), 0));
  const paid = roundMoney(entries.reduce((sum, entry) => sum + paidAmountFor(entry), 0));
  return { committed, accepted, paid, forecast: Math.max(committed, accepted, paid) };
};

// Unknown payment dates must never inherit document/import dates.
export const paymentDate = (entry: AppState['financeEntries'][number]) => {
  const date = entry.paidAt?.slice(0, 10);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = new Date(`${date}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : null;
};

export const paymentMovements = (entry: AppState['financeEntries'][number]) => {
  if (!entry.payments?.length) return [{ amount: paidAmountFor(entry), date: paymentDate(entry), legacy: true }];
  const movements = entry.payments.map(payment => ({ amount: payment.amount, date: payment.date, legacy: false }));
  const legacy = roundMoney(paidAmountFor(entry) - movements.reduce((sum, payment) => sum + payment.amount, 0));
  // The previous aggregate cannot be assigned to the latest new payment date.
  return [...(legacy > 0 ? [{ amount: legacy, date: null, legacy: true }] : []), ...movements];
};

export const undatedPayments = (state: AppState) => {
  const result = { expense: 0, income: 0 };
  for (const entry of state.financeEntries) {
    for (const movement of paymentMovements(entry)) if (!movement.date) result[entry.kind] += movement.amount;
  }
  return { expense: roundMoney(result.expense), income: roundMoney(result.income) };
};

// Source-sheet facts include estimates and reserves. They never create payments.
export const sourceEstimateTotals = (lines: BudgetLine[]) => {
  const source = lines.filter(line => line.sourceRow && !line.outsideSourceTotal);
  if (!source.length || source.some(line => (line.sourcePlan ?? line.plan) > 0 && !Number.isFinite(line.sourceFact))) return null;
  const round = (value: number) => Math.round(value * 100) / 100;
  const plan = round(source.reduce((sum, line) => sum + (line.sourcePlan ?? line.plan), 0));
  const fact = round(source.reduce((sum, line) => sum + (Number.isFinite(line.sourceFact) ? line.sourceFact! : 0), 0));
  return { plan, fact, deviation: round(fact - plan) };
};

export const financeTotals = (state: AppState) => {
  const expenses = state.financeEntries.filter((entry) => entry.kind === 'expense');
  const income = state.financeEntries.filter((entry) => entry.kind === 'income');
  const hasStatus = (current: ExpenseStatus, accepted: ExpenseStatus[]) => accepted.includes(current);

  return {
    plan: state.budgetLines.reduce((sum, line) => sum + line.plan, 0),
    forecast: roundMoney(state.budgetLines.reduce((sum, line) => sum + lineForecast(state, line), 0) + unallocatedExpenseTotals(state).forecast),
    storedForecast: roundMoney(state.budgetLines.reduce((sum, line) => sum + line.forecast, 0)),
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
