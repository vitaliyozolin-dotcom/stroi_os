import test from 'node:test';
import assert from 'node:assert/strict';
import { seedState } from '../src/seed.ts';
import { financeWorkspaceSummary } from '../src/domain/finance-workspace.js';
import { validateBudgetPlanningChanges } from '../src/domain/finance/planning.js';
import { financeCalendarItems } from '../src/domain/finance-calendar.ts';
import { emptyTreasury } from '../src/domain/treasury.js';

const today = '2026-11-17';
const fixture = () => {
  const state = structuredClone(seedState);
  state.budgetMeta = { version: 'Source', source: 'Contract annex' };
  state.project.contractValue = 9_500_000;
  state.budgetLines = [{ id: 'build', name: 'House', stageIds: [], plan: 9_500_000, forecast: 9_500_000 }];
  state.financeEntries = [];
  state.treasury = emptyTreasury();
  delete state.financeLedger;
  return state;
};

test('unclassified or commercial estimate cannot become internal cost or profit by equality with contract', () => {
  const state = fixture();
  const before = structuredClone(state);
  let result = financeWorkspaceSummary(state, today);
  assert.equal(result.contractCents, 950_000_000);
  assert.equal(result.internalBudgetCents, null);
  assert.equal(result.forecastResultCents, null);
  assert.equal(result.availableCashCents, null);
  assert.equal(result.paidCents, null);
  assert.equal(result.needs14Cents, null);
  assert.deepEqual(state, before);
  state.budgetMeta.estimateKind = 'commercial';
  state.budgetMeta.classificationSource = 'Customer estimate';
  result = financeWorkspaceSummary(state, today);
  assert.equal(result.commercialEstimateCents, 950_000_000);
  assert.equal(result.internalBudgetCents, null);
  assert.equal(result.forecastCents, null);
});

test('contract, customer estimate and internal cost remain independent and explicit zero is known', () => {
  const state = fixture();
  state.budgetLines[0].plan = 6_000_000;
  state.budgetMeta = { ...state.budgetMeta, estimateKind: 'internal_cost', classificationSource: 'Estimator', commercialEstimate: { amountCents: 920_000_000, version: 'v1', source: 'Proposal' } };
  let result = financeWorkspaceSummary(state, today);
  assert.equal(result.contractCents, 950_000_000);
  assert.equal(result.commercialEstimateCents, 920_000_000);
  assert.equal(result.internalBudgetCents, 600_000_000);
  assert.equal(result.internalBudgetApproved, false);
  state.budgetMeta.approvedAt = '2026-11-16T12:00:00Z';
  state.budgetLines[0].plan = 0;
  result = financeWorkspaceSummary(state, today);
  assert.equal(result.internalBudgetCents, 0);
  assert.equal(result.internalBudgetApproved, true);
  state.project.unknownFields = ['contractValue']; state.project.contractValue = 0;
  assert.equal(financeWorkspaceSummary(state, today).contractCents, null);
});

test('14-day needs use unpaid amounts and keep undated commitments visible without pretending completeness', () => {
  const state = fixture();
  const base = { kind: 'expense' as const, status: 'committed' as const, counterparty: 'Supplier', description: 'Materials', amount: 200, date: today };
  state.financeEntries = [
    { ...base, id: 'inside', dueDate: '2026-11-30', paidAmount: 80 },
    { ...base, id: 'outside', dueDate: '2026-12-01' },
    { ...base, id: 'unknown' },
    { ...base, id: 'overdue', dueDate: '2026-11-01', paidAmount: 150 },
  ];
  const result = financeWorkspaceSummary(state, today);
  assert.equal(result.needs14Cents, 17000);
  assert.equal(result.undatedExpenseCents, 20000);
  assert.equal(result.cashComplete, false);
  const items = financeCalendarItems(state, today, 14);
  assert.equal(items.find(item => item.id === 'inside')?.group, 'next7');
  assert.equal(items.find(item => item.id === 'outside')?.group, 'later');
  assert.throws(() => financeCalendarItems(state, today, 0), /horizon/);
});

test('escrow restrictions and unallocated shared balance cannot inflate available project money', () => {
  const state = fixture();
  state.treasury = { ...emptyTreasury(), enabled: true, accounts: [{ id: 'escrow', name: 'Escrow', currency: 'RUB', legalEntityId: 'company', isProjectDedicated: true, opening: { amountCents: 950_000_000, asOf: today, confirmed: true, source: 'Bank' }, restrictedCents: 950_000_000 }] };
  assert.equal(financeWorkspaceSummary(state, today).availableCashCents, 0);
  state.treasury.accounts = [{ id: 'shared', name: 'Company bank', currency: 'RUB', legalEntityId: 'company', isProjectDedicated: false, opening: { amountCents: 950_000_000, asOf: today, confirmed: true, source: 'Bank' } }];
  assert.equal(financeWorkspaceSummary(state, today).availableCashCents, null);
});

test('server rejects invalid estimate classification and documents outside the project', () => {
  const before = fixture();
  const state = structuredClone(before);
  state.budgetMeta.estimateKind = 'internal_cost';
  assert.match(validateBudgetPlanningChanges(before, state, { role: 'management' }), /основание/);
  state.budgetMeta.classificationSource = 'Estimator confirmed source';
  assert.equal(validateBudgetPlanningChanges(before, state, { role: 'management' }), '');
  assert.match(validateBudgetPlanningChanges(before, state, { role: 'foreman' }), /Управление/);
  state.budgetMeta.commercialEstimate = { amountCents: -1, version: 'v1', source: 'Proposal' };
  assert.match(validateBudgetPlanningChanges(before, state, { role: 'management' }), /Проверьте/);
  state.budgetMeta.commercialEstimate.amountCents = 100;
  state.budgetMeta.commercialEstimate.documentId = 'foreign-document';
  assert.match(validateBudgetPlanningChanges(before, state, { role: 'management' }), /не найден/);
});

test('initial internal estimate requires identifiable rows and local source document', () => {
  const before = fixture(); before.budgetLines = [];
  const next = structuredClone(before); next.budgetLines = [{ id: 'initial', name: 'Foundation', stageIds: [], plan: 400000, forecast: 400000 }];
  next.budgetMeta = { version: '1', source: 'Engineer estimate', estimateKind: 'internal_cost', classificationSource: 'Engineer estimate' };
  assert.equal(validateBudgetPlanningChanges(before, next, { name: 'Manager', role: 'management' }), '');
  next.budgetMeta.estimateDocumentId = 'foreign-document';
  assert.match(validateBudgetPlanningChanges(before, next, { name: 'Manager', role: 'management' }), /Документ/);
  delete next.budgetMeta.estimateDocumentId; next.budgetLines[0].name = '';
  assert.match(validateBudgetPlanningChanges(before, next, { name: 'Manager', role: 'management' }), /название/);
});
