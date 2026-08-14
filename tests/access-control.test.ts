import assert from 'node:assert/strict';
import test from 'node:test';

import {
  authenticatedIdentity,
  mergeStateForRole,
  projectIdentity,
  stateForRole,
} from '../sites/access-control.js';

const env = { OWNER_EMAIL: 'owner@example.test', OWNER_NAME: 'Владелец' };
const requestFor = (email?: string, name = '') => new Request('https://stroios.example.test/', {
  headers: email ? {
    'oai-authenticated-user-email': email,
    'oai-authenticated-user-full-name': encodeURIComponent(name),
    'oai-authenticated-user-full-name-encoding': 'percent-encoded-utf-8',
  } : {},
});

const state = () => ({
  project: { id: 'project-1', contractValue: 10_000, targetCost: 8_000, forecastDate: '2026-09-01', cameraStatus: 'online' },
  budgetMeta: { version: '1', source: 'Смета' },
  budgetLines: [{ id: 'budget' }],
  financeEntries: [
    { id: 'expense', kind: 'expense', counterparty: 'Поставщик' },
    { id: 'income', kind: 'income', counterparty: 'Клиент', counterpartyId: 'client', budgetLineId: 'budget' },
  ],
  procurement: [{ id: 'supply' }],
  counterparties: [{ id: 'vendor', name: 'Поставщик', type: 'supplier', status: 'active', email: 'secret@example.test' }],
  supplierQuotes: [{ id: 'quote' }],
  leads: [{ id: 'lead' }],
  tasks: [
    { id: 'own-task', assigneeId: 'foreman', assigneeName: 'Прораб', title: 'Своя', createdBy: 'owner', createdAt: 'now' },
    { id: 'other-task', assigneeId: 'manager', assigneeName: 'Менеджер', title: 'Чужая', createdBy: 'owner', createdAt: 'now' },
  ],
  fieldReports: [{ id: 'public-report', clientVisible: true }, { id: 'private-report', clientVisible: false }],
  settings: { users: [
    { id: 'foreman', name: 'Прораб', email: 'foreman@example.test', role: 'foreman', status: 'active' },
    { id: 'manager', name: 'Менеджер', email: 'manager@example.test', role: 'management', status: 'active' },
    { id: 'client', name: 'Клиент', email: 'client@example.test', role: 'client', status: 'active' },
  ] },
  checkpoints: [{ id: 'public-check', clientVisible: true }, { id: 'private-check', clientVisible: false }],
  documents: [{ id: 'public-doc', clientVisible: true }, { id: 'private-doc', clientVisible: false }],
  decisions: [{ id: 'decision' }],
  activity: [{ id: 'old-activity' }],
  stages: [{ id: 'stage' }],
});

test('identifies the owner and rejects requests without identity', () => {
  assert.deepEqual(authenticatedIdentity(requestFor('OWNER@example.test'), env), {
    email: 'owner@example.test',
    name: 'Владелец',
    isOwner: true,
  });
  assert.equal(authenticatedIdentity(requestFor(), env), null);
});

test('resolves active project users and rejects disabled or unknown roles', () => {
  assert.equal(projectIdentity(requestFor('foreman@example.test', 'Имя из входа'), env, state())?.role, 'foreman');
  const disabled = state();
  disabled.settings.users[0].status = 'disabled';
  assert.equal(projectIdentity(requestFor('foreman@example.test'), env, disabled), null);
  const invited = state();
  invited.settings.users[0].status = 'invited';
  assert.equal(projectIdentity(requestFor('foreman@example.test'), env, invited), null);
  const invalid = state();
  invalid.settings.users[0].role = 'administrator';
  assert.equal(projectIdentity(requestFor('foreman@example.test'), env, invalid), null);
});

test('local sessions are limited to explicitly active project memberships', () => {
  const allowed = requestFor('foreman@example.test', 'Прораб');
  allowed.headers.set('oai-authenticated-user-access-mode', 'local-membership');
  allowed.headers.set('oai-authenticated-user-projects', 'project-1');
  assert.equal(projectIdentity(allowed, env, state())?.role, 'foreman');

  const denied = requestFor('foreman@example.test', 'Прораб');
  denied.headers.set('oai-authenticated-user-access-mode', 'local-membership');
  denied.headers.set('oai-authenticated-user-projects', 'another-project');
  assert.equal(projectIdentity(denied, env, state()), null);
});

test('projects state for management, foreman and client without mutating source', () => {
  const source = state();
  assert.equal(stateForRole(source, { role: 'management' }), source);

  const foreman = stateForRole(source, { role: 'foreman', id: 'foreman' });
  assert.equal(foreman.project.contractValue, 0);
  assert.deepEqual(foreman.financeEntries, []);
  assert.deepEqual(foreman.tasks.map((item: { id: string }) => item.id), ['own-task']);
  assert.equal(foreman.settings.users.some((user: { role: string }) => user.role === 'client'), false);

  const client = stateForRole(source, { role: 'client', id: 'client' });
  assert.deepEqual(client.financeEntries.map((item: { id: string }) => item.id), ['income']);
  assert.deepEqual(client.documents.map((item: { id: string }) => item.id), ['public-doc']);
  assert.deepEqual(client.fieldReports.map((item: { id: string }) => item.id), ['public-report']);
  assert.deepEqual(client.tasks, []);
  assert.equal(source.project.contractValue, 10_000);
});

test('merge preserves fields a foreman and client cannot change', () => {
  const previous = state();
  const foremanIncoming = structuredClone(previous);
  foremanIncoming.project.contractValue = 1;
  foremanIncoming.tasks[0].title = 'Обновлена';
  foremanIncoming.tasks[1].title = 'Взломана';
  const foremanMerged = mergeStateForRole(previous, foremanIncoming, { role: 'foreman', id: 'foreman' });
  assert.equal(foremanMerged.project.contractValue, 10_000);
  assert.equal(foremanMerged.tasks[0].title, 'Обновлена');
  assert.equal(foremanMerged.tasks[1].title, 'Чужая');

  const clientIncoming = structuredClone(previous);
  clientIncoming.project.contractValue = 1;
  clientIncoming.decisions = [{ id: 'client-decision' }];
  const clientMerged = mergeStateForRole(previous, clientIncoming, { role: 'client', id: 'client' });
  assert.equal(clientMerged.project.contractValue, 10_000);
  assert.deepEqual(clientMerged.decisions, [{ id: 'client-decision' }]);
});

test('non-owner management cannot change the security-sensitive user roster', () => {
  const previous = state();
  const incoming = structuredClone(previous);
  incoming.settings.users[0].role = 'management';
  incoming.settings.users[0].email = 'attacker@example.test';
  incoming.settings.users[1].status = 'disabled';

  const restricted = mergeStateForRole(previous, incoming, { role: 'management', isOwner: false });
  assert.deepEqual(restricted.settings.users, previous.settings.users);

  const owner = mergeStateForRole(previous, incoming, { role: 'management', isOwner: true });
  assert.deepEqual(owner.settings.users, incoming.settings.users);

  const localPasswordOwner = mergeStateForRole(
    previous,
    incoming,
    { role: 'management', isOwner: true },
    { serverManagedRoster: true },
  );
  assert.deepEqual(localPasswordOwner.settings.users, previous.settings.users);
});
