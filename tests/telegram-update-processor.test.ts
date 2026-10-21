import assert from 'node:assert/strict';
import test from 'node:test';
import { createTelegramUpdateProcessor } from '../sites/telegram/update-handler.js';

function setup(overrides = {}) {
  const calls: string[] = [];
  const binding = { project_id: 'project', system_user_id: 'owner' };
  const processor = createTelegramUpdateProcessor({
    readSnapshot: async () => ({ state: { project: { name: 'Project' }, tasks: [{ id: 'task' }] } }),
    bindingsForTelegramUser: async () => [binding],
    bindingForTelegramUser: async () => binding,
    bindingForTelegramProject: async () => binding,
    telegramBotUsername: async () => 'ikioma_bot',
    telegramGroupChatAuthorized: async () => false,
    bindTelegramUser: async () => { calls.push('bind'); },
    createTelegramDraft: async () => ({ id: 'draft' }),
    telegramReadCommands: { tasks: async () => { calls.push('tasks'); } },
    telegramWriteDrafts: { task: async () => { calls.push('task'); } },
    telegramAttachmentDrafts: { payload: message => message, prepare: async () => { calls.push('file'); } },
    ...overrides,
  });
  const message = (text: string, type = 'private') => ({ message_id: 1, from: { id: 7 }, chat: { id: 9, type }, text });
  return { ...processor, calls, message };
}

test('commands dispatch to read/draft scenarios; multiple projects require a selection first', async t => {
  const sent: any[] = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    sent.push(JSON.parse(options.body));
    return Response.json({ ok: true });
  });
  const f = setup();
  await f.processTelegramUpdate({ message: f.message('/tasks') }, {});
  await f.processTelegramUpdate({ message: f.message('/task Inspect') }, {});
  assert.deepEqual(f.calls, ['tasks', 'task']);
  await f.processTelegramUpdate({ message: f.message('/unknown') }, {});
  assert.match(sent.at(-1).text, /не распознана/);

  const multi = setup({ bindingsForTelegramUser: async () => [{ project_id: 'a' }, { project_id: 'b' }] });
  await multi.processTelegramUpdate({ message: multi.message('/task Inspect') }, {});
  assert.deepEqual(multi.calls, []);
  assert.match(sent.at(-1).text, /К какому проекту/);
  assert.equal(sent.at(-1).reply_markup.inline_keyboard.length, 2);
});

test('unapproved group messages and callbacks cannot reach project data or writes', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ok: true }));
  const f = setup({ bindingsForTelegramUser: async () => { throw new Error('unexpected_read'); } });
  await f.processTelegramUpdate({ message: f.message('/task Inspect', 'group') }, {});
  await f.processTelegramUpdate({ callback_query: {
    id: 'callback', from: { id: 7 }, data: 'tc|draft', message: { chat: { id: 9, type: 'group' } },
  } }, {});
  assert.deepEqual(f.calls, []);
});

test('callback draft owner and chat are checked before confirmation', async t => {
  const sent: any[] = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    sent.push(JSON.parse(options.body));
    return Response.json({ ok: true });
  });
  let queried = false;
  const f = setup({ telegramConfirmTask: async () => { throw new Error('unexpected_write'); } });
  const db = { prepare: sql => ({ bind: (id, owner) => ({ run: async () => ({}), first: async () => {
    if (!sql.includes('FROM telegram_drafts')) return { status: 'sent' };
    assert.equal(id, 'draft');
    assert.equal(owner, '7');
    queried = true;
    return { id: 'draft', chat_id: 'another-chat', payload_json: '{}', status: 'draft', expires_at: '2099-01-01T00:00:00Z' };
  } }) }) };
  const result = await f.processTelegramUpdate({ callback_query: {
    id: 'callback', from: { id: 7 }, data: 'tc|draft', message: { chat: { id: 9, type: 'private' } },
  } }, { DB: db });
  assert.equal(queried, true);
  assert.equal(result.error, 'action_denied');
  assert.match(sent.at(-1).text, /недостаточно прав/);
});

test('unexpected persistence errors propagate for webhook retry', async () => {
  const f = setup({ bindingsForTelegramUser: async () => { throw new Error('database_unavailable'); } });
  await assert.rejects(() => f.processTelegramUpdate({ message: f.message('/tasks') }, {}), /database_unavailable/);
});
