import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceEstimateTotals, financeTotals } from '../src/domain/finance.ts';
import { seedState } from '../src/seed.ts';

test('source-sheet total excludes rows outside the formula and does not record payments', () => {
  const state = structuredClone(seedState);
  state.budgetLines = [
    { id: 'a', name: 'Материал', stageIds: [], sourceRow: 1, sourcePlan: 100, plan: 110, forecast: 110, sourceFact: 80.15 },
    { id: 'b', name: 'Резерв', stageIds: [], sourceRow: 2, sourcePlan: 20, plan: 20, forecast: 20, sourceFact: 20 },
    { id: 'c', name: 'Вне формулы', stageIds: [], sourceRow: 3, sourcePlan: 30, plan: 0, forecast: 0, sourceFact: 30, outsideSourceTotal: true },
    { id: 'd', name: 'Без суммы', stageIds: [], sourceRow: 4, plan: 0, forecast: 0 },
  ];
  const paid = financeTotals(state).paid;
  assert.deepEqual(sourceEstimateTotals(state.budgetLines), { plan: 120, fact: 100.15, deviation: -19.85 });
  assert.equal(financeTotals(state).paid, paid);
});

test('missing source values do not become a zero fact', () => {
  assert.equal(sourceEstimateTotals([]), null);
  assert.equal(sourceEstimateTotals([{ id: 'a', name: 'Не заполнено', stageIds: [], sourceRow: 1, plan: 100, forecast: 100 }]), null);
});
