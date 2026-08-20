import assert from 'node:assert/strict';
import test from 'node:test';

import { commitStateChange, createMutationContext } from '../src/application/index.ts';
import { changeCheckpoint, changeTaskStatus } from '../src/domain/index.ts';
import { seedState } from '../src/seed.ts';

const context = () => createMutationContext(
  'Прораб',
  { now: () => '2026-08-20T10:00:00.000Z' },
  { next: (prefix) => `${prefix}-fixed` },
);

test('task status change returns immutable state and auditable metadata', () => {
  const state = structuredClone(seedState);
  state.tasks.push({ id: 'task-1', title: 'Проверить работу', status: 'review', priority: 'normal', assigneeId: 'u1', assigneeName: 'Прораб', createdBy: 'Прораб', createdAt: '2026-08-20T09:00:00.000Z', updatedAt: '2026-08-20T09:00:00.000Z', dueDate: '2026-08-20', originalDueDate: '2026-08-20', rescheduleCount: 0, history: [] });
  const task = state.tasks[0];
  const change = changeTaskStatus(state, { taskId: task.id, status: 'done', text: 'Задача выполнена', extra: { completionNote: 'Готово' } }, context());

  assert.equal(state.tasks[0].status, task.status);
  assert.equal(change.state.tasks[0].status, 'done');
  assert.equal(change.state.tasks[0].completedAt, '2026-08-20T10:00:00.000Z');
  assert.equal(change.action, 'task_status_changed');
  assert.equal(change.summary, `Задача выполнена: «${task.title}»`);
  assert.equal(change.state.activity[0].id, 'activity-fixed');
});

test('checkpoint change and application sink preserve action and summary', () => {
  const state = structuredClone(seedState);
  state.checkpoints.push({ id: 'checkpoint-1', stageId: 'stage-1', title: 'Армирование', zone: 'Фундамент', status: 'in_review', requiredShots: [], photos: [], assignee: 'Прораб', reviewer: 'Виталий', clientVisible: false });
  const checkpoint = state.checkpoints[0];
  const change = changeCheckpoint(state, { checkpointId: checkpoint.id, patch: { status: 'accepted', acceptedAt: '2026-08-20T10:00:00.000Z', clientVisible: true }, summary: 'Контрольная точка принята', tone: 'positive' }, context());
  let received: unknown;

  commitStateChange(change, (next, metadata) => { received = { next, metadata }; });

  assert.deepEqual((received as { metadata: unknown }).metadata, { action: 'checkpoint_accepted', summary: 'Контрольная точка принята' });
  assert.equal(change.state.checkpoints[0].clientVisible, true);
});
