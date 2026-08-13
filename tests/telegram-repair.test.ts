import assert from 'node:assert/strict';
import test from 'node:test';
import { selectTelegramGroup, telegramGroupCandidates } from '../server/repair-telegram.js';

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
