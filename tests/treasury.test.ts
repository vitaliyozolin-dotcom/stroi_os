import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyTreasury, treasuryMoneyToCents, validTreasuryDate, treasuryPaymentReferences, treasuryProjection,
  treasuryCostSummary, validateTreasuryChanges, resolveTreasuryDateRule, treasuryScopeFingerprint, type TreasuryProject } from '../src/domain/treasury.js';
import type { TreasuryEntryPlan, TreasuryTranche } from '../src/entities/treasury.ts';
import type { Stage } from '../src/entities/stage.ts';
import { schedulePayload } from '../src/domain/construction/schedule-forecast.js';

const owner = { role: 'management', name: 'Owner' }, now = '2026-10-28T12:00:00Z';
const fixture = (): TreasuryProject => ({ project: { id: 'pilot' }, financeEntries: [], budgetLines: [], stages: [], tasks: [],
  treasury: { ...emptyTreasury(), enabled: true, accounts: [{ id: 'bank', name: 'Bank', legalEntityId: 'company', currency: 'RUB',
    isProjectDedicated: true, opening: { asOf: '2026-10-28', amountCents: 200_000_00, confirmed: true, source: 'Confirmed snapshot' } }],
    costEstimates: [{ id: 'synthetic-scope', name: 'Reviewed synthetic project', recognizedCents: 0, remainingWorkCents: 0, stockToConsumeCents: 0,
      otherRemainingCents: 0, approvedBudgetCents: 0, source: 'Synthetic complete-scope fixture' }] } });
const tranche = (id: string, amountCents: number, date: string, extra: Partial<TreasuryTranche> = {}): TreasuryTranche => ({ id, amountCents, forecastDate: date, certainty: 'confirmed', source: 'Contract', ...extra });
const plan = (entryId: string, tranches: TreasuryTranche[] = [], extra: Partial<TreasuryEntryPlan> = {}): TreasuryEntryPlan => ({ entryId, sourceAccountId: 'bank', cashTreatment: 'account', tranches, source: 'Contract', ...extra });
const forecast = (state: TreasuryProject, extra = {}) => {
  const copy = structuredClone(state);
  copy.treasury!.cashScopeReview ??= { asOf: '2026-10-28', source: 'Synthetic reviewed forecast coverage', fingerprint: treasuryScopeFingerprint(copy) };
  return treasuryProjection(copy, { today: '2026-10-28', horizonDays: 14, ...extra });
};

test('daily deficit and reserve are separate; peak is not sum of negative days', () => {
  const s = fixture(); s.treasury!.reserveCents = 50_000_00;
  s.financeEntries = [{ id: 'expense', kind: 'expense', amount: 300_000, description: 'Materials', dueDate: '2026-10-29' },
    { id: 'income', kind: 'income', amount: 250_000, description: 'Customer', dueDate: '2026-10-30' }];
  s.treasury!.entryPlans = [plan('expense'), plan('income')];
  const p = forecast(s);
  assert.deepEqual(p.days.slice(0, 2).map(day => day.balanceCents), [-100_000_00, 150_000_00]);
  assert.equal(p.firstDeficitDate, '2026-10-29'); assert.equal(p.peakFundingCents, 100_000_00);
  assert.equal(p.peakReserveFundingCents, 150_000_00); assert.equal(p.completeness, true);
});

test('unknown opening and undated amounts never become a reliable zero balance', () => {
  const s = fixture(); delete s.treasury!.accounts[0].opening;
  s.financeEntries = [{ id: 'e', kind: 'expense', amount: 80, description: 'Unknown date' }];
  s.treasury!.entryPlans = [plan('e')];
  const p = forecast(s); assert.equal(p.openingKnown, false); assert.equal(p.peakFundingCents, null);
  assert.equal(p.days[0].balanceCents, null); assert.equal(p.unallocatedCents.expense, 8000); assert.equal(p.completeness, false);
  assert.equal(treasuryMoneyToCents(null), null); assert.equal(treasuryMoneyToCents('1'), null);
});

test('advances settle exactly one tranche without becoming recognized construction cost', () => {
  const s = fixture();
  s.financeEntries = [{ id: 'contract', kind: 'expense', amount: 1_000_000, description: 'Foundation', paidAmount: 300_000,
    payments: [{ id: 'p1', amount: 300_000, date: '2026-10-20' }] }];
  s.treasury!.entryPlans = [plan('contract', [tranche('advance', 300_000_00, '2026-10-20', { paymentAllocations: [{ paymentId: 'p1', amountCents: 300_000_00 }] }),
    tranche('balance', 700_000_00, '2026-11-01')])];
  s.treasury!.costEstimates = [{ id: 'cost', name: 'Foundation', recognizedCents: 600_000_00, remainingWorkCents: 400_000_00,
    stockToConsumeCents: 0, otherRemainingCents: 0, approvedBudgetCents: 1_000_000_00, source: 'Accepted work and revised estimate' }];
  assert.equal(validateTreasuryChanges(null, s, owner), '');
  assert.equal(forecast(s).events.reduce((n, e) => n + e.amountCents, 0), 700_000_00);
  assert.equal(treasuryCostSummary(s).eacCents, 1_000_000_00);
  assert.equal(s.financeEntries[0].payments!.length, 1);
});

test('unallocated historical settlements do not invent which tranche was paid', () => {
  const s = fixture(); s.financeEntries = [{ id: 'e', kind: 'expense', amount: 100, paidAmount: 30, description: 'Historical' }];
  s.treasury!.entryPlans = [plan('e', [tranche('a', 5000, '2026-10-29'), tranche('b', 5000, '2026-11-02')])];
  const p = forecast(s); assert.equal(p.unallocatedSettlementCents, 3000);
  assert.equal(p.events.length, 1); assert.equal(p.events[0].amountCents, 7000); assert.equal(p.events[0].date, null);
  assert.equal(p.unallocatedCents.expense, 7000); assert.equal(p.completeness, false);
});

test('end-of-day snapshot includes same-day cash; only later confirmed mapped movements change it', () => {
  const s = fixture(); s.treasury!.accounts[0].opening!.asOf = '2026-10-26';
  s.financeEntries = [{ id: 'e', kind: 'expense', amount: 100, paidAmount: 100, description: 'Two payments', payments: [
    { id: 'p1', amount: 30, date: '2026-10-26' }, { id: 'p2', amount: 70, date: '2026-10-27' }] }];
  s.treasury!.entryPlans = [plan('e', [], { paymentFacts: ['p1', 'p2'].map(paymentId => ({ paymentId, accountId: 'bank', cashTreatment: 'account', confirmation: 'reconciled', source: 'Bank statement' })) })];
  const p = forecast(s); assert.equal(p.openingCents, 200_000_00 - 7000); assert.equal(p.events.length, 0);
});

test('an unmapped movement since a stale opening makes the bank balance unknown', () => {
  const s = fixture(); s.treasury!.accounts[0].opening!.asOf = '2026-10-26';
  s.financeEntries = [{ id: 'e', kind: 'expense', amount: 100, paidAmount: 100, paidAt: '2026-10-27', description: 'Unmapped' }];
  const p = forecast(s); assert.equal(p.openingKnown, false); assert.equal(p.openingCents, null);
  assert.ok(p.warnings.some(w => /не сверено/.test(w)));
});

test('participant direct payment settles supplier but not the company bank', () => {
  const s = fixture(); s.treasury!.accounts[0].opening!.asOf = '2026-10-26';
  s.financeEntries = [{ id: 'supplier', kind: 'expense', amount: 100, paidAmount: 100, description: 'Supplier', payments: [{ id: 'p', amount: 100, date: '2026-10-27' }] },
    { id: 'refund-partner', kind: 'expense', amount: 100, description: 'Reimbursement', dueDate: '2026-10-29' }];
  s.treasury!.entryPlans = [plan('supplier', [], { paymentFacts: [{ paymentId: 'p', cashTreatment: 'participant_direct', confirmation: 'confirmed', source: 'Partner confirmation' }] }), plan('refund-partner')];
  const p = forecast(s); assert.equal(p.openingCents, 200_000_00); assert.equal(p.days[0].outflowCents, 10000);
  assert.equal(p.events.length, 1);
});

test('claimed payment does not extinguish the expected outgoing cash', () => {
  const s = fixture(); s.financeEntries = [{ id: 'e', kind: 'expense', amount: 100, paidAmount: 100, description: 'Not executed', dueDate: '2026-10-29', payments: [{ id: 'p', amount: 100, date: '2026-10-28' }] }];
  s.treasury!.entryPlans = [plan('e', [], { paymentFacts: [{ paymentId: 'p', accountId: 'bank', cashTreatment: 'account', confirmation: 'claimed', source: 'Unexecuted order' }] })];
  assert.equal(forecast(s).days[0].outflowCents, 10000);
});

test('shared account requires an explicit project allocation and respects restricted funds', () => {
  const s = fixture(), account = s.treasury!.accounts[0]; account.isProjectDedicated = false; account.restrictedCents = 50_000_00;
  assert.equal(forecast(s).openingKnown, false);
  account.projectAllocationCents = 100_000_00; assert.equal(forecast(s).openingCents, 100_000_00);
  account.projectAllocationCents = 160_000_00;
  assert.match(validateTreasuryChanges(null, s, owner), /больше доступных/);
});

test('positive consolidated balance does not hide another legal entity deficit', () => {
  const s = fixture(); s.treasury!.accounts.push({ id: 'second', name: 'Second bank', legalEntityId: 'other-company', currency: 'RUB', isProjectDedicated: true,
    opening: { asOf: '2026-10-28', amountCents: 0, confirmed: true, source: 'Statement' } });
  s.financeEntries = [{ id: 'e', kind: 'expense', amount: 100, description: 'Second-company supplier', dueDate: '2026-10-29' }];
  s.treasury!.entryPlans = [plan('e', [], { sourceAccountId: 'second' })];
  const p = forecast(s); assert.equal(p.peakFundingCents, 0); assert.equal(p.completeness, false);
  assert.ok(p.warnings.some(w => /other-company/.test(w)));
  assert.equal(forecast(s, { accountId: 'second' }).peakFundingCents, 10000);
});

test('scenario delays cash, excludes uncertain receipts and only increases uncontracted estimates', () => {
  const s = fixture(); s.treasury!.scenarios = { cautiousDelayDays: 3, stressDelayDays: 10, stressCostIncreasePct: 10 };
  s.financeEntries = [{ id: 'in', kind: 'income', amount: 100, description: 'Contracted receipt' }, { id: 'maybe', kind: 'income', amount: 100, description: 'Tentative receipt' },
    { id: 'fixed', kind: 'expense', amount: 100, description: 'Fixed obligation' }, { id: 'estimate', kind: 'expense', amount: 100, description: 'Uncontracted estimate' }];
  s.treasury!.entryPlans = [plan('in', [tranche('t', 10000, '2026-10-29')]), plan('maybe', [tranche('t', 10000, '2026-10-29', { certainty: 'tentative' })]),
    plan('fixed', [tranche('t', 10000, '2026-10-29')]), plan('estimate', [tranche('t', 10000, '2026-10-29', { certainty: 'tentative' })])];
  const p = forecast(s, { scenario: 'stress' });
  assert.equal(p.events.find(e => e.entryId === 'in')!.date, '2026-11-08');
  assert.equal(p.events.find(e => e.entryId === 'maybe')!.excluded, true);
  assert.equal(p.events.find(e => e.entryId === 'fixed')!.amountCents, 10000);
  assert.equal(p.events.find(e => e.entryId === 'estimate')!.amountCents, 11000);
});

test('date rules use actual/forecast schedule and preserve fixed contractual deadline', () => {
  const s = fixture(); s.stages = [{ id: 'stage', planStart: '2026-10-30', forecastEnd: '2026-11-02' }];
  assert.equal(resolveTreasuryDateRule(s, { kind: 'stage_start', stageId: 'stage', offsetDays: 1, calendar: 'workdays' }), '2026-11-02');
  assert.equal(resolveTreasuryDateRule(s, { kind: 'stage_acceptance', stageId: 'stage', offsetDays: 0, calendar: 'calendar' }), null);
  s.financeEntries = [{ id: 'e', kind: 'expense', amount: 100, description: 'After completion' }];
  s.treasury!.entryPlans = [plan('e', [tranche('t', 10000, '2026-11-01', { contractualDueDate: '2026-10-27',
    dateRule: { kind: 'stage_end', stageId: 'stage', offsetDays: 3, calendar: 'calendar' } })])];
  assert.equal(forecast(s).events[0].date, '2026-11-05'); assert.equal(forecast(s).events[0].contractualDueDate, '2026-10-27');
  assert.equal(forecast(s).events[0].overdue, true);
  s.stages[0].forecastEnd = '2026-11-04'; assert.equal(forecast(s).events[0].date, '2026-11-07');
});

test('paid unconsumed stock belongs to ETC without becoming another future payment', () => {
  const s = fixture(); s.financeEntries = [{ id: 'stock', kind: 'expense', amount: 100, paidAmount: 100, description: 'Stock' }];
  s.treasury!.costEstimates = [{ id: 'cost', name: 'Stock', recognizedCents: 0, stockToConsumeCents: 10000, remainingWorkCents: 0, otherRemainingCents: 0, approvedBudgetCents: 10000, source: 'Stock register' }];
  assert.equal(treasuryCostSummary(s).eacCents, 10000); assert.equal(treasuryCostSummary(s).recognizedCents, 0);
  assert.equal(forecast(s).events.length, 0);
  s.financeEntries.push({ id: 'loan', kind: 'income', amount: 500, description: 'Loan', dueDate: '2026-10-29' });
  s.treasury!.entryPlans = [plan('loan')];
  assert.equal(forecast(s).days[0].inflowCents, 50000); assert.equal(treasuryCostSummary(s).eacCents, 10000);
});

test('unknown EAC is not zero and uncovered budget lines make the estimate incomplete', () => {
  const s = fixture(); s.treasury!.costEstimates = []; assert.equal(treasuryCostSummary(s).eacCents, null);
  s.budgetLines = [{ id: 'one', plan: 100 }, { id: 'two', plan: 200 }];
  s.treasury!.costEstimates = [{ id: 'estimate', budgetLineId: 'one', name: 'One', recognizedCents: 2000, remainingWorkCents: 9000, stockToConsumeCents: 0,
    otherRemainingCents: 0, approvedBudgetCents: 10000, source: 'Estimate' }];
  const c = treasuryCostSummary(s); assert.equal(c.eacCents, 11000); assert.equal(c.varianceCents, 1000); assert.equal(c.complete, false);
});

test('server appends history, client validation does not stamp, repeat does not duplicate', () => {
  const s = fixture(), before = structuredClone(s);
  assert.equal(validateTreasuryChanges(null, s, owner), ''); assert.deepEqual(s, before);
  assert.equal(validateTreasuryChanges(null, s, owner, now), ''); assert.equal(s.treasury!.history!.length, 1);
  const next = structuredClone(s); next.treasury!.reserveCents = 100; next.treasury!.changeReason = 'Liquidity policy';
  assert.equal(validateTreasuryChanges(s, next, owner, '2026-10-28T12:01:00Z'), '');
  assert.equal(next.treasury!.history!.length, 2); assert.equal(next.treasury!.history![1].by, 'Owner');
  assert.equal(validateTreasuryChanges(next, structuredClone(next), owner, now), '');
  assert.equal(next.treasury!.history!.length, 2);
});

test('permissions and immutable history block forged or destructive updates', () => {
  const s = fixture(); assert.match(validateTreasuryChanges(null, s, { role: 'foreman' }), /Управление/);
  validateTreasuryChanges(null, s, owner, now);
  const forged = structuredClone(s); forged.treasury!.history![0].by = 'Forged';
  assert.match(validateTreasuryChanges(s, forged, owner), /История/);
  const deleted = structuredClone(s); delete deleted.treasury;
  assert.match(validateTreasuryChanges(s, deleted, owner), /Нельзя удалить/);
  const changed = structuredClone(s); changed.treasury!.reserveCents = 1;
  assert.match(validateTreasuryChanges(s, changed, owner), /причину/);
});

test('tranche and payment allocations cannot duplicate or exceed recorded amounts', () => {
  const s = fixture(); s.financeEntries = [{ id: 'e', kind: 'expense', amount: 100, paidAmount: 30, description: 'Allocation', payments: [{ id: 'p', amount: 30, date: '2026-10-28' }] }];
  s.treasury!.entryPlans = [plan('e', [tranche('a', 5000, '2026-11-01', { paymentAllocations: [{ paymentId: 'p', amountCents: 2000 }] }),
    tranche('b', 5000, '2026-11-02', { paymentAllocations: [{ paymentId: 'p', amountCents: 2000 }] })])];
  assert.match(validateTreasuryChanges(null, s, owner), /превышает сумму/);
  s.treasury!.entryPlans[0].tranches[1].paymentAllocations![0].amountCents = 1000;
  assert.equal(validateTreasuryChanges(null, s, owner), ''); assert.equal(forecast(s).events.reduce((n, e) => n + e.amountCents, 0), 7000);
  s.treasury!.entryPlans[0].tranches[1].amountCents = 4000;
  assert.match(validateTreasuryChanges(null, s, owner), /Сумма траншей/);
});

test('future opening rejected on server, negative actual opening is explicit deficit', () => {
  const s = fixture(); s.treasury!.accounts[0].opening!.asOf = '2026-10-29';
  assert.match(validateTreasuryChanges(null, s, owner, now), /будущим/); assert.equal(forecast(s).openingKnown, false);
  s.treasury!.accounts[0].opening!.asOf = '2026-10-28'; s.treasury!.accounts[0].opening!.amountCents = -10000;
  assert.equal(validateTreasuryChanges(null, s, owner), ''); assert.equal(forecast(s).firstDeficitDate, '2026-10-28');
});

test('legacy references preserve unknown dates, exact zero and repeatable calculation', () => {
  const entry = { id: 'e', kind: 'expense' as const, amount: 100, paidAmount: 100, paidAt: '2026-10-28', description: 'Legacy', payments: [{ id: 'p', amount: 60, date: '2026-10-28' }] };
  assert.deepEqual(treasuryPaymentReferences(entry), [{ id: 'legacy:e', amountCents: 4000, date: null, legacy: true }, { id: 'p', amountCents: 6000, date: '2026-10-28', legacy: false }]);
  assert.deepEqual(treasuryPaymentReferences({ ...entry, paidAmount: 0, payments: [] }), []);
  assert.equal(treasuryMoneyToCents(0.3), 30); assert.equal(treasuryMoneyToCents(0.123), null);
  assert.equal(validTreasuryDate('2026-02-30'), false); assert.equal(validTreasuryDate('2028-02-29'), true);
  const s = fixture(), original = structuredClone(s); assert.deepEqual(forecast(s), forecast(s)); assert.deepEqual(s, original);
});

test('past unpaid deadline is preserved and rolled into tomorrow without deleting debt', () => {
  const s = fixture(); s.financeEntries = [{ id: 'e', kind: 'expense', amount: 100, paidAmount: 30, description: 'Late supplier', dueDate: '2026-10-01' }];
  s.treasury!.entryPlans = [plan('e')];
  const p = forecast(s); assert.equal(p.events[0].date, '2026-10-29'); assert.equal(p.events[0].overdue, true);
  assert.equal(p.events[0].scheduledDate, '2026-10-01');
  assert.equal(p.days[0].outflowCents, 7000); assert.equal(s.financeEntries[0].dueDate, '2026-10-01');
});

test('overdue forecast-only tranche retains scheduled date independently of projection and contract', () => {
  const s = fixture(); s.financeEntries = [{ id: 'e', kind: 'expense', amount: 100, description: 'Forecast-only deadline' }];
  s.treasury!.entryPlans = [plan('e', [tranche('t', 10000, '2026-10-23')])];
  const event = forecast(s).events[0];
  assert.equal(event.scheduledDate, '2026-10-23'); assert.equal(event.date, '2026-10-29');
  assert.equal(event.contractualDueDate, null); assert.equal(event.overdue, true);
  assert.equal(s.treasury!.entryPlans[0].tranches[0].forecastDate, '2026-10-23');
});

test('unchanged treasury revalidates changed operation and task references without demanding finance permission', () => {
  const s = fixture(); s.stages = [{ id: 'stage', forecastEnd: '2026-11-01' }];
  s.financeEntries = [{ id: 'e', kind: 'expense', amount: 100, description: 'Supplier' }];
  s.treasury!.entryPlans = [plan('e', [tranche('t', 10000, '2026-11-01', { dateRule: { kind: 'stage_end', stageId: 'stage', offsetDays: 0, calendar: 'calendar' } })])];
  const changed = structuredClone(s); changed.stages![0].forecastEnd = '2026-11-02';
  assert.equal(validateTreasuryChanges(s, changed, { role: 'foreman' }), '');
  const removed = structuredClone(s); removed.stages = [];
  assert.match(validateTreasuryChanges(s, removed, owner), /существующую/);
  const resized = structuredClone(s); resized.financeEntries[0].amount = 200;
  assert.match(validateTreasuryChanges(s, resized, owner), /Сумма траншей/);
});

test('payment date follows derived dependencies rather than stale stored forecastEnd', () => {
  const makeStage = (id: string, remainingDays: number, dependency?: string): Stage => {
    const stage: Stage = { id, name: id, shortName: id, order: 1, status: 'not_ready', weight: 1, progress: 0, responsible: 'Foreman',
      planStart: '2026-10-29', planEnd: '2026-10-29', forecastEnd: '2026-10-29',
      schedule: { kind: 'work', phase: 'Build', summaryOf: [], dependencies: dependency ? [{ stageId: dependency, gate: 'completed', lagDays: 0 }] : [],
        calendar: 'daily', daysOff: [], crew: id, reporterId: 'foreman', updatedAt: now },
      siteUpdate: { asOf: '2026-10-28', reviewOn: '2026-11-02', remainingDays, readyOn: '2026-10-29', acceptanceOn: '', note: 'Confirmed on site', nextAction: '', issueOwner: '', updatedAt: now,
        confirmedStatus: 'not_ready', confirmedBlocker: '', confirmedFacts: JSON.stringify(['', '', '', '']), confirmedSchedule: '' } };
    stage.siteUpdate!.confirmedSchedule = JSON.stringify(schedulePayload(stage.schedule));
    return stage;
  };
  const s = fixture(), a = makeStage('a', 2), b = makeStage('b', 1, 'a'); s.stages = [a, b];
  s.financeEntries = [{ id: 'e', kind: 'expense', amount: 100, description: 'After successor' }];
  s.treasury!.entryPlans = [plan('e', [tranche('t', 10000, '2026-10-29', { dateRule: { kind: 'stage_end', stageId: 'b', offsetDays: 0, calendar: 'calendar' } })])];
  assert.equal(forecast(s).events[0].date, '2026-10-31');
  a.siteUpdate!.remainingDays = 5;
  assert.equal(forecast(s).events[0].date, '2026-11-03');
  assert.equal(b.forecastEnd, '2026-10-29');
  b.siteUpdate!.confirmedSchedule = 'stale';
  assert.equal(forecast(s).events[0].date, null);
});

test('acceptance timestamp resolves in Moscow and unknown account is not charged to a selected bank', () => {
  const s = fixture(); s.stages = [{ id: 'stage', acceptedAt: '2026-10-27T23:30:00Z' }];
  assert.equal(resolveTreasuryDateRule(s, { kind: 'stage_acceptance', stageId: 'stage', offsetDays: 0, calendar: 'calendar' }, '2026-10-28'), '2026-10-28');
  s.financeEntries = [{ id: 'e', kind: 'expense', amount: 100, dueDate: '2026-10-29', description: 'Unknown bank' }];
  const p = forecast(s, { accountId: 'bank' });
  assert.equal(p.days[0].outflowCents, 0); assert.equal(p.unallocatedCents.expense, 10000); assert.equal(p.completeness, false);
});

test('future recorded facts and null reserves cannot produce an apparently complete projection', () => {
  const s = fixture(); s.financeEntries = [{ id: 'e', kind: 'income', amount: 100, paidAmount: 100, paidAt: '2026-10-29', description: 'Future actual' }];
  assert.equal(forecast(s).completeness, false);
  const malformed = structuredClone(s); malformed.treasury!.reserveCents = null as unknown as number;
  assert.equal(forecast(malformed).peakReserveFundingCents, null);
  assert.match(validateTreasuryChanges(null, malformed, owner), /Резерв/);
});

test('uncontracted budget remainder makes cash coverage incomplete without blindly adding ETC to cash', () => {
  const s = fixture(); s.budgetLines = [{ id: 'budget', name: 'Remaining construction', plan: 1000, forecast: 1200 }];
  s.financeEntries = [{ id: 'e', kind: 'expense', amount: 200, paidAmount: 200, budgetLineId: 'budget', description: 'Purchased materials' }];
  const p = forecast(s); assert.equal(p.completeness, false); assert.equal(p.events.length, 0);
  assert.ok(p.warnings.some(w => /не связаны с денежными событиями/.test(w)));
  assert.equal(p.openingCents, 200_000_00);
});

test('cash scope attestation is mandatory, expires after seven days and invalidates after a changed obligation', () => {
  const s = fixture();
  assert.equal(treasuryProjection(s, { today: '2026-10-28' }).completeness, false);
  s.treasury!.cashScopeReview = { asOf: '2026-10-28', source: 'All remaining costs and receipts reviewed', fingerprint: treasuryScopeFingerprint(s) };
  assert.equal(forecast(s).completeness, true);
  s.financeEntries.push({ id: 'new', kind: 'expense', amount: 100, description: 'New scope', dueDate: '2026-10-29' });
  assert.equal(forecast(s).completeness, false);
  s.financeEntries = [];
  s.treasury!.cashScopeReview.asOf = '2026-10-20';
  assert.equal(forecast(s).completeness, false);
  s.treasury!.cashScopeReview.asOf = '2026-10-29';
  assert.equal(forecast(s).completeness, false);
});

test('changed scope does not block unrelated saves; an explicit new review must match current data', () => {
  const old = fixture(); old.treasury!.cashScopeReview = { asOf: '2026-10-28', source: 'Reviewed', fingerprint: treasuryScopeFingerprint(old) };
  const next = structuredClone(old); next.financeEntries = [{ id: 'e', kind: 'income', amount: 100, description: 'New inflow' }];
  assert.equal(validateTreasuryChanges(old, next, owner, now), '');
  next.treasury!.changeReason = 'Confirm changed scope'; next.treasury!.cashScopeReview!.source = 'Reviewed again';
  assert.match(validateTreasuryChanges(old, next, owner, now), /Состав денежных событий изменился/);
  next.treasury!.cashScopeReview!.fingerprint = treasuryScopeFingerprint(next);
  assert.equal(validateTreasuryChanges(old, next, owner, now), '');
});

test('intermediate account overflow cannot disappear after a later compensating payment', () => {
  const s = fixture(); s.treasury!.accounts[0].opening = { asOf: '2026-10-26', amountCents: Number.MAX_SAFE_INTEGER - 10, confirmed: true, source: 'Boundary fixture' };
  s.financeEntries = [{ id: 'in', kind: 'income', amount: 1, paidAmount: 1, description: 'Overflow inflow', payments: [{ id: 'pi', amount: 1, date: '2026-10-27' }] },
    { id: 'out', kind: 'expense', amount: 1, paidAmount: 1, description: 'Compensating outflow', payments: [{ id: 'po', amount: 1, date: '2026-10-27' }] }];
  s.treasury!.entryPlans = [plan('in', [], { paymentFacts: [{ paymentId: 'pi', accountId: 'bank', cashTreatment: 'account', confirmation: 'reconciled', source: 'Statement' }] }),
    plan('out', [], { paymentFacts: [{ paymentId: 'po', accountId: 'bank', cashTreatment: 'account', confirmation: 'reconciled', source: 'Statement' }] })];
  const p = forecast(s); assert.equal(p.openingKnown, false); assert.equal(p.openingCents, null);
  assert.ok(p.warnings.some(w => /точный диапазон/.test(w)));
});
