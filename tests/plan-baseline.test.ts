import assert from 'node:assert/strict';
import test from 'node:test';
import { seedState } from '../src/seed.ts';
import { applyKelosiPpr } from '../src/kelosiPpr.ts';
import { normalizeAppStateWithFallback } from '../src/domain/normalization.ts';
import { baselineOverview, planDays, taskBaselineDelay, taskBaselineEnd, restoreKnownPprBaseline, validPlanDate } from '../sites/lib/plan-baseline.js';
import { validateBaselineChanges } from '../sites/projects/baseline.js';
import { createTelegramProjectStore } from '../sites/telegram/project-store.js';
import { createProjectWriteHandler } from '../sites/projects/write.js';
import { applyBattleAutomations } from '../sites/automations/battle.js';
import { createSyncModel, reconcileSavedSnapshot } from '../src/application/project-sync.ts';
import type { ProjectTask } from '../src/entities/index';

const now = '2026-09-08T18:00:00.000Z';
const owner = { name: 'Виталий', role: 'management' };
const baseline = (end = '2026-09-10') => ({ end, source: 'document' as const, note: 'Исходный ППР.xlsx', recordedAt: now, recordedBy: owner.name });
const task = (): ProjectTask => ({ id: 'task-1', title: 'Работа', status: 'todo', priority: 'normal', assigneeId: 'u1', assigneeName: 'Прораб', createdBy: 'Виталий', createdAt: now, updatedAt: now, dueDate: '2026-09-10', originalDueDate: '2026-09-10', rescheduleCount: 0, history: [] });
const state = () => {
  const s = structuredClone(seedState);
  s.project.id = 'project-1'; s.project.status = 'in_progress'; s.project.startDate = '2026-08-10'; s.project.targetDate = '2026-09-10';
  s.stages = [{ ...s.stages[0], id: 'stage-1', planStart: '2026-08-10', planEnd: '2026-09-10', forecastEnd: '2026-09-10' }];
  s.tasks = [task()]; s.activity = []; return s;
};

test('Plan 0 survives project, stage and task moves and records real actor, reason and date', () => {
  const before = state(); before.project.baseline = baseline(); before.stages[0].baseline = baseline();
  const next = structuredClone(before);
  next.project.targetDate = '2026-10-10'; next.project.planChangeReason = 'Новый срок согласован';
  next.stages[0].planEnd = '2026-10-10'; next.stages[0].planChangeReason = 'Поздняя поставка';
  next.tasks[0].dueDate = '2026-09-15'; next.tasks[0].planChangeReason = 'Подрядчик перенёс выезд';
  assert.equal(validateBaselineChanges(before, next, owner, now), null);
  assert.equal(next.project.baseline.end, '2026-09-10');
  assert.equal(next.tasks[0].originalDueDate, '2026-09-10');
  assert.deepEqual(next.stages[0].planHistory?.[0], { at: now, actor: owner.name, field: 'planEnd', before: '2026-09-10', after: '2026-10-10', reason: 'Поздняя поставка' });
  assert.equal(planDays(next.project.targetDate, next.project.baseline.end), 30);
});

test('missing fields from an older client preserve locked dates and server history', () => {
  const before = state(); before.project.baseline = baseline(); before.stages[0].baseline = baseline(); before.tasks[0].baseline = baseline();
  before.stages[0].planHistory = [{ at: now, actor: 'Виталий', field: 'planEnd', before: '2026-09-01', after: '2026-09-10', reason: 'Договорённость' }];
  const next = structuredClone(before);
  delete next.project.baseline; delete next.stages[0].baseline; delete next.stages[0].planHistory; delete next.tasks[0].baseline;
  delete (next.tasks[0] as Partial<ProjectTask>).originalDueDate;
  assert.equal(validateBaselineChanges(before, next, owner, now), null);
  assert.deepEqual(next.stages[0].baseline, before.stages[0].baseline);
  assert.deepEqual(next.stages[0].planHistory, before.stages[0].planHistory);
  assert.equal(next.tasks[0].originalDueDate, '2026-09-10');
});

test('tampering and deleting baseline records are rejected', () => {
  const before = state(); before.stages[0].baseline = baseline();
  const altered = structuredClone(before); altered.stages[0].baseline!.end = '2026-10-10';
  assert.ok(validateBaselineChanges(before, altered, owner, now));
  const removed = structuredClone(before); removed.stages = [];
  assert.ok(validateBaselineChanges(before, removed, owner, now));
  const taskChanged = structuredClone(before); taskChanged.tasks[0].originalDueDate = '2026-10-10';
  assert.ok(validateBaselineChanges(before, taskChanged, owner, now));
});

test('earlier moves also require a reason and management; invalid calendars are rejected', () => {
  const before = state(); const next = structuredClone(before); next.tasks[0].dueDate = '2026-09-09';
  assert.ok(validateBaselineChanges(before, next, owner, now));
  next.tasks[0].planChangeReason = 'Удалось ускорить';
  assert.ok(validateBaselineChanges(before, structuredClone(next), { role: 'foreman', name: 'Прораб' }, now));
  assert.equal(validateBaselineChanges(before, next, owner, now), null);
  next.tasks[0].dueDate = '2026-02-31';
  assert.ok(validateBaselineChanges(before, next, owner, now));
  assert.equal(validPlanDate('2026-02-31'), false);
  assert.equal(validPlanDate('2028-02-29'), true);
});

test('unknown original task date stays unknown; explicit documented recovery is allowed once', () => {
  const before = state(); delete (before.tasks[0] as Partial<ProjectTask>).originalDueDate;
  const normalized = normalizeAppStateWithFallback(before, seedState);
  assert.equal(taskBaselineEnd(normalized.tasks[0]), null);
  const restored = structuredClone(normalized); restored.tasks[0].baseline = baseline('2026-09-01'); restored.tasks[0].originalDueDate = '2026-09-01';
  assert.equal(validateBaselineChanges(before, restored, owner, now), null);
  assert.equal(restored.tasks[0].baseline?.recordedBy, owner.name);
});

test('known exact PPR restores only original dates and is idempotent', () => {
  const initial = state(); initial.project.name = 'Келози';
  const imported = applyKelosiPpr(initial);
  assert.equal(imported.stages.length, 12);
  for (const stage of imported.stages) { assert.equal(stage.baseline?.start, stage.planStart); assert.equal(stage.baseline?.end, stage.planEnd); }
  const moved = structuredClone(imported);
  moved.stages[0].planEnd = '2026-10-10'; moved.stages[0].status = 'accepted'; moved.stages[0].actualEnd = '2026-10-09';
  for (const stage of moved.stages) delete stage.baseline;
  const restored = applyKelosiPpr(moved);
  assert.equal(restored.stages[0].planEnd, '2026-10-10');
  assert.equal(restored.stages[0].status, 'accepted');
  assert.equal(restored.stages[0].actualEnd, '2026-10-09');
  assert.equal(restored.stages[0].baseline?.end, '2026-08-10');
  assert.deepEqual(restoreKnownPprBaseline(restored), restored);
  assert.equal(baselineOverview(restored).end, '2026-09-10');
  assert.equal(restored.project.baseline, undefined, 'PPR end is not invented as a contractual handover date');
  assert.equal(validateBaselineChanges(moved, structuredClone(restored), { role: 'foreman', name: 'Прораб' }, now), null);
  restored.activity = [];
  assert.deepEqual(applyKelosiPpr(restored), restored, 'truncated activity must not reimport the current schedule');
  for (const stage of restored.stages) delete stage.baseline;
  assert.equal(applyKelosiPpr(restored).stages[0].planEnd, '2026-10-10');
});

test('required dates cannot be cleared and each move consumes its reason', () => {
  const before = state();
  for (const [collection, field] of [['project', 'targetDate'], ['stages', 'planStart'], ['stages', 'planEnd'], ['tasks', 'dueDate']] as const) {
    const next = structuredClone(before);
    const item = (collection === 'project' ? next.project : next[collection][0]) as unknown as Record<string, unknown>;
    item[field] = ''; item.planChangeReason = 'Перенос';
    assert.ok(validateBaselineChanges(before, next, owner, now));
  }
  const moved = structuredClone(before); moved.tasks[0].dueDate = '2026-09-11'; moved.tasks[0].planChangeReason = 'Перенос';
  assert.equal(validateBaselineChanges(before, moved, owner, now), null);
  assert.equal(moved.tasks[0].planChangeReason, undefined);
  const second = structuredClone(moved); second.tasks[0].dueDate = '2026-09-12';
  assert.ok(validateBaselineChanges(moved, second, owner, now));
});

test('actual task delay uses Moscow date and remains unknown without a completion date', () => {
  assert.equal(taskBaselineDelay({ ...task(), status: 'done', completedAt: '2026-09-10T22:00:00Z' }), 1);
  assert.equal(taskBaselineDelay({ ...task(), status: 'done' }), null);
  assert.equal(taskBaselineDelay({ ...task(), status: 'canceled' }), null);
});

test('save acknowledgement accepts authoritative plan fields while preserving newer local work', () => {
  const before = state(), sent = structuredClone(before);
  sent.project.baseline = baseline();
  sent.tasks[0].dueDate = '2026-09-11'; sent.tasks[0].planChangeReason = 'Первая поставка';
  const saved = structuredClone(sent);
  assert.equal(validateBaselineChanges(before, saved, owner, '2026-09-08T18:00:01.000Z'), null);
  const local = structuredClone(sent);
  local.project.name = 'Уточнили название'; local.tasks[0].description = 'Добавили пояснение';
  const acknowledged = reconcileSavedSnapshot({ ...createSyncModel({ state: before, revision: 1 }), state: local, dirty: true }, sent, { state: saved, revision: 2 });
  assert.equal(acknowledged.state.project.name, local.project.name);
  assert.equal(acknowledged.state.tasks[0].description, local.tasks[0].description);
  assert.deepEqual(acknowledged.state.project.baseline, saved.project.baseline);
  assert.deepEqual(acknowledged.state.tasks[0].planHistory, saved.tasks[0].planHistory);
  assert.equal(acknowledged.state.tasks[0].planChangeReason, undefined);
  assert.equal(validateBaselineChanges(saved, structuredClone(acknowledged.state), owner, now), null);
  local.tasks[0].dueDate = '2026-09-12'; local.tasks[0].planChangeReason = 'Вторая поставка';
  const second = reconcileSavedSnapshot({ ...acknowledged, state: local }, sent, { state: saved, revision: 2 });
  assert.equal(second.state.tasks[0].dueDate, '2026-09-12');
  assert.equal(second.state.tasks[0].planChangeReason, 'Вторая поставка');
  assert.equal(validateBaselineChanges(saved, structuredClone(second.state), owner, now), null);
});

test('a project name alone does not imply the historical exact PPR or replace other projects', () => {
  const other = state(); other.project.name = 'Келози новый';
  assert.equal(restoreKnownPprBaseline(other), other);
  assert.equal(baselineOverview(other).end, null);
  assert.equal(baselineOverview({ ...other, stages: [] }).end, null);
});

test('automatic reopening keeps original date and records the date change', () => {
  const before = state(); before.tasks = [{ ...task(), id: 'auto-quality-cp', status: 'done', dueDate: '2026-01-01', originalDueDate: '2026-01-01' }];
  before.checkpoints = [{ id: 'cp', stageId: 'stage-1', title: 'Осмотр', zone: 'Объект', status: 'accepted', requiredShots: [], photos: [], assignee: 'Прораб', reviewer: 'Виталий', clientVisible: false }];
  const next = structuredClone(before); next.checkpoints[0].status = 'rework';
  const result = applyBattleAutomations(before, next, 'Виталий');
  assert.equal(result.tasks[0].originalDueDate, '2026-01-01');
  assert.equal(result.tasks[0].planHistory?.[0].before, '2026-01-01');
  assert.equal(result.tasks[0].planHistory?.[0].after, result.tasks[0].dueDate);
});

test('web endpoint rejects baseline tampering before storage or notifications', async () => {
  const before = state(); before.project.baseline = baseline(); const next = structuredClone(before); next.project.baseline!.end = '2026-10-10';
  const handler = createProjectWriteHandler({ ensureSchema: async () => {}, readSnapshot: async () => ({ state: before, revision: 1 }), changes: () => 1,
    applyAutomations: () => { throw new Error('must not reach'); }, buildNotificationPlan: async () => { throw new Error('must not reach'); }, dispatchNotifications: async () => {} });
  const response = await handler(new Request('https://app.test/api/state?projectId=project-1', { method: 'PUT', headers: { 'content-type': 'application/json', 'oai-authenticated-user-email': 'owner@example.test' }, body: JSON.stringify({ projectId: 'project-1', expectedRevision: 1, state: next }) }), { DB: {}, OWNER_EMAIL: 'owner@example.test' }, { waitUntil() {} });
  assert.equal(response.status, 422);
  assert.equal((await response.json()).error, 'invalid_baseline_transition');
});

test('Telegram CAS store also prevents rewriting the original task date', async () => {
  const before = state(); let writes = 0;
  const store = createTelegramProjectStore({ ensureSchema: async () => {}, readSnapshot: async () => ({ state: before, revision: 1 }), changes: () => 1, mutationNoop: Symbol() });
  await assert.rejects(store.mutate({ DB: { prepare() { writes++; throw new Error('unexpected write'); } } }, before.project.id, 'Виталий', 'management', 'edit', 'edit', (s: ReturnType<typeof state>) => { s.tasks[0].originalDueDate = '2026-10-10'; }), /invalid_baseline_transition/);
  assert.equal(writes, 0);
});
