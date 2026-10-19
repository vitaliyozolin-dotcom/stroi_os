import assert from 'node:assert/strict';
import test from 'node:test';
import { createFinanceUseCases } from '../src/application/finance.ts';
import { editProjectBudgetLine, classifyProjectCosts, setProjectPaymentDueDate } from '../src/application/finance-planning.ts';
import { budgetLineSnapshot, classificationSnapshot, validateFinanceChanges } from '../src/domain/finance/index.js';
import { lineForecast } from '../src/domain/finance-totals.js';
import { seedState } from '../src/seed.ts';
import type { AppState } from '../src/entities/index.ts';
import type { FinanceCommandResult } from '../src/application/finance.ts';

const now = '2026-10-19T12:00:00.000Z';
const identity = { name: 'Управляющий', role: 'management' as const };
const context = () => { let id = 0; return { identity, clock: { now: () => now }, ids: { next: (prefix: string) => `${prefix}-${++id}` } }; };
const fixture = () => {
  const state = structuredClone(seedState);
  state.budgetMeta = { ...state.budgetMeta, version: 'v1', source: 'Исходная смета', approvedAt: '2026-09-01', approvedBy: 'Владелец' };
  state.budgetLines = [{ id: 'line-1', name: 'Работы', plan: 100, forecast: 100, stageIds: [], sourcePlan: 100, sourceFact: 35, sourceRow: 1, sourceParticipantAmounts: { Участник: 35 } }];
  state.financeEntries = [{ id: 'expense-1', kind: 'expense', status: 'accepted', amount: 80, acceptedAmount: 60, paidAmount: 20, date: '2026-09-01', description: 'Работы', counterparty: 'Подрядчик', budgetLineId: 'line-1', payments: [{ id: 'p1', amount: 20, date: '2026-09-05', document: 'Чек', recordedBy: 'Кассир', recordedAt: '2026-09-05T10:00:00Z' }] }];
  return state;
};
const stateOf = (result: FinanceCommandResult) => { assert.ok(result.ok && result.change); if (!result.ok || !result.change) throw new Error('Expected change'); return result.change.state; };
const budgetInput = (state: AppState) => ({ lineId: 'line-1', plan: 110.25, forecast: 90, version: 'v2', source: 'Уточнение владельца', expected: budgetLineSnapshot(state, 'line-1') });

test('budget editing preserves source-sheet values, approvals, financial facts and input state', () => {
  const state = fixture(), before = structuredClone(state);
  const next = stateOf(editProjectBudgetLine(state, budgetInput(state), context()));
  assert.deepEqual(state, before);
  assert.equal(next.budgetLines[0].plan, 110.25);
  assert.equal(next.budgetLines[0].sourcePlan, 100);
  assert.equal(next.budgetLines[0].sourceFact, 35);
  assert.deepEqual(next.budgetLines[0].sourceParticipantAmounts, { Участник: 35 });
  assert.equal(next.budgetMeta.approvedBy, state.budgetMeta.approvedBy);
  assert.equal(next.budgetMeta.importedAt, now);
  assert.deepEqual(next.financeEntries, state.financeEntries);
  assert.equal(validateFinanceChanges(state, next, identity, now), '');
});

test('planning cannot lower effective forecast below recorded commitments', () => {
  const state = fixture();
  const next = stateOf(editProjectBudgetLine(state, { ...budgetInput(state), forecast: 1 }, context()));
  assert.equal(next.budgetLines[0].forecast, 1);
  assert.equal(lineForecast(next, next.budgetLines[0]), 80);
});

test('stale or removed budget rows and changed metadata require reopening the draft', () => {
  const state = fixture(), input = budgetInput(state);
  state.budgetLines[0].forecast = 120;
  assert.equal(editProjectBudgetLine(state, input, context()).ok, false);
  const another = fixture(), anotherInput = budgetInput(another);
  another.budgetMeta.source = 'Новый источник';
  assert.equal(editProjectBudgetLine(another, anotherInput, context()).ok, false);
  another.budgetLines = [];
  assert.equal(editProjectBudgetLine(another, anotherInput, context()).ok, false);
});

test('unrelated category annotations do not invalidate an open budget draft or get overwritten', () => {
  const state = fixture(), input = budgetInput(state);
  state.budgetLines[0].costGroup = 'overhead';
  state.budgetMeta.importedAt = '2026-10-19T11:00:00Z';
  const next = stateOf(editProjectBudgetLine(state, input, context()));
  assert.equal(next.budgetLines[0].costGroup, 'overhead');
  assert.equal(next.budgetLines[0].plan, 110.25);
});

test('invalid plan/forecast are rejected both by the command and authoritative write policy', () => {
  for (const amount of [NaN, Infinity, -1, 0.001]) {
    const state = fixture();
    assert.equal(editProjectBudgetLine(state, { ...budgetInput(state), plan: amount }, context()).ok, false);
    const forged = structuredClone(state); forged.budgetLines[0].plan = amount;
    assert.ok(validateFinanceChanges(state, forged, identity, now));
  }
  const state = fixture();
  assert.equal(editProjectBudgetLine(state, { ...budgetInput(state), source: ' ' }, context()).ok, false);
});

test('classification preserves payment facts and leaves history stamps to the server', () => {
  const state = fixture();
  const input = { lines: { 'line-1': 'construction' as const }, entries: { 'expense-1': 'overhead' as const }, expected: classificationSnapshot(state) };
  const next = stateOf(classifyProjectCosts(state, input, context()));
  assert.deepEqual(next.financeEntries[0].payments, state.financeEntries[0].payments);
  assert.equal(next.financeEntries[0].costGroupHistory, undefined);
  assert.equal(validateFinanceChanges(state, next, identity, now), '');
  assert.deepEqual(next.financeEntries[0].costGroupHistory, [{ group: 'overhead', at: now, by: identity.name }]);
  assert.equal(next.budgetLines[0].sourcePlan, 100);
  const { costGroup, costGroupHistory, ...facts } = next.financeEntries[0];
  assert.deepEqual(facts, state.financeEntries[0]);
});

test('classification rejects reserve expenses, unknown rows and stale financial snapshots', () => {
  const state = fixture(), expected = classificationSnapshot(state);
  assert.equal(classifyProjectCosts(state, { lines: {}, entries: { 'expense-1': 'reserve' }, expected }, context()).ok, false);
  assert.equal(classifyProjectCosts(state, { lines: { foreign: 'construction' }, entries: {}, expected }, context()).ok, false);
  state.financeEntries[0].payments!.push({ ...state.financeEntries[0].payments![0], id: 'p2' });
  assert.equal(classifyProjectCosts(state, { lines: {}, entries: {}, expected }, context()).ok, false);
});

test('due dates can be assigned and cleared without changing money or accepted work', () => {
  const state = fixture();
  const next = stateOf(setProjectPaymentDueDate(state, { entryId: 'expense-1', date: '2026-11-01', expected: JSON.stringify(state.financeEntries[0]) }, context()));
  assert.deepEqual(next.financeEntries[0].payments, state.financeEntries[0].payments);
  assert.equal(next.financeEntries[0].dueDateHistory, undefined);
  assert.equal(validateFinanceChanges(state, next, identity, now), '');
  assert.deepEqual(next.financeEntries[0].dueDateHistory, [{ date: '2026-11-01', at: now, by: identity.name }]);
  const cleared = stateOf(setProjectPaymentDueDate(next, { entryId: 'expense-1', date: '', expected: JSON.stringify(next.financeEntries[0]) }, context()));
  assert.equal(validateFinanceChanges(next, cleared, identity, now), '');
  assert.equal(cleared.financeEntries[0].dueDateHistory?.length, 2);
  const { dueDate, dueDateHistory, ...facts } = cleared.financeEntries[0];
  assert.deepEqual(facts, state.financeEntries[0]);
});

test('payment date draft rejects concurrent changes and impossible dates', () => {
  const state = fixture(), expected = JSON.stringify(state.financeEntries[0]);
  assert.equal(setProjectPaymentDueDate(state, { entryId: 'expense-1', date: '2026-02-30', expected }, context()).ok, false);
  state.financeEntries[0].paidAmount = 25;
  assert.equal(setProjectPaymentDueDate(state, { entryId: 'expense-1', date: '2026-11-01', expected }, context()).ok, false);
});

test('planning roles are enforced and no-op commands never cause persistence or audit', () => {
  const state = fixture();
  for (const role of ['foreman', 'client'] as const) {
    const deps = { ...context(), identity: { ...identity, role } };
    assert.equal(editProjectBudgetLine(state, budgetInput(state), deps).ok, false);
    assert.equal(classifyProjectCosts(state, { lines: {}, entries: {}, expected: classificationSnapshot(state) }, deps).ok, false);
    assert.equal(setProjectPaymentDueDate(state, { entryId: 'expense-1', date: '2026-11-01', expected: JSON.stringify(state.financeEntries[0]) }, deps).ok, false);
    const forged = structuredClone(state); forged.budgetLines[0].forecast = 110;
    assert.ok(validateFinanceChanges(state, forged, deps.identity, now));
  }
  const deps = context();
  const commands = createFinanceUseCases(state, identity, deps.clock, deps.ids, () => assert.fail('no-op write'));
  assert.deepEqual(commands.updateBudgetLine({ ...budgetInput(state), plan: 100, forecast: 100, source: state.budgetMeta.source, version: state.budgetMeta.version }), { ok: true, change: null });
  assert.deepEqual(commands.classifyCosts({ lines: {}, entries: {}, expected: classificationSnapshot(state) }), { ok: true, change: null });
  assert.deepEqual(commands.setDueDate({ entryId: 'expense-1', date: '', expected: JSON.stringify(state.financeEntries[0]) }), { ok: true, change: null });
});
