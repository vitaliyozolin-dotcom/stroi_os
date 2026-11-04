import assert from 'node:assert/strict';
import test from 'node:test';
import { createProjectState, createDraftOrderState, seedState } from '../src/seed.ts';
import { validateBaselineChanges } from '../sites/projects/baseline.js';

const businessCollections = [
  'financeEntries',
  'procurement',
  'counterparties',
  'supplierQuotes',
  'leads',
  'tasks',
  'fieldReports',
  'checkpoints',
  'documents',
  'decisions',
  'activity',
] as const;

test('new draft order records unknown inputs explicitly and never clones business facts or access', () => {
  const base = structuredClone(seedState);
  base.counterparties = [{ id: 'private-vendor' }] as typeof base.counterparties;
  base.documents = [{ id: 'private-document' }] as typeof base.documents;
  base.settings.users.push({ id: 'other-customer', name: 'Другой клиент', email: 'other@example.test', role: 'client', status: 'active' });
  const draft = createDraftOrderState(base, { code: 'O-1', name: 'Первичный заказ', actor: 'Владелец', customerId: 'party-1' });
  assert.equal(draft.project.status, 'draft');
  assert.equal(draft.orderRelations?.customerId, 'party-1');
  assert.equal(draft.orderRelations?.contractPricing, undefined);
  assert.deepEqual(draft.project.unknownFields, ['area', 'contractValue', 'targetCost']);
  assert.deepEqual([draft.project.startDate, draft.project.targetDate, draft.project.forecastDate], ['', '', '']);
  assert.deepEqual(draft.stages, []); assert.deepEqual(draft.budgetLines, []);
  for (const collection of businessCollections.filter(name => name !== 'activity')) assert.deepEqual(draft[collection], []);
  assert.deepEqual(draft.settings.users.map(user => user.id), ['user-owner']);
  assert.ok(draft.project.creationRequestId);
  assert.notEqual(draft.project.id, base.project.id);
  assert.equal(validateBaselineChanges(null, structuredClone(draft), { role: 'management', name: 'Owner' }), null);
  const dated = structuredClone(draft); dated.project.targetDate = '2026-12-31';
  const erased = structuredClone(dated); erased.project.targetDate = '';
  assert.ok(validateBaselineChanges(dated, erased, { role: 'management', name: 'Owner' }), 'existing dates cannot be erased through draft exception');
});

test('starts with a clean workspace and no demo business data', () => {
  assert.equal(seedState.schemaVersion, 17);
  assert.equal(seedState.project.status, 'workspace');
  for (const collection of businessCollections) assert.deepEqual(seedState[collection], []);
  assert.equal(seedState.settings.users.length, 1);
  assert.equal(seedState.settings.users[0].email, 'vitaliyozolin@gmail.com');
  assert.ok(seedState.budgetLines.every((line) => line.plan === 0 && line.forecast === 0));
});

test('creates a project without cloning operational records', () => {
  const base = structuredClone(seedState);
  base.settings.users.push(
    { id: 'user-foreman', name: 'Прораб', email: 'foreman@example.test', role: 'foreman', status: 'active' },
    { id: 'user-client', name: 'Клиент', email: 'client@example.test', role: 'client', status: 'active' },
  );
  const state = createProjectState(base, {
    code: 'H-001',
    name: 'Рабочий объект',
    address: '',
    model: '',
    area: 100,
    clientNames: '',
    contractValue: 0,
    targetCost: 0,
    startDate: '2026-07-29',
    targetDate: '2026-11-29',
    foreman: '',
    source: '',
    actor: 'Виталий Озолин',
  });

  assert.equal(state.project.status, 'active');
  assert.equal(state.project.code, 'H-001');
  assert.equal(state.budgetMeta.source, 'Смета не загружена');
  for (const collection of businessCollections.filter((name) => name !== 'activity')) assert.deepEqual(state[collection], []);
  assert.equal(state.activity.length, 1);
  assert.deepEqual(state.settings.users.map((user) => user.id), ['user-owner']);
});
