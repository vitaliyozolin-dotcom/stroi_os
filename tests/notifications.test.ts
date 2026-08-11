import assert from 'node:assert/strict';
import test from 'node:test';
import { formatNotificationMessage, notificationEvents } from '../sites/notifications.js';

const base = () => ({
  project: { id: 'p1', code: 'H-001', name: 'Контур', status: 'active', targetDate: '2026-12-01' },
  settings: { notifications: { events: {} } },
  tasks: [], stages: [], financeEntries: [], procurement: [], checkpoints: [], leads: [], documents: [], decisions: [], fieldReports: [], counterparties: [],
});

test('emits only significant task changes and a stable overdue key', () => {
  const previous = base();
  const next = base();
  next.tasks = [{ id: 't1', title: 'Проверить сваи', assigneeId: 'u1', assigneeName: 'Илья', dueDate: '2026-08-10', status: 'todo' }];
  const events = notificationEvents(previous, next, { today: '2026-08-11' });
  assert.deepEqual(events.map((item) => item.key), ['task.created.t1', 'task.overdue.t1.2026-08-10']);
});

test('does not turn an ordinary save into Telegram noise', () => {
  assert.deepEqual(notificationEvents(base(), base(), { today: '2026-08-11' }), []);
});

test('covers money, documents, decisions and field reports', () => {
  const previous = base();
  const next = base();
  next.financeEntries = [{ id: 'f1', kind: 'expense', description: 'СИП-панели', amount: 800000, status: 'committed' }];
  next.documents = [{ id: 'd1', name: 'Договор поставки', status: 'current' }];
  next.decisions = [{ id: 'c1', title: 'Цвет фасада', dueDate: '2026-08-15', status: 'waiting' }];
  next.fieldReports = [{ id: 'r1', author: 'Илья', note: 'Сваи смонтированы' }];
  const keys = notificationEvents(previous, next, { today: '2026-08-11' }).map((item) => item.key);
  assert.deepEqual(keys, ['finance.created.f1', 'document.created.d1', 'decision.created.c1', 'report.created.r1']);
});

test('formats a concise message with project, actor and deep links', () => {
  const message = formatNotificationMessage({
    project: { code: 'H-001', name: 'Контур' },
    actor: 'Виталий',
    occurredAt: '2026-08-11T12:30:00.000Z',
    events: [{ text: 'Задача создана', severity: 'info', page: 'tasks', entityId: 't1' }],
    linkFor: () => 'https://example.test/?page=tasks&entity=t1',
  });
  assert.match(message, /ИКИОМА ОС · H-001 · Контур/);
  assert.match(message, /Виталий/);
  assert.match(message, /page=tasks&entity=t1/);
});

