import assert from 'node:assert/strict';
import test from 'node:test';
import { seedState } from '../src/seed.ts';
import type { AppState, Stage } from '../src/entities/index.ts';
import { emptyTreasury, treasuryProjection, treasuryScheduleImpact } from '../src/domain/treasury.js';
import { validateStageControl, forecastSchedule, simulateSchedule } from '../src/domain/construction/index.js';
import { validateScheduleReview } from '../src/domain/construction/schedule-validation.js';
import { previewScheduleEdit, previewStagePlan, previewStageControl, previewScheduleRecovery } from '../src/application/schedule-payment-preview.ts';
import { scheduleEditSnapshot } from '../src/application/schedule-edits.ts';
import { stageCommandSnapshot, applyStageControl } from '../src/application/stage-control.ts';
import { stagePlanSnapshot } from '../src/domain/schedule-planning.ts';

const today = '2026-10-28', now = `${today}T12:00:00Z`;
const owner = { name: 'Управление', role: 'management' as const, id: 'owner', isOwner: true };
const stage = (id: string, order: number): Stage => ({ id, order, name: `Работа ${id}`, shortName: id, status: 'not_ready', weight: 1, progress: 0, responsible: 'Подрядчик', planStart: today, planEnd: '2026-11-02', forecastEnd: '2026-11-02',
  schedule: { kind: 'work', phase: 'Фундамент', summaryOf: [], dependencies: order === 2 ? [{ stageId: 'a', gate: 'completed', lagDays: 0 }] : [], calendar: 'daily', daysOff: [], crew: id, reporterId: '' },
  siteUpdate: { asOf: today, reviewOn: '2026-11-04', remainingDays: 2, readyOn: today, acceptanceOn: '', note: 'Подтверждено на объекте', nextAction: '', issueOwner: '', requestId: `initial-review-${id}` } });
const fixture = (): AppState => {
  const state = structuredClone(seedState); state.stages = [stage('a', 1), stage('b', 2)]; state.tasks = []; state.checkpoints = [];
  state.financeEntries = [{ id: 'expense', kind: 'expense', description: 'Оплата подрядчику', amount: 100000, paidAmount: 40000, status: 'committed', date: today, counterparty: 'Подрядчик', stageId: 'a',
    payments: [{ id: 'p1', amount: 40000, date: '2026-10-20', document: 'Выписка', recordedAt: now, recordedBy: owner.name }] },
  { id: 'income', kind: 'income', description: 'Поступление по следующему этапу', amount: 50000, status: 'committed', date: today, counterparty: 'Клиент', stageId: 'b' }];
  state.budgetLines = [];
  state.treasury = { ...emptyTreasury(), enabled: true, accounts: [{ id: 'bank', name: 'Счёт', legalEntityId: 'company', currency: 'RUB', isProjectDedicated: true, opening: { asOf: today, amountCents: 20000000, confirmed: true, source: 'Выписка' } }], entryPlans: state.financeEntries.map(entry => ({ entryId: entry.id, source: 'Договор', sourceAccountId: 'bank', cashTreatment: 'account', tranches: [{ id: `${entry.id}-tranche`, amountCents: entry.amount * 100, certainty: 'confirmed', source: 'Договор', contractualDueDate: '2026-11-03', dateRule: { kind: 'stage_end', stageId: entry.stageId, offsetDays: 0, calendar: 'calendar' }, ...(entry.id === 'expense' ? { paymentAllocations: [{ paymentId: 'p1', amountCents: 4000000 }] } : {}) }] })) };
  assert.equal(validateScheduleReview(null, state, owner, now), null);
  return state;
};

test('review preview runs server confirmation on a disposable candidate and includes downstream payments', () => {
  const state = fixture(), before = structuredClone(state), a = state.stages[0];
  const result = previewScheduleEdit(state, { kind: 'review', stageId: a.id, expected: scheduleEditSnapshot(state, 'review', a.id), form: { ...a.siteUpdate!, remainingDays: 5, note: 'Уточнили остаток' } }, owner, now);
  assert.ok(result.ok); if (!result.ok) return;
  const impact = treasuryScheduleImpact(state, result.state, { today });
  assert.deepEqual(impact.changes.map(row => [row.entryId, row.shiftDays, row.amountCents]), [['expense', 3, 6000000], ['income', 3, 5000000]]);
  assert.equal(result.state.stages[0].siteUpdate!.requestId, undefined);
  assert.deepEqual(result.state.financeEntries, state.financeEntries);
  assert.deepEqual(result.state.treasury, state.treasury);
  assert.deepEqual(state, before, 'even preview confirmation/history stamps cannot reach the original state');
});

test('invalid, stale and unauthorized drafts provide no financial preview candidate', () => {
  const state = fixture(), before = structuredClone(state), input = { kind: 'review' as const, stageId: 'a', expected: scheduleEditSnapshot(state, 'review', 'a'), form: { ...state.stages[0].siteUpdate!, remainingDays: 0 } };
  assert.equal(previewScheduleEdit(state, input, owner, now).ok, false);
  for (const role of ['client', 'foreman'] as const) assert.equal(previewScheduleEdit(state, { ...input, form: { ...input.form, remainingDays: 4 } }, { ...owner, role }, now).ok, false);
  assert.equal(previewScheduleEdit(state, { ...input, expected: 'stale' }, owner, now).ok, false);
  assert.deepEqual(state, before);
});

test('changing PPR structure invalidates its old review instead of reusing its dates', () => {
  const state = fixture(), result = previewScheduleEdit(state, { kind: 'structure', stageId: 'a', expected: scheduleEditSnapshot(state, 'structure', 'a'), structure: { ...state.stages[0].schedule!, calendar: 'weekdays' }, daysOff: '', checked: true }, owner, now);
  assert.ok(result.ok); if (!result.ok) return;
  const impact = treasuryScheduleImpact(state, result.state, { today });
  assert.ok(impact.changes.length);
  assert.equal(impact.changes.find(row => row.entryId === 'expense')!.afterDate, null);
});

test('stage action preview matches real action plus server policy without posting a payment', () => {
  const state = fixture(), before = structuredClone(state), command = { stageId: 'a', action: 'delay' as const, expected: stageCommandSnapshot(state, 'a'), input: { date: '2026-11-07', note: 'Задержана поставка', tasks: [], remainingDays: 4, readyOn: '2026-11-01', nextAction: 'Уточнить поставку', issueOwner: 'Снабжение' } };
  const preview = previewStageControl(state, command, owner, now); assert.ok(preview.ok); if (!preview.ok) return;
  const actual = applyStageControl(state, 'a', 'delay', command.input, owner.name, owner.role, owner.id, { clock: { now: () => now }, ids: { next: prefix => `actual-${prefix}` } });
  assert.equal(validateStageControl(state, actual.snapshot, owner, now), null);
  const actualState = { ...state, stages: actual.snapshot.stages, tasks: actual.snapshot.tasks };
  assert.deepEqual(treasuryProjection(preview.state, { today }).events, treasuryProjection(actualState, { today }).events);
  assert.deepEqual(preview.state.financeEntries, before.financeEntries);
  assert.deepEqual(state, before);
});

test('owner confirmation with unknown completion only anchors acceptance; no finish is invented', () => {
  const state = fixture(); state.treasury!.entryPlans[0].tranches[0].dateRule!.kind = 'stage_acceptance';
  const result = previewStageControl(state, { stageId: 'a', action: 'owner_accept', expected: stageCommandSnapshot(state, 'a'), input: { date: today, note: '', tasks: [], completionDateUnknown: true } }, owner, now);
  assert.ok(result.ok); if (!result.ok) return;
  assert.equal(result.state.stages[0].status, 'accepted');
  assert.equal(result.state.stages[0].completedOn, undefined);
  assert.equal(result.state.stages[0].actualEnd, undefined);
  assert.equal(treasuryProjection(result.state, { today }).events.find(event => event.entryId === 'expense')!.scheduledDate, today);
  assert.equal(state.stages[0].status, 'not_ready');
});

test('manual date preview uses the real plan validation and keeps its contract deadline', () => {
  const state = fixture(); for (const row of state.stages) { delete row.schedule; delete row.siteUpdate; }
  const result = previewStagePlan(state, { stageId: 'a', expected: stagePlanSnapshot(state, 'a'), draft: { planStart: today, planEnd: '2026-11-10', forecastEnd: '2026-11-10', dependencyId: '', responsibleId: '', reason: 'Перенос поставки' } }, owner, now);
  assert.ok(result.ok); if (!result.ok) return;
  const event = treasuryProjection(result.state, { today }).events.find(event => event.entryId === 'expense')!;
  assert.equal(event.scheduledDate, '2026-11-10');
  assert.equal(event.contractualDueDate, '2026-11-03');
  assert.equal(state.stages[0].forecastEnd, '2026-11-02');
});

test('recovery scenario uses the same schedule as the existing simulator without changing original data', () => {
  const state = fixture(), before = structuredClone(state), change = { stageId: 'a', remainingDays: 1, crew: 'Другой ресурс' };
  const result = previewScheduleRecovery(state, change); assert.ok(result.ok); if (!result.ok) return;
  assert.deepEqual(forecastSchedule(result.state, today), simulateSchedule(state, change, today).forecast);
  assert.deepEqual(state, before);
});
