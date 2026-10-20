import test from 'node:test';
import assert from 'node:assert/strict';
import { seedState } from '../src/seed.ts';
import { createFinanceUseCases } from './support/finance-project.ts';
import { historyImportSnapshot } from '../src/infrastructure/finance-project.ts';
import { importProjectFinanceHistory } from './support/finance-project.ts';
import { parseHistoryRegister, type HistoryRegister } from '../src/domain/finance/history-import.ts';
import { validateFinanceChanges } from '../src/domain/finance/index.js';

const now = '2026-10-19T12:00:00.000Z';
const context = { identity: { role: 'management' as const, name: 'Владелец' }, clock: { now: () => now }, ids: { next: (prefix: string) => `${prefix}-test` } };
const register = (): HistoryRegister => ({ format: 'IKIOMA-Kelosi-staged-import-v1', sources: [{ fileName: 'invoice.pdf', sha256: 'a'.repeat(64) }], budgetLines: [{ id: 'row-1', sourceRow: 1, name: 'Материалы', stageIds: [], plan: 100, sourceFact: 35 }], budgetReconciliation: { sourceDisplayedPlan: 100, sumOfPlanItems: 100 }, paidInvoices: [{ vendor: 'Поставщик', number: '1', documentDate: '2026-09-07', amount: 50, description: 'Материалы', file: 'invoice.pdf', dedupKey: 'supplier:1', paymentConfirmation: 'Подтверждение владельца', suggestedBudgetSourceRow: 1 }], paidLemanaPurchases: [] });
const fixture = () => {
  const state = structuredClone(seedState);
  state.project.id = 'project-test';
  state.documents.push({ id: 'doc-1', name: 'Счёт', fileName: 'invoice.pdf', fileKey: 'project-test/invoice.pdf', type: 'Счёт', updatedAt: now, clientVisible: false, status: 'current' });
  return state;
};
const command = (state: ReturnType<typeof fixture>) => ({ register: register(), includeBudget: true, confirmed: true, expected: historyImportSnapshot(state) });

test('history command preserves its input, unknown payment dates and separate acceptance; server accepts it', () => {
  const state = fixture(), before = structuredClone(state);
  const result = importProjectFinanceHistory(state, command(state), context);
  assert.ok(result.ok && result.change);
  if (!result.ok || !result.change) return;
  assert.deepEqual(state, before);
  assert.equal(result.added, 1);
  assert.equal(result.change.action, 'finance_history_imported');
  assert.equal(result.change.state.activity[0].id, 'history-import-test');
  assert.equal(result.change.state.financeEntries[0].paidAt, undefined);
  assert.equal(result.change.state.financeEntries[0].acceptedAmount, 0);
  assert.equal(validateFinanceChanges(state, result.change.state, context.identity, now), '');
});

test('role, explicit confirmation and private project evidence are required before saving', () => {
  const state = fixture();
  assert.equal(importProjectFinanceHistory(state, command(state), { ...context, identity: { role: 'foreman', name: 'Прораб' } }).ok, false);
  assert.equal(importProjectFinanceHistory(state, { ...command(state), confirmed: false }, context).ok, false);
  for (const mode of ['missing', 'visible', 'foreign']) {
    const candidate = fixture();
    if (mode === 'missing') candidate.documents = [];
    if (mode === 'visible') candidate.documents[0].clientVisible = true;
    if (mode === 'foreign') candidate.documents[0].fileKey = 'another/invoice.pdf';
    assert.equal(importProjectFinanceHistory(candidate, command(candidate), context).ok, false);
  }
});

test('changed financial previews fail while unrelated activity is preserved', () => {
  for (const mutate of [
    (state: ReturnType<typeof fixture>) => { state.project.targetCost += 1; },
    (state: ReturnType<typeof fixture>) => { state.documents[0].clientVisible = true; },
    (state: ReturnType<typeof fixture>) => { state.budgetLines = []; },
    (state: ReturnType<typeof fixture>) => { state.project.id = 'another'; },
  ]) {
    const state = fixture(), input = command(state);
    mutate(state);
    assert.equal(importProjectFinanceHistory(state, input, context).ok, false);
  }
  const state = fixture(), input = command(state);
  state.activity.unshift({ id: 'unrelated', actor: 'Другой участник', timestamp: now, text: 'Изменена задача', tone: 'neutral' });
  const result = importProjectFinanceHistory(state, input, context);
  assert.ok(result.ok && result.change);
  if (result.ok && result.change) assert.equal(result.change.state.activity[1].id, 'unrelated');
});

test('reimport keeps counters but creates neither a write nor another audit event', () => {
  const state = fixture();
  let writes = 0;
  const first = createFinanceUseCases(state, context.identity, context.clock, context.ids, () => { writes++; }).importHistory(command(state));
  assert.ok(first.ok && first.change);
  if (!first.ok || !first.change) return;
  const next = first.change.state;
  assert.equal(validateFinanceChanges(state, next, context.identity, now), '');
  const second = createFinanceUseCases(next, context.identity, context.clock, context.ids, () => { writes++; }).importHistory(command(next));
  assert.ok(second.ok);
  if (!second.ok) return;
  assert.equal(second.change, null);
  assert.equal(second.added, 0);
  assert.equal(second.skipped, 1);
  assert.equal(writes, 1);
});

test('malformed register records are rejected without mutating project state', () => {
  for (const mutate of [
    (input: any) => { input.sources = [null]; },
    (input: any) => { input.sources.push({ ...input.sources[0] }); },
    (input: any) => { input.budgetLines = [null]; },
    (input: any) => { input.paidInvoices = [null]; },
    (input: any) => { input.paidInvoices[0].paymentDate = ''; },
    (input: any) => { input.paidInvoices[0].dedupKey = {}; },
  ]) {
    const input = register(); mutate(input);
    assert.throws(() => parseHistoryRegister(input));
    const state = fixture(), before = structuredClone(state);
    assert.equal(importProjectFinanceHistory(state, { ...command(state), register: input }, context).ok, false);
    assert.deepEqual(state, before);
  }
});
