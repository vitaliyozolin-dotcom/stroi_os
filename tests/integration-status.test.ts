import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createIntegrationStatus } from '../sites/integrations/status.js';

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('integration status projects configured channels and bounded Telegram metrics', async () => {
  const rows = [
    { count: '3' },
    { count: '4', dead_count: '1' },
    { last_error: 'x'.repeat(400) },
  ];
  let index = 0;
  const DB = { prepare: () => ({ first: async () => rows[index++] }) };
  const status = createIntegrationStatus({
    ensureSchema: async () => undefined,
    resolveTelegramConnection: async () => ({
      tokenConfigured: true,
      chat: { id: '-1', title: 'Штаб', type: 'group' },
      bot: { username: 'ikioma_bot' },
      candidates: [],
      issue: '',
    }),
  });

  const result = await status({
    DB,
    RESEND_API_KEY: 'configured',
    EMAIL_FROM: 'sender@example.test',
    TELEGRAM_WEBHOOK_URL: 'https://app.test/hook',
    TELEGRAM_WEBHOOK_SECRET: 'configured',
    CAMERA_VIEW_URL: 'https://camera.test/view',
  });
  assert.equal(result.email, true);
  assert.equal(result.telegram, true);
  assert.equal(result.telegramInbound, true);
  assert.equal(result.telegramBoundUsers, 3);
  assert.equal(result.telegramPendingMessages, 4);
  assert.equal(result.telegramDeadMessages, 1);
  assert.equal(result.telegramLastDeliveryError.length, 300);
  assert.equal('RESEND_API_KEY' in result, false);
  assert.equal('TELEGRAM_WEBHOOK_SECRET' in result, false);
});

test('integration status fails closed to zero metrics when storage is unavailable', async () => {
  const status = createIntegrationStatus({
    ensureSchema: async () => { throw new Error('database_down'); },
    resolveTelegramConnection: async () => ({ tokenConfigured: false, chat: null, candidates: [], issue: 'token_missing' }),
  });
  const result = await status({ DB: {} });
  assert.equal(result.telegram, false);
  assert.equal(result.telegramBoundUsers, 0);
  assert.equal(result.telegramPendingMessages, 0);
  assert.equal(result.telegramLastDeliveryError, '');
});

test('integration status aggregation is isolated from the Worker', () => {
  const worker = source('sites/worker.js');
  const status = source('sites/integrations/status.js');
  assert.match(worker, /createIntegrationStatus/);
  assert.doesNotMatch(worker, /SELECT COUNT\(\*\) AS count FROM telegram_bindings/);
  assert.match(status, /FROM telegram_outbox/);
  assert.match(status, /telegramLastDeliveryError = clean/);
});
