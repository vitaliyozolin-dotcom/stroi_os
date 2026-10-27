import assert from 'node:assert/strict';
import test from 'node:test';
import { createFinanceUseCases, approveProjectExpense, acceptProjectExpense, recordProjectPayment, recordProjectReceipt, type FinanceCommandResult } from './support/finance-project.ts';
import { validateFinanceChanges } from '../src/domain/finance/index.js';
import { seedState } from '../src/seed.ts';
import type { AppState, FinanceEntry } from '../src/entities/index.ts';

const now = '2026-10-19T10:00:00.000Z';
const date = '2026-10-19';
const identity = { name: 'Управляющий', role: 'management' as const };
const context = () => {
  let next = 0;
  return { identity, clock: { now: () => now }, ids: { next: (prefix: string) => `${prefix}-${++next}` } };
};
const fixture = () => {
  const state = structuredClone(seedState);
  state.project.id = 'house-1';
  state.stages = [{ ...state.stages[0], id: 'stage-1', name: 'Фундамент', status: 'accepted' }];
  state.financeEntries = [{ id: 'expense-1', kind: 'expense', status: 'committed', amount: 1000.30, date, description: 'Работы', counterparty: 'Подрядчик', counterpartyId: 'vendor-1', stageId: 'stage-1' }];
  state.documents = [];
  state.activity = [];
  return state;
};
const changedState = (result: FinanceCommandResult) => {
  assert.equal(result.ok, true);
  if (!result.ok || !result.change) throw new Error('Expected a state change');
  return result.change.state;
};
const fact = (amount: number) => ({ entryId: 'expense-1', amount, date, document: '  Чек №1  ', source: 'stage:stage-1' });

test('approval is immutable, auditable and does not create accepted or paid money', () => {
  const state = fixture();
  const before = structuredClone(state);
  const result = approveProjectExpense(state, 'expense-1', context());
  const candidate = changedState(result);
  assert.deepEqual(state, before);
  assert.equal(candidate.financeEntries[0].approvedBy, identity.name);
  assert.equal(candidate.financeEntries[0].approvedAt, now);
  assert.equal(candidate.financeEntries[0].status, 'committed');
  assert.equal(candidate.financeEntries[0].acceptedAmount, undefined);
  assert.equal(candidate.financeEntries[0].paidAmount, undefined);
  assert.deepEqual(candidate.documents, []);
  assert.equal(result.ok && result.change?.action, 'expense_approved');
  assert.equal(candidate.activity[0].actor, identity.name);
  assert.equal(validateFinanceChanges(state, candidate, identity, now), '');
});

test('repeated approval is a no-op and never duplicates audit or changes the approver', () => {
  const state = changedState(approveProjectExpense(fixture(), 'expense-1', context()));
  const calls: AppState[] = [];
  const deps = context();
  const commands = createFinanceUseCases(state, { ...identity, name: 'Другой управляющий' }, deps.clock, deps.ids, next => calls.push(next));
  assert.deepEqual(commands.approveExpense('expense-1'), { ok: true, change: null });
  assert.deepEqual(calls, []);
  assert.equal(state.financeEntries[0].approvedBy, identity.name);
});

test('partial acceptance and independent payments pass the authoritative validator without rewriting the client ledger', () => {
  const initial = fixture();
  const approved = changedState(approveProjectExpense(initial, 'expense-1', context()));
  const accepted = changedState(acceptProjectExpense(approved, fact(1000.30), context()));
  assert.equal(validateFinanceChanges(approved, accepted, identity, now), '');
  const first = changedState(recordProjectPayment(accepted, fact(1000.10), context()));
  assert.deepEqual(first.financeEntries[0].payments, accepted.financeEntries[0].payments);
  assert.equal(validateFinanceChanges(accepted, first, identity, now), '');
  const final = changedState(recordProjectPayment(first, { ...fact(0.20), document: 'Чек №2' }, context()));
  assert.equal(validateFinanceChanges(first, final, identity, now), '');
  assert.equal(final.financeEntries[0].status, 'paid');
  assert.equal(final.financeEntries[0].paidAmount, 1000.30);
  assert.deepEqual(final.financeEntries[0].payments?.map(payment => payment.amount), [1000.10, 0.20]);
  assert.equal(final.documents[0].financeEntryId, 'expense-1');
  assert.equal(final.documents[0].clientVisible, false);
  assert.equal(final.documents[0].counterpartyId, 'vendor-1');
  assert.equal(final.documents[0].documentDate, date);
  assert.equal(final.activity[0].timestamp, now);
});

test('commands recheck current approval, acceptance sources and the remaining amount', () => {
  const state = fixture();
  assert.equal(acceptProjectExpense(state, fact(1), context()).ok, false);
  assert.equal(recordProjectPayment(state, fact(1), context()).ok, false);
  const approved = changedState(approveProjectExpense(state, 'expense-1', context()));
  approved.stages[0].status = 'rework';
  assert.equal(acceptProjectExpense(approved, fact(1), context()).ok, false);
  approved.stages[0].status = 'accepted';
  const accepted = changedState(acceptProjectExpense(approved, fact(20), context()));
  for (const amount of [NaN, Infinity, 0, -1, 0.001, 1000.31]) {
    assert.equal(recordProjectPayment(accepted, fact(amount), context()).ok, false, String(amount));
  }
  assert.equal(recordProjectPayment(accepted, { ...fact(1), date: '2026-02-30' }, context()).ok, false);
  assert.equal(recordProjectPayment(accepted, { ...fact(1), document: ' ' }, context()).ok, false);
});

test('forbidden roles, wrong operation kinds and missing IDs produce no persistence call', () => {
  const state = fixture();
  for (const role of ['foreman', 'client'] as const) {
    const deps = context();
    const commands = createFinanceUseCases(state, { ...identity, role }, deps.clock, deps.ids, () => assert.fail('forbidden persistence'));
    assert.equal(commands.approveExpense('expense-1').ok, false);
    assert.equal(commands.acceptExpense(fact(1)).ok, false);
    assert.equal(commands.recordPayment(fact(1)).ok, false);
    assert.equal(commands.recordReceipt(fact(1)).ok, false);
  }
  assert.equal(approveProjectExpense(state, 'other-project-entry', context()).ok, false);
  assert.equal(recordProjectPayment(state, { ...fact(1), entryId: 'missing' }, context()).ok, false);
  assert.equal(recordProjectReceipt(state, fact(1), context()).ok, false);
  state.financeEntries[0].kind = 'income';
  assert.equal(approveProjectExpense(state, 'expense-1', context()).ok, false);
  assert.equal(recordProjectPayment(state, fact(1), context()).ok, false);
});

test('receipt remains separate from work acceptance and is persisted with precise audit metadata', () => {
  const state = fixture(); state.financeEntries[0].kind = 'income';
  const deps = context();
  const calls: { state: AppState; metadata: unknown }[] = [];
  const commands = createFinanceUseCases(state, identity, deps.clock, deps.ids, (next, metadata) => calls.push({ state: next, metadata }));
  assert.equal(commands.recordReceipt(fact(100)).ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].state.financeEntries[0].acceptedAmount, 0);
  assert.equal(calls[0].state.financeEntries[0].paidAmount, 100);
  assert.equal((calls[0].metadata as { action: string }).action, 'income_received');
  assert.equal(validateFinanceChanges(state, calls[0].state, identity, now), '');
});

test('historical money remains immutable and legacy totals are not given invented payment dates', () => {
  const state = fixture();
  Object.assign(state.financeEntries[0], { status: 'paid', acceptedAmount: 0, paidAmount: 1000.30, historicalPayment: {} } as Partial<FinanceEntry>);
  const before = structuredClone(state);
  assert.equal(acceptProjectExpense(state, fact(1), context()).ok, false);
  assert.equal(recordProjectPayment(state, fact(1), context()).ok, false);
  assert.deepEqual(state, before);
  delete state.financeEntries[0].historicalPayment;
  Object.assign(state.financeEntries[0], { status: 'accepted', acceptedAmount: 1000.30, paidAmount: 1000.10 });
  const candidate = changedState(recordProjectPayment(state, fact(0.20), context()));
  assert.equal(validateFinanceChanges(state, candidate, identity, now), '');
  assert.equal(candidate.financeEntries[0].legacyPayment?.amount, 1000.10);
  assert.equal(candidate.financeEntries[0].legacyPayment?.lastRecordedDate, undefined);
  assert.equal(candidate.financeEntries[0].payments?.[0].amount, 0.20);
});
