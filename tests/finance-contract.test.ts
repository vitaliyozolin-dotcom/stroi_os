import test from 'node:test';
import assert from 'node:assert/strict';
import { seedState } from '../src/seed.ts';
import type { FinanceEntry } from '../src/entities/index.ts';
import { financeTotals, stageFinanceTotals, acceptedAmountFor, paidAmountFor } from '../src/domain/finance.ts';
import { buildIkiomaCompanyOsPayload } from '../sites/company-os-export.js';
import { buildIkiomaInvestorPayload } from '../sites/company-os-investor-export.js';

const entry = (overrides: Partial<FinanceEntry> = {}): FinanceEntry => ({
  id: 'synthetic', kind: 'expense', status: 'committed', amount: 100,
  date: '2026-10-01', counterparty: 'Synthetic supplier', description: 'Synthetic purchase', ...overrides,
});
const exportsFor = (state: typeof seedState) => {
  const args = { stateRows: [{ revision: 1, updated_at: '2026-10-06T12:00:00Z', state_json: JSON.stringify(state) }], generatedAt: '2026-10-06T12:00:00Z' };
  return [buildIkiomaCompanyOsPayload(args), buildIkiomaInvestorPayload(args)];
};

test('one snapshot has the same money contract in the workspace and both exports', () => {
  const state = structuredClone(seedState);
  state.budgetLines = [
    { id: 'b', name: 'Recorded purchase', plan: 100, forecast: 100, stageIds: ['one'] },
    { id: 'future', name: 'Remaining work', plan: 200, forecast: 250, stageIds: ['two'] },
    { id: 'shared', name: 'Shared work', plan: 60, forecast: 60, stageIds: ['one', 'two'] },
    { id: 'reserve', name: 'Reserve', plan: 50, forecast: 50, stageIds: [], costGroup: 'reserve' },
  ];
  state.financeEntries = [
    entry({ id: 'historical', budgetLineId: 'b', stageId: 'one', amount: 150, status: 'paid', paidAmount: 150, acceptedAmount: 0 }),
    entry({ id: 'explicit-zero', budgetLineId: 'shared', stageId: 'one', amount: 10, status: 'paid', paidAmount: 0, acceptedAmount: 0 }),
    { ...entry({ id: 'legacy-null', budgetLineId: 'b', stageId: 'one', amount: 20, status: 'paid' }), paidAmount: null, acceptedAmount: null } as unknown as FinanceEntry,
    entry({ id: 'unallocated', stageId: 'one', amount: 30, status: 'accepted', paidAmount: 10, acceptedAmount: 20 }),
    entry({ id: 'orphan', budgetLineId: 'missing', stageId: 'two', amount: 15, paidAmount: 0, acceptedAmount: 0 }),
    entry({ id: 'income', kind: 'income', amount: 100, status: 'paid', paidAmount: 40 }),
  ];
  const original = structuredClone(state);
  const totals = financeTotals(state);
  assert.deepEqual(totals, { plan: 410, forecast: 575, storedForecast: 460, committed: 225, accepted: 40, paid: 180, received: 40, contractedIncome: 100 });
  for (const payload of exportsFor(state)) {
    assert.equal(payload.meta.finance_rules_version, 2);
    const row = payload.investor_projects[0];
    assert.equal(row.forecast_cost_rub, totals.forecast);
    assert.equal(row.accepted_cost_rub, totals.accepted);
    assert.equal(row.paid_cost_rub, totals.paid);
    assert.equal(row.total_committed_cost_rub, totals.committed);
    assert.equal(row.outstanding_cost_rub, 45);
  }
  const financeExport = exportsFor(state)[0].finance_projects[0];
  const [general, investor] = exportsFor(state);
  assert.equal(general.investor_projects[0].committed_cost_rub, 225, 'general export retains its full-commitment compatibility alias');
  assert.equal(investor.investor_projects[0].committed_cost_rub, 45, 'investor export retains its unpaid-remainder compatibility alias');
  assert.equal(financeExport.commitments.reduce((sum: number, row: { amount_rub: number }) => sum + row.amount_rub, 0), 45);
  assert.equal(financeExport.confirmed_inflows[0].amount_rub, 60);
  assert.equal(financeExport.confirmed_inflows[0].due_date, null, 'document date must never become a planned payment date');
  assert.ok(financeExport.commitments.every((row: { due_date: string | null }) => row.due_date === null));
  assert.equal(stageFinanceTotals(state, 'one').forecast, 230);
  assert.equal(stageFinanceTotals(state, 'two').forecast, 295);
  assert.equal(stageFinanceTotals(state, 'one').forecast + stageFinanceTotals(state, 'two').forecast + 50, totals.forecast);
  assert.deepEqual(state, original, 'read-only calculations must never rewrite imported facts or plans');
});

test('exported payment deadlines use only explicit valid planned dates', () => {
  const state = structuredClone(seedState);
  state.financeEntries = [
    { ...entry({ id: 'dated' }), dueDate: '2026-11-01' },
    { ...entry({ id: 'invalid', kind: 'income' }), dueDate: '2026-02-30' },
  ];
  const row = exportsFor(state)[0].finance_projects[0];
  assert.equal(row.commitments[0].due_date, '2026-11-01');
  assert.equal(row.confirmed_inflows[0].due_date, null);
});

test('explicit zero is retained while null and absent legacy amounts use status fallbacks', () => {
  for (const amount of [null, undefined]) {
    const legacy = { ...entry({ status: 'paid', amount: 100 }), paidAmount: amount, acceptedAmount: amount } as unknown as FinanceEntry;
    assert.equal(paidAmountFor(legacy), 100);
    assert.equal(acceptedAmountFor(legacy), 100);
  }
  const zero = entry({ status: 'paid', amount: 100, paidAmount: 0, acceptedAmount: 0 });
  assert.equal(paidAmountFor(zero), 0);
  assert.equal(acceptedAmountFor(zero), 0);
});

test('empty or unspent budgets and unallocated expenses are not replaced by project target costs', () => {
  const state = structuredClone(seedState);
  state.project.targetCost = 999;
  state.budgetLines = [{ id: 'planned', name: 'Remaining planned work', plan: 100, forecast: 120, stageIds: ['one'] }];
  state.financeEntries = [];
  for (const payload of exportsFor(state)) assert.equal(payload.investor_projects[0].forecast_cost_rub, 120);
  state.budgetLines = [];
  for (const payload of exportsFor(state)) assert.equal(payload.investor_projects[0].forecast_cost_rub, financeTotals(state).forecast);
  state.financeEntries = [entry({ amount: 25, status: 'paid', acceptedAmount: 0 })];
  for (const payload of exportsFor(state)) {
    const row = payload.investor_projects[0];
    assert.equal(row.forecast_cost_rub, 25);
    assert.equal(row.accepted_cost_rub, 0);
    assert.equal(row.paid_cost_rub, 25);
    assert.equal(row.total_committed_cost_rub, 25);
    assert.equal(row.outstanding_cost_rub, 0);
  }
});
