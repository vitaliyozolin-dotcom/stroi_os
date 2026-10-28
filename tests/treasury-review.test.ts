import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyTreasury, treasuryProjection, treasuryCostSummary, treasuryScopeFingerprint, treasuryScenarioFingerprint, validateTreasuryChanges, type TreasuryProject } from '../src/domain/treasury.js';
import { emptyFinanceLedger, validateFinanceLedgerChanges } from '../src/domain/finance-ledger.js';

const today = '2026-10-28', now = `${today}T12:00:00Z`, owner = { role: 'management', name: 'Independent reviewer' };
const fixture = (): TreasuryProject => ({ project: { id: 'review' }, financeEntries: [], stages: [], tasks: [], budgetLines: [{ id: 'work', name: 'Work', plan: 100 }], financeLedger: emptyFinanceLedger(), treasury: {
  ...emptyTreasury(), enabled: true, accounts: [{ id: 'bank', name: 'Bank', currency: 'RUB', legalEntityId: 'company', isProjectDedicated: true, opening: { asOf: today, amountCents: 100000, source: 'Statement', confirmed: true } }],
  costEstimates: [{ id: 'estimate', name: 'Works', budgetLineId: 'work', recognizedCents: 0, remainingWorkCents: 10000, stockToConsumeCents: 0, otherRemainingCents: 0, approvedBudgetCents: 10000, source: 'Physical scope', taxBasis: 'gross' }],
  cashPlans: [{ id: 'plan', name: 'Uncontracted works', kind: 'expense', category: 'uncontracted_work', amountCents: 10000, budgetLineId: 'work', date: '2026-10-30', accountId: 'bank', certainty: 'expected', source: 'Cash schedule' }],
} });
const confirmScope = (state: TreasuryProject) => { state.treasury!.cashScopeReview = { asOf: today, source: 'Reviewed all known cash', fingerprint: treasuryScopeFingerprint(state) }; return state; };
const project = (state: TreasuryProject, extra = {}) => treasuryProjection(state, { today, horizonDays: 20, ...extra });

test('review: positive unlinked cost cannot claim cash completeness without an explicit mapping', () => {
  const state = fixture(); state.budgetLines = []; state.treasury!.cashPlans = []; delete state.treasury!.costEstimates[0].budgetLineId;
  assert.equal(validateTreasuryChanges(null, state, owner), ''); confirmScope(state);
  const result = project(state);
  assert.equal(treasuryCostSummary(state).eacCents, 10000);
  assert.equal(result.events.length, 0, 'do not invent payment facts or automatically repay ETC');
  assert.equal(result.completeness, false, '100 ₽ of remaining work is not a reliable zero future cash');
  assert.ok(result.warnings.length > 0);
});

test('review: newly approved budget scope needs its own completion estimate', () => {
  const state = fixture(); state.treasury!.budgetVersions = [{ id: 'approved', name: 'Expanded scope', source: 'Owner decision', taxBasis: 'gross', taxNote: 'Gross sums', lines: [{ id: 'work', name: 'Work', amountCents: 10000 }, { id: 'new-roof', name: 'Added roof', amountCents: 5000 }] }]; state.treasury!.activeBudgetVersionId = 'approved';
  assert.equal(validateTreasuryChanges(null, state, owner), ''); confirmScope(state);
  assert.equal(treasuryCostSummary(state).budgetCents, 15000);
  assert.equal(treasuryCostSummary(state).complete, false, 'new version line must not appear as a saving from missing ETC');
  assert.equal(project(state).completeness, false);
});

test('review: saved assumptions detect changed opening, allocation, reserve and default scenario data', () => {
  const state = fixture(); confirmScope(state);
  const fingerprint = treasuryScenarioFingerprint(state);
  state.treasury!.savedScenarios = [{ id: 'saved', name: 'Named assumptions', source: 'What if', asOf: today, basisFingerprint: fingerprint, incomeDelayDays: 0, workDelayDays: 0, tentativeCostIncreasePct: 0, extraCashPlans: [] }];
  for (const mutate of [
    (next: TreasuryProject) => { next.treasury!.accounts[0].opening!.amountCents -= 100; },
    (next: TreasuryProject) => { next.treasury!.accounts[0].restrictedCents = 100; },
    (next: TreasuryProject) => { next.treasury!.accounts[0].projectAllocationCents = 100; },
    (next: TreasuryProject) => { next.treasury!.reserveCents = 100; },
    (next: TreasuryProject) => { next.treasury!.scenarios = { cautiousDelayDays: 1, stressDelayDays: 2, stressCostIncreasePct: 3 }; },
  ]) {
    const next = structuredClone(state); mutate(next);
    assert.notEqual(treasuryScenarioFingerprint(next), fingerprint);
    assert.ok(project(next, { savedScenarioId: 'saved' }).warnings.some(message => message.includes('после сохранения сценария')));
  }
});

test('review: covered work and a partial supplier refund restore debt once without resurrecting covered cash plans', () => {
  const state = fixture(); state.financeEntries = [{ id: 'contract', kind: 'expense', amount: 80, paidAmount: 30, paidAt: '2026-10-27', approvedAt: '2026-10-26T12:00:00Z', description: 'Contract', budgetLineId: 'work', dueDate: '2026-10-30' }];
  state.treasury!.cashPlans![0].coverage = [{ entryId: 'contract', amountCents: 8000 }];
  state.treasury!.entryPlans = [{ entryId: 'contract', source: 'Agreement', sourceAccountId: 'bank', tranches: [] }];
  state.financeLedger!.operations = [{ id: 'refund', kind: 'supplier_refund', date: today, amountCents: 1000, accountId: 'bank', allocations: [{ entryId: 'contract', amountCents: 1000 }], confirmation: 'confirmed', description: 'Refund', source: 'Bank record', counterparty: 'Supplier', refundOfLegacyPayment: { entryId: 'contract', paymentId: 'legacy:contract' } }];
  state.financeLedger!.changeReason = 'Bank-confirmed partial return';
  assert.equal(validateFinanceLedgerChanges(null, state, owner, now), '');
  assert.equal(validateTreasuryChanges(null, state, owner), ''); confirmScope(state);
  const before = structuredClone(state), result = project(state);
  assert.equal(result.events.find(event => event.sourceType === 'cash_plan')!.amountCents, 2000);
  assert.equal(result.events.find(event => event.entryId === 'contract')!.amountCents, 6000);
  assert.equal(result.events.reduce((sum, event) => sum + event.amountCents, 0), 8000);
  assert.deepEqual(state, before);
});

test('review: materials consumption and reversal move AC/ETC while the supplier payment stays single', () => {
  const state = fixture(); state.treasury!.cashPlans = []; state.treasury!.costEstimates[0].remainingWorkCents = 0;
  state.financeEntries = [{ id: 'materials', kind: 'expense', amount: 100.01, description: 'Materials', budgetLineId: 'work', dueDate: '2026-10-30' }];
  state.treasury!.entryPlans = [{ entryId: 'materials', source: 'Supplier', sourceAccountId: 'bank', tranches: [] }];
  state.treasury!.inventoryLots = [{ id: 'lot', name: 'Material', costEstimateId: 'estimate', quantityMillis: 3000, unit: 'm3', totalCostCents: 10001, receivedOn: today, source: 'Receipt' }];
  const original = project(state);
  state.treasury!.inventoryMovements = [{ id: 'use', lotId: 'lot', kind: 'consume', quantityMillis: 1000, date: today, source: 'Works completed' }];
  let cost = treasuryCostSummary(state); assert.equal(cost.recognizedCents, 3333); assert.equal(cost.etcCents, 6668); assert.equal(cost.eacCents, 10001);
  assert.deepEqual(project(state).events, original.events);
  state.treasury!.inventoryMovements.push({ id: 'undo', lotId: 'lot', kind: 'reverse', reversesId: 'use', date: today, source: 'Correction' });
  cost = treasuryCostSummary(state); assert.equal(cost.recognizedCents, 0); assert.equal(cost.etcCents, 10001);
  assert.deepEqual(project(state).events, original.events); assert.equal(project(state).events.length, 1);
});

test('review: stress inflates uncontracted plans, not committed, accepted or partially paid obligations', () => {
  for (const fields of [
    { status: 'committed' as const },
    { status: 'accepted' as const, acceptedAmount: 100 },
    { approvedAt: '2026-10-27T12:00:00Z' },
    { paidAmount: 30, paidAt: today },
  ]) {
    const state = fixture(); state.financeEntries = [{ id: 'contract', kind: 'expense', amount: 100, description: 'Existing fixed commitment', budgetLineId: 'work', ...fields }];
    const paid = 'paidAmount' in fields ? fields.paidAmount : 0;
    state.treasury!.entryPlans = [{ entryId: 'contract', source: 'Existing contract', sourceAccountId: 'bank', tranches: [{ id: 'remaining', amountCents: 10000, forecastDate: '2026-10-30', certainty: 'tentative', source: 'Timing still uncertain', ...(paid ? { paymentAllocations: [{ paymentId: 'legacy:contract', amountCents: paid * 100 }] } : {}) }] }];
    state.treasury!.cashPlans![0].certainty = 'tentative';
    state.treasury!.scenarios = { cautiousDelayDays: 0, stressDelayDays: 0, stressCostIncreasePct: 10 };
    const original = structuredClone(state), result = project(state, { scenario: 'stress' });
    assert.equal(result.events.find(event => event.entryId === 'contract')!.amountCents, 10000 - paid * 100);
    assert.equal(result.events.find(event => event.sourceType === 'cash_plan')!.amountCents, 11000);
    assert.deepEqual(state, original, 'scenario never rewrites the contractual amount or payment facts');
  }
});
