import type { AppState, BudgetLine } from '../entities/index';
import { paidAmountFor, roundMoney } from './finance-totals.js';
export { acceptedAmountFor, paidAmountFor, financeTotals, lineTotals, lineForecast,
  unallocatedExpenses, unallocatedExpenseTotals, stageFinanceTotals } from './finance-totals.js';

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
