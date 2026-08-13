import assert from 'node:assert/strict';
import test from 'node:test';
import { selectTelegramGroup, telegramGroupCandidates } from '../server/repair-telegram.js';
import { ensureTelegramWebhook } from '../server/telegram-webhook.js';

const groupUpdate = (updateId: number, chatId: number, title: string, text: string) => ({
  update_id: updateId,
  message: {
    text,
    chat: { id: chatId, title, type: 'group' },
  },
});

test('telegram repair ignores private chats and keeps the latest group update', () => {
  const updates = [
    { update_id: 1, message: { text: '/start', chat: { id: 10, type: 'private' } } },
    groupUpdate(2, -100, 'ИкиОМА', 'старое сообщение'),
    groupUpdate(3, -100, 'ИкиОМА', '/start@ikioma_bot'),
  ];

  const candidates = telegramGroupCandidates(updates);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].id, '-100');
  assert.equal(candidates[0].updateId, 3);
});

test('telegram repair selects the group that sent the addressed start command', () => {
  const selected = selectTelegramGroup([
    groupUpdate(10, -1001, 'Другой чат', 'обычное сообщение'),
    groupUpdate(11, -1002, 'ИкиОМА', '/start@ikioma_bot'),
  ]);

  assert.equal(selected?.id, '-1002');
  assert.equal(selected?.title, 'ИкиОМА');
});

test('telegram repair refuses an ambiguous group choice', () => {
  const selected = selectTelegramGroup([
    groupUpdate(20, -2001, 'Проект 1', 'сообщение'),
    groupUpdate(21, -2002, 'Проект 2', 'сообщение'),
  ]);

  assert.equal(selected, null);
});

test('startup restores a missing webhook without deleting pending updates', async () => {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  const responses = [
    { ok: true, result: { url: '', pending_update_count: 2, last_error_message: 'Wrong response from the webhook: 404' } },
    { ok: true, result: true },
    { ok: true, result: { url: 'https://os.example/api/integrations/telegram/update', pending_update_count: 2 } },
  ];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split('/').at(-1) ?? '';
    calls.push({ method, payload: JSON.parse(String(init?.body ?? '{}')) });
    return new Response(JSON.stringify(responses.shift()), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const result = await ensureTelegramWebhook({
    TELEGRAM_BOT_TOKEN: 'token',
    TELEGRAM_WEBHOOK_URL: 'https://os.example/api/integrations/telegram/update',
    TELEGRAM_WEBHOOK_SECRET: 'secret',
    TELEGRAM_API_BASE: 'http://relay:18787',
  }, { fetchImpl });

  assert.equal(result.ready, true);
  assert.equal(result.changed, true);
  assert.deepEqual(calls.map((call) => call.method), ['getWebhookInfo', 'setWebhook', 'getWebhookInfo']);
  assert.equal(calls.some((call) => call.method === 'deleteWebhook'), false);
  assert.equal(calls[1].payload.drop_pending_updates, false);
});

test('startup leaves a healthy webhook unchanged', async () => {
  const calls: string[] = [];
  const fetchImpl = async (url: string | URL | Request) => {
    calls.push(String(url).split('/').at(-1) ?? '');
    return new Response(JSON.stringify({
      ok: true,
      result: { url: 'https://os.example/api/integrations/telegram/update', pending_update_count: 0 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const result = await ensureTelegramWebhook({
    TELEGRAM_BOT_TOKEN: 'token',
    TELEGRAM_WEBHOOK_URL: 'https://os.example/api/integrations/telegram/update',
    TELEGRAM_WEBHOOK_SECRET: 'secret',
  }, { fetchImpl });

  assert.equal(result.changed, false);
  assert.deepEqual(calls, ['getWebhookInfo']);
});

test('startup does not churn a correctly configured webhook after a transient delivery error', async () => {
  const calls: string[] = [];
  const fetchImpl = async (url: string | URL | Request) => {
    calls.push(String(url).split('/').at(-1) ?? '');
    return new Response(JSON.stringify({
      ok: true,
      result: {
        url: 'https://os.example/api/integrations/telegram/update',
        pending_update_count: 1,
        last_error_message: 'Connection timed out',
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const result = await ensureTelegramWebhook({
    TELEGRAM_BOT_TOKEN: 'token',
    TELEGRAM_WEBHOOK_URL: 'https://os.example/api/integrations/telegram/update',
    TELEGRAM_WEBHOOK_SECRET: 'secret',
  }, { fetchImpl });

  assert.equal(result.changed, false);
  assert.deepEqual(calls, ['getWebhookInfo']);
});
