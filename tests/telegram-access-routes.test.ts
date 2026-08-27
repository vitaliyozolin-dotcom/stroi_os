import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createTelegramAccessHandlers } from '../sites/integrations/telegram-access.js';

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const state = {
  project: { id: 'project-1' },
  settings: { users: [
    { id: 'manager', name: 'Менеджер', email: 'manager@example.test', role: 'management', status: 'active' },
    { id: 'disabled', name: 'Отключённый', email: 'disabled@example.test', role: 'foreman', status: 'disabled' },
  ] },
  activity: [],
};
const ownerEnv = { OWNER_EMAIL: 'owner@example.test', OWNER_NAME: 'Владелец', TELEGRAM_BOT_TOKEN: 'test-token' };
const request = (body: object, email = 'owner@example.test') => new Request('https://app.test/api/integrations/telegram/link', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(email ? { 'oai-authenticated-user-email': email } : {}) },
  body: JSON.stringify(body),
});

const setup = () => {
  const batches: unknown[][] = [];
  const mutations: unknown[][] = [];
  const DB = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        sql,
        args,
        all: async () => ({ results: [{ telegram_user_id: '42', private_chat_id: '42' }] }),
      }),
    }),
    batch: async (statements: unknown[]) => {
      batches.push(statements);
      return [{ meta: { changes: 1 } }, { meta: { changes: 1 } }, { meta: { changes: 1 } }];
    },
  };
  const handlers = createTelegramAccessHandlers({
    ensureSchema: async () => undefined,
    readSnapshot: async () => ({ state }),
    telegramBotUsername: async () => 'ikioma_bot',
    mutateProjectFromTelegram: async (...args: unknown[]) => { mutations.push(args); },
  });
  return { handlers, env: { ...ownerEnv, DB }, batches, mutations };
};

test('Telegram access rejects missing configuration, malformed targets and non-owners', async () => {
  const { handlers, env } = setup();
  assert.equal((await handlers.link(request({ projectId: 'project-1', userId: 'manager' }), { ...ownerEnv, DB: null })).status, 409);
  assert.equal((await handlers.link(request({ projectId: '../other', userId: 'manager' }), env)).status, 422);
  assert.equal((await handlers.link(request({ projectId: 'project-1', userId: 'manager' }, 'manager@example.test'), env)).status, 403);
  assert.equal((await handlers.link(request({ projectId: 'project-1', userId: 'missing' }), env)).status, 404);
  assert.equal((await handlers.link(request({ projectId: 'project-1', userId: 'disabled' }), env)).status, 404);
});

test('owner receives a one-day Telegram link and only its hash is persisted', async () => {
  const { handlers, env, batches } = setup();
  const response = await handlers.link(request({ projectId: 'project-1', userId: 'manager' }), env);
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.match(body.url, /^https:\/\/t\.me\/ikioma_bot\?start=[a-f0-9]{32}$/);
  assert.equal(new URL(body.url).searchParams.get('start')?.length, 32);
  assert.equal(batches.length, 1);
  const serialized = JSON.stringify(batches[0]);
  assert.doesNotMatch(serialized, new RegExp(new URL(body.url).searchParams.get('start')));
});

test('owner can unlink a disabled user without changing web access', async () => {
  const { handlers, env, batches, mutations } = setup();
  const response = await handlers.unlink(request({ projectId: 'project-1', userId: 'disabled' }), env);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.telegram.status, 'not_connected');
  assert.equal(batches.length, 1);
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0][4], 'telegram.unlink');
});

test('Telegram access implementation is isolated from the Worker', () => {
  const worker = source('sites/worker.js');
  const access = source('sites/integrations/telegram-access.js');
  assert.match(worker, /from '\.\/integrations\/telegram-access\.js'/);
  assert.doesNotMatch(worker, /INSERT INTO telegram_link_codes/);
  assert.doesNotMatch(worker, /const handleTelegramLink = async/);
  assert.match(access, /if \(!identity\?\.isOwner\)/);
  assert.match(access, /unlinkTelegramBinding/);
});
