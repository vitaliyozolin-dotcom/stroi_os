import type { FinanceSettlementContext, FinanceBudgetContext } from './finance/context';
import { effectiveLedgerConfirmation, ledgerOperationAllocations, ledgerEffect } from './finance-ledger.js';
import type { FinanceEntry, BudgetLine } from '../entities/index';
import { paidAmountFor, roundMoney } from './finance-totals.js';
export { acceptedAmountFor, paidAmountFor, settledAmountFor, outstandingAmountFor, payableAmountFor, effectiveBudgetLines, financeTotals, lineTotals, lineForecast,
  unallocatedExpenses, unallocatedExpenseTotals, stageFinanceTotals } from './finance-totals.js';

// Unknown payment dates must never inherit document/import dates.
export const paymentDate = (entry: FinanceEntry) => {
  const date = entry.paidAt?.slice(0, 10);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = new Date(`${date}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : null;
};

const legacyPaymentMovements = (entry: FinanceEntry) => {
  if (!entry.payments?.length) return [{ amount: paidAmountFor(entry), date: paymentDate(entry), legacy: true }];
  const movements = entry.payments.map(payment => ({ amount: payment.amount, date: payment.date, legacy: false }));
  const legacy = roundMoney(paidAmountFor(entry) - movements.reduce((sum, payment) => sum + payment.amount, 0));
  // The previous aggregate cannot be assigned to the latest new payment date.
  return [...(legacy > 0 ? [{ amount: legacy, date: null, legacy: true }] : []), ...movements];
};

/** Cash facts only; offsets never appear as payments and reconciliations never repeat them. */
export const paymentMovements = (entry: FinanceEntry, state?: FinanceSettlementContext) => {
  const ledger = state?.financeLedger;
  const facts = new Map(state?.treasury?.entryPlans.find(plan => plan.entryId === entry.id)?.paymentFacts?.map(fact => [fact.paymentId, fact.confirmation]) ?? []);
  for (const operation of ledger?.operations ?? []) if (operation.legacyPayment?.entryId === entry.id && effectiveLedgerConfirmation(ledger, operation) !== 'claimed') facts.set(operation.legacyPayment.paymentId, effectiveLedgerConfirmation(ledger, operation));
  let paymentIndex = 0;
  const legacy = legacyPaymentMovements(entry).filter(movement => {
    const id = movement.legacy ? `legacy:${entry.id}` : entry.payments![paymentIndex++].id;
    return facts.get(id) !== 'claimed';
  });
  const additional = (ledger?.operations ?? []).flatMap(operation => {
    if (operation.legacyPayment || operation.kind === 'offset' || effectiveLedgerConfirmation(ledger, operation) === 'claimed') return [];
    const sign = ['supplier_refund', 'customer_refund'].includes(operation.kind) ? -1 : 1;
    const amount = ledgerOperationAllocations(ledger!, operation).filter(allocation => allocation.entryId === entry.id)
      .reduce((sum, allocation) => sum + sign * allocation.amountCents, 0) / 100;
    return amount ? [{ amount, date: operation.date, legacy: false }] : [];
  });
  return [...legacy, ...additional];
};

/** Account cash, counted once per operation regardless of allocation count. */
export const financeCashMovementRows = (state: { financeEntries: FinanceEntry[] } & FinanceSettlementContext & FinanceBudgetContext) => {
  const ledger = ledgerEffect(state);
  const rows: { id: string; date: string | null; inflowCents: number; outflowCents: number; accountId: string | null }[] = [...ledger.cashMovements];
  for (const entry of state.financeEntries) {
    const plan = state.treasury?.entryPlans.find(row => row.entryId === entry.id);
    let paymentIndex = 0;
    for (const movement of legacyPaymentMovements(entry)) {
      const id = movement.legacy ? `legacy:${entry.id}` : entry.payments![paymentIndex++].id;
      const linked = ledger.legacyFacts.find(row => row.entryId === entry.id && row.paymentId === id);
      const fact = linked ?? plan?.paymentFacts?.find(row => row.paymentId === id);
      if (fact?.confirmation === 'claimed' || (fact?.cashTreatment ?? plan?.cashTreatment) === 'participant_direct' || !movement.amount) continue;
      const amountCents = Math.round(movement.amount * 100);
      rows.push({ id: `legacy-cash:${entry.id}:${id}`, date: movement.date,
        accountId: fact?.accountId ?? plan?.sourceAccountId ?? null,
        inflowCents: entry.kind === 'income' ? amountCents : 0, outflowCents: entry.kind === 'expense' ? amountCents : 0 });
    }
  }
  return rows;
};

export const undatedPayments = (state: { financeEntries: FinanceEntry[] } & FinanceSettlementContext) => {
  const result = { expense: 0, income: 0 };
  for (const entry of state.financeEntries) {
    for (const movement of paymentMovements(entry, state)) if (!movement.date) result[entry.kind] += movement.amount;
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
