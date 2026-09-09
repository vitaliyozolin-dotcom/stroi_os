import assert from 'node:assert/strict';
import test from 'node:test';
import { seedState } from '../src/seed.ts';
import { applyStageControl } from '../src/application/stage-control.ts';
import { stageCanStart, stageGaps, stageRadar } from '../sites/lib/stage-control.js';
import { validateStageControl } from '../sites/projects/stage-control.js';
import { validateBaselineChanges } from '../sites/projects/baseline.js';
import { createTelegramProjectStore } from '../sites/telegram/project-store.js';
import { createProjectWriteHandler } from '../sites/projects/write.js';
import { createSyncModel, reconcileSavedSnapshot } from '../src/application/project-sync.ts';

const now = '2026-09-09T12:00:00.000Z', owner = { role: 'management', name: 'Виталий' }, foreman = { role: 'foreman', name: 'Прораб' };
const fixture = () => {
  const s = structuredClone(seedState);
  s.project.id = 'project-1'; s.project.status = 'in_progress'; s.project.name = 'Тест';
  s.tasks = []; s.checkpoints = []; s.activity = [];
  s.stages = [{ id: 'a', name: 'Подготовка', shortName: 'Подготовка', order: 1, status: 'in_progress', weight: 1, progress: 0, planStart: '2026-08-10', planEnd: '2026-09-10', forecastEnd: '2026-09-10', actualStart: '2026-08-10', responsible: 'Прораб' },
    { id: 'parallel', name: 'Поставка', shortName: 'Поставка', order: 2, status: 'in_progress', weight: 1, progress: 0, planStart: '2026-08-10', planEnd: '2026-09-10', forecastEnd: '2026-09-10', responsible: 'Прораб' },
    { id: 'b', name: 'Фундамент', shortName: 'Фундамент', order: 3, status: 'not_ready', weight: 1, progress: 0, planStart: '2026-08-10', planEnd: '2026-09-10', forecastEnd: '2026-09-10', dependencyId: 'a', responsible: 'Прораб' }];
  return s;
};
const input = { date: '2026-08-15', note: 'Проверено по результату осмотра', tasks: [] };

test('completion, acceptance and payment remain separate; dependencies unlock without starting parallel work', () => {
  const before = fixture(), completed = applyStageControl(before, 'a', 'complete', input, owner.name, 'management');
  assert.equal(completed.stages[0].status, 'awaiting_inspection');
  assert.equal(completed.stages[2].status, 'not_ready');
  assert.deepEqual(completed.financeEntries, before.financeEntries);
  assert.equal(validateStageControl(before, completed, owner, now), null);
  assert.equal(validateBaselineChanges(before, completed, owner, now), null);
  const accepted = applyStageControl(completed, 'a', 'accept', { ...input, date: '2026-08-16' }, owner.name, 'management');
  assert.equal(validateStageControl(completed, accepted, owner, now), null);
  assert.equal(accepted.stages[0].actualEnd, '2026-08-15');
  assert.equal(accepted.stages[1].status, 'in_progress');
  assert.equal(accepted.stages[2].status, 'ready');
  assert.deepEqual(accepted.financeEntries, before.financeEntries);
  assert.equal(accepted.stages[0].statusHistory?.length, 2);
});

test('only explicit task confirmations count; stage tracking is not a circular acceptance condition', () => {
  const s = fixture();
  s.tasks = [{ id: 'real', title: 'Работа', status: 'todo', priority: 'normal', assigneeId: 'worker', assigneeName: 'Прораб', reviewerId: 'owner', createdBy: owner.name, createdAt: now, updatedAt: now, dueDate: '2026-09-10', originalDueDate: '2026-09-10', stageId: 'a', rescheduleCount: 0, history: [] }];
  s.tasks.push({ ...s.tasks[0], id: 'auto-stage-a' });
  assert.equal(stageGaps(s, 'a').tasks.length, 1);
  const done = applyStageControl(s, 'a', 'complete', { ...input, tasks: ['real'] }, foreman.name, 'foreman', 'worker');
  assert.equal(done.tasks[0].status, 'review');
  assert.throws(() => applyStageControl(done, 'a', 'accept', input, owner.name, 'management'));
  const accepted = applyStageControl(done, 'a', 'accept', { ...input, tasks: ['real'] }, owner.name, 'management');
  assert.equal(accepted.tasks[1].status, 'done');
});

test('blocker resolution and dates require explicit confirmation', () => {
  const s = fixture(); s.stages[0].blocker = 'Нет поставки';
  assert.throws(() => applyStageControl(s, 'a', 'complete', input, owner.name, 'management'), /Препятствие|препятствие/);
  const done = applyStageControl(s, 'a', 'complete', { ...input, blockerResolved: true }, owner.name, 'management');
  const changed = structuredClone(done); changed.stages[0].completedOn = '2026-08-14';
  assert.ok(validateStageControl(done, changed, foreman, now));
  assert.throws(() => applyStageControl(fixture(), 'a', 'complete', { ...input, date: '2099-01-01' }, owner.name, 'management'));
});

test('roles cannot spoof acceptance, bypass review, or erase accepted evidence', () => {
  const s = fixture(), spoof = structuredClone(s); spoof.stages[0].acceptedBy = 'Виталий'; spoof.stages[0].actualEnd = '2026-08-15';
  assert.ok(validateStageControl(s, spoof, foreman, now));
  s.checkpoints = [{ id: 'cp', stageId: 'a', title: 'Осмотр', zone: 'Объект', status: 'accepted', requiredShots: [], photos: [], assignee: 'Прораб', reviewer: 'Виталий', acceptedAt: now, clientVisible: false }];
  const removed = structuredClone(s); removed.checkpoints[0].acceptedAt = '2026-01-01';
  assert.ok(validateStageControl(s, removed, foreman, now));
  const moved = applyStageControl(s, 'a', 'complete', input, owner.name, 'management');
  const accepted = applyStageControl(moved, 'a', 'accept', input, owner.name, 'management');
  accepted.checkpoints[0].stageId = 'b';
  assert.ok(validateStageControl(moved, accepted, owner, now));
});

test('radar shows concurrent and overdue stages; work forecast cannot overwrite handover promise', () => {
  const s = fixture(), before = structuredClone(s);
  const radar = stageRadar(s, '2026-09-09');
  assert.equal(radar.running.length, 2); assert.equal(radar.due.length, 3); assert.equal(radar.forecast, null);
  s.project.workForecastDate = '2026-10-10'; s.project.workForecastNote = 'Оценка оставшихся работ'; s.project.workForecastUpdatedAt = now;
  assert.equal(validateStageControl(before, s, owner, now), null);
  assert.equal(s.project.forecastDate, before.project.forecastDate);
  assert.equal(s.project.targetDate, before.project.targetDate);
  assert.equal(stageRadar(s, '2026-09-09').forecast, '2026-10-10');
  assert.equal(stageRadar(s, '2026-09-20').stale, true);
  s.stages[0].dependencyId = 'b';
  assert.ok(validateStageControl(before, s, owner, now));
  assert.equal(stageCanStart(s, s.stages[2]), false);
});

test('web and Telegram enforce acceptance before persistence', async () => {
  const before = fixture(), next = structuredClone(before); next.stages[0].status = 'accepted';
  const handler = createProjectWriteHandler({ ensureSchema: async () => {}, readSnapshot: async () => ({ state: before, revision: 1 }), changes: () => 1, applyAutomations: () => { throw Error('unexpected'); }, buildNotificationPlan: async () => { throw Error('unexpected'); }, dispatchNotifications: async () => {} });
  const response = await handler(new Request('https://app.test/api/state?projectId=project-1', { method: 'PUT', headers: { 'content-type': 'application/json', 'oai-authenticated-user-email': 'owner@example.test' }, body: JSON.stringify({ projectId: 'project-1', expectedRevision: 1, state: next }) }), { DB: {}, OWNER_EMAIL: 'owner@example.test' }, { waitUntil() {} });
  assert.equal(response.status, 422); assert.equal((await response.json()).error, 'invalid_stage_transition');
  const store = createTelegramProjectStore({ ensureSchema: async () => {}, readSnapshot: async () => ({ state: before, revision: 1 }), changes: () => 1, mutationNoop: Symbol() });
  await assert.rejects(store.mutate({ DB: {} }, 'project-1', owner.name, 'management', 'edit', 'edit', () => next), /invalid_stage_transition/);
});

test('a save acknowledgement keeps a concurrent stage edit while accepting server history', () => {
  const before = fixture(), sent = applyStageControl(before, 'a', 'complete', input, owner.name, 'management');
  const local = structuredClone(sent); local.stages[0].responsible = 'Новый ответственный';
  const remote = structuredClone(sent);
  assert.equal(validateStageControl(before, remote, owner, now), null);
  const model = reconcileSavedSnapshot({ ...createSyncModel({ state: before, revision: 1 }), state: local, dirty: true }, sent, { state: remote, revision: 2 });
  assert.equal(model.state.stages[0].responsible, local.stages[0].responsible);
  assert.deepEqual(model.state.stages[0].statusHistory, remote.stages[0].statusHistory);
  assert.equal(model.state.stages[0].statusNote, undefined);
  assert.equal(validateStageControl(remote, structuredClone(model.state), owner, now), null);
});
