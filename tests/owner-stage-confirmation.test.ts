import assert from 'node:assert/strict';
import test from 'node:test';
import { seedState } from '../src/seed.ts';
import { applyStageControl } from '../src/application/stage-control.ts';
import { createSyncModel, reconcileSavedSnapshot } from '../src/application/project-sync.ts';
import { stageProgressTotals } from '../src/domain/progress.ts';
import { validateStageControl } from '../sites/projects/stage-control.js';
import { stageControlFingerprint } from '../sites/lib/stage-control.js';
import { forecastSchedule } from '../sites/lib/schedule-forecast.js';
import { planToday } from '../sites/lib/plan-baseline.js';

const owner = { id: 'owner', role: 'management', name: 'Owner', isOwner: true };
const today = planToday(), now = new Date().toISOString();
const fixture = () => {
  const state = structuredClone(seedState);
  state.stages = [{ id: 'a', name: 'Frame', shortName: 'Frame', order: 1, status: 'not_ready', weight: 1, progress: 0,
    planStart: '2026-01-01', planEnd: '2026-01-02', forecastEnd: '2026-01-02', responsible: 'Worker' },
    { id: 'b', name: 'Windows', shortName: 'Windows', order: 2, status: 'not_ready', weight: 1, progress: 0,
      planStart: '2026-01-03', planEnd: '2026-01-04', forecastEnd: '2026-01-04', responsible: 'Worker', dependencyId: 'a' }];
  state.tasks = [{ id: 'task', title: 'Report', status: 'todo', priority: 'normal', assigneeId: 'worker', assigneeName: 'Worker', reviewerId: 'owner', createdBy: 'Owner', createdAt: now, updatedAt: now, dueDate: today, originalDueDate: today, stageId: 'a', rescheduleCount: 0, history: [] }];
  state.checkpoints = [{ id: 'photo', stageId: 'a', title: 'Photo report', zone: 'Site', status: 'pending', requiredShots: ['Overview'], photos: [], assignee: 'Worker', reviewer: 'Owner', clientVisible: false }];
  return state;
};
const confirm = (state: ReturnType<typeof fixture>, extra = {}) => applyStageControl(state, 'a', 'owner_accept', { date: today, note: '', tasks: [], completionDateUnknown: true, ...extra }, owner.name, 'management', owner.id);

test('owner confirmation accepts observed work, preserving unfinished evidence, money, baseline and exact-date uncertainty', () => {
  const before = fixture(), original = structuredClone(before);
  before.stages[0].blocker = 'Awaiting report';
  const next = confirm(before);
  assert.equal(validateStageControl(before, next, owner, now), null);
  assert.equal(next.stages[0].status, 'accepted');
  assert.equal(next.stages[0].completedOn, undefined);
  assert.equal(next.stages[0].actualEnd, undefined);
  assert.equal(next.stages[0].completionObservedOn, today);
  assert.equal(next.stages[0].acceptedAt, now);
  assert.equal(next.stages[0].acceptedBy, owner.name);
  assert.deepEqual(next.stages[0].ownerAcceptance, { note: 'Лично подтверждаю: этап выполнен.', at: now, by: owner.name, pendingTaskIds: ['task'], pendingCheckpointIds: ['photo'] });
  assert.deepEqual(next.tasks, before.tasks);
  assert.deepEqual(next.checkpoints, before.checkpoints);
  assert.deepEqual(next.financeEntries, before.financeEntries);
  assert.equal(next.stages[0].planEnd, original.stages[0].planEnd);
  assert.equal(next.stages[1].status, 'ready');
  assert.equal(before.stages[0].status, 'not_ready');
  assert.deepEqual(stageProgressTotals(next, 'a'), { physical: 100, accepted: 100 });
  assert.equal(next.stages[0].statusHistory?.length, 1);
  const again = structuredClone(next);
  assert.equal(validateStageControl(next, again, owner, now), null);
  assert.equal(again.stages[0].statusHistory?.length, 1);
});

test('owner confirmation preserves known completion and may record an explicitly supplied earlier exact date', () => {
  const before = fixture(); before.stages[0].status = 'awaiting_inspection'; before.stages[0].completedOn = '2026-01-02'; before.stages[0].completionNote = 'Existing result';
  assert.throws(() => confirm(before), /сохраняется/);
  const next = confirm(before, { completionDateUnknown: false, date: '2026-01-02', note: 'Personally checked' });
  assert.equal(validateStageControl(before, next, owner, now), null);
  assert.equal(next.stages[0].actualEnd, '2026-01-02');
  assert.equal(next.stages[0].completionNote, 'Existing result');
  const observed = fixture(); observed.stages[0].status = 'awaiting_inspection'; observed.stages[0].completionObservedOn = '2026-01-05'; observed.stages[0].completionNote = 'Observed';
  const exact = confirm(observed, { completionDateUnknown: false, date: '2026-01-04' });
  assert.equal(validateStageControl(observed, exact, owner, now), null);
  assert.throws(() => confirm(observed, { completionDateUnknown: false, date: '2026-01-06' }), /наблюдения/);
});

test('only the authenticated owner can use personal confirmation; stamps cannot be supplied by the client', () => {
  const before = fixture(), next = confirm(before);
  assert.throws(() => applyStageControl(before, 'a', 'owner_accept', { date: today, note: '', tasks: [] }, 'Manager', 'management', 'manager'), /владельцу/);
  assert.ok(validateStageControl(before, structuredClone(next), { role: 'management', id: 'owner', name: 'Impersonator', isOwner: false }, now));
  assert.ok(validateStageControl(before, structuredClone(next), { role: 'foreman', isOwner: true }, now));
  next.stages[0].ownerAcceptance = { note: 'Confirmed', at: '2000-01-01', by: 'Impersonator', pendingTaskIds: [], pendingCheckpointIds: [] };
  next.stages[0].acceptedAt = '2000-01-01';
  assert.equal(validateStageControl(before, next, owner, now), null);
  assert.equal(next.stages[0].ownerAcceptance?.by, owner.name);
  assert.equal(next.stages[0].ownerAcceptance?.at, now);
  assert.equal(next.stages[0].acceptedAt, now);
  assert.deepEqual(next.stages[0].ownerAcceptance?.pendingCheckpointIds, ['photo']);
});

test('saved personal acceptance and its required evidence cannot be rewritten or removed', () => {
  const before = fixture(), next = confirm(before);
  assert.equal(validateStageControl(before, next, owner, now), null);
  for (const mutation of [s => { delete s.stages[0].ownerAcceptance; }, s => { s.stages[0].ownerAcceptance.note = 'Changed'; }, s => { s.stages[0].acceptedBy = 'Other'; }]) {
    const tampered = structuredClone(next); mutation(tampered);
    assert.ok(validateStageControl(next, tampered, owner, now));
  }
  const removed = confirm(before); removed.checkpoints = [];
  assert.match(validateStageControl(before, removed, owner, now), /Нельзя убрать/);
  const newStage = structuredClone(before); newStage.stages.push({ ...newStage.stages[0], id: 'new', ownerAcceptance: { note: 'Injected' } });
  assert.ok(validateStageControl(before, newStage, owner, now));
});

test('personal acceptance is valid across the Moscow midnight boundary without fabricating exact completion', () => {
  const before = fixture(), next = confirm(before);
  next.stages[0].completionObservedOn = '2026-09-09';
  const lateUtc = '2026-09-08T23:30:00.000Z';
  assert.equal(validateStageControl(before, next, owner, lateUtc), null);
  assert.equal(planToday(new Date(next.stages[0].acceptedAt!)), '2026-09-09');
  assert.equal(next.stages[0].completedOn, undefined);
  const future = confirm(before); future.stages[0].completionObservedOn = '2099-01-01';
  assert.ok(validateStageControl(before, future, owner, now));
});

test('summary rows still require their children; unknown exact dates do not become a false forecast', () => {
  const before = fixture();
  before.stages[0].schedule = { kind: 'summary', phase: 'Shell', summaryOf: ['b'], dependencies: [], calendar: 'daily', daysOff: [], crew: '', reporterId: '', updatedAt: now };
  assert.throws(() => confirm(before), /по отдельности/);
  const work = fixture();
  work.stages[0].schedule = { ...before.stages[0].schedule, kind: 'work', summaryOf: [] };
  const next = confirm(work);
  assert.equal(validateStageControl(work, next, owner, now), null);
  const forecast = forecastSchedule(next, today);
  assert.equal(forecast.end, null);
  assert.ok(forecast.issues.some(i => i.stageId === 'a' && i.code === 'fact'));
});

test('form fingerprint ignores its own save acknowledgement but detects concurrent factual edits', () => {
  const before = fixture(); before.checkpoints = []; before.tasks = [];
  const sent = applyStageControl(before, 'a', 'complete', { date: '2026-01-02', note: 'Observed work', tasks: [] }, owner.name, 'management', owner.id);
  const fingerprint = stageControlFingerprint(sent.stages[0]), saved = structuredClone(sent);
  assert.equal(validateStageControl(before, saved, owner, now), null);
  saved.stages[0].progress = 100;
  assert.equal(stageControlFingerprint(saved.stages[0]), fingerprint);
  for (const key of ['completedOn', 'completionNote', 'status', 'blocker', 'responsible']) {
    const changed = structuredClone(saved.stages[0]); changed[key] = 'changed';
    assert.notEqual(stageControlFingerprint(changed), fingerprint);
  }
});

test('save acknowledgement retains owner audit stamps alongside a concurrent unrelated edit', () => {
  const before = fixture(), sent = confirm(before), local = structuredClone(sent), saved = structuredClone(sent);
  local.project.name = 'Renamed';
  assert.equal(validateStageControl(before, saved, owner, now), null);
  const model = reconcileSavedSnapshot({ ...createSyncModel({ state: before, revision: 1 }), state: local, dirty: true }, sent, { state: saved, revision: 2 });
  assert.equal(model.state.project.name, 'Renamed');
  assert.deepEqual(model.state.stages[0].ownerAcceptance, saved.stages[0].ownerAcceptance);
  assert.equal(validateStageControl(saved, structuredClone(model.state), owner, now), null);
});
