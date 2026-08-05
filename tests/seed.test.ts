import assert from 'node:assert/strict';
import test from 'node:test';
import { createProjectState, seedState } from '../src/seed.ts';

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

test('starts with a clean workspace and no demo business data', () => {
  assert.equal(seedState.schemaVersion, 17);
  assert.equal(seedState.project.status, 'workspace');
  for (const collection of businessCollections) assert.deepEqual(seedState[collection], []);
  assert.equal(seedState.settings.users.length, 1);
  assert.equal(seedState.settings.users[0].email, 'vitaliyozolin@gmail.com');
  assert.ok(seedState.budgetLines.every((line) => line.plan === 0 && line.forecast === 0));
});

test('creates a project without cloning operational records', () => {
  const state = createProjectState(seedState, {
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
});
