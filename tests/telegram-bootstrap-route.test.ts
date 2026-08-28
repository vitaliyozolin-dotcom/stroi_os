import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createTelegramBootstrapHandler } from '../sites/integrations/telegram-bootstrap.js';

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const request = (key = '') => new Request('https://app.test/api/integrations/telegram/bootstrap', {
  method: 'POST',
  headers: key ? { 'x-stroios-setup-key': key } : {},
});

const setup = (connection: object) => {
  const telegramCalls: Array<{ method: string; payload?: object }> = [];
  const DB = {
    prepare: (sql: string) => ({
      bind: () => ({
        run: async () => ({ meta: { changes: 0 } }),
        first: async () => sql.includes('SELECT status') ? { status: 'done', received_at: '2026-08-28T00:00:00.000Z' } : null,
      }),
    }),
  };
  const handler = createTelegramBootstrapHandler({
    ensureSchema: async () => undefined,
    changes: (result: { meta?: { changes?: number } }) => Number(result?.meta?.changes ?? 0),
    resolveTelegramConnection: async () => connection,
    telegramRequest: async (_token: string, method: string, payload?: object) => {
      telegramCalls.push({ method, payload });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
    telegramSend: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    parseTelegramBody: async (response: Response) => response.json(),
    telegramOrigin: () => 'https://app.test',
  });
  return { handler, env: { DB, TELEGRAM_SETUP_KEY: 'setup-secret', TELEGRAM_WEBHOOK_URL: 'https://app.test/hook', TELEGRAM_WEBHOOK_SECRET: 'hook-secret', TELEGRAM_BOT_TOKEN: 'bot-token' }, telegramCalls };
};

test('Telegram bootstrap rejects missing and incorrect setup keys before side effects', async () => {
  let connectionCalls = 0;
  const handler = createTelegramBootstrapHandler({
    resolveTelegramConnection: async () => { connectionCalls += 1; return {}; },
  });
  const env = { TELEGRAM_SETUP_KEY: 'setup-secret' };
  assert.equal((await handler(request(), env)).status, 403);
  assert.equal((await handler(request('wrong'), env)).status, 403);
  assert.equal(connectionCalls, 0);
});

test('authorized bootstrap preserves pending updates and reports missing common chat', async () => {
  const { handler, env, telegramCalls } = setup({ tokenConfigured: true, chat: null, candidates: [], issue: 'chat_missing' });
  const response = await handler(request('setup-secret'), env);
  const body = await response.json();

  assert.equal(response.status, 409);
  assert.equal(body.telegramInbound, true);
  assert.equal(body.telegramCommon, false);
  assert.deepEqual(telegramCalls.map((call) => call.method), ['setWebhook', 'setMyCommands']);
  assert.equal((telegramCalls[0].payload as { drop_pending_updates: boolean }).drop_pending_updates, false);
});

test('repeated bootstrap does not resend an already delivered field guide', async () => {
  const { handler, env } = setup({ tokenConfigured: true, chat: { id: '-1', title: 'Штаб' }, candidates: [], issue: '' });
  const response = await handler(request('setup-secret'), env);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.telegramGuideSent, false);
  assert.equal(body.telegramGuideReady, true);
  assert.equal(body.telegramGuideStatus, 'already_sent');
});

test('Telegram bootstrap implementation is isolated from the Worker', () => {
  const worker = source('sites/worker.js');
  const bootstrap = source('sites/integrations/telegram-bootstrap.js');
  assert.match(worker, /createTelegramBootstrapHandler/);
  assert.doesNotMatch(worker, /setMyCommands/);
  assert.doesNotMatch(worker, /system:telegram-field-headquarters-guide-v1/);
  assert.match(bootstrap, /constantTimeEqual/);
  assert.match(bootstrap, /drop_pending_updates: false/);
});
