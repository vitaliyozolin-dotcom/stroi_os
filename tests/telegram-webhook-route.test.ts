import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createTelegramWebhookHandler } from '../sites/telegram/webhook.js';

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const request = (body: object, secret = 'webhook-secret') => new Request('https://app.test/api/integrations/telegram/update', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
  body: JSON.stringify(body),
});
const env = { DB: {}, TELEGRAM_BOT_TOKEN: 'bot-token', TELEGRAM_WEBHOOK_SECRET: 'webhook-secret' };

const setup = (overrides: Record<string, unknown> = {}) => {
  const calls: string[] = [];
  const handler = createTelegramWebhookHandler({
    ensureSchema: async () => { calls.push('schema'); },
    rememberTelegramChatCandidates: async () => { calls.push('remember'); },
    flushTelegramOutbox: async () => { calls.push('flush'); },
    claimTelegramUpdate: async () => 'lease-1',
    readTelegramUpdateStatus: async () => '',
    processTelegramUpdate: async () => { calls.push('process'); },
    completeTelegramUpdate: async () => { calls.push('complete'); },
    failTelegramUpdate: async () => { calls.push('fail'); },
    ...overrides,
  });
  const waits: Promise<unknown>[] = [];
  return { handler, calls, context: { waitUntil: (promise: Promise<unknown>) => waits.push(promise) }, waits };
};

test('Telegram webhook rejects a wrong secret before parsing or storage', async () => {
  const { handler, calls, context } = setup();
  const response = await handler(request({ update_id: 1 }, 'wrong'), env, context);
  assert.equal(response.status, 403);
  assert.deepEqual(calls, []);
});

test('Telegram webhook validates update id before claiming a lease', async () => {
  let claims = 0;
  const { handler, context } = setup({ claimTelegramUpdate: async () => { claims += 1; return 'lease'; } });
  const response = await handler(request({ message: {} }), env, context);
  assert.equal(response.status, 422);
  assert.equal(claims, 0);
});

test('Telegram webhook returns duplicate and busy states without processing', async () => {
  const duplicate = setup({ claimTelegramUpdate: async () => null, readTelegramUpdateStatus: async () => 'done' });
  const duplicateResponse = await duplicate.handler(request({ update_id: 2 }), env, duplicate.context);
  assert.deepEqual(await duplicateResponse.json(), { ok: true, duplicate: true });
  assert.equal(duplicate.calls.includes('process'), false);

  const busy = setup({ claimTelegramUpdate: async () => null, readTelegramUpdateStatus: async () => 'processing' });
  assert.equal((await busy.handler(request({ update_id: 3 }), env, busy.context)).status, 503);
});

test('Telegram webhook completes the lease or records a bounded retryable failure', async () => {
  const accepted = setup();
  const response = await accepted.handler(request({ update_id: 4 }), env, accepted.context);
  await Promise.all(accepted.waits);
  assert.equal(response.status, 200);
  assert.deepEqual(accepted.calls, ['schema', 'remember', 'flush', 'process', 'complete']);

  const failed = setup({ processTelegramUpdate: async () => { throw new Error('temporary'); } });
  assert.equal((await failed.handler(request({ update_id: 5 }), env, failed.context)).status, 503);
  assert.equal(failed.calls.includes('fail'), true);
});

test('Telegram webhook HTTP lifecycle is isolated from the Worker', () => {
  const worker = source('sites/worker.js');
  const webhook = source('sites/telegram/webhook.js');
  assert.match(worker, /createTelegramWebhookHandler/);
  assert.doesNotMatch(worker, /webhook_authorization_required/);
  assert.doesNotMatch(worker, /telegram_update_busy/);
  assert.match(webhook, /constantTimeEqual/);
  assert.match(webhook, /MAX_TELEGRAM_UPDATE_BYTES = 1024 \* 1024/);
});
