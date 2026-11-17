import assert from 'node:assert/strict';
import test from 'node:test';
import { isTaskOverdue } from '../src/domain/tasks.ts';
import { seedState } from '../src/seed.ts';
import { applyStageControl } from './support/module-project.ts';
import { stageCanStart, stageDependencyIssue } from '../sites/lib/stage-control.js';
import { validateStageControl } from '../sites/projects/stage-control.js';
import { createTelegramProjectStore } from '../sites/telegram/project-store.js';
import { createProjectWriteHandler } from '../sites/projects/write.js';

const now = '2026-11-17T12:00:00Z';
const actor = { role: 'management', id: 'owner', name: 'Owner', isOwner: true };
function fixture() {
  const state = structuredClone(seedState);
  state.project.id = 'gate-test'; state.tasks = []; state.checkpoints = [];
  state.stages = ['foundation', 'frame', 'documents'].map((id, index) => ({
    id, name: id, shortName: id, order: index + 1, status: 'not_ready', weight: 1, progress: 0,
    planStart: '2026-11-01', planEnd: '2026-11-20', forecastEnd: '2026-11-20', responsible: 'Worker',
    ...(id === 'frame' ? { dependencyId: 'foundation' } : {}),
  }));
  return state;
}
const start = { date: '2026-11-17', note: 'Started on site', tasks: [] };

test('dependency blocks start and completion, independent parallel work stays available', () => {
  const state = fixture();
  assert.equal(stageCanStart(state, state.stages[1], start.date), false);
  assert.throws(() => applyStageControl(state, 'frame', 'start', start, actor.name, 'management'), /предыдущий/);
  assert.throws(() => applyStageControl(state, 'frame', 'complete', start, actor.name, 'management'), /предыдущий/);
  const parallel = applyStageControl(state, 'documents', 'start', start, actor.name, 'management');
  assert.equal(validateStageControl(state, parallel, actor, now), null);
  assert.equal(parallel.stages[2].status, 'in_progress');
  assert.equal(parallel.stages[0].status, 'not_ready');
});

test('HTTP and Telegram reject a direct dependency bypass before persistence', async () => {
  const previous = fixture(), next = structuredClone(previous);
  Object.assign(next.stages[1], { status: 'in_progress', actualStart: start.date, statusNote: start.note });
  assert.match(validateStageControl(previous, structuredClone(next), actor, now) || '', /предыдущий/);
  const handler = createProjectWriteHandler({ ensureSchema: async () => {}, readSnapshot: async () => ({ state: previous, revision: 1 }), changes: () => 1, applyAutomations: () => { throw Error('unexpected write'); }, buildNotificationPlan: async () => { throw Error('unexpected notification'); }, dispatchNotifications: async () => {} });
  const response = await handler(new Request('https://app.test/api/state?projectId=gate-test', { method: 'PUT', headers: { 'content-type': 'application/json', 'oai-authenticated-user-email': 'owner@example.test' }, body: JSON.stringify({ projectId: 'gate-test', expectedRevision: 1, state: next }) }), { DB: {}, OWNER_EMAIL: 'owner@example.test' }, { waitUntil() {} });
  assert.equal(response.status, 422);
  const store = createTelegramProjectStore({ ensureSchema: async () => {}, readSnapshot: async () => ({ state: previous, revision: 1 }), changes: () => 1, mutationNoop: Symbol() });
  await assert.rejects(store.mutate({ DB: {} }, 'gate-test', actor.name, 'management', 'update', 'update', () => next), /invalid_stage_transition/);
});

test('removing a dependency and starting in the same update is rejected', () => {
  const previous = fixture(), next = structuredClone(previous);
  Object.assign(next.stages[1], { dependencyId: undefined, status: 'in_progress', actualStart: start.date, statusNote: start.note });
  assert.match(validateStageControl(previous, next, actor, now) || '', /отдельно сохраните/);
});

test('bulk update cannot satisfy its own prerequisite; prior accepted facts and dates are respected', () => {
  const previous = fixture();
  Object.assign(previous.stages[0], { status: 'awaiting_inspection', completedOn: '2026-11-15', completionNote: 'Ready' });
  const next = structuredClone(previous);
  Object.assign(next.stages[0], { status: 'accepted', acceptedAt: now, acceptedBy: actor.name, actualEnd: '2026-11-15', statusNote: 'Accepted' });
  Object.assign(next.stages[1], { status: 'in_progress', actualStart: start.date, statusNote: start.note });
  assert.match(validateStageControl(previous, next, actor, now) || '', /предыдущий/);
  Object.assign(previous.stages[0], { status: 'accepted', acceptedAt: '2026-11-16T12:00:00Z' });
  assert.equal(stageCanStart(previous, previous.stages[1], '2026-11-17'), true);
  assert.equal(stageCanStart(previous, previous.stages[1], '2026-11-15'), false);
});

test('FF dependencies allow parallel start but protect completion and lag dates', () => {
  const state = fixture();
  delete state.stages[1].dependencyId;
  state.stages[1].schedule = { kind: 'work', phase: 'Shell', summaryOf: [], dependencies: [{ stageId: 'foundation', type: 'FF', gate: 'accepted', lagDays: 2 }], calendar: 'daily', daysOff: [], crew: '', reporterId: '', updatedAt: now };
  assert.equal(stageCanStart(state, state.stages[1], '2026-11-17'), true);
  assert.match(stageDependencyIssue(state, state.stages[1], 'finish', '2026-11-17') || '', /примите/);
  Object.assign(state.stages[0], { status: 'accepted', completedOn: '2026-11-14', acceptedAt: '2026-11-16T12:00:00Z' });
  assert.match(stageDependencyIssue(state, state.stages[1], 'finish', '2026-11-17') || '', /пауза/);
  assert.equal(stageDependencyIssue(state, state.stages[1], 'finish', '2026-11-18'), null);
});

test('new working stage and unconfigured empty quality acceptance cannot be injected', () => {
  const previous = fixture(), next = structuredClone(previous);
  next.stages.push({ ...next.stages[0], id: 'injected', status: 'in_progress', actualStart: start.date });
  assert.match(validateStageControl(previous, next, actor, now) || '', /Новый этап/);
  const quality = structuredClone(previous);
  quality.checkpoints.push({ id: 'empty', stageId: 'foundation', title: 'Check', zone: 'Site', status: 'accepted', requiredShots: [], photos: [], assignee: 'Worker', reviewer: 'Owner', clientVisible: false });
  assert.match(validateStageControl(previous, quality, actor, now) || '', /подтверждений/);
});


test('unknown task deadline is not fabricated as an overdue task', () => {
  const task = { status: 'todo', dueDate: '' } as any;
  assert.equal(isTaskOverdue(task, '2026-11-17'), false);
  assert.equal(isTaskOverdue({ ...task, dueDate: '2026-11-16' }, '2026-11-17'), true);
  assert.equal(isTaskOverdue({ ...task, dueDate: 'invalid' }, '2026-11-17'), false);
});
