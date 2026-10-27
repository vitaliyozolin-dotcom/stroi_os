import assert from 'node:assert/strict';
import test from 'node:test';

import { createTelegramProjectStore } from '../sites/telegram/project-store.js';

const noop = Symbol('noop');

test('Telegram project listing is bounded and excludes service, workspace and corrupt snapshots', async () => {
  let ensured = false;
  const db = {
    prepare: (sql: string) => ({
      all: async () => {
        assert.match(sql, /LIMIT 100/);
        assert.match(sql, /substr\(project_id, 1, 2\) != '__'/);
        return { results: [
          { project_id: 'project-1', state_json: JSON.stringify({ project: { id: 'project-1', status: 'active' } }), revision: 2, updated_at: 'now' },
          { project_id: 'workspace', state_json: JSON.stringify({ project: { id: 'workspace', status: 'workspace' } }), revision: 1, updated_at: 'now' },
          { project_id: 'broken', state_json: '{broken', revision: 1, updated_at: 'now' },
        ] };
      },
    }),
  };
  const store = createTelegramProjectStore({ ensureSchema: async () => { ensured = true; }, readSnapshot: async () => null, changes: () => 0, mutationNoop: noop });
  const snapshots = await store.listSnapshots(db);
  assert.equal(ensured, true);
  assert.deepEqual(snapshots.map((item: { projectId: string }) => item.projectId), ['project-1']);
});

test('Telegram project mutation returns explicit no-op without writing state or audit', async () => {
  let prepared = false;
  const db = { prepare: () => { prepared = true; throw new Error('unexpected_write'); } };
  const snapshot = { state: { project: { id: 'project-1' }, tasks: [] }, revision: 4, updatedAt: 'before' };
  const store = createTelegramProjectStore({ ensureSchema: async () => undefined, readSnapshot: async () => snapshot, changes: () => 0, mutationNoop: noop });
  const result = await store.mutate({ DB: db }, 'project-1', 'Actor', 'foreman', 'noop', 'Без изменений', async () => noop);
  assert.equal(result.changed, false);
  assert.equal(result.revision, 4);
  assert.equal(prepared, false);
});

test('Telegram project mutation retries CAS and audits only the successful revision', async () => {
  let reads = 0;
  let updates = 0;
  let audits = 0;
  const db = {
    prepare: (sql: string) => ({ bind: () => ({
      run: async () => {
        if (sql.includes('UPDATE project_state')) return { changes: ++updates === 2 ? 1 : 0 };
        if (sql.includes('INSERT INTO audit_log')) audits += 1;
        return { changes: 1 };
      },
    }) }),
  };
  const store = createTelegramProjectStore({
    ensureSchema: async () => undefined,
    readSnapshot: async () => ({ state: { project: { id: 'project-1' }, tasks: [] }, revision: ++reads, updatedAt: `read-${reads}` }),
    changes: (result: { changes?: number }) => result.changes ?? 0,
    mutationNoop: noop,
  });
  const result = await store.mutate({ DB: db }, 'project-1', 'Actor', 'management', 'task_create', 'Создана задача', (state: { tasks: unknown[] }) => {
    state.tasks.push({ id: 'task-1', dueDate: '2026-09-10' });
  });
  assert.equal(updates, 2);
  assert.equal(audits, 1);
  assert.equal(result.revision, 3);
  assert.equal(result.changed, true);
});

test('Telegram project mutation fails after three conflicting revisions', async () => {
  const db = { prepare: () => ({ bind: () => ({ run: async () => ({ changes: 0 }) }) }) };
  const store = createTelegramProjectStore({
    ensureSchema: async () => undefined,
    readSnapshot: async () => ({ state: { project: { id: 'project-1' } }, revision: 1, updatedAt: 'now' }),
    changes: () => 0,
    mutationNoop: noop,
  });
  await assert.rejects(
    store.mutate({ DB: db }, 'project-1', 'Actor', 'management', 'update', 'Изменение', () => undefined),
    /revision_conflict/,
  );
});

test('Telegram shares the financial write policy and rejects unauthorized or unapproved payments before SQL', async () => {
  const previous = { project: { id: 'project-1' }, financeEntries: [{ id: 'e', kind: 'expense', status: 'committed', amount: 100, date: '2026-10-19', description: 'Работы', counterparty: 'Подрядчик' }] };
  const store = createTelegramProjectStore({ ensureSchema: async () => undefined, readSnapshot: async () => ({ state: previous, revision: 1 }), changes: () => 1, mutationNoop: noop });
  for (const role of ['management', 'foreman', 'client']) {
    const db = { prepare: () => assert.fail('financial rejection must happen before SQL') };
    await assert.rejects(store.mutate({ DB: db }, 'project-1', 'Actor', role, 'payment', 'Оплата', (state: typeof previous) => {
      Object.assign(state.financeEntries[0], { paidAmount: 10, paidAt: '2026-10-19', paymentDocument: 'Чек' });
    }), /invalid_finance_transition/);
  }
});

test('Telegram CAS retries stamp one payment event from the latest authoritative snapshot', async () => {
  let reads = 0;
  let updates = 0;
  let persisted: { financeEntries: { paidAmount: number; payments: { amount: number; recordedBy: string }[] }[] } | undefined;
  const db = { prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ run: async () => {
    if (sql.includes('UPDATE project_state')) {
      updates += 1;
      if (updates === 1) return { changes: 0 };
      persisted = JSON.parse(String(values[0]));
    }
    return { changes: 1 };
  } }) }) };
  const store = createTelegramProjectStore({
    ensureSchema: async () => undefined, changes: (result: { changes: number }) => result.changes, mutationNoop: noop,
    readSnapshot: async () => {
      reads += 1;
      return { revision: reads, state: { project: { id: 'project-1' }, financeEntries: [{ id: 'e', kind: 'expense', status: 'accepted', amount: 100, acceptedAmount: 100, paidAmount: reads === 1 ? 0 : 20, payments: reads === 1 ? [] : [{ id: 'existing', amount: 20, date: '2026-10-18', document: 'Первый чек', recordedAt: 'before', recordedBy: 'Другой управляющий' }] }] } };
    },
  });
  await store.mutate({ DB: db }, 'project-1', 'Настоящий актор', 'management', 'payment', 'Оплата', (state: { financeEntries: { paidAmount: number }[] }) => {
    Object.assign(state.financeEntries[0], { paidAmount: state.financeEntries[0].paidAmount + 30, paidAt: '2026-10-19', paymentDocument: 'Новый чек', paidBy: 'Подставное имя' });
  });
  assert.equal(updates, 2);
  assert.equal(persisted?.financeEntries[0].paidAmount, 50);
  assert.deepEqual(persisted?.financeEntries[0].payments.map(payment => payment.amount), [20, 30]);
  assert.equal(persisted?.financeEntries[0].payments[1].recordedBy, 'Настоящий актор');
});
