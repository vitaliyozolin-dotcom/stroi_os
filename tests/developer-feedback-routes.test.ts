import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createDeveloperFeedbackHandler } from '../sites/feedback/routes.js';

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const env = { OWNER_EMAIL: 'owner@example.test', OWNER_NAME: 'Владелец' };
const projectState = {
  project: { id: 'project-1' },
  settings: { users: [
    { id: 'manager', name: 'Менеджер', email: 'manager@example.test', role: 'management', status: 'active' },
    { id: 'foreman', name: 'Прораб', email: 'foreman@example.test', role: 'foreman', status: 'active' },
  ] },
};

const request = (method: string, email = '', body?: object, projectId = 'project-1') => new Request(
  `https://app.test/api/developer-feedback${method === 'GET' ? `?projectId=${projectId}` : ''}`,
  {
    method,
    headers: {
      ...(email ? { 'oai-authenticated-user-email': email } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify({ projectId, ...body }) : undefined,
  },
);

const setup = () => {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const DB = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        all: async () => ({ results: [{
          id: 'feedback-1', project_id: 'project-1', created_at: '2026-08-25T12:00:00.000Z',
          created_by: 'Менеджер', page: 'tasks', category: 'Ошибка', title: 'Заголовок', details: 'Описание', status: 'new',
        }] }),
        run: async () => { calls.push({ sql, args }); return { changes: 1 }; },
      }),
    }),
  };
  const handler = createDeveloperFeedbackHandler({
    ensureSchema: async () => undefined,
    readSnapshot: async () => ({ state: projectState }),
  });
  return { handler, runtime: { ...env, DB }, calls };
};

test('developer feedback fails closed for missing storage, invalid projects and unauthenticated users', async () => {
  const { handler, runtime } = setup();
  assert.equal((await handler(request('GET'), env)).status, 503);
  assert.equal((await handler(request('GET', '', undefined, '../other'), runtime)).status, 422);
  assert.equal((await handler(request('GET'), runtime)).status, 403);
});

test('developer feedback denies non-management and cross-project local memberships', async () => {
  const { handler, runtime } = setup();
  assert.equal((await handler(request('GET', 'foreman@example.test'), runtime)).status, 403);

  const crossProject = request('GET', 'manager@example.test');
  crossProject.headers.set('oai-authenticated-user-access-mode', 'local-membership');
  crossProject.headers.set('oai-authenticated-user-projects', 'other-project');
  assert.equal((await handler(crossProject, runtime)).status, 403);
});

test('management can read only the bounded project queue', async () => {
  const { handler, runtime } = setup();
  const response = await handler(request('GET', 'manager@example.test'), runtime);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.items[0].projectId, 'project-1');
  assert.equal(body.items[0].title, 'Заголовок');
});

test('management feedback validates required fields and persists bounded values', async () => {
  const { handler, runtime, calls } = setup();
  assert.equal((await handler(request('POST', 'manager@example.test', { page: '', category: 'Ошибка', title: '', details: '' }), runtime)).status, 422);

  const response = await handler(request('POST', 'manager@example.test', {
    page: 'x'.repeat(80), category: 'Ошибка', title: 't'.repeat(200), details: 'd'.repeat(3_200),
  }), runtime);
  assert.equal(response.status, 201);
  assert.equal(calls.length, 1);
  assert.equal(String(calls[0].args[4]).length, 60);
  assert.equal(String(calls[0].args[6]).length, 160);
  assert.equal(String(calls[0].args[7]).length, 3_000);
});

test('developer feedback persistence is isolated from the Worker', () => {
  const worker = source('sites/worker.js');
  const feedback = source('sites/feedback/routes.js');
  assert.match(worker, /from '\.\/feedback\/routes\.js'/);
  assert.doesNotMatch(worker, /INSERT INTO developer_feedback/);
  assert.doesNotMatch(worker, /const handleDeveloperFeedback = async/);
  assert.match(feedback, /FROM developer_feedback WHERE project_id = \? ORDER BY created_at DESC LIMIT 50/);
  assert.match(feedback, /identity\.role !== 'management'/);
});
