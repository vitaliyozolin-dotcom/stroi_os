// One read-only money contract for the workspace and its exports. Missing legacy
// amounts may inherit their status; an explicitly recorded zero never does.
export const FINANCE_RULES_VERSION = 2;
const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
export const roundMoney = (value) => Math.round((number(value) + Number.EPSILON) * 100) / 100;
export const acceptedAmountFor = (entry) => number(entry?.acceptedAmount
  ?? (['accepted', 'paid'].includes(entry?.status) ? entry.amount : 0));
export const paidAmountFor = (entry) => number(entry?.paidAmount
  ?? (entry?.status === 'paid' ? entry.amount : 0));
export const outstandingAmountFor = (entry) => roundMoney(Math.max(0, number(entry?.amount) - paidAmountFor(entry)));

export const entryTotals = (entries) => ({
  committed: roundMoney(entries.reduce((sum, entry) => sum + number(entry.amount), 0)),
  accepted: roundMoney(entries.reduce((sum, entry) => sum + acceptedAmountFor(entry), 0)),
  paid: roundMoney(entries.reduce((sum, entry) => sum + paidAmountFor(entry), 0)),
});

export const lineTotals = (state, line) => entryTotals((state.financeEntries ?? [])
  .filter((entry) => entry?.kind === 'expense' && Boolean(line.id) && entry.budgetLineId === line.id));

// This bound preserves the recorded estimate; it does not establish that all
// remaining work has been priced or that unallocated costs are additional scope.
export const lineForecast = (state, line) => {
  const totals = lineTotals(state, line);
  return roundMoney(Math.max(number(line.forecast), totals.committed, totals.accepted, totals.paid));
};

export const unallocatedExpenses = (state) => {
  const ids = new Set((state.budgetLines ?? []).map((line) => line.id));
  return (state.financeEntries ?? []).filter((entry) => entry?.kind === 'expense'
    && (!entry.budgetLineId || !ids.has(entry.budgetLineId)));
};

export const unallocatedExpenseTotals = (state) => {
  const totals = entryTotals(unallocatedExpenses(state));
  return { ...totals, forecast: Math.max(totals.committed, totals.accepted, totals.paid) };
};

export const financeTotals = (state) => {
  const lines = state.budgetLines ?? [];
  const expenses = (state.financeEntries ?? []).filter((entry) => entry?.kind === 'expense');
  const income = (state.financeEntries ?? []).filter((entry) => entry?.kind === 'income');
  const costs = entryTotals(expenses);
  return {
    plan: roundMoney(lines.reduce((sum, line) => sum + number(line.plan), 0)),
    forecast: roundMoney(lines.reduce((sum, line) => sum + lineForecast(state, line), 0) + unallocatedExpenseTotals(state).forecast),
    storedForecast: roundMoney(lines.reduce((sum, line) => sum + number(line.forecast), 0)),
    ...costs,
    received: roundMoney(income.reduce((sum, entry) => sum + paidAmountFor(entry), 0)),
    contractedIncome: roundMoney(income.reduce((sum, entry) => sum + number(entry.amount), 0)),
  };
};

export const outstandingExpenseTotal = (state) => roundMoney((state.financeEntries ?? [])
  .filter((entry) => entry?.kind === 'expense')
  .reduce((sum, entry) => sum + outstandingAmountFor(entry), 0));

export const stageFinanceTotals = (state, stageId) => {
  const lines = (state.budgetLines ?? []).filter((line) => (line.stageIds ?? []).includes(stageId));
  const entries = (state.financeEntries ?? []).filter((entry) => entry?.stageId === stageId);
  const expenses = entries.filter((entry) => entry.kind === 'expense');
  const income = entries.filter((entry) => entry.kind === 'income');
  const unallocated = entryTotals(unallocatedExpenses(state).filter((entry) => entry.stageId === stageId));
  // There is no approved amount allocation between stages yet. Shared budget
  // lines retain the existing equal-share approximation, now using the same
  // effective line forecast as the money page. Unassigned stages remain outside
  // stage totals; the project total still includes all of them exactly once.
  return {
    plan: roundMoney(lines.reduce((sum, line) => sum + number(line.plan) / Math.max(1, line.stageIds.length), 0)),
    forecast: roundMoney(lines.reduce((sum, line) => sum + lineForecast(state, line) / Math.max(1, line.stageIds.length), 0)
      + Math.max(unallocated.committed, unallocated.accepted, unallocated.paid)),
    ...entryTotals(expenses),
    billed: roundMoney(income.reduce((sum, entry) => sum + number(entry.amount), 0)),
    received: roundMoney(income.reduce((sum, entry) => sum + paidAmountFor(entry), 0)),
  };
};
