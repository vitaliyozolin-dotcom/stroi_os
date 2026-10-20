import assert from 'node:assert/strict';
import test from 'node:test';
import { createProjectCommitment } from '../src/infrastructure/finance-commitment.js';
import { createFinanceUseCases } from './support/finance-project.ts';
import { validateFinanceChanges } from '../src/domain/finance/index.js';
import { createTelegramProjectStore } from '../sites/telegram/project-store.js';
import { buildStages, seedState } from '../src/seed.ts';
import type { AppState } from '../src/entities/index.ts';

const identity = { name: 'Управляющий', role: 'management' as const };
const input = { id: 'new-expense', kind: 'expense' as const, amount: 10.25, date: '2026-10-19', description: '  Поставка бетона  ', counterpartyId: 'vendor-1', budgetLineId: 'line-1', stageId: 'stage-1' };
const context = () => {
  let id = 0;
  return { identity, clock: { now: () => '2026-10-19T12:00:00.000Z' }, ids: { next: (prefix: string) => `${prefix}-${++id}` } };
};
const fixture = (): AppState => {
  const state = structuredClone(seedState);
  state.project.id = 'project-1';
  state.counterparties = [{ id: 'vendor-1', name: 'Поставщик', type: 'supplier', status: 'active' }];
  state.stages = [{ ...buildStages('2026-10-01', '2026-12-01')[0], id: 'stage-1' }];
  state.budgetLines = [{ id: 'line-1', name: 'Фундамент', stageIds: ['stage-1'], plan: 100, forecast: 5 }];
  state.financeEntries = [{ id: 'existing', kind: 'expense', amount: 40, status: 'committed', date: input.date, description: 'Другие работы', counterparty: 'Поставщик', counterpartyId: 'vendor-1', budgetLineId: 'line-1', stageId: 'stage-1' }];
  return state;
};

test('shared creation records only a commitment, derives project-owned labels and updates forecast immutably', () => {
  const state = fixture(), before = structuredClone(state);
  const result = createProjectCommitment(state, input, context());
  assert.ok(result.ok && result.change);
  if (!result.ok || !result.change) return;
  const candidate = result.change.state;
  const entry = candidate.financeEntries[0];
  assert.deepEqual(state, before);
  assert.equal(entry.status, 'committed');
  assert.equal(entry.description, 'Поставка бетона');
  assert.equal(entry.counterparty, 'Поставщик');
  assert.equal(entry.createdBy, identity.name);
  for (const key of ['approvedAt', 'acceptedAmount', 'paidAmount', 'payments']) assert.equal(entry[key as keyof typeof entry], undefined);
  assert.equal(candidate.budgetLines[0].forecast, 50.25);
  assert.equal(result.change.action, 'expense_committed');
  assert.equal(validateFinanceChanges(state, candidate, identity, context().clock.now()), '');
});

test('income planning never changes expense forecast or records a payment', () => {
  const state = fixture();
  const result = createProjectCommitment(state, { ...input, kind: 'income' }, context());
  assert.ok(result.ok && result.change);
  if (!result.ok || !result.change) return;
  const entry = result.change.state.financeEntries[0];
  assert.equal(entry.kind, 'income');
  assert.equal(entry.budgetLineId, undefined);
  assert.equal(entry.stageId, undefined);
  assert.equal(entry.paidAmount, undefined);
  assert.deepEqual(result.change.state.budgetLines, state.budgetLines);
  assert.equal(result.change.action, 'income_planned');
});

test('invalid amounts, dates, descriptions and stale project links do not reach persistence', () => {
  for (const patch of [
    { amount: NaN }, { amount: Infinity }, { amount: 0 }, { amount: -1 }, { amount: 0.001 },
    { date: '2026-02-30' }, { date: '' }, { description: ' ' }, { description: 'x'.repeat(501) },
    { counterpartyId: 'foreign-vendor' }, { budgetLineId: 'foreign-line' }, { stageId: 'foreign-stage' },
  ]) {
    const deps = context();
    const commands = createFinanceUseCases(fixture(), identity, deps.clock, deps.ids, () => assert.fail('invalid write'));
    assert.equal(commands.createCommitment({ ...input, ...patch }).ok, false, JSON.stringify(patch));
  }
  const state = fixture(); state.counterparties[0].status = 'blocked';
  assert.equal(createProjectCommitment(state, input, context()).ok, false);
  state.counterparties[0].status = 'active'; state.stages = [];
  assert.equal(createProjectCommitment(state, input, context()).ok, false);
});

test('foreman and client cannot create financial commitments', () => {
  for (const role of ['foreman', 'client'] as const) {
    assert.equal(createProjectCommitment(fixture(), input, { ...context(), identity: { ...identity, role } }).ok, false);
  }
});

test('stable draft id is idempotent; unrelated ID collisions cannot overwrite an operation', () => {
  const state = fixture();
  const result = createProjectCommitment(state, { ...input, sourceDraftId: 'draft-1' }, context());
  assert.ok(result.ok && result.change);
  if (!result.ok || !result.change) return;
  const next = result.change.state;
  const replay = createProjectCommitment(next, { ...input, id: 'another-id', sourceDraftId: 'draft-1' }, context());
  assert.deepEqual(replay, { ok: true, entryId: input.id, change: null });
  assert.equal(next.financeEntries.length, 2);
  assert.equal(next.budgetLines[0].forecast, 50.25);
  assert.equal(createProjectCommitment(next, input, context()).ok, false);
});

test('web adapter commits the shared use case with action metadata and a generated finance ID', () => {
  const deps = context();
  const calls: { state: AppState; action?: string }[] = [];
  const commands = createFinanceUseCases(fixture(), identity, deps.clock, deps.ids, (state, metadata) => calls.push({ state, action: metadata?.action }));
  const { id, ...withoutId } = input;
  const result = commands.createCommitment(withoutId);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.entryId, 'finance-1');
  assert.equal(calls[0].action, 'expense_committed');
  assert.equal(calls[0].state.financeEntries[0].id, result.entryId);
});

test('Telegram CAS rechecks creation against the latest snapshot and replay does not inflate forecast', async () => {
  let reads = 0, updates = 0, audits = 0;
  let persisted: AppState | undefined;
  const db = { prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ run: async () => {
    if (sql.includes('UPDATE project_state')) {
      updates += 1;
      if (updates === 1) return { changes: 0 };
      persisted = JSON.parse(String(values[0]));
    } else if (sql.includes('INSERT INTO audit_log')) audits += 1;
    return { changes: 1 };
  } }) }) };
  const noop = Symbol('noop');
  const store = createTelegramProjectStore({
    ensureSchema: async () => undefined, changes: (value: { changes: number }) => value.changes, mutationNoop: noop,
    readSnapshot: async () => {
      reads += 1;
      if (persisted) return { state: persisted, revision: 3 };
      const state = fixture();
      if (reads > 1) { state.financeEntries[0].amount = 90; state.counterparties[0].name = 'Обновлённый поставщик'; }
      return { state, revision: reads };
    },
  });
  const mutate = (state: AppState) => {
    const result = createProjectCommitment(state, { ...input, sourceDraftId: 'draft-1' }, context());
    if (!result.ok) throw new Error(result.error);
    return result.change?.state ?? noop;
  };
  await store.mutate({ DB: db }, 'project-1', identity.name, identity.role, 'telegram.expense.create', 'Создан расход', mutate);
  assert.equal(persisted?.budgetLines[0].forecast, 100.25);
  assert.equal(persisted?.financeEntries[0].counterparty, 'Обновлённый поставщик');
  assert.equal(persisted?.financeEntries.filter(entry => entry.sourceDraftId === 'draft-1').length, 1);
  await store.mutate({ DB: db }, 'project-1', identity.name, identity.role, 'telegram.expense.create', 'Повтор', mutate);
  assert.equal(updates, 2);
  assert.equal(audits, 1);
});
