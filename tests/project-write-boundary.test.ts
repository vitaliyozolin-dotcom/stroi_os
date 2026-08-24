import assert from 'node:assert/strict';
import test from 'node:test';

import { createProjectWriteHandler } from '../sites/projects/write.js';

const ownerHeaders = {
  'content-type': 'application/json',
  'oai-authenticated-user-email': 'owner@example.test',
};

const projectState = (id = 'project-1') => ({
  version: 1,
  project: { id },
  settings: { users: [] },
});

const handlerFor = (overrides: Record<string, unknown> = {}) => createProjectWriteHandler({
  ensureSchema: async () => undefined,
  readSnapshot: async () => null,
  changes: (result: { meta?: { changes?: number } }) => result?.meta?.changes ?? 0,
  applyAutomations: (_previous: unknown, state: unknown) => state,
  buildNotificationPlan: async () => ({ deliveries: [] }),
  dispatchNotifications: async () => undefined,
  ...overrides,
});

test('project write denies an unauthenticated caller before parsing its body', async () => {
  const request = new Request('https://example.test/api/state?projectId=project-1', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: '{invalid-json',
  });
  const response = await handlerFor({ readSnapshot: async () => ({ state: projectState() }) })(request, { DB: {} }, { waitUntil() {} });
  assert.equal(response.status, 403);
});

test('only the owner can create a project at revision zero', async () => {
  const db = {
    prepare: () => ({ bind: () => ({ run: async () => ({}) }) }),
    batch: async () => [{ meta: { changes: 1 } }],
  };
  const state = projectState();
  const request = new Request('https://example.test/api/state?projectId=project-1', {
    method: 'PUT',
    headers: ownerHeaders,
    body: JSON.stringify({ projectId: 'project-1', expectedRevision: 0, state, action: 'project_create', summary: 'Создан проект' }),
  });
  let backgroundTask: Promise<unknown> | undefined;
  const response = await handlerFor()(request, { DB: db, OWNER_EMAIL: 'owner@example.test', OWNER_NAME: 'Владелец' }, {
    waitUntil(task: Promise<unknown>) { backgroundTask = task; },
  });
  const body = await response.json() as { ok: boolean; snapshot: { revision: number; state: unknown } };
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.snapshot.revision, 1);
  assert.deepEqual(body.snapshot.state, state);
  await backgroundTask;
});

test('project write rejects mismatched payload and URL project identifiers', async () => {
  const request = new Request('https://example.test/api/state?projectId=project-1', {
    method: 'PUT',
    headers: ownerHeaders,
    body: JSON.stringify({ projectId: 'project-2', expectedRevision: 0, state: projectState('project-2') }),
  });
  const response = await handlerFor()(request, { DB: {}, OWNER_EMAIL: 'owner@example.test' }, { waitUntil() {} });
  assert.equal(response.status, 422);
  assert.equal((await response.json() as { error: string }).error, 'invalid_state');
});
