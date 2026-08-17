import assert from 'node:assert/strict';
import test from 'node:test';
import { projectProgressTotals, stageProgressTotals, taskPhysicalProgress } from '../src/progressEngine.ts';
import type { AppState, ProjectTask } from '../src/types.ts';

const task = (overrides: Partial<ProjectTask> & Record<string, unknown>): ProjectTask => ({
  id: String(overrides.id || Math.random()), title: 'Работа', status: 'todo', priority: 'normal',
  assigneeId: 'u1', assigneeName: 'Прораб', createdBy: 'Система', createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-01T00:00:00Z', dueDate: '2026-08-10', originalDueDate: '2026-08-10',
  rescheduleCount: 0, history: [], ...overrides,
} as ProjectTask);

const state = (tasks: ProjectTask[], stageStatus: AppState['stages'][number]['status'] = 'in_progress'): AppState => ({
  version: 1,
  project: { id: 'p', code: 'P', name: 'Дом', address: '', model: '', area: 100, clientNames: '', contractValue: 0, targetCost: 0, startDate: '2026-08-03', targetDate: '2026-12-01', forecastDate: '2026-12-01', foreman: '', cameraStatus: 'offline' },
  budgetMeta: { version: '1', source: 'test' },
  stages: [{ id: 's1', order: 1, name: 'Фундамент', shortName: 'Фундамент', status: stageStatus, weight: 25, progress: 99, planStart: '2026-08-03', planEnd: '2026-08-20', forecastEnd: '2026-08-20', responsible: 'Прораб' }],
  budgetLines: [], financeEntries: [], procurement: [], counterparties: [], supplierQuotes: [], leads: [], tasks,
  fieldReports: [], settings: { users: [], notifications: { channels: { email: false, telegram: false, browser: false }, events: { financeApproval: true, supplyRisk: true, qualityRework: true, leadWithoutAction: true, scheduleDelay: true, taskAssigned: true, taskOverdue: true, projectActivity: true } }, dashboardWidgets: [] },
  checkpoints: [], documents: [], decisions: [], activity: [],
});

test('binary task progress comes from workflow facts, not a typed percentage', () => {
  assert.equal(taskPhysicalProgress(task({ status: 'todo' })), 0);
  assert.equal(taskPhysicalProgress(task({ status: 'in_progress' })), 0);
  assert.equal(taskPhysicalProgress(task({ status: 'review' })), 100);
  assert.equal(taskPhysicalProgress(task({ status: 'done' })), 100);
  assert.equal(taskPhysicalProgress(task({ status: 'canceled' })), null);
});

test('quantity and checklist tasks calculate progress from measurable facts', () => {
  assert.equal(taskPhysicalProgress(task({ progressMode: 'quantity', completedQuantity: 30, totalQuantity: 40 })), 75);
  assert.equal(taskPhysicalProgress(task({ progressMode: 'checklist', progressChecklist: [{ done: true }, { done: true }, { done: false }, { done: false }] })), 50);
});

test('stage progress uses task weights and accepted progress stays zero until stage acceptance', () => {
  const current = state([
    task({ id: 'a', stageId: 's1', status: 'done', progressWeight: 10 }),
    task({ id: 'b', stageId: 's1', status: 'todo', progressMode: 'quantity', completedQuantity: 3, totalQuantity: 4, progressWeight: 60 }),
    task({ id: 'c', stageId: 's1', status: 'todo', progressWeight: 30 }),
  ]);
  assert.deepEqual(stageProgressTotals(current, 's1'), { physical: 55, accepted: 0 });
  assert.deepEqual(projectProgressTotals(current), { physical: 55, accepted: 0 });
  assert.deepEqual(stageProgressTotals(state(current.tasks, 'accepted'), 's1'), { physical: 55, accepted: 100 });
});
