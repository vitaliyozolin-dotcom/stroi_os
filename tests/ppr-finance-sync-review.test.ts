import test from 'node:test';
import assert from 'node:assert/strict';
import type { AppState, FinanceEntry, Stage } from '../src/entities/index.ts';
import { seedState } from '../src/seed.ts';
import { emptyTreasury, treasuryProjection } from '../src/domain/treasury.js';
import { financeCalendarItems } from '../src/domain/finance-calendar.ts';
import { schedulePaymentMarkers } from '../src/components/schedule-work-model.ts';

const today = '2026-10-28';
const stage = (id: string): Stage => ({ ...structuredClone(seedState.stages[0]), id, name: id,
  status: 'not_ready', planStart: '2026-11-02', planEnd: '2026-11-10', forecastEnd: '2026-11-10',
  actualStart: undefined, actualEnd: undefined, completedOn: undefined, acceptedAt: undefined,
  schedule: undefined, siteUpdate: undefined });
const entry = (id: string, extra: Partial<FinanceEntry> = {}): FinanceEntry => ({ id, stageId: 'accounting', kind: 'expense',
  status: 'committed', amount: 100, date: today, counterparty: 'Synthetic supplier', description: id, ...extra });
const fixture = (): AppState => ({ ...structuredClone(seedState), project: { ...seedState.project, id: 'sync-review' },
  stages: [stage('accounting'), stage('trigger'), stage('task-stage')], tasks: [], budgetLines: [], financeEntries: [],
  treasury: { ...emptyTreasury(), enabled: true, accounts: [{ id: 'bank', name: 'Synthetic bank', legalEntityId: 'company', currency: 'RUB',
    isProjectDedicated: true, opening: { asOf: today, amountCents: 10000, confirmed: true, source: 'Synthetic fixture' } }] } });

test('PPR markers follow each tranche trigger instead of the obligation accounting stage', () => {
  const state = fixture();
  state.tasks = [{ ...structuredClone(seedState.tasks[0]), id: 'trigger-task', title: 'Task anchor', stageId: 'task-stage',
    status: 'todo', plannedStart: '2026-11-01', dueDate: '2026-11-12', completedAt: undefined }];
  state.financeEntries = [entry('mixed')];
  state.treasury!.entryPlans = [{ entryId: 'mixed', source: 'Synthetic terms', sourceAccountId: 'bank', tranches: [
    { id: 'stage-part', amountCents: 6000, source: 'Stage trigger', certainty: 'confirmed', dateRule: { kind: 'stage_end', stageId: 'trigger', offsetDays: 2, calendar: 'calendar' } },
    { id: 'task-part', amountCents: 4000, source: 'Task trigger', certainty: 'confirmed', dateRule: { kind: 'task_end', taskId: 'trigger-task', offsetDays: 1, calendar: 'calendar' } },
  ] }];
  const before = structuredClone(state);
  const markers = schedulePaymentMarkers(state, 'management', today);
  assert.deepEqual(markers.map(marker => [marker.id, marker.stageId, marker.date, marker.amount]), [
    ['mixed:stage-part', 'trigger', '2026-11-12', 60], ['mixed:task-part', 'task-stage', '2026-11-13', 40],
  ]);
  assert.deepEqual(state, before, 'reading timeline does not rewrite accounting links or dates');
});

test('unknown task completion keeps its stage and reason without an invented due date', () => {
  const state = fixture();
  state.tasks = [{ ...structuredClone(seedState.tasks[0]), id: 'done-task', title: 'Done without dated evidence', stageId: 'trigger',
    status: 'done', dueDate: '2026-10-20', completedAt: undefined }];
  state.financeEntries = [entry('unknown')];
  state.treasury!.entryPlans = [{ entryId: 'unknown', source: 'Synthetic terms', tranches: [
    { id: 'end', amountCents: 10000, source: 'Task completion', certainty: 'expected', dateRule: { kind: 'task_end', taskId: 'done-task', offsetDays: 3, calendar: 'calendar' } },
  ] }];
  const marker = schedulePaymentMarkers(state, 'management', today)[0];
  assert.equal(marker.stageId, 'trigger');
  assert.equal(marker.date, null);
  assert.equal(marker.forecastDate, null);
  assert.ok(marker.dateReason, 'missing date has an actionable explanation');
  assert.equal(financeCalendarItems(state, today)[0].dueDate, null);
});

test('calendar and PPR preserve original overdue date while cash projection moves only the unsettled balance', () => {
  const state = fixture();
  state.financeEntries = [entry('partial', { amount: 101.13, paidAmount: 40.11, payments: [
    { id: 'paid', amount: 40.11, date: '2026-10-20', document: 'Synthetic receipt', recordedAt: '2026-10-20', recordedBy: 'Reviewer' },
  ] })];
  state.treasury!.entryPlans = [{ entryId: 'partial', source: 'Synthetic terms', sourceAccountId: 'bank', tranches: [
    { id: 'tranche', amountCents: 10113, source: 'Fixed date', certainty: 'confirmed', forecastDate: '2026-10-25', contractualDueDate: '2026-10-25',
      paymentAllocations: [{ paymentId: 'paid', amountCents: 4011 }] },
  ] }];
  const before = structuredClone(state);
  const projected = treasuryProjection(state, { today, horizonDays: 2 }).events[0];
  const marker = schedulePaymentMarkers(state, 'management', today)[0];
  const calendar = financeCalendarItems(state, today)[0];
  assert.equal(projected.scheduledDate, '2026-10-25');
  assert.equal(projected.date, '2026-10-29');
  assert.equal(marker.date, calendar.dueDate);
  assert.equal(marker.forecastDate, projected.date);
  assert.equal(marker.amount, 61.02);
  assert.equal(marker.amount, calendar.remaining);
  assert.equal(calendar.remaining * 100, projected.amountCents);
  assert.equal(marker.contractualDueDate, '2026-10-25');
  assert.deepEqual(state, before, 'overdue roll-forward never rewrites the contract or payment ledger');
});

test('direct participant payments remain visible milestones and are explicitly outside company cash', () => {
  const state = fixture();
  state.financeEntries = [entry('participant')];
  state.treasury!.entryPlans = [{ entryId: 'participant', source: 'Synthetic participant funding', cashTreatment: 'participant_direct', tranches: [
    { id: 'direct', amountCents: 10000, source: 'Direct supplier payment', certainty: 'confirmed', forecastDate: '2026-10-30' },
  ] }];
  const projection = treasuryProjection(state, { today, horizonDays: 3 });
  const markers = schedulePaymentMarkers(state, 'management', today);
  assert.equal(markers.length, 1);
  assert.equal(markers[0].excludedFromCash, true);
  assert.equal(markers[0].amount, financeCalendarItems(state, today)[0].remaining);
  assert.ok(projection.days.every(day => day.outflowCents === 0));
});

test('a missed planned date is visible without claiming that a later contract deadline has passed', () => {
  const state = fixture();
  state.financeEntries = [entry('early-plan')];
  state.treasury!.entryPlans = [{ entryId: 'early-plan', source: 'Synthetic terms', tranches: [
    { id: 'early', amountCents: 10000, source: 'Early expected payment', certainty: 'confirmed', forecastDate: '2026-10-25', contractualDueDate: '2026-11-10' },
  ] }];
  const marker = schedulePaymentMarkers(state, 'management', today)[0];
  assert.equal(marker.overdue, true);
  assert.equal(marker.contractOverdue, false);
  assert.equal(marker.date, '2026-10-25');
});

test('new rule metadata and direct participant milestones remain invisible to nonmanagement roles', () => {
  const state = fixture();
  state.financeEntries = [entry('private-terms')];
  state.treasury!.entryPlans = [{ entryId: 'private-terms', source: 'Private terms', cashTreatment: 'participant_direct', tranches: [
    { id: 'private', amountCents: 10000, source: 'Private agreement', certainty: 'confirmed', dateRule: { kind: 'stage_end', stageId: 'trigger', offsetDays: 3, calendar: 'calendar' } },
  ] }];
  for (const role of ['foreman', 'client'] as const) assert.deepEqual(schedulePaymentMarkers(state, role, today), []);
});

test('a PPR delay reaches all views and changes the cash gap without moving fixed terms or rewriting facts', () => {
  const original = fixture();
  original.financeEntries = [entry('receipt', { kind: 'income', amount: 100 }), entry('fixed-outflow', { amount: 150 }),
    entry('settled', { amount: 40.11, paidAmount: 40.11, status: 'paid', paidAt: '2026-10-20' })];
  original.treasury!.entryPlans = [
    { entryId: 'receipt', source: 'Synthetic receipt', sourceAccountId: 'bank', tranches: [
      { id: 'end', amountCents: 10000, source: 'End of works', certainty: 'confirmed', contractualDueDate: '2026-11-10',
        dateRule: { kind: 'stage_end', stageId: 'trigger', offsetDays: 0, calendar: 'calendar' } },
    ] },
    { entryId: 'fixed-outflow', source: 'Fixed supplier date', sourceAccountId: 'bank', tranches: [
      { id: 'fixed', amountCents: 15000, source: 'Contract', certainty: 'confirmed', contractualDueDate: '2026-11-11', forecastDate: '2026-11-11' },
    ] },
  ];
  const changed = structuredClone(original);
  changed.stages.find(row => row.id === 'trigger')!.forecastEnd = '2026-11-12';
  const before = treasuryProjection(original, { today, horizonDays: 30 });
  const after = treasuryProjection(changed, { today, horizonDays: 30 });
  assert.equal(before.peakFundingCents, 0);
  assert.equal(after.peakFundingCents, 5000);
  assert.equal(after.firstDeficitDate, '2026-11-11');
  for (const state of [original, changed]) {
    const events = treasuryProjection(state, { today, horizonDays: 30 }).events;
    const calendar = financeCalendarItems(state, today);
    const markers = schedulePaymentMarkers(state, 'management', today);
    for (const event of events) {
      assert.equal(calendar.find(row => row.id === event.id)?.dueDate, event.scheduledDate);
      assert.equal(markers.find(row => row.id === event.id)?.date, event.scheduledDate);
      assert.equal(markers.find(row => row.id === event.id)?.amount, event.amountCents / 100);
    }
    assert.equal(events.some(event => event.entryId === 'settled'), false);
  }
  assert.deepEqual(changed.financeEntries, original.financeEntries);
  assert.deepEqual(changed.treasury, original.treasury);
  assert.equal(after.events.find(event => event.entryId === 'fixed-outflow')!.scheduledDate, '2026-11-11');
  assert.equal(after.events.find(event => event.entryId === 'receipt')!.contractualDueDate, '2026-11-10');
});
