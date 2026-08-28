import assert from 'node:assert/strict';
import test from 'node:test';

import { createTelegramWriteDrafts } from '../sites/telegram/write-drafts.js';

const message = { from: { id: 77 }, chat: { id: 88 }, message_id: 99 };
const binding = { project_id: 'project-a', system_user_id: 'user-a' };
const env = { DB: {}, TELEGRAM_BOT_TOKEN: 'test-token' };

const withTelegramMessages = async (action: (messages: string[]) => Promise<void>) => {
  const originalFetch = globalThis.fetch;
  const messages: string[] = [];
  globalThis.fetch = (async (_input, init) => {
    messages.push(JSON.parse(String(init?.body)).text);
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  try {
    await action(messages);
  } finally {
    globalThis.fetch = originalFetch;
  }
};

test('non-management Telegram users cannot create task or expense drafts', async () => {
  let draftCalls = 0;
  const drafts = createTelegramWriteDrafts({
    createDraft: async () => { draftCalls += 1; },
    parseExpense: () => ({ amount: 6000, description: 'бурение' }),
    projectForBinding: async () => ({ snapshot: { state: {} }, user: { id: 'user-a', role: 'foreman' } }),
    renderExpenseDraft: () => { throw new Error('unexpected_render'); },
    renderTaskDraft: () => { throw new Error('unexpected_render'); },
  });

  await withTelegramMessages(async (messages) => {
    await drafts.task(message, binding, 'проверить сваи', env);
    await drafts.expense(message, binding, '6000 бурение', env);
    assert.equal(draftCalls, 0);
    assert.match(messages[0], /роль «Управление»/);
    assert.match(messages[1], /только роль «Управление»/);
  });
});

test('invalid management input is rejected before creating a draft', async () => {
  let draftCalls = 0;
  const drafts = createTelegramWriteDrafts({
    createDraft: async () => { draftCalls += 1; },
    parseExpense: () => null,
    projectForBinding: async () => ({ snapshot: { state: {} }, user: { id: 'owner', role: 'management' } }),
    renderExpenseDraft: () => { throw new Error('unexpected_render'); },
    renderTaskDraft: () => { throw new Error('unexpected_render'); },
  });

  await withTelegramMessages(async (messages) => {
    await drafts.task(message, binding, '', env);
    await drafts.expense(message, binding, 'непонятно', env);
    assert.equal(draftCalls, 0);
    assert.match(messages[0], /Напишите после команды саму задачу/);
    assert.match(messages[1], /Ничего не записано/);
  });
});
