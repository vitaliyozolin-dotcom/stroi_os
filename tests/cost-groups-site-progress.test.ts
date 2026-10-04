import test from 'node:test';
import assert from 'node:assert/strict';
import { seedState } from '../src/seed.ts';
import { costGroupTotals, expenseCostGroup } from '../src/domain/cost-groups.ts';
import { validateFinanceChanges } from '../sites/projects/finance.js';
import { validateStageControl } from '../sites/projects/stage-control.js';
import { applyStageControl } from '../src/application/stage-control.ts';
import { stateForRole } from '../sites/access-control.js';
const owner = { role: 'management', name: 'Owner' }, now = '2026-09-09T12:00:00Z';

test('cost groups reconcile cents, retain unallocated expenses and exclude reserve from spending', () => {
  const state = structuredClone(seedState);
  state.budgetLines = [
    { id: 'a', name: 'Build', plan: 100, forecast: 100, stageIds: [], costGroup: 'construction' },
    { id: 'b', name: 'Admin', plan: 20, forecast: 20, stageIds: [], costGroup: 'overhead' },
    { id: 'r', name: 'Reserve', plan: 30, forecast: 30, stageIds: [], costGroup: 'reserve' },
    { id: 'x', name: 'Outside original total', plan: 0, sourcePlan: 50, forecast: 0, stageIds: [], costGroup: 'construction' },
  ];
  const base = { kind: 'expense' as const, status: 'paid' as const, date: '2026-09-01', counterparty: 'Vendor', description: 'Materials' };
  state.financeEntries = [
    { ...base, id: '1', amount: 10.01, budgetLineId: 'a' },
    { ...base, id: '2', amount: 2.02, budgetLineId: 'a', costGroup: 'overhead' },
    { ...base, id: '3', amount: 4.03, budgetLineId: 'r' },
    { ...base, id: '4', amount: 50, paidAmount: 0 },
    { ...base, id: '5', amount: 90, kind: 'income' },
  ];
  assert.deepEqual(costGroupTotals(state), { construction: { plan: 100, paid: 10.01 }, overhead: { plan: 20, paid: 2.02 }, reserve: { plan: 30, paid: 0 }, unallocated: { plan: 0, paid: 4.03 } });
  assert.equal(expenseCostGroup(state, state.financeEntries[2]), 'unallocated');
});

test('classification annotates historical payments while amounts, source and history stay immutable', () => {
  const before = structuredClone(seedState);
  before.financeEntries = [{ id: 'e', kind: 'expense', status: 'paid', amount: 10, paidAmount: 10, acceptedAmount: 0, date: '2026-09-01', counterparty: 'Vendor', description: 'Old expense', historicalPayment: { sourceUniqueKey: 'source' } }];
  const next = structuredClone(before); next.financeEntries[0].costGroup = 'construction';
  assert.equal(validateFinanceChanges(before, next, owner, now), '');
  assert.deepEqual(next.financeEntries[0].costGroupHistory, [{ group: 'construction', at: now, by: 'Owner' }]);
  const tampered = structuredClone(next); tampered.financeEntries[0].amount = 11;
  assert.match(validateFinanceChanges(before, tampered, owner, now), /нельзя переписывать/);
  const changed = structuredClone(next); changed.financeEntries[0].costGroup = 'overhead'; changed.financeEntries[0].costGroupHistory = [];
  assert.equal(validateFinanceChanges(next, changed, owner, now), '');
  assert.equal(changed.financeEntries[0].costGroupHistory.length, 2);
  const invalid = structuredClone(next); invalid.financeEntries[0].costGroup = 'reserve';
  assert.match(validateFinanceChanges(next, invalid, owner, now), /резерв/);
  assert.match(validateFinanceChanges(before, structuredClone(next), { role: 'foreman' }, now), /управление/);
});

test('site state is append-only, sourced, dated, private to staff and never accepts work', () => {
  const before = structuredClone(seedState), next = structuredClone(before);
  next.project.siteProgressHistory = [{ id: 'report', asOf: '2026-09-09', completed: ['Frame'], remaining: ['Windows'], source: 'Owner report' }];
  assert.equal(validateStageControl(before, next, owner, now), null);
  assert.equal(next.project.siteProgressHistory[0].recordedBy, 'Owner');
  const facts = (stages) => stages.map(({ id, status, completedOn, actualEnd, acceptedAt, planStart, planEnd }) => ({ id, status, completedOn, actualEnd, acceptedAt, planStart, planEnd }));
  assert.deepEqual(facts(next.stages), facts(before.stages));
  assert.deepEqual(next.financeEntries, before.financeEntries);
  const changed = structuredClone(next); changed.project.siteProgressHistory[0].completed = [];
  assert.match(validateStageControl(next, changed, owner, now), /История/);
  const removed = structuredClone(next); removed.project.siteProgressHistory = [];
  assert.match(validateStageControl(next, removed, owner, now), /История/);
  assert.equal(stateForRole(next, { role: 'client' }).project.siteProgressHistory, undefined);
  const future = structuredClone(before); future.project.siteProgressHistory = [{ ...next.project.siteProgressHistory[0], asOf: '2027-01-01' }];
  assert.match(validateStageControl(before, future, owner, now), /датой/);
});

test('observed readiness does not invent completion dates, close tasks, unlock or accept a stage', () => {
  const before = structuredClone(seedState);
  before.stages = [{ id: 'stage', name: 'Frame', shortName: 'Frame', order: 1, status: 'not_ready', weight: 1, progress: 0, planStart: '2026-08-10', planEnd: '2026-09-10', forecastEnd: '2026-09-10', responsible: '' }];
  const next = applyStageControl(before, 'stage', 'complete', { date: '2026-09-09', note: 'Owner confirmed frame exists', tasks: [], completionDateUnknown: true }, owner.name, 'management');
  assert.equal(validateStageControl(before, next, owner, now), null);
  assert.equal(next.stages[0].status, 'awaiting_inspection');
  assert.equal(next.stages[0].completedOn, undefined);
  assert.equal(next.stages[0].completionObservedOn, '2026-09-09');
  assert.deepEqual(next.tasks, before.tasks);
  assert.deepEqual(next.financeEntries, before.financeEntries);
  assert.throws(() => applyStageControl(next, 'stage', 'accept', { date: '2026-09-09', note: 'accept', tasks: [] }, owner.name, 'management'), /дату/);
  const invalid = structuredClone(next); invalid.stages[0].status = 'accepted';
  assert.ok(validateStageControl(before, invalid, owner, now));
  const recovered = structuredClone(next); recovered.stages[0].completedOn = '2026-09-08'; recovered.stages[0].factRecoveryNote = 'Dated site log';
  assert.equal(validateStageControl(next, recovered, owner, now), null);
  assert.equal(recovered.stages[0].completionObservedOn, '2026-09-09');
  const late = structuredClone(next); late.stages[0].completedOn = '2026-09-10'; late.stages[0].factRecoveryNote = 'Wrong day';
  assert.match(validateStageControl(next, late, owner, '2026-09-11T12:00:00Z'), /наблюдения/);
});
