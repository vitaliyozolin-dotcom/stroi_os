import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeProjectStates } from '../src/conflict.ts';
import type { AppState } from '../src/entities/index.ts';

const clone = (): AppState => ({
  version: 1,
  schemaVersion: 17,
  project: {
    id: 'project-1',
    code: 'P-001',
    name: 'Проект',
    address: '',
    model: '',
    area: 0,
    clientNames: '',
    contractValue: 0,
    targetCost: 0,
    startDate: '2026-07-29',
    targetDate: '2026-11-26',
    forecastDate: '2026-11-26',
    foreman: '',
    cameraStatus: 'offline',
  },
  budgetMeta: { version: '—', source: 'Не загружена' },
  stages: [],
  budgetLines: [],
  financeEntries: [],
  procurement: [],
  counterparties: [],
  supplierQuotes: [],
  leads: [],
  tasks: [],
  fieldReports: [],
  settings: {
    users: [],
    notifications: {
      channels: { email: false, telegram: false, browser: true },
      events: {
        financeApproval: true,
        supplyRisk: true,
        qualityRework: true,
        leadWithoutAction: true,
        scheduleDelay: true,
        taskAssigned: true,
        taskOverdue: true,
        projectActivity: true,
      },
    },
    dashboardWidgets: [],
  },
  checkpoints: [],
  documents: [],
  decisions: [],
  activity: [],
});

test('merges unrelated task and procurement changes without a conflict', () => {
  const base = clone();
  base.tasks = [{
    id: 'task-1',
    title: 'Задача',
    status: 'todo',
    priority: 'normal',
    assigneeId: 'user-owner',
    assigneeName: 'Виталий Озолин',
    createdBy: 'Виталий Озолин',
    createdAt: '2026-07-29T10:00:00Z',
    updatedAt: '2026-07-29T10:00:00Z',
    dueDate: '2026-07-30',
    originalDueDate: '2026-07-30',
    rescheduleCount: 0,
    history: [],
  }];
  base.procurement = [{
    id: 'supply-1',
    stageId: 'foundation',
    item: 'Сваи',
    quantity: 20,
    unit: 'шт',
    neededBy: '2026-08-01',
    status: 'need',
    budget: 0,
    supplier: 'Не выбран',
    owner: 'Виталий Озолин',
  }];
  const local = structuredClone(base);
  const remote = structuredClone(base);
  local.tasks[0].status = 'in_progress';
  remote.procurement[0].status = 'rfq';

  const result = mergeProjectStates(base, local, remote);

  assert.deepEqual(result.conflicts, []);
  assert.equal(result.state.tasks[0].status, 'in_progress');
  assert.equal(result.state.procurement[0].status, 'rfq');
});

test('reports a conflict when the same entity changed differently', () => {
  const base = clone();
  base.financeEntries = [{
    id: 'finance-1',
    kind: 'expense',
    status: 'committed',
    amount: 100_000,
    date: '2026-07-29',
    counterparty: 'Подрядчик',
    description: 'Работы',
  }];
  const local = structuredClone(base);
  const remote = structuredClone(base);
  local.financeEntries[0].amount = 110_000;
  remote.financeEntries[0].amount = 120_000;

  const result = mergeProjectStates(base, local, remote);

  assert.deepEqual(result.conflicts, ['financeEntries.finance-1']);
});

test('keeps a remote addition together with a local addition', () => {
  const base = clone();
  const local = structuredClone(base);
  const remote = structuredClone(base);
  local.documents.push({
    id: 'document-local',
    name: 'Акт',
    type: 'Акт',
    updatedAt: '2026-07-29',
    clientVisible: false,
    status: 'draft',
  });
  remote.decisions.push({
    id: 'decision-remote',
    title: 'Выбрать цвет',
    dueDate: '2026-08-01',
    status: 'waiting',
  });

  const result = mergeProjectStates(base, local, remote);

  assert.deepEqual(result.conflicts, []);
  assert.equal(result.state.documents.length, 1);
  assert.equal(result.state.decisions.length, 1);
});

test('merges independent task progress without a derived stage conflict', () => {
  const base = clone();
  base.stages = [{
    id: 'foundation', order: 1, name: 'Фундамент', shortName: 'Фундамент', status: 'in_progress',
    weight: 100, progress: 0, planStart: '2026-08-01', planEnd: '2026-08-20', forecastEnd: '2026-08-20', responsible: 'Прораб',
  }];
  base.tasks = [
    {
      id: 'task-local', title: 'Первая работа', status: 'todo', priority: 'normal', progressWeight: 25,
      assigneeId: 'u1', assigneeName: 'Прораб', createdBy: 'Система', createdAt: '2026-08-01T00:00:00Z',
      updatedAt: '2026-08-01T00:00:00Z', dueDate: '2026-08-10', originalDueDate: '2026-08-10', stageId: 'foundation', rescheduleCount: 0, history: [],
    },
    {
      id: 'task-remote', title: 'Вторая работа', status: 'todo', priority: 'normal', progressWeight: 75,
      assigneeId: 'u1', assigneeName: 'Прораб', createdBy: 'Система', createdAt: '2026-08-01T00:00:00Z',
      updatedAt: '2026-08-01T00:00:00Z', dueDate: '2026-08-10', originalDueDate: '2026-08-10', stageId: 'foundation', rescheduleCount: 0, history: [],
    },
  ];
  const local = structuredClone(base);
  const remote = structuredClone(base);
  local.tasks[0].status = 'done';
  local.stages[0].progress = 25;
  remote.tasks[1].status = 'done';
  remote.stages[0].progress = 75;

  const result = mergeProjectStates(base, local, remote);

  assert.deepEqual(result.conflicts, []);
  assert.equal(result.state.tasks.every((current) => current.status === 'done'), true);
  assert.equal(result.state.stages[0].progress, 100);
});

test('still reports conflicting source fields on the same stage', () => {
  const base = clone();
  base.stages = [{
    id: 'foundation', order: 1, name: 'Фундамент', shortName: 'Фундамент', status: 'in_progress',
    weight: 100, progress: 0, planStart: '2026-08-01', planEnd: '2026-08-20', forecastEnd: '2026-08-20', responsible: 'Прораб',
  }];
  const local = structuredClone(base);
  const remote = structuredClone(base);
  local.stages[0].forecastEnd = '2026-08-22';
  remote.stages[0].forecastEnd = '2026-08-25';

  const result = mergeProjectStates(base, local, remote);

  assert.deepEqual(result.conflicts, ['stages.foundation']);
});
