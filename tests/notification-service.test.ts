import assert from 'node:assert/strict';
import test from 'node:test';

import { createNotificationService, deepLink, notificationEvents } from '../sites/integrations/notifications.js';

const settings = (users: unknown[] = []) => ({
  users,
  notifications: {
    channels: { telegram: true, email: false },
    events: { taskAssigned: true, taskOverdue: true, projectActivity: true },
  },
});

const state = (tasks: unknown[] = [], users: unknown[] = []) => ({
  project: { id: 'project-1', code: 'H-001' },
  tasks,
  settings: settings(users),
  activity: [],
});

test('notification events are deterministic, bounded and preserve task recipient identity', () => {
  const previous = state([], []);
  const next = state(Array.from({ length: 10 }, (_, index) => ({
    id: `task-${index}`,
    title: `Задача ${index}`,
    assigneeId: `user-${index}`,
    assigneeName: `Сотрудник ${index}`,
    dueDate: '2026-09-01',
    status: 'todo',
  })), []);
  const events = notificationEvents(previous, next, '2026-08-25');
  assert.equal(events.length, 8);
  assert.equal(events[0].recipientId, 'user-0');
  assert.equal(events[0].entityId, 'task-0');
});

test('notification plan uses stable delivery ids and excludes disabled direct recipients', async () => {
  const users = [
    { id: 'active', role: 'foreman', status: 'active', telegramChatId: 'direct-active' },
    { id: 'disabled', role: 'foreman', status: 'disabled', telegramChatId: 'direct-disabled' },
  ];
  const previous = state([], users);
  const next = state([
    { id: 'active-task', title: 'Активная', assigneeId: 'active', assigneeName: 'Активный', dueDate: '2026-09-01', status: 'todo' },
    { id: 'disabled-task', title: 'Отключённая', assigneeId: 'disabled', assigneeName: 'Отключённый', dueDate: '2026-09-01', status: 'todo' },
  ], users);
  const service = createNotificationService({
    resolveTelegramConnection: async () => ({ chat: { id: 'common-chat' } }),
    sha256: async (value: string) => `hash-${value}`.padEnd(64, '0'),
  });
  const plan = await service.buildPlan(previous, next, { TELEGRAM_BOT_TOKEN: 'configured' }, 'Владелец', 'https://os.example.test', '', 'revision-2');
  assert.deepEqual(plan.deliveries.map((item: { chatId: string }) => item.chatId), ['common-chat', 'direct-active']);
  assert.match(plan.deliveries[0].stableId, /^telegram-notification-/);
  assert.match(plan.deliveries[1].stableId, /^telegram-personal-/);
  assert.equal(plan.message.includes('direct-disabled'), false);
});

test('deep links retain project, page and entity boundaries', () => {
  assert.equal(
    deepLink('https://os.example.test/path', 'project-1', 'tasks', 'task-1'),
    'https://os.example.test/?projectId=project-1&page=tasks&entity=task-1',
  );
});
