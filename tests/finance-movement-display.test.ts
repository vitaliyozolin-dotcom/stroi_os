import test from 'node:test';
import assert from 'node:assert/strict';
import { financeMovementDisplay, financeMovementRows } from '../src/presentation/finance-view.ts';
import { seedState } from '../src/seed.ts';
import { emptyFinanceLedger } from '../src/domain/finance-ledger.js';

test('supplier and customer refunds display the actual cash direction with one sign', () => {
  assert.deepEqual(financeMovementDisplay({ entry: { kind: 'expense' }, amount: -30 }), { cashKind: 'income', amount: 30, sign: '+', label: 'Возврат от поставщика' });
  assert.deepEqual(financeMovementDisplay({ entry: { kind: 'income' }, amount: -30 }), { cashKind: 'expense', amount: 30, sign: '−', label: 'Возврат заказчику' });
  assert.equal(financeMovementDisplay({ entry: { kind: 'expense' }, amount: 30 }).sign, '−');
  assert.equal(financeMovementDisplay({ entry: { kind: 'income' }, amount: 30 }).sign, '+');
});

test('journal-only updates produce new movement rows while a full refund preserves both historical facts', () => {
  const state = { ...structuredClone(seedState), financeEntries: [{ id: 'expense', kind: 'expense' as const, status: 'committed' as const, paidAmount: 0, amount: 100, date: '2026-10-01', description: 'Expense', counterparty: 'Vendor' }], financeLedger: emptyFinanceLedger() };
  assert.equal(financeMovementRows(state).length, 0);
  const next = { ...state, financeLedger: emptyFinanceLedger() };
  next.financeLedger.operations = [
    { id: 'payment', kind: 'payment', amountCents: 10000, date: '2026-10-20', accountId: 'bank', counterparty: 'Vendor', description: 'Payment', source: 'Evidence', confirmation: 'confirmed', allocations: [{ entryId: 'expense', amountCents: 10000 }] },
    { id: 'refund', kind: 'supplier_refund', amountCents: 10000, date: '2026-10-21', accountId: 'bank', counterparty: 'Vendor', description: 'Refund', source: 'Evidence', confirmation: 'confirmed', allocations: [{ entryId: 'expense', amountCents: 10000 }], refundOfOperationId: 'payment' },
  ];
  assert.equal(next.financeEntries, state.financeEntries);
  const rows = financeMovementRows(next);
  assert.deepEqual(rows.map(row => row.amount), [-100, 100]);
  assert.equal(rows.reduce((sum, row) => sum + row.amount, 0), 0);
  assert.ok(rows.some(row => row.amount !== 0), 'zero net settlement is not empty history');
});
