import test from 'node:test';
import assert from 'node:assert/strict';
import { financeCalendarItems, financeCalendarToday, financeCalendarTotal, validFinanceDueDate } from '../src/domain/finance-calendar.ts';
import { validateFinanceChanges } from '../sites/projects/finance.js';
import { seedState } from '../src/seed.ts';
import type { FinanceEntry } from '../src/entities/index.ts';

const identity = { role: 'management', name: 'Owner' };
const now = '2026-10-06T21:15:00Z';
const entry = (overrides: Partial<FinanceEntry> = {}): FinanceEntry => ({ id: 'e', kind: 'expense', status: 'committed', amount: 100, date: '2026-09-01', counterparty: 'Vendor', description: 'Materials', ...overrides });
const fixture = (entries = [entry()]) => ({ ...structuredClone(seedState), financeEntries: entries });

test('calendar shows unpaid remainder, preserves partial payments and rounds to cents', () => {
  const state = fixture([
    entry({ id: 'partial', amount: 100, paidAmount: 30 }),
    entry({ id: 'legacy-paid', status: 'paid' }),
    entry({ id: 'explicit-paid', paidAmount: 100 }),
    entry({ id: 'income', kind: 'income', amount: 50, paidAmount: 10 }),
    entry({ id: 'cents', amount: 0.3, paidAmount: 0.1 }),
  ]);
  const before = structuredClone(state);
  const items = financeCalendarItems(state, '2026-10-07');
  assert.deepEqual(new Map(items.map(item => [item.entry.id, item.remaining])), new Map([['partial', 70], ['income', 40], ['cents', 0.2]]));
  assert.equal(financeCalendarTotal(items), 110.2);
  assert.equal(financeCalendarTotal(items.filter(item => item.entry.kind === 'expense')), 70.2);
  assert.deepEqual(state, before);
});

test('calendar only uses explicit due dates and distinguishes seven-day boundaries', () => {
  const state = fixture([
    entry({ id: 'old-invoice', date: '2020-01-01' }),
    entry({ id: 'invalid', dueDate: '2026-02-30' }),
    entry({ id: 'overdue', dueDate: '2026-10-06' }),
    entry({ id: 'today', dueDate: '2026-10-07' }),
    entry({ id: 'last-seven', dueDate: '2026-10-13' }),
    entry({ id: 'later', dueDate: '2026-10-14' }),
  ]);
  const byId = new Map(financeCalendarItems(state, '2026-10-07').map(item => [item.entry.id, item]));
  assert.equal(byId.get('old-invoice')?.group, 'undated');
  assert.equal(byId.get('old-invoice')?.dueDate, null);
  assert.equal(byId.get('invalid')?.group, 'undated');
  assert.equal(byId.get('overdue')?.group, 'overdue');
  assert.equal(byId.get('today')?.group, 'next7');
  assert.equal(byId.get('last-seven')?.group, 'next7');
  assert.equal(byId.get('later')?.group, 'later');
  assert.throws(() => financeCalendarItems(state, 'invalid'), /Invalid calendar date/);
});

test('Moscow calendar day survives UTC midnight boundary and calendar validates real dates', () => {
  assert.equal(financeCalendarToday(new Date('2026-10-06T21:15:00Z')), '2026-10-07');
  assert.equal(financeCalendarToday(new Date('2026-10-06T20:59:00Z')), '2026-10-06');
  assert.equal(validFinanceDueDate('2028-02-29'), true);
  for (const value of ['2026-02-29', '2026-10-7', '', null, '2026-10-07T00:00:00Z']) assert.equal(validFinanceDueDate(value), false);
});

test('server records and clears planned dates without touching payment and acceptance facts', () => {
  const before = fixture([entry({ status: 'accepted', paidAmount: 30, paidAt: '2026-09-15', acceptedAmount: 80, acceptedAt: '2026-09-10', acceptedBy: 'Receiver', approvedAt: '2026-09-01', approvedBy: 'Approver', payments: [{ id: 'p', amount: 30, date: '2026-09-15', document: 'Receipt', recordedAt: '2026-09-15T12:00:00Z', recordedBy: 'Payer' }] })]);
  const next = structuredClone(before);
  next.financeEntries[0].dueDate = '2026-10-15';
  assert.equal(validateFinanceChanges(before, next, identity, now), '');
  assert.deepEqual(next.financeEntries[0].dueDateHistory, [{ date: '2026-10-15', at: now, by: 'Owner' }]);
  const { dueDate, dueDateHistory, ...facts } = next.financeEntries[0];
  assert.deepEqual(facts, before.financeEntries[0]);
  const cleared = structuredClone(next);
  delete cleared.financeEntries[0].dueDate;
  assert.equal(validateFinanceChanges(next, cleared, identity, now), '');
  assert.deepEqual(cleared.financeEntries[0].dueDateHistory, [{ date: '2026-10-15', at: now, by: 'Owner' }, { date: null, at: now, by: 'Owner' }]);
  assert.equal(validateFinanceChanges(cleared, structuredClone(cleared), identity, now), '');
});

test('historical payment permits future planning metadata but not changed monetary/source facts', () => {
  const historical = { sourceUniqueKey: 'imported', sourceDocumentId: 'doc', sourceSha256: 'a'.repeat(64), confirmation: 'Owner', sourceDate: '2026-09-01', recordedAt: '2026-09-10', recordedBy: 'Importer' };
  const before = fixture([entry({ status: 'paid', amount: 100, paidAmount: 100, acceptedAmount: 0, historicalPayment: historical })]);
  const next = structuredClone(before); next.financeEntries[0].dueDate = '2027-01-01';
  assert.equal(validateFinanceChanges(before, next, identity, now), '');
  assert.deepEqual(next.financeEntries[0].historicalPayment, historical);
  assert.equal(next.financeEntries[0].acceptedAmount, 0);
  assert.deepEqual(financeCalendarItems(next, '2026-10-07'), []);
  for (const mutate of [(e: FinanceEntry) => { e.amount = 101; }, (e: FinanceEntry) => { e.acceptedAmount = 100; }, (e: FinanceEntry) => { e.historicalPayment!.confirmation = 'Changed'; }]) {
    const bad = structuredClone(before); bad.financeEntries[0].dueDate = '2027-01-01'; mutate(bad.financeEntries[0]);
    assert.match(validateFinanceChanges(before, bad, identity, now), /нельзя переписывать/);
  }
});

test('date metadata cannot forge or remove server history and only management may change it', () => {
  const before = fixture();
  for (const date of ['2026-02-30', '', 'tomorrow']) {
    const invalid = structuredClone(before); invalid.financeEntries[0].dueDate = date;
    assert.match(validateFinanceChanges(before, invalid, identity, now), /корректную/);
  }
  const forbidden = structuredClone(before); forbidden.financeEntries[0].dueDate = '2026-10-15';
  assert.match(validateFinanceChanges(before, forbidden, { role: 'foreman', name: 'Foreman' }, now), /Управление/);
  const next = structuredClone(before); next.financeEntries[0].dueDate = '2026-10-15';
  assert.equal(validateFinanceChanges(before, next, identity, now), '');
  const forged = structuredClone(next); forged.financeEntries[0].dueDateHistory![0].by = 'Someone else';
  assert.match(validateFinanceChanges(next, forged, identity, now), /история сроков/);
  const stale = structuredClone(next); delete stale.financeEntries[0].dueDateHistory;
  assert.match(validateFinanceChanges(next, stale, identity, now), /история сроков/);
});

test('adding a due date cannot bypass payment amount rules or rewrite ledger', () => {
  const before = fixture([entry({ acceptedAmount: 50, paidAmount: 20, payments: [{ id: 'p', amount: 20, date: '2026-09-15', document: 'Receipt', recordedAt: '2026-09-15T12:00:00Z', recordedBy: 'Payer' }] })]);
  const overpaid = structuredClone(before); Object.assign(overpaid.financeEntries[0], { dueDate: '2026-10-15', paidAmount: 60, paidAt: '2026-10-07', paymentDocument: 'Receipt' });
  assert.match(validateFinanceChanges(before, overpaid, identity, now), /Суммы/);
  const rewritten = structuredClone(before); rewritten.financeEntries[0].dueDate = '2026-10-15'; rewritten.financeEntries[0].payments = [];
  assert.match(validateFinanceChanges(before, rewritten, identity, now), /История платежей/);
});
