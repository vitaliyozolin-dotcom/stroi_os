import assert from 'node:assert/strict';
import test from 'node:test';
import { seedState } from '../src/seed.ts';
import type { AppState, FinanceEntry, ProjectTask, Stage } from '../src/entities/index.ts';
import { emptyTreasury, treasuryProjection } from '../src/domain/treasury.js';
import { linkedStageTasks, normalizeSchedulePreferences, scheduleColumn, schedulePaymentMarkers, scheduleVariance } from '../src/components/schedule-work-model.ts';

const stage = (patch: Partial<Stage> = {}): Stage => ({ ...structuredClone(seedState.stages[0]), id: 'work', baseline: { start: '2026-10-01', end: '2026-10-20', source: 'document', note: 'ППР', recordedAt: '2026-10-01', recordedBy: 'Управление' }, ...patch });
const entry = (patch: Partial<FinanceEntry> = {}): FinanceEntry => ({ id: 'payment', stageId: 'work', kind: 'expense', status: 'committed', amount: 100000, date: '2026-10-10', counterparty: 'Подрядчик', description: 'Монтаж', ...patch });

test('schedule views reuse current stage and task identities; blocked work keeps its production column', () => {
  assert.equal(scheduleColumn(stage({ status: 'blocked', actualStart: '2026-10-12' })), 'progress');
  assert.equal(scheduleColumn(stage({ status: 'blocked', actualStart: undefined })), 'planned');
  assert.equal(scheduleColumn(stage({ status: 'awaiting_inspection' })), 'review');
  assert.equal(scheduleColumn(stage({ status: 'accepted' })), 'accepted');
  const task = { ...seedState.tasks[0], id: 'task', stageId: 'work' } as ProjectTask;
  const control = { ...task, id: 'auto-stage-work' };
  const unrelated = { ...task, id: 'other-task', stageId: 'another-stage' };
  assert.deepEqual(linkedStageTasks([task, control, unrelated], 'work'), [task]);
  assert.equal(linkedStageTasks([task], 'work')[0], task, 'view does not manufacture a separate task');
});

test('payment markers show only unpaid remainder and never borrow an invoice date', () => {
  const entries = [entry({ paidAmount: 40000 }), entry({ id: 'settled', status: 'paid' }), entry({ id: 'dated', dueDate: '2026-10-30' }), entry({ id: 'invalid', dueDate: '2026-02-30' }), entry({ id: 'unassigned', stageId: undefined })];
  const before = structuredClone(entries);
  const markers = schedulePaymentMarkers(entries, 'management');
  assert.deepEqual(markers.map(marker => marker.id).sort(), ['dated', 'invalid', 'payment']);
  assert.equal(markers.find(marker => marker.id === 'payment')!.amount, 60000);
  assert.equal(markers.find(marker => marker.id === 'payment')!.date, null);
  assert.equal(markers.find(marker => marker.id === 'invalid')!.date, null);
  assert.equal(markers.find(marker => marker.id === 'dated')!.date, '2026-10-30');
  assert.deepEqual(entries, before);
});

test('financial markers are absent for clients and foremen even if an unfiltered state is supplied', () => {
  for (const role of ['client', 'foreman'] as const) assert.deepEqual(schedulePaymentMarkers([entry(), entry({ kind: 'income' })], role), []);
});

test('enabled financial planning uses the same residual tranche dates as the cash forecast', () => {
  const state: AppState = { ...structuredClone(seedState), stages: [stage()], tasks: [],
    financeEntries: [entry({ dueDate: '2026-10-30', paidAmount: 40000, payments: [{ id: 'fact-1', amount: 40000, date: '2026-10-20', document: 'Выписка', recordedAt: '2026-10-20', recordedBy: 'Управление' }] })],
    treasury: { ...emptyTreasury(), enabled: true, entryPlans: [{ entryId: 'payment', source: 'Договор', tranches: [
      { id: 'first', amountCents: 6000000, forecastDate: '2026-11-02', certainty: 'confirmed', source: 'Первый транш', paymentAllocations: [{ paymentId: 'fact-1', amountCents: 4000000 }] },
      { id: 'second', amountCents: 4000000, forecastDate: '2026-11-05', certainty: 'confirmed', source: 'Второй транш' },
    ] }] },
  };
  const before = structuredClone(state);
  const markers = schedulePaymentMarkers(state, 'management', '2026-10-28');
  const events = treasuryProjection(state, { today: '2026-10-28' }).events;
  assert.deepEqual(markers.map(marker => [marker.id, marker.date, marker.amount]), events.map(event => [event.id, event.date, event.amountCents / 100]));
  assert.deepEqual(markers.map(marker => marker.amount), [20000, 40000]);
  assert.deepEqual(markers.map(marker => marker.entryId), ['payment', 'payment'], 'each unique tranche opens its existing financial entry');
  assert.equal(markers.some(marker => marker.date === '2026-10-30'), false, 'legacy dueDate cannot override a planned tranche');
  assert.deepEqual(state, before);
  assert.deepEqual(schedulePaymentMarkers(state, 'client', '2026-10-28'), []);
});

test('observed completion never becomes a fabricated actual finish or baseline variance', () => {
  assert.deepEqual(scheduleVariance(stage({ status: 'accepted', completedOn: undefined, actualEnd: undefined, completionObservedOn: '2026-10-25' }), '2026-10-25', 'Подтверждено к'), { days: null, basis: 'unknown' });
  assert.deepEqual(scheduleVariance(stage({ status: 'accepted', completedOn: '2026-10-23' }), '2026-10-25', 'Выполнено'), { days: 3, basis: 'actual' });
  assert.deepEqual(scheduleVariance(stage({ status: 'in_progress' }), '2026-10-24', 'Прогноз до'), { days: 4, basis: 'forecast' });
  assert.deepEqual(scheduleVariance(stage({ status: 'not_ready' }), '2026-10-24', 'По плану до'), { days: 4, basis: 'plan' });
  assert.equal(scheduleVariance(stage({ baseline: undefined }), '2026-10-24', 'Прогноз до').days, null);
});

test('saved view preferences are bounded and tolerate broken or older stored values', () => {
  const result = normalizeSchedulePreferences({ view: 'kanban', compare: false, showCompleted: false, showPayments: false, showTasks: true, drivingOnly: true, secret: 'must not persist' });
  assert.deepEqual(result, { view: 'kanban', compare: false, showCompleted: false, showPayments: false, showTasks: true, drivingOnly: true });
  assert.equal(normalizeSchedulePreferences({ view: 'unknown', compare: 'false' }).view, 'auto');
  assert.equal(normalizeSchedulePreferences({ compare: 'false' }).compare, true);
  assert.equal(normalizeSchedulePreferences(null).showCompleted, true);
});
