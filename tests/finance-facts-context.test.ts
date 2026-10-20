import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { seedState } from '../src/seed.ts';
import { approveFinanceExpense, acceptFinanceExpense, recordFinancePayment, recordFinanceReceipt } from '../src/application/finance-context-facts.ts';
import { financeFactsSnapshot, applyFinanceFactsResult } from '../src/application/finance-facts.ts';
import { approveProjectExpense, acceptProjectExpense } from '../src/application/finance.ts';
const context = () => { let id = 0; return { identity: { name: 'Управляющий', role: 'management' as const }, clock: { now: () => '2026-10-20T12:00:00Z' }, ids: { next: (prefix: string) => `${prefix}-${++id}` } }; };
const fixture = () => {
 const state = structuredClone(seedState);
 state.financeEntries = [{ id: 'expense', kind: 'expense', status: 'committed', amount: 100, date: '2026-10-20', description: 'Работы', counterparty: 'Подрядчик', stageId: 'stage' }];
 state.stages = [{ ...state.stages[0], id: 'stage', status: 'accepted' }];
 return state;
};
const fact = { entryId: 'expense', amount: 50, date: '2026-10-20', document: 'Акт', source: 'stage:stage' };
const approved = () => { const result = approveProjectExpense(fixture(), 'expense', context()); if (!result.ok || !result.change) throw Error('approval'); return result.change.state; };

test('facts run on finance and acceptance references without a project snapshot', () => {
 const state = approved(), snapshot = financeFactsSnapshot(state), before = structuredClone(snapshot);
 assert.equal('documents' in snapshot, false); assert.equal('tasks' in snapshot, false);
 const result = acceptFinanceExpense(snapshot, fact, context());
 assert.ok(result.ok && result.change); if (!result.ok || !result.change) return;
 assert.deepEqual(snapshot, before); assert.equal('state' in result.change, false);
 assert.equal(result.change.patch.financeEntries?.[0].acceptedAmount, 50);
 assert.equal(result.change.appendDocument?.clientVisible, false);
 assert.equal(result.change.appendDocument?.financeEntryId, 'expense');
 const applied = applyFinanceFactsResult(state, result);
 assert.deepEqual(applied, acceptProjectExpense(state, fact, context()));
});

test('applying a fact preserves concurrent documents, tasks and audit', () => {
 const state = approved(), result = acceptFinanceExpense(financeFactsSnapshot(state), fact, context());
 state.documents.unshift({ id: 'parallel-document', name: 'Другой документ', type: 'Прочее', updatedAt: context().clock.now(), clientVisible: false });
 state.activity.unshift({ id: 'parallel-event', timestamp: context().clock.now(), actor: 'Другой', text: 'Задача', tone: 'neutral' });
 const applied = applyFinanceFactsResult(state, result);
 assert.ok(applied.ok && applied.change); if (!applied.ok || !applied.change) return;
 assert.equal(applied.change.state.documents[1], state.documents[0]);
 assert.equal(applied.change.state.activity[1], state.activity[0]);
 assert.equal(applied.change.state.tasks, state.tasks);
});

test('stale finance, changed project, changed acceptance reject without mutation', () => {
 for (const mutate of [
  (state: ReturnType<typeof fixture>) => { state.financeEntries[0].amount = 200; },
  (state: ReturnType<typeof fixture>) => { state.project.id = 'other'; },
  (state: ReturnType<typeof fixture>) => { state.stages[0].status = 'rework'; },
 ]) {
  const state = approved(), result = acceptFinanceExpense(financeFactsSnapshot(state), fact, context());
  mutate(state); const before = structuredClone(state);
  assert.equal(applyFinanceFactsResult(state, result).ok, false); assert.deepEqual(state, before);
 }
});

test('approval no-op, payment restrictions and incoming receipts remain in narrow core', () => {
 const state = approved(), snapshot = financeFactsSnapshot(state);
 assert.deepEqual(approveFinanceExpense(snapshot, 'expense', context()), { ok: true, change: null });
 assert.equal(recordFinancePayment(snapshot, fact, context()).ok, false);
 assert.equal(acceptFinanceExpense(snapshot, fact, { ...context(), identity: { name: 'Клиент', role: 'client' } }).ok, false);
 snapshot.financeEntries = [{ ...snapshot.financeEntries[0], kind: 'income' }];
 const receipt = recordFinanceReceipt(snapshot, fact, context());
 assert.ok(receipt.ok && receipt.change); if (!receipt.ok || !receipt.change) return;
 assert.equal(receipt.change.patch.financeEntries?.[0].paidAmount, 50);
 assert.equal(receipt.change.appendDocument?.category, 'other');
 assert.equal(receipt.change.appendDocument?.clientVisible, false);
});

test('finance fact core has no whole-project, transport or UI dependencies', () => {
 const code = readFileSync(new URL('../src/application/finance-context-facts.ts', import.meta.url), 'utf8');
 assert.doesNotMatch(code, /\bAppState\b|\bStateChange\b|infrastructure|from ['"]react|\bfetch\(/);
});
