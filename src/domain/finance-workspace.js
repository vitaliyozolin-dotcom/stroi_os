import { effectiveBudgetLines, financeTotals, outstandingAmountFor } from './finance-totals.js';
import { treasuryCostSummary, treasuryProjection, validTreasuryDate } from './treasury.js';

const cents = value => Number.isFinite(value) && value >= 0 && Number.isSafeInteger(Math.round(value * 100)) ? Math.round(value * 100) : null;
const addDays = (date, days) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

/** Read-only display contract. It never reclassifies or edits historical amounts. */
export function financeWorkspaceSummary(state, today) {
  if (!validTreasuryDate(today)) throw new Error('Укажите корректную дату среза.');
  const totals = financeTotals(state);
  const cash = treasuryProjection(state, { today, horizonDays: 91 });
  const cost = treasuryCostSummary(state, { today });
  const estimateKind = state.budgetMeta?.estimateKind ?? 'unknown';
  const lines = effectiveBudgetLines(state);
  const hasLines = lines.length > 0;
  const planCents = hasLines ? cents(totals.plan) : null;
  const contractCents = state.project.unknownFields?.includes('contractValue') ? null : cents(state.project.contractValue);
  const commercialEstimateCents = state.budgetMeta?.commercialEstimate?.amountCents
    ?? (estimateKind === 'commercial' ? planCents : null);
  const internalBudgetCents = estimateKind === 'internal_cost' ? planCents : null;
  const internalBudgetApproved = internalBudgetCents !== null && Boolean(state.budgetMeta?.approvedAt || state.treasury?.budgetVersions?.find(row => row.id === state.treasury?.activeBudgetVersionId)?.approvedAt);
  const forecastCents = cost.eacCents;
  const forecastResultCents = contractCents === null || forecastCents === null || !cost.complete ? null : contractCents - forecastCents;
  const enabled = state.treasury?.enabled === true;
  const horizonEnd = addDays(today, enabled ? 14 : 13);
  const relevantEvents = cash.events.filter(event => !event.excluded && event.kind === 'expense');
  const scheduled = enabled
    ? relevantEvents.filter(event => event.date && event.date <= horizonEnd)
    : state.financeEntries.filter(entry => entry.kind === 'expense' && validTreasuryDate(entry.dueDate) && entry.dueDate <= horizonEnd);
  const scheduled14Cents = enabled
    ? scheduled.reduce((sum, event) => sum + event.amountCents, 0)
    : scheduled.reduce((sum, entry) => sum + Math.round(outstandingAmountFor(entry, state) * 100), 0);
  const undatedExpenseCents = enabled
    ? relevantEvents.filter(event => !event.scheduledDate).reduce((sum, event) => sum + event.amountCents, 0)
    : state.financeEntries.filter(entry => entry.kind === 'expense' && !validTreasuryDate(entry.dueDate)).reduce((sum, entry) => sum + Math.round(outstandingAmountFor(entry, state) * 100), 0);
  const firstDeficit = cash.days.find(day => day.date === cash.firstDeficitDate);
  const hasExpenseFacts = state.financeEntries.some(entry => entry.kind === 'expense');
  return {
    estimateKind, contractCents, commercialEstimateCents, internalBudgetCents, internalBudgetApproved,
    forecastCents, forecastComplete: cost.complete, forecastResultCents,
    availableCashCents: cash.openingKnown ? cash.openingCents : null,
    paidCents: hasExpenseFacts ? cents(totals.paid) : null,
    scheduled14Cents, horizonEnd, undatedExpenseCents,
    needs14Cents: scheduled14Cents > 0 || cash.completeness ? scheduled14Cents : null,
    cashComplete: cash.completeness, firstDeficitDate: cash.firstDeficitDate,
    firstDeficitCents: firstDeficit?.deficitCents ?? null, peakFundingCents: cash.peakFundingCents,
    costWarnings: cost.warnings,
  };
}
