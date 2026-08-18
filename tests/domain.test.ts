import assert from 'node:assert/strict';
import test from 'node:test';

import { stageFinanceTotals } from '../src/domain.ts';
import { seedState } from '../src/seed.ts';
import type { AppState, FinanceEntry } from '../src/types.ts';

const entry = (overrides: Partial<FinanceEntry> & Pick<FinanceEntry, 'id' | 'kind' | 'status' | 'amount'>): FinanceEntry => ({
  date: '2026-08-18',
  counterparty: 'Контрагент',
  description: 'Операция',
  ...overrides,
});

const stateWithFinance = (): AppState => ({
  ...structuredClone(seedState),
  budgetLines: [
    { id: 'shared', name: 'Общая статья', stageIds: ['foundation', 'floor'], plan: 1_000, forecast: 1_200 },
    { id: 'foundation-only', name: 'Фундамент', stageIds: ['foundation'], plan: 300, forecast: 400 },
    { id: 'other', name: 'Другой этап', stageIds: ['roof'], plan: 9_000, forecast: 10_000 },
  ],
  financeEntries: [
    entry({ id: 'accepted-legacy', kind: 'expense', status: 'accepted', amount: 500, stageId: 'foundation' }),
    entry({ id: 'paid-legacy', kind: 'expense', status: 'paid', amount: 300, stageId: 'foundation' }),
    entry({ id: 'partial', kind: 'expense', status: 'accepted', amount: 400, acceptedAmount: 250, paidAmount: 100, stageId: 'foundation' }),
    entry({ id: 'income-paid', kind: 'income', status: 'paid', amount: 700, paidAmount: 450, stageId: 'foundation' }),
    entry({ id: 'income-legacy', kind: 'income', status: 'paid', amount: 200, stageId: 'foundation' }),
    entry({ id: 'other-stage', kind: 'expense', status: 'paid', amount: 8_000, stageId: 'roof' }),
  ],
});

test('stage finance totals allocate shared budgets and apply compatible amount fallbacks', () => {
  assert.deepEqual(stageFinanceTotals(stateWithFinance(), 'foundation'), {
    plan: 800,
    forecast: 1_000,
    committed: 1_200,
    accepted: 1_050,
    paid: 400,
    billed: 900,
    received: 650,
  });
});

test('stage finance totals exclude budgets and operations from other stages', () => {
  assert.deepEqual(stageFinanceTotals(stateWithFinance(), 'unknown'), {
    plan: 0,
    forecast: 0,
    committed: 0,
    accepted: 0,
    paid: 0,
    billed: 0,
    received: 0,
  });
});
