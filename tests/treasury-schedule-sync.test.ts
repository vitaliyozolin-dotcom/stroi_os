import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyTreasury, resolveTreasuryDateRuleDetails, treasuryProjection, treasuryScheduleImpact, treasuryScopeFingerprint,
  type TreasuryProject } from '../src/domain/treasury.js';
import { schedulePayload } from '../src/domain/construction/schedule-forecast.js';
import type { Stage } from '../src/entities/stage.ts';
import type { TreasuryDateRule, TreasuryEntryPlan } from '../src/entities/treasury.ts';

const today = '2026-10-28', stamp = `${today}T12:00:00Z`;
const rule = (kind: TreasuryDateRule['kind'], id = 'a', offsetDays = 0): TreasuryDateRule => ({ kind,
  ...(kind.startsWith('task') ? { taskId: id } : { stageId: id }), offsetDays, calendar: 'calendar' });
const stage = (id: string, remainingDays = 2, dependencies: string[] = []): Stage => {
  const value: Stage = { id, name: `Этап ${id}`, shortName: id, order: 1, status: 'not_ready', weight: 1, progress: 0,
    responsible: 'Foreman', planStart: '2026-10-29', planEnd: '2026-10-30', forecastEnd: '2026-10-30',
    schedule: { kind: 'work', phase: 'Building', summaryOf: [], dependencies: dependencies.map(stageId => ({ stageId, gate: 'completed', lagDays: 0 })),
      calendar: 'daily', daysOff: [], crew: id, reporterId: 'foreman', updatedAt: stamp },
    siteUpdate: { asOf: today, reviewOn: '2026-11-02', remainingDays, readyOn: '2026-10-29', acceptanceOn: '2026-11-02',
      note: 'Site check', nextAction: '', issueOwner: '', updatedAt: stamp, confirmedStatus: 'not_ready', confirmedBlocker: '',
      confirmedFacts: JSON.stringify(['', '', '', '']), confirmedSchedule: '' } };
  value.siteUpdate!.confirmedSchedule = JSON.stringify(schedulePayload(value.schedule));
  return value;
};
const plan = (entryId: string, amountCents: number, dateRule?: TreasuryDateRule): TreasuryEntryPlan => ({
  entryId, cashTreatment: 'account', sourceAccountId: 'bank', source: 'Contract', tranches: [{ id: 'balance', amountCents,
    dateRule, forecastDate: '2026-10-29', contractualDueDate: '2026-10-31', certainty: 'confirmed', source: 'Contract' }] });
const fixture = (): TreasuryProject => {
  const state: TreasuryProject = { project: { id: 'sync' }, stages: [stage('a'), stage('b', 1, ['a'])], tasks: [], financeEntries: [], budgetLines: [],
    treasury: { ...emptyTreasury(), enabled: true,
      accounts: [{ id: 'bank', name: 'Bank', legalEntityId: 'company', currency: 'RUB', isProjectDedicated: true,
        opening: { asOf: today, amountCents: 5000, confirmed: true, source: 'Bank statement' } }],
      costEstimates: [{ id: 'reviewed', name: 'Complete synthetic scope', recognizedCents: 0, remainingWorkCents: 0,
        stockToConsumeCents: 0, otherRemainingCents: 0, approvedBudgetCents: 0, source: 'Reviewed' }] } };
  return state;
};
const review = (state: TreasuryProject) => {
  state.treasury!.cashScopeReview = { asOf: today, source: 'Reviewed future events', fingerprint: treasuryScopeFingerprint(state) };
  return state;
};
const projection = (state: TreasuryProject) => treasuryProjection(state, { today, horizonDays: 14 });

test('rule explanation uses dependency forecast and fixed contract deadline remains independent', () => {
  const state = fixture();
  state.financeEntries = [{ id: 'expense', kind: 'expense', amount: 100, description: 'Final payment' }];
  state.treasury!.entryPlans = [plan('expense', 10000, rule('stage_end', 'b', 3))];
  const event = projection(state).events[0];
  assert.equal(event.scheduledDate, '2026-11-03');
  assert.equal(event.dateResolution.anchorDate, '2026-10-31');
  assert.equal(event.dateResolution.basis, 'forecast');
  assert.match(event.dateResolution.label, /Окончание этапа.*b.*3 календ/);
  assert.equal(event.contractualDueDate, '2026-10-31');
  assert.equal(event.forecastDelayDays, 3);
  assert.equal(event.contractOverdue, false);
  assert.equal(event.overdue, false);
});

test('actual stage event uses Moscow date, survives later PPR moves and does not create payment facts', () => {
  const state = fixture(), value = state.stages![0];
  Object.assign(value, { status: 'accepted', actualEnd: '2026-10-27', completedOn: '2026-10-27', acceptedAt: '2026-10-27T23:30:00Z' });
  const original = structuredClone(state);
  const resolved = resolveTreasuryDateRuleDetails(state, rule('stage_acceptance', 'a', 2), today);
  assert.equal(resolved.date, '2026-10-30'); assert.equal(resolved.basis, 'actual');
  value.forecastEnd = '2026-11-20';
  assert.deepEqual(resolveTreasuryDateRuleDetails(state, rule('stage_acceptance', 'a', 2), today), resolved);
  assert.deepEqual(state.financeEntries, original.financeEntries);
});

test('reopened stage ignores old completion and resolves current remaining work', () => {
  const state = fixture(), value = state.stages![0] as Stage;
  value.status = 'rework'; value.actualStart = '2026-10-26'; value.actualEnd = '2026-10-27'; value.completedOn = '2026-10-27';
  value.siteUpdate!.confirmedStatus = value.status;
  value.siteUpdate!.confirmedFacts = JSON.stringify([value.actualStart, value.completedOn, value.actualEnd, '']);
  const result = resolveTreasuryDateRuleDetails(state, rule('stage_end'), today);
  assert.equal(result.date, '2026-10-30'); assert.equal(result.basis, 'forecast');
});

test('closed stage without actual start cannot invent start from completion date', () => {
  const state = fixture();
  Object.assign(state.stages![0], { status: 'accepted', completedOn: '2026-10-27', actualEnd: '2026-10-27' });
  const result = resolveTreasuryDateRuleDetails(state, rule('stage_start'), today);
  assert.equal(result.date, null); assert.match(result.reason!, /начала неизвестна/);
});

test('acceptance forecast requires current PPR evidence and a date after work completion', () => {
  const state = fixture();
  assert.equal(resolveTreasuryDateRuleDetails(state, rule('stage_acceptance'), today).basis, 'forecast');
  (state.stages![0] as Stage).siteUpdate!.acceptanceOn = '2026-10-29';
  assert.equal(resolveTreasuryDateRuleDetails(state, rule('stage_acceptance'), today).date, null);
  (state.stages![0] as Stage).siteUpdate!.acceptanceOn = '2026-11-02';
  (state.stages![0] as Stage).siteUpdate!.reviewOn = '2026-10-27';
  assert.match(resolveTreasuryDateRuleDetails(state, rule('stage_acceptance'), today).reason!, /устарели/);
  state.stages = [{ id: 'a', siteUpdate: { acceptanceOn: '2026-11-02' } }];
  assert.equal(resolveTreasuryDateRuleDetails(state, rule('stage_acceptance'), today).date, null);
});

test('upstream resource conflict makes dependent payment date unknown with its original target retained', () => {
  const state = fixture(), concurrent = stage('c');
  concurrent.schedule!.crew = 'a'; concurrent.siteUpdate!.confirmedSchedule = JSON.stringify(schedulePayload(concurrent.schedule));
  state.stages!.push(concurrent);
  const result = resolveTreasuryDateRuleDetails(state, rule('stage_end', 'b'), today);
  assert.equal(result.date, null); assert.equal(result.stageId, 'b'); assert.match(result.reason!, /Бригада|бригад/);
});

test('task dates remain explicit and stage linkage exposes conflicts without an invented dependency', () => {
  const state = fixture(); state.tasks = [{ id: 'task', title: 'Delivery', status: 'todo', stageId: 'b', dueDate: '2026-10-30', plannedStart: '2026-10-29' }];
  const result = resolveTreasuryDateRuleDetails(state, rule('task_end', 'task'), today);
  assert.equal(result.date, '2026-10-30'); assert.equal(result.basis, 'recorded_plan'); assert.equal(result.linkedStageId, 'b');
  assert.match(result.reason!, /раньше прогнозного начала/); assert.match(result.label, /срок задачи задан отдельно/);
  (state.stages![0] as Stage).siteUpdate!.remainingDays = 4;
  assert.equal(resolveTreasuryDateRuleDetails(state, rule('task_end', 'task'), today).date, '2026-10-30');
});

test('task completion, reopening, cancellation and overdue recorded dates cannot fabricate actual cash anchors', () => {
  const state = fixture(); state.tasks = [{ id: 'task', status: 'done', dueDate: '2026-10-22' }];
  assert.equal(resolveTreasuryDateRuleDetails(state, rule('task_end', 'task'), today).date, null);
  state.tasks[0].completedAt = '2026-10-27T23:30:00Z';
  assert.equal(resolveTreasuryDateRuleDetails(state, rule('task_end', 'task'), today).date, '2026-10-28');
  assert.equal(resolveTreasuryDateRuleDetails(state, rule('task_end', 'task'), today).basis, 'actual');
  state.tasks[0].status = 'in_progress';
  const reopened = resolveTreasuryDateRuleDetails(state, rule('task_end', 'task'), today);
  assert.equal(reopened.date, '2026-10-22'); assert.equal(reopened.basis, 'recorded_plan'); assert.match(reopened.reason!, /уже наступил/);
  state.tasks[0].status = 'canceled';
  assert.equal(resolveTreasuryDateRuleDetails(state, rule('task_end', 'task'), today).date, null);
});

test('negative weekday offset is computed from the anchor and labels no official holiday assumption', () => {
  const state = fixture(); state.stages = [{ id: 'a', actualStart: '2026-10-26' }];
  const result = resolveTreasuryDateRuleDetails(state, { ...rule('stage_start', 'a', -1), calendar: 'workdays' }, today);
  assert.equal(result.date, '2026-10-23'); assert.equal(result.anchorDate, '2026-10-26'); assert.match(result.label, /− 1 будн/);
});

test('PPR preview moves only remaining tranche, preserves paid/fixed facts and calculates receipt-induced gap', () => {
  const state = fixture();
  state.financeEntries = [{ id: 'income', kind: 'income', amount: 100, description: 'Customer', paidAmount: 40,
    payments: [{ id: 'paid', amount: 40, date: '2026-10-27' }] },
  { id: 'fixed', kind: 'expense', amount: 100, description: 'Supplier' },
  { id: 'settled', kind: 'expense', amount: 20, description: 'Paid work', paidAmount: 20, paidAt: '2026-10-27' }];
  const income = plan('income', 10000, rule('stage_end'));
  income.tranches[0].paymentAllocations = [{ paymentId: 'paid', amountCents: 4000 }];
  state.treasury!.entryPlans = [income, plan('fixed', 10000), plan('settled', 2000, rule('stage_end'))];
  state.treasury!.entryPlans[1].tranches[0].forecastDate = '2026-10-31';
  review(state);
  const next = structuredClone(state); (next.stages![0] as Stage).siteUpdate!.remainingDays = 5;
  const originalBefore = structuredClone(state), originalAfter = structuredClone(next);
  const impact = treasuryScheduleImpact(state, next, { today, horizonDays: 14 });
  assert.equal(impact.changes.length, 1); assert.equal(impact.changes[0].entryId, 'income');
  assert.equal(impact.changes[0].amountCents, 6000); assert.equal(impact.changes[0].shiftDays, 3);
  assert.equal(impact.changes[0].beforeDate, '2026-10-30'); assert.equal(impact.changes[0].afterDate, '2026-11-02');
  assert.equal(impact.before.peakFundingCents, 0); assert.equal(impact.after.peakFundingCents, 5000);
  assert.equal(impact.peakFundingDeltaCents, 5000); assert.equal(impact.shiftedIncomeCents, 6000);
  assert.equal(impact.shiftedExpenseCents, 0); assert.equal(impact.comparable, true); assert.equal(impact.complete, true);
  assert.deepEqual(state, originalBefore); assert.deepEqual(next, originalAfter);
  assert.deepEqual(next.financeEntries, state.financeEntries); assert.deepEqual(next.treasury, state.treasury);
});

test('losing PPR evidence makes impact unknown instead of claiming a vanished cash gap', () => {
  const state = fixture(); state.financeEntries = [{ id: 'e', kind: 'expense', amount: 100, description: 'Work' }];
  state.treasury!.entryPlans = [plan('e', 10000, rule('stage_end'))]; review(state);
  const next = structuredClone(state); (next.stages![0] as Stage).siteUpdate!.confirmedSchedule = 'stale';
  const impact = treasuryScheduleImpact(state, next, { today, horizonDays: 14 });
  assert.equal(impact.changes[0].beforeDate, '2026-10-30'); assert.equal(impact.changes[0].afterDate, null);
  assert.equal(impact.changes[0].afterResolution.basis, 'unknown'); assert.equal(impact.comparable, false);
  assert.equal(impact.complete, false); assert.equal(impact.peakFundingDeltaCents, null);
  assert.equal(impact.after.unallocatedCents.expense, 10000);
});

test('incomplete scope permits a labelled comparison of known events but never completeness', () => {
  const state = fixture(); state.financeEntries = [{ id: 'e', kind: 'expense', amount: 100, description: 'Work' }];
  state.treasury!.entryPlans = [plan('e', 10000, rule('stage_end'))];
  const next = structuredClone(state); (next.stages![0] as Stage).siteUpdate!.remainingDays = 3;
  const impact = treasuryScheduleImpact(state, next, { today, horizonDays: 14 });
  assert.equal(impact.comparable, true); assert.equal(impact.complete, false);
  assert.equal(impact.peakFundingDeltaCents, 0);
});

test('unallocated historical payment loses tranche timing and cannot produce a misleading impact delta', () => {
  const state = fixture(); state.financeEntries = [{ id: 'e', kind: 'expense', amount: 100, paidAmount: 40, description: 'Work' }];
  state.treasury!.entryPlans = [plan('e', 10000, rule('stage_end'))];
  const event = projection(state).events[0];
  assert.equal(event.amountCents, 6000); assert.equal(event.scheduledDate, null); assert.equal(event.dateResolution.date, null);
  assert.equal(event.dateResolution.basis, 'unknown'); assert.match(event.dateResolution.reason!, /Распределите/);
  const next = structuredClone(state); (next.stages![0] as Stage).siteUpdate!.remainingDays = 3;
  const impact = treasuryScheduleImpact(state, next, { today });
  assert.equal(impact.changes.length, 0); assert.equal(impact.comparable, false); assert.equal(impact.peakFundingDeltaCents, null);
});

test('legacy dueDate is a planned date, never silently promoted into an explicit contract deadline', () => {
  const state = fixture(); state.financeEntries = [{ id: 'e', kind: 'expense', amount: 100, dueDate: '2026-10-20', description: 'Legacy' }];
  const event = projection(state).events[0];
  assert.equal(event.contractualDueDate, null); assert.equal(event.contractOverdue, false); assert.equal(event.forecastDelayDays, null);
  assert.equal(event.scheduledDate, '2026-10-20'); assert.equal(event.date, '2026-10-29'); assert.equal(event.overdue, true);
});

test('schedule lateness and cash forecast lateness stay distinct after overdue and scenario shifts', () => {
  const state = fixture(); state.financeEntries = [{ id: 'e', kind: 'income', amount: 100, description: 'Customer' }];
  state.treasury!.entryPlans = [plan('e', 10000)];
  const tranche = state.treasury!.entryPlans[0].tranches[0];
  tranche.forecastDate = '2026-10-25'; tranche.contractualDueDate = '2026-10-25';
  state.treasury!.scenarios = { cautiousDelayDays: 2, stressDelayDays: 10, stressCostIncreasePct: 0 };
  const base = projection(state).events[0];
  assert.equal(base.scheduledDelayDays, 0); assert.equal(base.forecastDelayDays, 4); assert.equal(base.contractOverdue, true);
  const stress = treasuryProjection(state, { today, scenario: 'stress' }).events[0];
  assert.equal(stress.date, '2026-11-08'); assert.equal(stress.forecastDelayDays, 14); assert.equal(stress.scheduledDelayDays, 0);
  assert.equal(stress.scheduledDate, '2026-10-25'); assert.equal(tranche.contractualDueDate, '2026-10-25');
});

test('impact rejects accidental cross-project comparisons', () => {
  const state = fixture(), other = structuredClone(state); other.project.id = 'other';
  assert.throws(() => treasuryScheduleImpact(state, other, { today }), /одного проекта/);
});
