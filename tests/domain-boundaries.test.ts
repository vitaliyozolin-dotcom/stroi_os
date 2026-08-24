import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { addTaskComment, changeCheckpoint, changeProjectState, isTaskClosed, isTaskOverdue, normalizeAppStateWithFallback } from '../src/domain/index.ts';
import type { AppState } from '../src/entities/index.ts';
import { seedState } from '../src/seed.ts';

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('task predicates are deterministic for an explicitly supplied date', () => {
  const current = { ...structuredClone(seedState.tasks[0]), status: 'todo' as const, dueDate: '2026-08-19' };

  assert.equal(isTaskClosed(current.status), false);
  assert.equal(isTaskOverdue(current, '2026-08-19'), false);
  assert.equal(isTaskOverdue(current, '2026-08-20'), true);
  assert.equal(isTaskClosed('done'), true);
  assert.equal(isTaskClosed('canceled'), true);
});

test('state normalization uses an explicit fallback without mutating either input', () => {
  const fallback = structuredClone(seedState);
  const input = structuredClone(seedState) as AppState;
  const fallbackBefore = structuredClone(fallback);
  const inputBefore = structuredClone(input);

  const normalized = normalizeAppStateWithFallback(input, fallback);

  assert.notEqual(normalized, input);
  assert.deepEqual(input, inputBefore);
  assert.deepEqual(fallback, fallbackBefore);
});

test('removed domain compatibility facades cannot become parallel implementations again', () => {
  for (const file of ['domain.ts', 'conflict.ts', 'progressEngine.ts']) {
    assert.equal(existsSync(new URL(`../src/${file}`, import.meta.url)), false, `${file} was restored`);
  }
});

test('task mutations produce auditable StateChange without mutating the source state', () => {
  const state = structuredClone(seedState);
  state.tasks.push({ id: 'task-1', title: 'Проверить работу', status: 'todo', priority: 'normal', assigneeId: 'u1', assigneeName: 'Прораб', createdBy: 'Прораб', createdAt: '2026-08-20T09:00:00.000Z', updatedAt: '2026-08-20T09:00:00.000Z', dueDate: '2026-08-20', originalDueDate: '2026-08-20', rescheduleCount: 0, history: [] });
  const task = structuredClone(state.tasks[0]);
  const before = structuredClone(state);
  const context = { actor: 'Проверяющий', timestamp: '2026-08-20T12:00:00.000Z', nextId: (prefix: string) => `${prefix}-test` };

  const comment = addTaskComment(state, { taskId: task.id, text: 'Проверить узел' }, context);

  assert.deepEqual(state, before);
  assert.equal(comment.action, 'task_comment_added');
  assert.equal(comment.state.tasks[0].history[0].text, 'Проверить узел');
  assert.equal(comment.state.activity[0].actor, 'Проверяющий');
});

test('generic project changes preserve supplied payload and expose audit metadata', () => {
  const state = structuredClone(seedState);
  const context = { actor: 'Менеджер', timestamp: '2026-08-20T12:00:00.000Z', nextId: (prefix: string) => `${prefix}-test` };
  const settings = { ...state.settings, dashboardWidgets: [] };

  const change = changeProjectState(state, {
    patch: { settings },
    action: 'settings_updated',
    summary: 'Обновлены настройки',
  }, context);

  assert.equal(change.action, 'settings_updated');
  assert.deepEqual(change.state.settings.dashboardWidgets, []);
  assert.equal(change.state.activity[0].text, 'Обновлены настройки');
  assert.notEqual(change.state, state);
});

test('checkpoint draft changes can remain quiet while still carrying save metadata', () => {
  const state = structuredClone(seedState);
  state.checkpoints.push({ id: 'checkpoint-1', stageId: 'stage-1', title: 'Армирование', zone: 'Фундамент', status: 'pending', requiredShots: [], photos: [], assignee: 'Прораб', reviewer: 'Виталий', clientVisible: false });
  const checkpoint = state.checkpoints[0];
  const context = { actor: 'Прораб', timestamp: '2026-08-20T12:00:00.000Z', nextId: (prefix: string) => `${prefix}-test` };

  const change = changeCheckpoint(state, {
    checkpointId: checkpoint.id,
    patch: { note: 'Черновик замера' },
    summary: 'Обновлена контрольная точка',
    recordActivity: false,
  }, context);

  assert.equal(change.summary, 'Обновлена контрольная точка');
  assert.deepEqual(change.state.activity, state.activity);
  assert.equal(change.state.checkpoints[0].note, 'Черновик замера');
});
