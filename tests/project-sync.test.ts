import assert from 'node:assert/strict';
import test from 'node:test';

import { applyLocalChange, createSyncModel, reconcileRemoteSnapshot, reconcileRevisionConflict, reconcileSavedSnapshot } from '../src/application/project-sync.ts';
import { seedState } from '../src/seed.ts';

const snapshot = (revision: number) => {
  const state = structuredClone(seedState);
  state.tasks.push({ id: 'task-1', title: 'Задача', status: 'todo', priority: 'normal', assigneeId: 'u1', assigneeName: 'Прораб', createdBy: 'Прораб', createdAt: '2026-08-20T09:00:00Z', updatedAt: '2026-08-20T09:00:00Z', dueDate: '2026-08-21', originalDueDate: '2026-08-21', rescheduleCount: 0, history: [] });
  state.procurement.push({ id: 'supply-1', stageId: 'stage-1', item: 'Бетон', quantity: 1, unit: 'м³', neededBy: '2026-08-21', status: 'need', budget: 0, supplier: 'Не выбран', owner: 'Прораб' });
  return { state, revision, updatedAt: `revision-${revision}` };
};

test('local changes retain audit metadata without mutating the source', () => {
  const model = createSyncModel(snapshot(3), false, true);
  const next = structuredClone(model.state);
  next.tasks[0].status = 'in_progress';
  const changed = applyLocalChange(model, next, { action: 'task_started', summary: 'Задача начата' });
  assert.equal(changed.dirty, true);
  assert.equal(changed.pendingAction, 'task_started');
  assert.equal(changed.pendingSummary, 'Задача начата');
  assert.equal(model.state.tasks[0].status, 'todo');
});

test('reloading an acknowledged dirty cache never writes an identical financial snapshot again', () => {
  const initial = snapshot(5);
  initial.state.financeEntries.push({ id: 'paid-1', kind: 'expense', status: 'paid', amount: 100, acceptedAmount: 100, paidAmount: 100, date: '2026-10-19', description: 'Работы', counterparty: 'Подрядчик', payments: [{ id: 'payment-1', amount: 100, date: '2026-10-19', document: 'Чек', recordedAt: '2026-10-19T10:00:00Z', recordedBy: 'Управляющий' }] });
  const cached = createSyncModel(initial, true, false);
  const result = reconcileRemoteSnapshot(cached, { ...initial, state: structuredClone(cached.state) });
  assert.equal(result.kind, 'remote');
  assert.equal(result.model.dirty, false);
  assert.equal(result.model.revision, 5);
  assert.deepEqual(result.model.state.financeEntries, cached.state.financeEntries);
});

test('server-stamped payment facts acknowledge an older dirty cache without a no-op save', () => {
  const cached = createSyncModel(snapshot(4), true, false);
  cached.state.financeEntries = [{ id: 'paid-1', kind: 'expense', status: 'paid', amount: 100, acceptedAmount: 100, paidAmount: 100, date: '2026-10-19', description: 'Работы', counterparty: 'Подрядчик' }];
  cached.base = structuredClone(cached.state);
  const server = { state: structuredClone(cached.state), revision: 5 };
  server.state.financeEntries[0].payments = [{ id: 'payment-1', amount: 100, date: '2026-10-19', document: 'Чек', recordedAt: '2026-10-19T10:00:00Z', recordedBy: 'Управляющий' }];
  const result = reconcileRemoteSnapshot(cached, server);
  assert.equal(result.kind, 'remote');
  assert.equal(result.model.dirty, false);
  assert.equal(result.model.revision, 5);
  assert.deepEqual(result.model.state.financeEntries[0].payments, server.state.financeEntries[0].payments);
});

test('hydration merges independent changes and exposes same-record conflicts', () => {
  const model = createSyncModel(snapshot(1), false, false);
  const local = structuredClone(model.state);
  local.tasks[0].status = 'in_progress';
  const dirty = applyLocalChange(model, local);
  const remote = snapshot(2);
  remote.state.procurement[0].status = 'rfq';
  const merged = reconcileRemoteSnapshot(dirty, remote);
  assert.equal(merged.kind, 'save');
  assert.equal(merged.model.state.tasks[0].status, 'in_progress');
  assert.equal(merged.model.state.procurement[0].status, 'rfq');

  remote.state.tasks[0].status = 'done';
  const conflict = reconcileRemoteSnapshot(dirty, remote);
  assert.equal(conflict.kind, 'conflict');
});

test('save reconciliation keeps concurrent edits and advances conflict revision', () => {
  const model = createSyncModel(snapshot(1), false, true);
  const sent = structuredClone(model.state);
  sent.tasks[0].status = 'in_progress';
  const whileSaving = structuredClone(sent);
  whileSaving.procurement[0].status = 'rfq';
  const dirty = applyLocalChange({ ...model, state: sent }, whileSaving);
  const saved = reconcileSavedSnapshot(dirty, sent, { state: sent, revision: 2, updatedAt: 'saved' });
  assert.equal(saved.state.procurement[0].status, 'rfq');

  const remote = snapshot(2);
  remote.state.procurement[0].status = 'rfq';
  const resolution = reconcileRevisionConflict({ ...model, state: sent, dirty: true }, sent, remote);
  assert.equal(resolution.kind, 'save');
  assert.equal(resolution.model.revision, 2);
});

