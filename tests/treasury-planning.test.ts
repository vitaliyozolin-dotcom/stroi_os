import test from 'node:test';
import assert from 'node:assert/strict';
import { treasuryProjection, treasuryTrancheBalance, treasuryCostSummary, treasuryDelaySummary, treasuryInventorySummary, treasuryBudgetComparison, treasuryScenarioFingerprint, validateTreasuryChanges, type TreasuryProject } from '../src/domain/treasury.js';
import { emptyFinanceLedger } from '../src/domain/finance-ledger.js';
import type { TreasuryCashPlan, TreasuryDelayRate, LedgerOperation } from '../src/entities/index.ts';
const today = '2026-10-28', now = `${today}T12:00:00Z`, owner = { role: 'management', name: 'Reviewer' };
const fixture = (): TreasuryProject => ({ project: { id: 'test' }, financeEntries: [], budgetLines: [{ id: 'work', name: 'Work', plan: 100 }], stages: [], tasks: [], financeLedger: emptyFinanceLedger(), treasury: { version: 1, enabled: true, accounts: [{ id: 'bank', name: 'Bank', currency: 'RUB', legalEntityId: 'company', isProjectDedicated: true, opening: { amountCents: 100000, asOf: today, confirmed: true, source: 'Bank statement' } }], entryPlans: [], costEstimates: [{ id: 'estimate', name: 'Work estimate', budgetLineId: 'work', recognizedCents: 0, remainingWorkCents: 10000, stockToConsumeCents: 0, otherRemainingCents: 0, approvedBudgetCents: 10000, taxBasis: 'gross', source: 'Reviewed estimate without stocked materials' }] } });
const plan = (extra: Partial<TreasuryCashPlan> = {}): TreasuryCashPlan => ({ id: 'plan', name: 'Uncontracted work', kind: 'expense', category: 'uncontracted_work', amountCents: 10000, date: '2026-10-30', accountId: 'bank', budgetLineId: 'work', certainty: 'expected', source: 'Expected subcontract scope', ...extra });
const operation = (id: string, kind: LedgerOperation['kind'], amountCents: number, extra: Partial<LedgerOperation> = {}): LedgerOperation => ({ id, kind, amountCents, date: '2026-10-28', accountId: 'bank', allocations: [], confirmation: 'confirmed', source: 'Evidence', description: id, counterparty: 'Party', ...extra });
const projection = (state: TreasuryProject, extra = {}) => treasuryProjection(state, { today, horizonDays: 30, ...extra });
const rate = (extra: Partial<TreasuryDelayRate> = {}): TreasuryDelayRate => ({ id: 'rate', name: 'Extended site overhead', category: 'overhead', baselineEnd: '2026-10-28', endDate: '2026-10-31', dailyCents: 1000, calendar: 'calendar', paymentOffsetDays: 1, accountId: 'bank', source: 'Approved daily site cost', costTreatment: 'additional', recognizedCents: 1000, ...extra });

test('uncontracted 100 replaced by obligation 80 paid 30 yields 20 standalone plus 50 obligation', () => {
  const state = fixture(); state.financeEntries = [{ id: 'entry', kind: 'expense', description: 'Contract', amount: 80, paidAmount: 30, paidAt: today, dueDate: '2026-10-30', budgetLineId: 'work' }];
  state.treasury!.entryPlans = [{ entryId: 'entry', source: 'Contract', sourceAccountId: 'bank', tranches: [] }];
  state.treasury!.cashPlans = [plan({ coverage: [{ entryId: 'entry', amountCents: 8000 }] })];
  assert.equal(validateTreasuryChanges(null, state, owner, now), '');
  const result = projection(state);
  assert.equal(result.events.reduce((sum, row) => sum + row.amountCents, 0), 7000);
  assert.equal(result.events.find(row => row.sourceType === 'cash_plan')!.amountCents, 2000);
  assert.equal(result.days[1].outflowCents, 7000);
});

test('coverage is globally exclusive and cannot survive deleted or reduced commitments', () => {
  const state = fixture(); state.financeEntries = [{ id: 'entry', kind: 'expense', description: 'Contract', amount: 80 }];
  state.treasury!.cashPlans = [plan({ coverage: [{ entryId: 'entry', amountCents: 6000 }] }), plan({ id: 'second', coverage: [{ entryId: 'entry', amountCents: 3000 }] })];
  assert.match(validateTreasuryChanges(null, state, owner), /больше плановых/);
  state.treasury!.cashPlans.pop(); assert.equal(validateTreasuryChanges(null, state, owner), '');
  const next = structuredClone(state); next.financeEntries[0].amount = 50;
  assert.match(validateTreasuryChanges(state, next, owner), /больше плановых/);
  next.financeEntries = []; assert.match(validateTreasuryChanges(state, next, owner), /существующее обязательство/);
});

test('unknown standalone cash date remains allocated money outside the day calendar', () => {
  const state = fixture(); state.treasury!.cashPlans = [plan({ date: undefined })];
  const result = projection(state);
  assert.equal(result.unallocatedCents.expense, 10000); assert.equal(result.days.reduce((sum, day) => sum + day.outflowCents, 0), 0); assert.equal(result.completeness, false);
});

test('inventory allocates exact cents cumulatively and moves stock ETC into AC without any second cash', () => {
  const state = fixture(); state.treasury!.costEstimates[0].remainingWorkCents = 0;
  state.treasury!.inventoryLots = [{ id: 'lot', name: 'Concrete', costEstimateId: 'estimate', quantityMillis: 3000, unit: 'm3', totalCostCents: 100003, receivedOn: today, source: 'Receipt, base estimate excludes this material' }];
  const before = projection(state); assert.equal(before.events.length, 0); assert.ok(before.warnings.some(row => /не связаны/.test(row)), 'unpaid/unmodeled stock cash must be explicitly covered');
  for (let index = 1; index <= 3; index++) {
    state.treasury!.inventoryMovements ??= []; state.treasury!.inventoryMovements.push({ id: `use${index}`, lotId: 'lot', kind: 'consume', quantityMillis: 1000, date: today, source: 'Work acceptance' });
    const stock = treasuryInventorySummary(state.treasury), costs = treasuryCostSummary(state);
    assert.equal(stock.consumedCents, Math.floor(100003 * index / 3)); assert.equal(costs.recognizedCents, stock.consumedCents); assert.equal(costs.etcCents, stock.stockCents); assert.equal(costs.eacCents, 100003); assert.equal(projection(state).events.length, 0);
  }
  const previous = structuredClone(state); assert.equal(validateTreasuryChanges(null, previous, owner, now), '');
  state.treasury!.inventoryMovements!.push({ id: 'undo', lotId: 'lot', kind: 'reverse', reversesId: 'use2', date: today, source: 'Acceptance corrected' });
  assert.equal(treasuryInventorySummary(state.treasury).stockCents, 33335);
  assert.equal(validateTreasuryChanges(null, state, owner, now), '');
});

test('inventory cannot overconsume, double reverse, rewrite facts, coexist with manual stock or use future receipts', () => {
  const state = fixture(); state.treasury!.inventoryLots = [{ id: 'lot', name: 'Steel', costEstimateId: 'estimate', quantityMillis: 1000, unit: 't', totalCostCents: 10000, receivedOn: today, source: 'Receipt' }];
  state.treasury!.inventoryMovements = [{ id: 'use', lotId: 'lot', kind: 'consume', quantityMillis: 1001, date: today, source: 'Work' }];
  assert.match(validateTreasuryChanges(null, state, owner, now), /превышает остаток/);
  state.treasury!.inventoryMovements[0].quantityMillis = 1000;
  const next = structuredClone(state); next.treasury!.inventoryLots![0].totalCostCents = 1; next.treasury!.changeReason = 'Change';
  assert.match(validateTreasuryChanges(state, next, owner), /не переписываются/);
  state.treasury!.costEstimates[0].stockToConsumeCents = 1; assert.match(validateTreasuryChanges(null, state, owner), /обнулите ручной запас/);
  state.treasury!.costEstimates[0].stockToConsumeCents = 0; state.treasury!.inventoryLots![0].receivedOn = '2026-10-29'; assert.match(validateTreasuryChanges(null, state, owner, now), /фактическая дата/);
});

test('budget snapshots are immutable, server authored, activated and compared against original', () => {
  const state = fixture(); state.treasury!.budgetVersions = [{ id: 'v1', name: 'Original', source: 'Decision 1', taxBasis: 'gross', taxNote: 'Configured tax included', lines: [{ id: 'work', name: 'Work', amountCents: 10000 }] }, { id: 'v2', name: 'Revised', source: 'Decision 2', taxBasis: 'gross', taxNote: 'Configured tax included', lines: [{ id: 'work', name: 'Work', amountCents: 12000 }] }]; state.treasury!.activeBudgetVersionId = 'v2';
  assert.equal(validateTreasuryChanges(null, state, owner, now), ''); assert.equal(state.treasury!.budgetVersions[1].approvedBy, owner.name);
  assert.equal(treasuryBudgetComparison(state).changeCents, 2000); assert.equal(treasuryCostSummary(state).budgetCents, 12000);
  const next = structuredClone(state); next.treasury!.changeReason = 'Rewrite'; next.treasury!.budgetVersions![0].lines[0].amountCents = 5;
  assert.match(validateTreasuryChanges(state, next, owner), /не переписываются/);
  state.treasury!.costEstimates[0].taxBasis = 'net'; assert.ok(treasuryCostSummary(state).warnings.some(row => /База сумм/.test(row)));
});

test('delay cost separates additional AC/ETC from cash and only subtracts explicit obligation coverage', () => {
  const state = fixture(); state.treasury!.delayRates = [rate()];
  assert.equal(treasuryDelaySummary(state).totalCents, 3000);
  const cost = treasuryCostSummary(state); assert.equal(cost.recognizedCents, 1000); assert.equal(cost.etcCents, 12000); assert.equal(cost.eacCents, 13000);
  assert.equal(projection(state).events[0].amountCents, 3000, 'recognition does not pay cash');
  state.financeEntries = [{ id: 'entry', kind: 'expense', description: 'Delay contract', amount: 20, paidAmount: 10, paidAt: today, dueDate: '2026-11-01' }];
  state.treasury!.delayRates[0].coverage = [{ entryId: 'entry', amountCents: 2000 }]; state.treasury!.entryPlans = [{ entryId: 'entry', source: 'Agreement', sourceAccountId: 'bank', tranches: [] }];
  assert.equal(projection(state).events.reduce((sum, row) => sum + row.amountCents, 0), 2000);
  state.treasury!.delayRates[0].costTreatment = 'included_in_estimate'; assert.equal(treasuryCostSummary(state).eacCents, 10000); assert.equal(projection(state).events.reduce((sum, row) => sum + row.amountCents, 0), 2000);
});

test('unresolved delay rule never falls back to stale fixed end and unknown rate never becomes zero EAC', () => {
  const state = fixture(); state.stages = [{ id: 'stage', name: 'Unknown stage' }]; state.treasury!.delayRates = [rate({ endRule: { kind: 'stage_end', stageId: 'stage', offsetDays: 0, calendar: 'calendar' } })];
  assert.equal(treasuryDelaySummary(state).totalCents, null); assert.equal(treasuryCostSummary(state).eacCents, null); assert.equal(projection(state).completeness, false);
});

test('saved scenario shifts uncompleted PPR events and delay cost, leaves fixed dates and actual anchors intact', () => {
  const state = fixture(); state.tasks = [{ id: 'future', title: 'Future', dueDate: '2026-10-30' }, { id: 'done', title: 'Done', status: 'done', completedAt: '2026-10-28' }];
  state.treasury!.cashPlans = [plan({ id: 'fixed' }), plan({ id: 'linked', dateRule: { kind: 'task_end', taskId: 'future', offsetDays: 0, calendar: 'calendar' } }), plan({ id: 'actual', dateRule: { kind: 'task_end', taskId: 'done', offsetDays: 2, calendar: 'calendar' } })];
  state.treasury!.delayRates = [rate({ recognizedCents: 0 })];
  state.treasury!.savedScenarios = [{ id: 'stress', name: 'Work delay', source: 'What-if', asOf: today, basisFingerprint: treasuryScenarioFingerprint(state), incomeDelayDays: 2, workDelayDays: 5, tentativeCostIncreasePct: 10, extraCashPlans: [plan({ id: 'extra', amountCents: 500 })] }];
  const before = structuredClone(state), result = projection(state, { savedScenarioId: 'stress' });
  assert.equal(result.events.find(row => row.sourceId === 'fixed')!.date, '2026-10-30');
  assert.equal(result.events.find(row => row.sourceId === 'linked')!.date, '2026-11-04');
  assert.equal(result.events.find(row => row.sourceId === 'actual')!.date, '2026-10-30');
  assert.equal(result.delayCosts.totalCents, 8000); assert.equal(result.events.filter(row => row.sourceType === 'scenario').length, 1); assert.deepEqual(state, before);
});

test('ledger cash cutoff, legacy reconciliation and offset are counted once; refunds restore debt', () => {
  const state = fixture(); state.treasury!.accounts[0].opening!.asOf = '2026-10-26';
  state.financeEntries = [{ id: 'entry', kind: 'expense', description: 'Contract', amount: 100, paidAmount: 30, paidAt: '2026-10-27', dueDate: '2026-10-30' }, { id: 'income', kind: 'income', description: 'Customer', amount: 100, dueDate: '2026-10-30' }];
  state.treasury!.entryPlans = ['entry', 'income'].map(entryId => ({ entryId, source: 'Agreement', sourceAccountId: 'bank', tranches: [] }));
  state.financeLedger!.operations = [operation('reconcile', 'payment', 3000, { legacyPayment: { entryId: 'entry', paymentId: 'legacy:entry' } }), operation('payment', 'payment', 4000, { allocations: [{ entryId: 'entry', amountCents: 4000 }] }), operation('offset', 'offset', 1000, { accountId: undefined, allocations: [{ entryId: 'entry', amountCents: 1000 }, { entryId: 'income', amountCents: 1000 }] }), operation('refund', 'supplier_refund', 2000, { allocations: [{ entryId: 'entry', amountCents: 2000 }], refundOfOperationId: 'payment' })];
  const result = projection(state); assert.equal(result.openingCents, 95000); assert.equal(result.events.find(row => row.entryId === 'entry')!.amountCents, 4000); assert.equal(result.events.find(row => row.entryId === 'income')!.amountCents, 9000);
  state.treasury!.accounts[0].opening!.asOf = today; assert.equal(projection(state).openingCents, 100000, 'same-day snapshot already contains all cash');
});

test('retention splits existing unpaid balance once and unknown release stays visible outside calendar', () => {
  const state = fixture(); state.financeEntries = [{ id: 'entry', kind: 'expense', description: 'Contract', amount: 100, dueDate: '2026-10-30' }]; state.treasury!.entryPlans = [{ entryId: 'entry', sourceAccountId: 'bank', source: 'Contract', tranches: [] }];
  state.financeLedger!.retentions = [{ id: 'hold', entryId: 'entry', amountCents: 3000, status: 'held', releaseDate: '2026-11-10', source: 'Warranty' }];
  let result = projection(state); assert.equal(result.events.reduce((sum, row) => sum + row.amountCents, 0), 10000); assert.equal(result.events.find(row => row.sourceType === 'retention')!.amountCents, 3000); assert.equal(result.days[1].outflowCents, 7000);
  delete state.financeLedger!.retentions[0].releaseDate; result = projection(state); assert.equal(result.unallocatedCents.expense, 3000); assert.equal(result.events.find(row => row.sourceType === 'retention')!.date, null);
});

test('loan cash and internal transfer preserve consolidated money without altering EAC or delaying financing', () => {
  const state = fixture(); state.treasury!.accounts[0].opening!.asOf = '2026-10-26'; state.treasury!.accounts.push({ ...state.treasury!.accounts[0], id: 'cash', name: 'Cash', opening: { ...state.treasury!.accounts[0].opening!, amountCents: 0 } });
  state.financeLedger!.loans = [{ id: 'loan', name: 'Loan', accountId: 'bank', principalCents: 20000, openingPrincipalCents: 0, direction: 'borrowed', counterparty: 'Lender', source: 'Loan contract', status: 'active', schedule: [{ id: 'draw', kind: 'drawdown', date: '2026-10-29', amountCents: 20000 }, { id: 'pay', kind: 'principal', date: '2026-11-10', amountCents: 20000 }] }];
  state.financeLedger!.operations = [operation('move', 'transfer', 10000, { toAccountId: 'cash' })]; state.treasury!.scenarios = { cautiousDelayDays: 5, stressDelayDays: 7, stressCostIncreasePct: 0 };
  const result = projection(state, { scenario: 'cautious' }); assert.equal(result.openingCents, 100000); assert.equal(result.events.find(row => row.kind === 'income')!.date, '2026-10-29'); assert.equal(result.events[0].sourceId, 'loan'); assert.equal(treasuryCostSummary(state).eacCents, 10000);
});

test('bank import protects stable account identity and ledger protects original legal entity', () => {
  const state = fixture(); state.financeLedger!.operations = [operation('import', 'payment', 1000, { sourceKey: 'bank:source-row' })];
  const next = structuredClone(state); next.treasury!.changeReason = 'Rename'; next.treasury!.accounts[0].sharedAccountKey = 'changed';
  assert.match(validateTreasuryChanges(state, next, owner), /после импорта/);
  delete next.treasury!.accounts[0].sharedAccountKey; next.treasury!.accounts[0].legalEntityId = 'other-company';
  assert.match(validateTreasuryChanges(state, next, owner), /Владелец счёта/);
});


test('tranche balance includes retained remainder and exposes unknown allocation instead of selecting first event', () => {
  const state = fixture(); state.financeEntries = [{ id: 'entry', kind: 'expense', description: 'Contract', amount: 100 }];
  state.treasury!.entryPlans = [{ entryId: 'entry', source: 'Contract', sourceAccountId: 'bank', tranches: [{ id: 'first', amountCents: 7000, forecastDate: '2026-10-30', certainty: 'confirmed', source: 'Contract' }, { id: 'last', amountCents: 3000, forecastDate: '2026-11-10', certainty: 'confirmed', source: 'Contract' }] }];
  state.financeLedger!.operations = [operation('pay', 'payment', 3000, { allocations: [{ entryId: 'entry', trancheId: 'first', amountCents: 3000 }] })];
  state.financeLedger!.retentions = [{ id: 'hold', entryId: 'entry', trancheId: 'first', amountCents: 2000, releaseDate: '2026-11-15', status: 'held', source: 'Warranty' }];
  let balance = treasuryTrancheBalance(projection(state), 'entry', 'first');
  assert.equal(balance.remainingCents, 4000); assert.equal(balance.heldCents, 2000); assert.equal(balance.payableCents, 2000); assert.equal(balance.retentions[0].scheduledDate, '2026-11-15');
  delete state.financeLedger!.retentions[0].releaseDate; balance = treasuryTrancheBalance(projection(state), 'entry', 'first'); assert.equal(balance.remainingCents, 4000); assert.equal(balance.retentions[0].date, null);
  delete state.financeLedger!.operations[0].allocations[0].trancheId; balance = treasuryTrancheBalance(projection(state), 'entry', 'first'); assert.equal(balance.unknown, true); assert.equal(balance.remainingCents, null); assert.equal(balance.heldCents, null);
});
