import test from 'node:test';
import assert from 'node:assert/strict';
import { seedState } from '../src/seed.ts';
import { parseHistoryRegister, prepareHistoryImport, type HistoryRegister } from '../src/domain/history-import.ts';
import { validateFinanceChanges } from '../sites/projects/finance.js';
import { financeTotals } from '../src/domain/finance.ts';

const now = '2026-09-30T00:00:00.000Z';
const identity = { role: 'management', name: 'Владелец' };
const register = (): HistoryRegister => ({ format: 'IKIOMA-Kelosi-staged-import-v1', sources: [{ fileName: 'invoice.pdf', sha256: 'a'.repeat(64) }], budgetLines: [{ id: 'source-1', sourceRow: 1, name: 'Материалы', stageIds: ['sip'], plan: 120000, sourceFact: 90000 }], budgetReconciliation: { sourceDisplayedPlan: 100000, sumOfPlanItems: 120000 }, paidInvoices: [{ vendor: 'Поставщик', vendorInn: '1234567890', number: '1', documentDate: '2026-09-07', amount: 50000, description: 'Материалы', file: 'invoice.pdf', dedupKey: 'supplier:1', suggestedBudgetSourceRow: 1, paymentConfirmation: 'Владелец подтвердил оплату' }], paidLemanaPurchases: [] });
const current = () => {
  const state = structuredClone(seedState);
  state.project.id = 'project-test';
  state.documents.push({ id: 'doc-1', name: 'Счёт', fileName: 'invoice.pdf', fileKey: 'project-test/invoice.pdf', type: 'Счёт', updatedAt: now, clientVisible: false, status: 'current' });
  return state;
};

test('import preserves original state, source totals, prior budget and unknown actual payment date', () => {
  const before = current(), snapshot = structuredClone(before);
  before.financeEntries.push({ id: 'old', kind: 'income', status: 'paid', amount: 100, date: '2026-09-01', counterparty: 'Заказчик', description: 'Аванс' });
  snapshot.financeEntries = structuredClone(before.financeEntries);
  const result = prepareHistoryImport(before, register(), identity.name, now, true);
  assert.deepEqual(before, snapshot);
  assert.deepEqual(result.state.financeEntries[0], before.financeEntries[0]);
  assert.equal(result.added, 1);
  assert.equal(result.state.budgetLines[0].plan, 120000);
  assert.equal(result.state.budgetLines[0].sourceFact, 90000);
  assert.deepEqual(result.state.budgetMeta.importPreviousBudget?.lines, before.budgetLines);
  assert.equal(result.state.financeEntries[1].paidAt, undefined);
  assert.equal(financeTotals(result.state).paid, 50000);
  assert.equal(financeTotals(result.state).accepted, 0);
  assert.deepEqual(result.state.stages, before.stages);
  assert.deepEqual(result.state.settings, before.settings);
  assert.equal(validateFinanceChanges(before, result.state, identity, now), '');
});

test('repeat import is deduplicated and original recorded timestamp remains', () => {
  const first = prepareHistoryImport(current(), register(), identity.name, now, true);
  assert.equal(validateFinanceChanges(current(), first.state, identity, now), '');
  const second = prepareHistoryImport(first.state, register(), identity.name, '2026-10-01T00:00:00Z', true);
  assert.equal(second.added, 0); assert.equal(second.skipped, 1);
  assert.deepEqual(second.state, first.state);
});

test('missing, client-visible and foreign project documents cannot back an import', () => {
  for (const mode of ['missing', 'visible', 'foreign']) {
    const state = current();
    if (mode === 'missing') state.documents = [];
    if (mode === 'visible') state.documents[0].clientVisible = true;
    if (mode === 'foreign') state.documents[0].fileKey = 'other/invoice.pdf';
    assert.throws(() => prepareHistoryImport(state, register(), identity.name, now, true));
  }
});

test('server rejects fabricated acceptance, missing evidence, duplicate source, non-manager and historical edits', () => {
  const base = current(), candidate = prepareHistoryImport(base, register(), identity.name, now, true).state;
  for (const mutate of [(s: typeof candidate) => { s.financeEntries[0].acceptedAmount = 50000; }, (s: typeof candidate) => { s.documents = []; }, (s: typeof candidate) => { s.financeEntries.push({ ...s.financeEntries[0], id: 'duplicate' }); }, (s: typeof candidate) => { s.financeEntries[0].paidAt = '2026-02-30'; }]) {
    const bad = structuredClone(candidate); mutate(bad); assert.ok(validateFinanceChanges(base, bad, identity, now));
  }
  assert.ok(validateFinanceChanges(base, structuredClone(candidate), { role: 'foreman', name: 'Прораб' }, now));
  assert.equal(validateFinanceChanges(base, candidate, identity, now), '');
  const changed = structuredClone(candidate); changed.financeEntries[0].description = 'Изменено';
  assert.ok(validateFinanceChanges(candidate, changed, identity, now));
  const removed = structuredClone(candidate); removed.financeEntries = [];
  assert.ok(validateFinanceChanges(candidate, removed, identity, now));
});

test('malformed or duplicate records fail before state mutation', () => {
  const input = register(); input.paidInvoices[0].amount = -5;
  assert.throws(() => parseHistoryRegister(input));
  const duplicate = register(); duplicate.paidInvoices.push({ ...duplicate.paidInvoices[0] });
  assert.throws(() => parseHistoryRegister(duplicate));
});
