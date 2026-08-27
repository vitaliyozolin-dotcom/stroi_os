import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createAccessUsersHandler } from '../sites/access/users.js';

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const state = {
  project: { id: 'project-1' },
  settings: { users: [
    { id: 'manager', name: 'Менеджер', email: 'manager@example.test', role: 'management', status: 'active' },
    { id: 'foreman', name: 'Прораб', email: 'foreman@example.test', role: 'foreman', status: 'active' },
  ] },
};
const env = { OWNER_EMAIL: 'owner@example.test', OWNER_NAME: 'Владелец' };
const request = (email = 'owner@example.test', projectId = 'project-1') => new Request(
  `https://app.test/api/access/users?projectId=${encodeURIComponent(projectId)}`,
  { headers: email ? { 'oai-authenticated-user-email': email } : {} },
);

const setup = (rows: object[] = []) => {
  let schemaCalls = 0;
  let queryProjectId = '';
  const DB = {
    prepare: () => ({
      bind: (projectId: string) => ({
        all: async () => { queryProjectId = projectId; return { results: rows }; },
      }),
    }),
  };
  const handler = createAccessUsersHandler({
    ensureSchema: async () => { schemaCalls += 1; },
    readSnapshot: async () => ({ state }),
  });
  return { handler, runtime: { ...env, DB }, evidence: () => ({ schemaCalls, queryProjectId }) };
};

test('access users validates project identifiers before storage access', async () => {
  const { handler, runtime, evidence } = setup();
  const response = await handler(request('owner@example.test', '../other'), runtime);
  assert.equal(response.status, 422);
  assert.equal(evidence().schemaCalls, 0);
});

test('access users denies unauthenticated and non-owner identities', async () => {
  const { handler, runtime } = setup();
  assert.equal((await handler(request(''), runtime)).status, 403);
  assert.equal((await handler(request('manager@example.test'), runtime)).status, 403);
});

test('owner receives project-scoped Sites access and latest Telegram projection', async () => {
  const { handler, runtime, evidence } = setup([
    { system_user_id: 'foreman', bound_at: '2026-08-25T12:00:00.000Z', username: 'new', updated_at: '2026-08-25T12:00:00.000Z' },
    { system_user_id: 'foreman', bound_at: '2026-08-24T12:00:00.000Z', username: 'old', updated_at: '2026-08-24T12:00:00.000Z' },
  ]);
  const response = await handler(request(), runtime);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.authMode, 'sites_sso');
  assert.deepEqual(body.users, [
    { userId: 'manager', web: { status: 'not_issued' }, telegram: { status: 'not_connected' } },
    { userId: 'foreman', web: { status: 'not_issued' }, telegram: { status: 'connected', boundAt: '2026-08-25T12:00:00.000Z', username: 'new' } },
  ]);
  assert.equal(evidence().queryProjectId, 'project-1');
});

test('access users fails closed when storage fails', async () => {
  const handler = createAccessUsersHandler({
    ensureSchema: async () => { throw new Error('database_down'); },
    readSnapshot: async () => null,
  });
  const response = await handler(request(), { ...env, DB: {} });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { ok: false, error: 'access_storage_error' });
});

test('access users implementation is isolated from the Worker', () => {
  const worker = source('sites/worker.js');
  const users = source('sites/access/users.js');
  assert.match(worker, /from '\.\/access\/users\.js'/);
  assert.doesNotMatch(worker, /const handleAccessUsers = async/);
  assert.doesNotMatch(worker, /FROM telegram_bindings WHERE project_id/);
  assert.match(users, /if \(!identity\?\.isOwner\)/);
  assert.match(users, /FROM telegram_bindings WHERE project_id = \? ORDER BY updated_at DESC/);
});
