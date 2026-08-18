import assert from 'node:assert/strict';
import test from 'node:test';
import { createTelegramConnection } from '../sites/telegram/connection.js';
import { renderFileDraft, renderTaskDraft, telegramHelp } from '../sites/telegram/rendering.js';

const dependencies = {
  ensureSchema: async () => { throw new Error('database_must_not_be_read'); },
  readSnapshot: async () => { throw new Error('database_must_not_be_read'); },
  reviveTelegramOutbox: async () => {},
};

test('environment Telegram chat takes precedence without reading stored configuration', async () => {
  const connection = createTelegramConnection(dependencies);
  const result = await connection.resolveTelegramConnection({
    TELEGRAM_BOT_TOKEN: 'configured',
    TELEGRAM_COMMON_CHAT_ID: '-100123',
  });

  assert.deepEqual(result, {
    tokenConfigured: true,
    chat: { id: '-100123', title: 'Общий Telegram-чат', type: 'group' },
    bot: null,
    candidates: [],
    issue: '',
  });
});

test('group authorization rejects a different chat before database access', async () => {
  const connection = createTelegramConnection(dependencies);
  assert.equal(await connection.telegramGroupChatAuthorized({ TELEGRAM_COMMON_CHAT_ID: '-100123' }, '-100999'), false);
  assert.equal(await connection.telegramGroupChatAuthorized({ TELEGRAM_COMMON_CHAT_ID: '-100123' }, '-100123'), true);
});

test('draft rendering preserves confirmation callbacks and role-specific help', () => {
  const task = renderTaskDraft({
    id: 'draft-1',
    payload: {
      projectName: 'Дом H-001',
      title: 'Проверить фундамент',
      assigneeId: 'user-1',
      dueDate: '2026-08-20',
      dueOffset: 1,
      priority: 'high',
    },
  }, {
    settings: { users: [{ id: 'user-1', name: 'Иван', role: 'foreman', status: 'active' }] },
  });
  assert.match(task.text, /ИКИОМА ОС ничего не сохранит/);
  assert.equal(task.replyMarkup.inline_keyboard.at(-1)?.[0]?.callback_data, 'tc|draft-1');

  const file = renderFileDraft({ id: 'draft-2', kind: 'document', payload: { projectName: 'Дом', fileName: 'акт.pdf', typeLabel: 'Акт' } });
  assert.equal(file.replyMarkup.inline_keyboard[0][0].callback_data, 'fc|draft-2');
  assert.match(telegramHelp('management'), /\/expense сумма описание/);
  assert.doesNotMatch(telegramHelp('foreman'), /\/expense сумма описание/);
});
