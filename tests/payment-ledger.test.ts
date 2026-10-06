import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFinanceChanges } from '../sites/projects/finance.js';
import { paymentMovements, undatedPayments } from '../src/domain/finance.ts';
import { seedState } from '../src/seed.ts';
import type { FinanceEntry } from '../src/entities/index.ts';

const identity = { id: 'owner', role: 'management', name: 'Owner', isOwner: true };
const now = '2026-10-06T13:00:00Z';
const fixture = () => ({ ...structuredClone(seedState), financeEntries: [{ id: 'income', kind: 'income', status: 'committed', amount: 100, date: '2026-09-01', counterparty: 'Customer', description: 'Synthetic income', acceptedAmount: 0 } as FinanceEntry] });
const pay = (previous: ReturnType<typeof fixture>, total: number, date: string) => {
  const next = structuredClone(previous);
  Object.assign(next.financeEntries[0], { paidAmount: total, paidAt: date, paymentDocument: `Receipt ${total}` });
  assert.equal(validateFinanceChanges(previous, next, identity, now), '');
  return next;
};

test('server records separate partial receipts with immutable dates and documents', () => {
  const first = pay(fixture(), 30, '2026-09-01');
  const second = pay(first, 100, '2026-10-01');
  assert.deepEqual(second.financeEntries[0].payments?.map(p => [p.amount, p.date, p.document]), [[30, '2026-09-01', 'Receipt 30'], [70, '2026-10-01', 'Receipt 100']]);
  assert.deepEqual(second.financeEntries[0].payments?.[0], first.financeEntries[0].payments?.[0]);
  assert.deepEqual(paymentMovements(second.financeEntries[0]).map(p => [p.amount, p.date]), [[30, '2026-09-01'], [70, '2026-10-01']]);
});

test('legacy aggregate remains intact and is not assigned to the new payment date', () => {
  const previous = fixture();
  Object.assign(previous.financeEntries[0], { paidAmount: 40, paidAt: '2026-08-15', paymentDocument: 'Legacy' });
  const next = pay(previous, 100, '2026-10-01');
  assert.deepEqual(paymentMovements(next.financeEntries[0]).map(p => [p.amount, p.date]), [[40, null], [60, '2026-10-01']]);
  assert.equal(previous.financeEntries[0].paidAt, '2026-08-15');
  assert.deepEqual(next.financeEntries[0].legacyPayment, { amount: 40, lastRecordedDate: '2026-08-15', document: 'Legacy' });
  assert.deepEqual(undatedPayments(next), { expense: 0, income: 40 });
});

test('cannot delete, rewrite or forge server payment events', () => {
  const previous = pay(fixture(), 30, '2026-09-01');
  for (const change of ['delete', 'edit', 'forge']) {
    const next = structuredClone(previous);
    if (change === 'delete') delete next.financeEntries[0].payments;
    if (change === 'edit') next.financeEntries[0].payments![0].date = '2026-09-02';
    if (change === 'forge') next.financeEntries[0].payments!.push({ ...next.financeEntries[0].payments![0], id: 'forged' });
    assert.match(validateFinanceChanges(previous, next, identity, now), /История платежей/);
  }
});

test('unrelated saves do not append duplicate payments; stale client cannot drop ledger', () => {
  const previous = pay(fixture(), 30, '2026-09-01');
  const next = structuredClone(previous);
  next.financeEntries[0].description = 'New description';
  assert.equal(validateFinanceChanges(previous, next, identity, now), '');
  assert.equal(next.financeEntries[0].payments?.length, 1);
  const stale = fixture();
  Object.assign(stale.financeEntries[0], { paidAmount: 60, paidAt: '2026-10-01', paymentDocument: 'Stale' });
  assert.match(validateFinanceChanges(previous, stale, identity, now), /История платежей/);
});

test('role and overpayment validation still protects new payment events', () => {
  const previous = fixture(), next = structuredClone(previous);
  Object.assign(next.financeEntries[0], { paidAmount: 101, paidAt: '2026-10-01', paymentDocument: 'Receipt' });
  assert.match(validateFinanceChanges(previous, next, identity, now), /Суммы/);
  next.financeEntries[0].paidAmount = 20;
  assert.match(validateFinanceChanges(previous, next, { ...identity, role: 'foreman' }, now), /Управление/);
  assert.equal(next.financeEntries[0].payments, undefined);
});
