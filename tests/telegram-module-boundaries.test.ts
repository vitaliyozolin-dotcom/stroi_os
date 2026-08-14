import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('Telegram transport and durable outbox are isolated behind Worker compatibility exports', () => {
  const worker = source('sites/worker.js');
  const transport = source('sites/telegram/transport.js');
  const outbox = source('sites/telegram/outbox.js');

  assert.match(worker, /from '\.\/telegram\/transport\.js'/);
  assert.match(worker, /from '\.\/telegram\/outbox\.js'/);
  assert.match(worker, /export const flushTelegramOutbox = \(env, limit = 10\) => flushTelegramOutboxModule\(env, limit, ensureSchema\)/);
  assert.doesNotMatch(worker, /const queueTelegramMessage/);
  assert.doesNotMatch(worker, /const telegramRuntimeEnv/);
  assert.match(transport, /export const telegramSend/);
  assert.match(outbox, /export const telegramDurableSend/);
  assert.match(outbox, /WHERE id = \? AND status = \? AND updated_at = \? AND attempts = \?/);
});
