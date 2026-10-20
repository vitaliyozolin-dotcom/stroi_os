import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { seedState, buildStages } from '../src/seed.ts';
import { createFinanceCommitment } from '../src/application/finance-context-commitment.js';
import { financeCommitmentSnapshot, applyFinanceCommitmentResult, createProjectCommitment } from '../src/infrastructure/finance-commitment.js';
import { financeHistoryState, type HistoryRegister } from '../src/domain/finance/history-import.ts';
import { financeHistoryFingerprint, importFinanceHistory } from '../src/application/finance-context-history.ts';
import { historyImportSnapshot, applyFinanceHistoryResult } from '../src/infrastructure/finance-project.ts';
import { importProjectFinanceHistory } from './support/finance-project.ts';
import { validateFinanceChanges } from '../src/domain/finance/index.js';

const now = '2026-10-20T12:00:00.000Z';
const context = () => {
  let id = 0;
  return { identity: { name: 'Владелец', role: 'management' as const }, clock: { now: () => now }, ids: { next: (prefix: string) => `${prefix}-${++id}` } };
};
const fixture = () => {
  const state = structuredClone(seedState);
  state.project.id = 'project-test';
  state.stages = [{ ...buildStages('2026-10-01', '2026-12-01')[0], id: 'stage' }];
  state.counterparties = [{ id: 'vendor', name: 'Поставщик', type: 'supplier', status: 'active' }];
  state.budgetLines = [{ id: 'line', name: 'Работы', stageIds: ['stage'], plan: 100, forecast: 100 }];
  state.documents = [{ id: 'doc', name: 'Счёт', type: 'Счёт', fileName: 'invoice.pdf', fileKey: 'project-test/invoice.pdf', updatedAt: now, clientVisible: false }];
  return state;
};
const commitment = { kind: 'expense' as const, amount: 50, date: '2026-10-20', description: 'Материалы', counterpartyId: 'vendor', stageId: 'stage', budgetLineId: 'line', sourceDraftId: 'draft' };
const register = (): HistoryRegister => ({
  format: 'IKIOMA-Kelosi-staged-import-v1', sources: [{ fileName: 'invoice.pdf', sha256: 'a'.repeat(64) }],
  budgetLines: [{ id: 'imported-line', name: 'Материалы', sourceRow: 1, plan: 100, stageIds: ['stage'] }],
  budgetReconciliation: { sourceDisplayedPlan: 100, sumOfPlanItems: 100 },
  paidInvoices: [{ vendor: 'Новый поставщик', number: '1', documentDate: '2026-09-07', amount: 25, description: 'Материалы', file: 'invoice.pdf', dedupKey: 'invoice:1', paymentConfirmation: 'Подтверждено владельцем', suggestedBudgetSourceRow: 1 }], paidLemanaPurchases: [],
});
const historyCommand = (state: ReturnType<typeof fixture>) => ({ register: register(), includeBudget: true, confirmed: true, expected: historyImportSnapshot(state) });

test('commitment core uses only finance data and explicit references; legacy UI/Telegram adapter stays identical', () => {
  const state = fixture(), snapshot = financeCommitmentSnapshot(state), before = structuredClone(snapshot);
  assert.equal('tasks' in snapshot, false); assert.equal('settings' in snapshot, false); assert.equal('activity' in snapshot, false);
  const result = createFinanceCommitment(snapshot, commitment, context());
  assert.ok(result.ok && result.change); if (!result.ok || !result.change) return;
  assert.deepEqual(snapshot, before); assert.equal('state' in result.change, false);
  assert.equal(result.change.patch.financeEntries?.[0].status, 'committed');
  assert.deepEqual(applyFinanceCommitmentResult(state, result), createProjectCommitment(state, commitment, context()));
  const patch = { ...result.change.patch, tasks: [], documents: [], budgetMeta: { source: 'forged' } };
  state.activity.unshift({ id: 'parallel', timestamp: now, actor: 'Другой', text: 'Задача', tone: 'neutral' });
  const applied = applyFinanceCommitmentResult(state, { ...result, change: { ...result.change, patch } });
  assert.ok(applied.ok && applied.change); if (!applied.ok || !applied.change) return;
  assert.equal(applied.change.state.tasks, state.tasks); assert.equal(applied.change.state.documents, state.documents);
  assert.equal(applied.change.state.budgetMeta, state.budgetMeta); assert.equal(applied.change.state.activity[1].id, 'parallel');
  assert.equal(validateFinanceChanges(state, structuredClone(applied.change.state), context().identity, now), '');
});

test('evaluated commitments reject changed finance, blocked counterparties, removed stage links and project switches', () => {
  for (const mutate of [
    (state: ReturnType<typeof fixture>) => { state.budgetLines[0].forecast = 200; },
    (state: ReturnType<typeof fixture>) => { state.counterparties[0].status = 'blocked'; },
    (state: ReturnType<typeof fixture>) => { state.budgetLines[0].stageIds = []; },
    (state: ReturnType<typeof fixture>) => { state.stages = []; },
    (state: ReturnType<typeof fixture>) => { state.project.id = 'another'; },
  ]) {
    const state = fixture(), result = createFinanceCommitment(financeCommitmentSnapshot(state), commitment, context());
    mutate(state); const before = structuredClone(state);
    assert.equal(applyFinanceCommitmentResult(state, result).ok, false); assert.deepEqual(state, before);
  }
});

test('history core emits financial patches, metadata updates, new counterparties and target cost without whole-project state', () => {
  const state = fixture(), snapshot = financeHistoryState(state), before = structuredClone(snapshot), input = historyCommand(state);
  assert.equal('activity' in snapshot, false); assert.equal('tasks' in snapshot, false);
  assert.deepEqual(Object.keys(snapshot.project).sort(), ['id', 'targetCost']);
  assert.equal(financeHistoryFingerprint(snapshot), input.expected);
  const result = importFinanceHistory(snapshot, input, context());
  assert.ok(result.ok && result.change); if (!result.ok || !result.change) return;
  assert.deepEqual(snapshot, before); assert.equal('state' in result.change, false);
  assert.equal(result.change.documentUpdates[0].id, 'doc'); assert.equal(result.change.documentUpdates[0].category, 'invoice');
  assert.equal(result.change.counterpartyAdditions[0].name, 'Новый поставщик');
  assert.equal(result.change.targetCost, 100); assert.equal(result.change.patch.financeEntries?.[0].acceptedAmount, 0);
  assert.equal(result.change.patch.financeEntries?.[0].paidAt, undefined);
  assert.deepEqual(applyFinanceHistoryResult(state, result), importProjectFinanceHistory(state, input, context()));
});

test('history adapter preserves project presentation, unrelated collections and document access metadata', () => {
  const state = fixture(), result = importFinanceHistory(financeHistoryState(state), historyCommand(state), context());
  assert.ok(result.ok && result.change); if (!result.ok || !result.change) return;
  state.project.name = 'Обновлённый проект';
  state.activity.unshift({ id: 'parallel', timestamp: now, actor: 'Другой', text: 'Комментарий', tone: 'neutral' });
  const patch = { ...result.change.patch, tasks: [], settings: {}, documents: [] };
  const documentUpdates = result.change.documentUpdates.map(update => ({ ...update, fileKey: 'another/private.pdf', clientVisible: true, name: 'forged' }));
  const applied = applyFinanceHistoryResult(state, { ...result, change: { ...result.change, patch, documentUpdates } });
  assert.ok(applied.ok && applied.change); if (!applied.ok || !applied.change) return;
  const candidate = applied.change.state;
  assert.equal(candidate.project.name, state.project.name); assert.equal(candidate.project.targetCost, 100);
  assert.equal(candidate.tasks, state.tasks); assert.equal(candidate.settings, state.settings); assert.equal(candidate.activity[1].id, 'parallel');
  assert.equal(candidate.documents[0].fileKey, state.documents[0].fileKey);
  assert.equal(candidate.documents[0].name, state.documents[0].name); assert.equal(candidate.documents[0].clientVisible, false);
  assert.equal(candidate.counterparties[0], state.counterparties[0]); assert.equal(candidate.counterparties.length, 2);
  assert.equal(validateFinanceChanges(state, structuredClone(candidate), context().identity, now), '');
});

test('evaluated history cannot overwrite changed evidence, finances, counterparties, stage links or target cost', () => {
  for (const mutate of [
    (state: ReturnType<typeof fixture>) => { state.documents[0].clientVisible = true; },
    (state: ReturnType<typeof fixture>) => { state.documents[0].fileKey = 'another/invoice.pdf'; },
    (state: ReturnType<typeof fixture>) => { state.budgetLines[0].forecast = 200; },
    (state: ReturnType<typeof fixture>) => { state.counterparties[0].name = 'Другое имя'; },
    (state: ReturnType<typeof fixture>) => { state.stages = []; },
    (state: ReturnType<typeof fixture>) => { state.project.targetCost += 1; },
    (state: ReturnType<typeof fixture>) => { state.project.id = 'another'; },
  ]) {
    const state = fixture(), result = importFinanceHistory(financeHistoryState(state), historyCommand(state), context());
    mutate(state); const before = structuredClone(state);
    assert.equal(applyFinanceHistoryResult(state, result).ok, false); assert.deepEqual(state, before);
  }
});

test('import document-only refinements are auditable and repeats produce neither writes nor new events', () => {
  const state = fixture(), first = importProjectFinanceHistory(state, historyCommand(state), context());
  assert.ok(first.ok && first.change); if (!first.ok || !first.change) return;
  const next = first.change.state;
  next.documents[0].number = 'Уточнить';
  const refined = importProjectFinanceHistory(next, historyCommand(next), context());
  assert.ok(refined.ok && refined.change); if (!refined.ok || !refined.change) return;
  assert.equal(refined.added, 0); assert.equal(refined.change.state.documents[0].number, '1');
  assert.equal(refined.change.summary, 'Уточнены сведения документов исторического импорта');
  assert.equal(refined.change.state.activity[1], next.activity[0]);
  const repeated = importProjectFinanceHistory(refined.change.state, historyCommand(refined.change.state), context());
  assert.ok(repeated.ok); if (repeated.ok) { assert.equal(repeated.change, null); assert.equal(repeated.skipped, 1); }
});

test('financial creation cores depend on narrow contracts, never project state, UI or transport', () => {
  for (const path of ['src/application/finance-context-commitment.js', 'src/application/finance-context-commitment.d.ts', 'src/application/finance-context-history.ts', 'src/domain/finance/history-import.ts']) {
    const code = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
    assert.doesNotMatch(code, /\bAppState\b|\bStateChange\b|from ['"]react|infrastructure|\bfetch\(|\.DB\b/);
  }
});
