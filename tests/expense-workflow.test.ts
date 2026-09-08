import assert from 'node:assert/strict';
import test from 'node:test';
import { expenseAcceptanceSources, financeActionError, needsExpenseApproval } from '../src/domain/index.ts';
import { validateFinanceChanges, hasFinanceAcceptanceSource } from '../sites/projects/finance.js';
import { mergeStateForRole } from '../sites/access-control.js';
import { createProjectWriteHandler } from '../sites/projects/write.js';
import { seedState } from '../src/seed.ts';
import type { FinanceEntry } from '../src/entities/index.ts';

const now = '2026-09-08T18:00:00.000Z';
const identity = { id: 'owner', role: 'management', isOwner: true, name: 'Владелец' };
const entry = (): FinanceEntry => ({ id: 'expense-1', kind: 'expense', status: 'committed', amount: 100000, date: '2026-09-08', stageId: 'stage-1', budgetLineId: 'budget-1', counterpartyId: 'vendor-1', counterparty: 'Поставщик', description: 'Поставка' });
const state = () => {
  const value = structuredClone(seedState);
  value.financeEntries = [entry()];
  value.stages = [{ ...value.stages[0], id: 'stage-1', name: 'Фундамент', status: 'accepted' }];
  value.procurement = [];
  value.checkpoints = [];
  return value;
};

test('owner approves without recording accepted or paid money; server stamps real actor', () => {
  const previous = state();
  const next = structuredClone(previous);
  Object.assign(next.financeEntries[0], { approvedAt: now, approvedBy: 'Подставное имя' });
  assert.equal(needsExpenseApproval(previous.financeEntries[0]), true);
  assert.equal(validateFinanceChanges(previous, next, identity, now), '');
  assert.equal(next.financeEntries[0].approvedBy, 'Владелец');
  assert.equal(needsExpenseApproval(next.financeEntries[0]), false);
  assert.equal(next.financeEntries[0].status, 'committed');
  assert.equal(next.financeEntries[0].paidAmount, undefined);
});

test('accepted stage authorizes work; explicit procurement cannot use unrelated accepted supply or stage', () => {
  const value = state();
  const expense = value.financeEntries[0];
  assert.deepEqual(expenseAcceptanceSources(value, expense).map((item) => item.id), ['stage:stage-1']);
  assert.equal(hasFinanceAcceptanceSource(value, { ...expense, acceptanceSource: 'stage:stage-1' }), true);
  expense.procurementItemId = 'supply-1';
  value.procurement.push({ id: 'other', stageId: 'stage-1', item: 'Другая поставка', quantity: 1, unit: 'шт', neededBy: '2026-09-08', status: 'accepted', budget: 100000, supplier: 'Поставщик', supplierId: 'vendor-1', owner: 'Прораб' });
  assert.deepEqual(expenseAcceptanceSources(value, expense), []);
  assert.equal(hasFinanceAcceptanceSource(value, { ...expense, acceptanceSource: 'stage:stage-1' }), false);
  assert.equal(hasFinanceAcceptanceSource(value, { ...expense, acceptanceSource: 'procurement:other' }), false);
  value.procurement[0].id = 'supply-1';
  assert.equal(expenseAcceptanceSources(value, expense).length, 1);
  assert.equal(hasFinanceAcceptanceSource(value, { ...expense, acceptanceSource: 'procurement:supply-1' }), true);
  value.procurement[0].supplierId = 'another-vendor';
  assert.equal(expenseAcceptanceSources(value, expense).length, 0);
  assert.equal(hasFinanceAcceptanceSource(value, { ...expense, acceptanceSource: 'procurement:supply-1' }), false);
});

test('partial acceptance and payments obey actual remaining amount; legacy totals remain untouched', () => {
  const previous = state();
  previous.financeEntries[0].approvedAt = now;
  const accepted = structuredClone(previous);
  Object.assign(accepted.financeEntries[0], { status: 'accepted', acceptedAmount: 40000, acceptedAt: '2026-09-08', acceptanceDocument: 'Акт 1', acceptanceSource: 'stage:stage-1' });
  assert.equal(validateFinanceChanges(previous, accepted, identity, now), '');
  const paid = structuredClone(accepted);
  Object.assign(paid.financeEntries[0], { paidAmount: 25000, paidAt: '2026-09-08', paymentDocument: 'ПП 1' });
  assert.equal(validateFinanceChanges(accepted, paid, identity, now), '');
  assert.equal(financeActionError(paid, paid.financeEntries[0], 'pay', 15000, '2026-09-08', 'ПП 2', ''), '');
  assert.ok(financeActionError(paid, paid.financeEntries[0], 'pay', 15001, '2026-09-08', 'ПП 2', ''));
  const overpaid = structuredClone(paid);
  overpaid.financeEntries[0].paidAmount = 40001;
  assert.ok(validateFinanceChanges(paid, overpaid, identity, now));
  const legacy = state();
  legacy.financeEntries[0].status = 'paid';
  assert.equal(validateFinanceChanges(legacy, structuredClone(legacy), identity, now), '');
  assert.equal(needsExpenseApproval(legacy.financeEntries[0]), false);
});

test('submit rechecks approval, source, document and finite amount', () => {
  const previous = state();
  const expense = previous.financeEntries[0];
  assert.ok(financeActionError(previous, expense, 'accept', 100, '2026-09-08', 'Акт', 'stage:stage-1'));
  expense.approvedAt = now;
  for (const amount of [NaN, Infinity, 0, -1, 100001]) assert.ok(financeActionError(previous, expense, 'accept', amount, '2026-09-08', 'Акт', 'stage:stage-1'));
  assert.ok(financeActionError(previous, expense, 'accept', 100, '2026-09-08', '', 'stage:stage-1'));
  previous.stages[0].status = 'rework';
  assert.ok(financeActionError(previous, expense, 'accept', 100, '2026-09-08', 'Акт', 'stage:stage-1'));
  const next = structuredClone(previous);
  Object.assign(next.financeEntries[0], { status: 'accepted', acceptedAmount: 100, acceptedAt: '2026-09-08', acceptanceDocument: 'Акт', acceptanceSource: 'stage:stage-1' });
  assert.ok(validateFinanceChanges(previous, next, identity, now));
});

test('foreman and client cannot alter financial facts through role merging', () => {
  const previous = state();
  for (const role of ['foreman', 'client']) {
    const next = structuredClone(previous);
    Object.assign(next.financeEntries[0], { status: 'paid', paidAmount: 100000 });
    const merged = mergeStateForRole(previous, next, { role, id: 'user' });
    assert.deepEqual(merged.financeEntries, previous.financeEntries);
  }
});

test('HTTP write boundary rejects payment without acceptance before any database mutation', async () => {
  const previous = state();
  previous.project.id = 'project-1';
  const next = structuredClone(previous);
  Object.assign(next.financeEntries[0], { paidAmount: 100, paidAt: '2026-09-08', paymentDocument: 'ПП' });
  const handler = createProjectWriteHandler({ ensureSchema: async () => undefined, readSnapshot: async () => ({ state: previous, revision: 1 }), changes: () => 1, applyAutomations: (_old: unknown, value: unknown) => value, buildNotificationPlan: async () => ({ deliveries: [] }), dispatchNotifications: async () => undefined });
  const response = await handler(new Request('https://app.test/api/state?projectId=project-1', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'oai-authenticated-user-email': 'owner@example.test' }, body: JSON.stringify({ projectId: 'project-1', expectedRevision: 1, state: next }) }), { DB: {}, OWNER_EMAIL: 'owner@example.test' }, { waitUntil() {} });
  assert.equal(response.status, 422);
  assert.equal((await response.json()).error, 'invalid_finance_transition');
});

test('final partial payment keeps kopecks and server prohibits deleting recorded money', () => {
  const previous = state();
  Object.assign(previous.financeEntries[0], { amount: 1000.30, status: 'accepted', acceptedAmount: 1000.30, paidAmount: 1000.10 });
  assert.equal(financeActionError(previous, previous.financeEntries[0], 'pay', 0.20, '2026-09-08', 'Чек', ''), '');
  const next = structuredClone(previous);
  Object.assign(next.financeEntries[0], { status: 'paid', paidAmount: 1000.30, paidAt: '2026-09-08', paymentDocument: 'Чек' });
  assert.equal(validateFinanceChanges(previous, next, identity, now), '');
  next.financeEntries = [];
  assert.ok(validateFinanceChanges(previous, next, identity, now));
});
