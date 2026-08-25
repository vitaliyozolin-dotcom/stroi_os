import assert from 'node:assert/strict';
import test from 'node:test';
import { applyBattleAutomations } from '../sites/automations/battle.js';

const state = (): any => ({
  project: { id: 'project-1', status: 'active' },
  settings: {
    users: [{ id: 'foreman-1', name: 'Иван Прораб', role: 'foreman', status: 'active' }],
  },
  stages: [],
  checkpoints: [],
  procurement: [],
  tasks: [],
  activity: [],
});

test('battle automations leave workspace projects unchanged', () => {
  const previous = state();
  const next = { ...state(), project: { id: 'project-1', status: 'workspace' } };

  assert.equal(applyBattleAutomations(previous, next, 'Владелец'), next);
  assert.deepEqual(next.tasks, []);
  assert.deepEqual(next.activity, []);
});

test('a new procurement risk creates one assigned auditable task', () => {
  const previous = state();
  const next = state();
  next.procurement.push({
    id: 'supply-1', item: 'Кирпич', risk: 'Опоздание', owner: 'Иван Прораб',
    neededBy: '2026-09-01', stageId: 'stage-1',
  });

  applyBattleAutomations(previous, next, 'Владелец');

  assert.equal(next.tasks.length, 1);
  assert.equal(next.tasks[0].id, 'auto-supply-supply-1');
  assert.equal(next.tasks[0].assigneeId, 'foreman-1');
  assert.equal(next.tasks[0].dueDate, '2026-09-01');
  assert.match(next.activity[0].text, /Создана задача/);
});

test('an unchanged procurement risk does not duplicate its task', () => {
  const previous = state();
  previous.procurement.push({ id: 'supply-1', item: 'Кирпич', risk: 'Опоздание' });
  const next = structuredClone(previous);

  applyBattleAutomations(previous, next, 'Владелец');

  assert.deepEqual(next.tasks, []);
  assert.deepEqual(next.activity, []);
});

test('a completed automatic task reopens when the risk changes again', () => {
  const previous = state();
  previous.procurement.push({ id: 'supply-1', item: 'Кирпич', risk: 'Опоздание' });
  const next = structuredClone(previous);
  next.procurement[0].risk = 'Поставка сорвана';
  next.tasks.push({
    id: 'auto-supply-supply-1', status: 'done', completedAt: '2026-08-24T12:00:00.000Z',
    completionNote: 'Закрыто', rescheduleCount: 0, history: [],
  });

  applyBattleAutomations(previous, next, 'Владелец');

  assert.equal(next.tasks[0].status, 'todo');
  assert.equal(next.tasks[0].completedAt, undefined);
  assert.equal(next.tasks[0].rescheduleCount, 1);
  assert.equal(next.tasks[0].history.at(-1)?.kind, 'reopened');
  assert.match(next.activity[0].text, /Переоткрыта задача/);
});
