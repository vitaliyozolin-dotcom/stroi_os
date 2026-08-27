import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createIntegrationHandlers } from '../sites/integrations/routes.js';

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const baseEnv = { OWNER_EMAIL: 'owner@example.test', OWNER_NAME: 'Владелец', TELEGRAM_BOT_TOKEN: 'test-token', DB: {} };
const request = (path: string, email = 'owner@example.test', body?: object) => new Request(`https://app.test${path}`, {
  method: body ? 'POST' : 'GET',
  headers: {
    ...(email ? { 'oai-authenticated-user-email': email } : {}),
    ...(body ? { 'Content-Type': 'application/json' } : {}),
  },
  body: body ? JSON.stringify(body) : undefined,
});

const setup = (overrides: Record<string, unknown> = {}) => {
  const verified: unknown[][] = [];
  const handlers = createIntegrationHandlers({
    integrationStatus: async () => ({ email: false, telegram: false, telegramIssue: 'chat_missing', telegramCandidates: [{ id: '-1', title: 'Штаб', type: 'group' }] }),
    resolveTelegramConnection: async () => ({ chat: { id: '-1' } }),
    telegramSend: async () => new Response('{}', { status: 200 }),
    reviveTelegramOutbox: async () => undefined,
    flushTelegramOutbox: async () => undefined,
    readObservedTelegramChats: async () => [{ id: '-1', title: 'Штаб', type: 'group' }],
    readTelegramBot: async () => ({ id: 1, username: 'ikioma_bot' }),
    discoverTelegramChats: async () => ({ ok: true, candidates: [], bot: null }),
    verifyAndStoreTelegramChat: async (...args: unknown[]) => { verified.push(args); return { ok: true }; },
    ...overrides,
  });
  return { handlers, verified };
};

test('integration status requires authentication and hides setup candidates from non-owners', async () => {
  const { handlers } = setup();
  assert.equal((await handlers.status(request('/api/integrations/status', ''), baseEnv)).status, 401);

  const member = await handlers.status(request('/api/integrations/status', 'manager@example.test'), baseEnv);
  assert.deepEqual((await member.json()).integrations.telegramCandidates, []);

  const owner = await handlers.status(request('/api/integrations/status'), baseEnv);
  assert.equal((await owner.json()).integrations.telegramCandidates[0].id, '-1');
});

test('integration test is owner-only, bounded and rejects unsupported channels', async () => {
  const { handlers } = setup();
  assert.equal((await handlers.test(request('/api/integrations/test', 'manager@example.test', { channel: 'telegram' }), baseEnv)).status, 403);
  const response = await handlers.test(request('/api/integrations/test', 'owner@example.test', { channel: 'sms' }), baseEnv);
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { ok: false, error: 'unsupported_channel' });
});

test('owner selects only an observed Telegram chat and persists verified metadata', async () => {
  const { handlers, verified } = setup();
  const response = await handlers.telegramChatSelect(request('/api/integrations/telegram/select', 'owner@example.test', { chatId: '-1' }), baseEnv);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, chat: { title: 'Штаб', type: 'group' } });
  assert.equal(verified.length, 1);

  const missing = setup({
    readObservedTelegramChats: async () => [],
    discoverTelegramChats: async () => ({ ok: true, candidates: [], bot: null }),
  });
  assert.equal((await missing.handlers.telegramChatSelect(request('/api/integrations/telegram/select', 'owner@example.test', { chatId: '-2' }), baseEnv)).status, 404);
});

test('integration HTTP handlers are isolated from the Worker', () => {
  const worker = source('sites/worker.js');
  const routes = source('sites/integrations/routes.js');
  assert.match(worker, /from '\.\/integrations\/routes\.js'/);
  assert.doesNotMatch(worker, /const handleIntegrationTest = async/);
  assert.doesNotMatch(worker, /api\.resend\.com\/emails/);
  assert.match(routes, /if \(!identity\?\.isOwner\)/);
  assert.match(routes, /telegramCandidates = \[\]/);
});
