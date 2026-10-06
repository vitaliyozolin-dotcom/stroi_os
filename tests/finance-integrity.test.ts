import test from 'node:test';
import assert from 'node:assert/strict';
import { seedState } from '../src/seed.ts';
import { financeTotals, lineForecast, lineTotals, unallocatedExpenseTotals, unallocatedExpenses, paymentDate, undatedPayments } from '../src/domain/finance.ts';
import type { FinanceEntry } from '../src/entities/index.ts';

const entry = (overrides: Partial<FinanceEntry> = {}): FinanceEntry => ({ id: 'e', kind: 'expense', status: 'paid', amount: 12000, date: '2026-10-05', counterparty: 'Test', description: 'Synthetic expense', ...overrides });
const fixture = () => ({ ...structuredClone(seedState), budgetLines: [{ id: 'b', name: 'Budget', plan: 0, forecast: 0, stageIds: [] }], financeEntries: [entry({ budgetLineId: 'b' })] });

test('forecast floor covers paid expenses without rewriting original budget or facts', () => {
  const state = fixture(), before = structuredClone(state);
  assert.equal(financeTotals(state).forecast, 12000);
  assert.equal(financeTotals(state).storedForecast, 0);
  assert.equal(lineForecast(state, state.budgetLines[0]), 12000);
  assert.equal(financeTotals(state).plan, 0);
  assert.deepEqual(state, before);
});

test('forecast keeps larger saved remainder and covers outstanding commitments', () => {
  const state = fixture();
  state.budgetLines[0].forecast = 20000;
  assert.equal(financeTotals(state).forecast, 20000);
  state.financeEntries[0] = entry({ budgetLineId: 'b', status: 'committed', amount: 30000, paidAmount: 5000 });
  assert.equal(financeTotals(state).forecast, 30000);
});

test('missing and orphan budget links reconcile with totals without counting income as cost', () => {
  const state = fixture();
  state.financeEntries.push(entry({ id: 'unlinked', amount: 10 }), entry({ id: 'orphan', budgetLineId: 'gone', amount: 20 }), entry({ id: 'income', kind: 'income', amount: 1000 }));
  const unallocated = unallocatedExpenseTotals(state);
  assert.equal(unallocated.paid, 30);
  assert.equal(unallocatedExpenses(state).length, 2);
  assert.equal(lineTotals(state, state.budgetLines[0]).paid + unallocated.paid, financeTotals(state).paid);
  assert.equal(lineForecast(state, state.budgetLines[0]) + unallocated.forecast, financeTotals(state).forecast);
  assert.equal(financeTotals(state).received, 1000);
});

test('empty budget still includes unallocated commitments in forecast', () => {
  const state = fixture();
  state.budgetLines = [];
  assert.equal(financeTotals(state).forecast, 12000);
  state.financeEntries = [];
  assert.equal(financeTotals(state).forecast, 0);
});

test('unknown payment date does not inherit invoice/import date', () => {
  assert.equal(paymentDate(entry()), null);
  assert.equal(paymentDate(entry({ paidAt: '2026-09-15' })), '2026-09-15');
  assert.equal(paymentDate(entry({ paidAt: '2026-02-30' })), null);
  assert.equal(paymentDate(entry({ paidAt: 'garbage' })), null);
});

test('undated payments include partial payments and keep income separate', () => {
  const state = fixture();
  state.financeEntries = [entry({ status: 'accepted', paidAmount: 50 }), entry({ id: 'income', kind: 'income', amount: 20 }), entry({ id: 'dated', paidAt: '2026-09-15' }), entry({ id: 'unpaid', status: 'committed' })];
  assert.deepEqual(undatedPayments(state), { expense: 50, income: 20 });
});

test('calculated forecast and unallocated amounts are rounded to cents', () => {
  const state = fixture();
  state.financeEntries = [entry({ amount: 0.1 }), entry({ id: 'b', amount: 0.2 })];
  assert.equal(unallocatedExpenseTotals(state).paid, 0.3);
  assert.equal(financeTotals(state).forecast, 0.3);
});
