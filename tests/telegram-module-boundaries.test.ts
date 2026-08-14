import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('Telegram transport, durable outbox, inbox, drafts and bindings are isolated behind Worker compatibility exports', () => {
  const worker = source('sites/worker.js');
  const transport = source('sites/telegram/transport.js');
  const outbox = source('sites/telegram/outbox.js');
  const inbox = source('sites/telegram/inbox.js');
  const drafts = source('sites/telegram/drafts.js');
  const bindings = source('sites/telegram/bindings.js');

  assert.ok(worker.includes("from './telegram/transport.js'"));
  assert.ok(worker.includes("from './telegram/inbox.js'"));
  assert.ok(worker.includes("from './telegram/outbox.js'"));
  assert.ok(worker.includes("from './telegram/drafts.js'"));
  assert.ok(worker.includes("from './telegram/bindings.js'"));
  assert.match(worker, /export const flushTelegramOutbox = \(env, limit = 10\) => flushTelegramOutboxModule\(env, limit, ensureSchema\)/);
  assert.doesNotMatch(worker, /const queueTelegramMessage/);
  assert.doesNotMatch(worker, /const readTelegramUpdateStatus/);
  assert.doesNotMatch(worker, /const telegramRuntimeEnv/);
  assert.doesNotMatch(worker, /const readTelegramDraft/);
  assert.doesNotMatch(worker, /INSERT INTO telegram_drafts/);
  assert.doesNotMatch(worker, /SELECT project_id\s+FROM telegram_user_chat_projects/);
  assert.match(transport, /export const telegramSend/);
  assert.match(outbox, /export const telegramDurableSend/);
  assert.match(inbox, /export const claimTelegramUpdate/);
  assert.match(inbox, /export const completeTelegramUpdate/);
  assert.match(inbox, /export const failTelegramUpdate/);
  assert.match(drafts, /export const createTelegramDraft/);
  assert.match(drafts, /export const readTelegramDraft/);
  assert.match(drafts, /export const claimTelegramDraft/);
  assert.match(drafts, /export const assertTelegramDraftLease/);
  assert.match(drafts, /WHERE id = \? AND telegram_user_id = \? AND chat_id = \? AND status = 'draft' AND updated_at = \?/);
  assert.match(bindings, /WHERE telegram_user_id = \? AND chat_id = \?/);
  assert.match(bindings, /ON CONFLICT\(telegram_user_id, chat_id\) DO UPDATE SET/);
  assert.match(outbox, /WHERE id = \? AND status = \? AND updated_at = \? AND attempts = \?/);
});
