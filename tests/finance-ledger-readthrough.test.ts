import test from 'node:test';
import assert from 'node:assert/strict';
import { seedState } from '../src/seed.ts';
import type { AppState, FinanceEntry, LedgerOperation } from '../src/entities/index.ts';
import { emptyFinanceLedger, ledgerEffect, validateFinanceLedgerChanges } from '../src/domain/finance-ledger.js';
import { financeTotals, stageFinanceTotals, paidAmountFor, settledAmountFor, outstandingAmountFor, payableAmountFor, effectiveBudgetLines } from '../src/domain/finance-totals.js';
import { financeCashMovementRows, paymentMovements } from '../src/domain/finance.ts';
import { financeActionError, validateFinanceChanges } from '../src/domain/finance/index.js';
import { financeFactsSnapshot, applyFinanceFactsResult } from '../src/infrastructure/finance-project.ts';
import { recordFinancePayment } from '../src/application/finance-context-facts.ts';
import { recordProjectPayment } from './support/finance-project.ts';
import { costGroupTotals } from '../src/domain/cost-groups.ts';

const now = '2026-10-28T12:00:00Z';
const actor = { role: 'management' as const, name: 'Reviewer' };
const context = () => { let serial = 0; return { identity: actor, clock: { now: () => now }, ids: { next: (prefix: string) => `${prefix}-${++serial}` } }; };
const entry = (id: string, patch: Partial<FinanceEntry> = {}): FinanceEntry => ({ id, kind: 'expense', amount: 100, status: 'committed', paidAmount: 0, acceptedAmount: 0, date: '2026-10-01', approvedAt: now, approvedBy: actor.name, description: id, counterparty: 'Synthetic vendor', stageId: 'stage', budgetLineId: 'budget', ...patch });
const fixture = (): AppState => ({ ...structuredClone(seedState), budgetLines: [{ id: 'budget', name: 'Work', plan: 200, forecast: 220, stageIds: ['stage'], costGroup: 'construction' }], financeEntries: [entry('a'), entry('b')], financeLedger: emptyFinanceLedger(), documents: [], treasury: { version: 1, enabled: true, accounts: [{ id: 'bank', name: 'Bank', legalEntityId: 'company', currency: 'RUB' }, { id: 'cash', name: 'Cash', legalEntityId: 'company', currency: 'RUB' }], entryPlans: [], costEstimates: [] } });
const operation = (id: string, amountCents: number, allocations: LedgerOperation['allocations'], patch: Partial<LedgerOperation> = {}): LedgerOperation => ({ id, kind: 'payment', amountCents, allocations, date: '2026-10-20', accountId: 'bank', counterparty: 'Synthetic vendor', description: id, source: 'Synthetic evidence', confirmation: 'confirmed', ...patch });
const fact = (amount: number) => ({ entryId: 'a', amount, date: '2026-10-28', document: 'ПП' });

test('cash, offsets, partial allocations and legacy reconciliation agree across every read total without mutation', () => {
  const state = fixture();
  state.financeEntries.push(entry('income', { kind: 'income', amount: 100, approvedAt: undefined }));
  state.financeEntries[0].paidAmount = 10;
  state.financeEntries[0].paidAt = '2026-10-20';
  state.financeLedger!.operations = [
    operation('split', 6000, [{ entryId: 'a', amountCents: 4000 }, { entryId: 'b', amountCents: 2000 }]),
    operation('offset', 3000, [{ entryId: 'a', amountCents: 3000 }, { entryId: 'income', amountCents: 3000 }], { kind: 'offset', accountId: undefined }),
    operation('same-legacy', 1000, [], { legacyPayment: { entryId: 'a', paymentId: 'legacy:a' }, confirmation: 'reconciled' }),
    operation('assertion', 1000, [{ entryId: 'a', amountCents: 1000 }], { confirmation: 'claimed' }),
  ];
  const before = structuredClone(state), a = state.financeEntries[0];
  assert.equal(paidAmountFor(a), 10, 'raw command aggregate remains available');
  assert.equal(paidAmountFor(a, state), 50);
  assert.equal(settledAmountFor(a, state), 80);
  assert.equal(outstandingAmountFor(a, state), 20);
  assert.equal(financeTotals(state).paid, 70);
  assert.equal(financeTotals(state).received, 0, 'offset is not revenue or incoming cash');
  assert.equal(stageFinanceTotals(state, 'stage').paid, 70);
  assert.equal(costGroupTotals(state).construction.paid, 70);
  assert.equal(paymentMovements(a, state).reduce((sum, row) => sum + row.amount, 0), 50);
  assert.deepEqual(state, before);
});

test('old UI commands and trusted validator cannot bypass ledger settlement or held retention', () => {
  const state = fixture();
  state.financeLedger!.operations.push(operation('partial', 6000, [{ entryId: 'a', amountCents: 6000 }]));
  state.financeLedger!.retentions.push({ id: 'hold', entryId: 'a', amountCents: 2000, status: 'held', source: 'Contract' });
  assert.equal(outstandingAmountFor(state.financeEntries[0], state), 40);
  assert.equal(payableAmountFor(state.financeEntries[0], state), 20);
  assert.notEqual(financeActionError(state, state.financeEntries[0], 'pay', 20.01, '2026-10-28', 'ПП', ''), '');
  assert.equal(recordProjectPayment(state, fact(20.01), context()).ok, false, 'scoped repository must retain ledger read dependency');
  const forged = structuredClone(state);
  Object.assign(forged.financeEntries[0], { paidAmount: 21, paidAt: '2026-10-28', paymentDocument: 'ПП' });
  assert.match(validateFinanceChanges(state, forged, actor, now), /удержанную/);
  forged.financeEntries[0].paidAmount = 50;
  assert.match(validateFinanceChanges(state, forged, actor, now), /остаток/);
  const valid = recordProjectPayment(state, fact(20), context());
  assert.ok(valid.ok && valid.change);
  if (!valid.ok || !valid.change) return;
  assert.equal(validateFinanceChanges(state, valid.change.state, actor, now), '');
  assert.equal(valid.change.state.financeEntries[0].paidAmount, 20, 'never synthesize ledger amounts into legacy aggregate');
  assert.equal(paidAmountFor(valid.change.state.financeEntries[0], valid.change.state), 80);
});

test('documented refund restores debt and permits a new payment without reducing or rewriting lifetime legacy cash', () => {
  const state = fixture();
  state.financeEntries[0] = entry('a', { paidAmount: 100, status: 'paid', paidAt: '2026-10-10' });
  state.financeLedger!.operations.push(operation('refund', 3000, [{ entryId: 'a', amountCents: 3000 }], { kind: 'supplier_refund', refundOfLegacyPayment: { entryId: 'a', paymentId: 'legacy:a' } }));
  assert.equal(paidAmountFor(state.financeEntries[0], state), 70);
  assert.equal(outstandingAmountFor(state.financeEntries[0], state), 30);
  const result = recordProjectPayment(state, fact(30), context());
  assert.ok(result.ok && result.change);
  if (!result.ok || !result.change) return;
  const next = result.change.state;
  assert.equal(validateFinanceChanges(state, next, actor, now), '');
  assert.equal(validateFinanceLedgerChanges(state, next, actor, now), '');
  assert.equal(next.financeEntries[0].paidAmount, 130);
  assert.equal(next.financeEntries[0].legacyPayment?.amount, 100);
  assert.equal(next.financeEntries[0].payments?.[0].amount, 30);
  assert.equal(paidAmountFor(next.financeEntries[0], next), 100);
  assert.equal(outstandingAmountFor(next.financeEntries[0], next), 0);
  assert.equal(paymentMovements(next.financeEntries[0], next).reduce((sum, row) => sum + row.amount, 0), 100);
});

test('ledger changes between evaluation and commit invalidate old payment drafts without overwriting them', () => {
  const state = fixture();
  const result = recordFinancePayment(financeFactsSnapshot(state), fact(100), context());
  state.financeLedger!.operations.push(operation('concurrent', 10000, [{ entryId: 'a', amountCents: 10000 }]));
  const before = structuredClone(state);
  assert.equal(applyFinanceFactsResult(state, result).ok, false);
  assert.deepEqual(state, before);
});

test('loan principal and paired internal transfers change account cash without operating revenue or cost', () => {
  const state = fixture();
  state.financeLedger!.loans.push({ id: 'loan', name: 'Loan', counterparty: 'Lender', direction: 'borrowed', accountId: 'bank', principalCents: 100000, source: 'Contract', status: 'active', schedule: [] });
  state.financeLedger!.operations.push(operation('draw', 100000, [], { kind: 'loan_drawdown', loanId: 'loan' }), operation('move', 30000, [], { kind: 'transfer', toAccountId: 'cash' }));
  const effects = ledgerEffect(state), total = financeTotals(state);
  assert.equal(total.paid, 0); assert.equal(total.received, 0);
  assert.equal(effects.cashMovements.reduce((sum, row) => sum + row.inflowCents - row.outflowCents, 0), 100000);
  assert.equal(effects.cashMovements.filter(row => row.kind === 'transfer').reduce((sum, row) => sum + row.inflowCents - row.outflowCents, 0), 0);
});

test('historical cash chart uses whole cash operations once, including unallocated cash and loans, excluding offsets and direct participant payments', () => {
  const state = fixture();
  state.financeEntries[0].paidAmount = 10;
  state.financeEntries[0].paidAt = '2026-10-20';
  state.financeEntries[1].paidAmount = 20;
  state.financeEntries[1].paidAt = '2026-10-20';
  state.treasury!.entryPlans = [{ entryId: 'b', source: 'Participant evidence', tranches: [], cashTreatment: 'participant_direct' }];
  state.financeLedger!.operations = [
    operation('split', 6000, [{ entryId: 'a', amountCents: 1000 }, { entryId: 'b', amountCents: 2000 }]),
    operation('legacy-reconcile', 1000, [], { legacyPayment: { entryId: 'a', paymentId: 'legacy:a' } }),
    operation('direct', 1000, [{ entryId: 'a', amountCents: 1000 }], { cashTreatment: 'participant_direct' }),
    operation('draw', 100000, [], { kind: 'loan_drawdown' }),
    operation('transfer', 3000, [], { kind: 'transfer', toAccountId: 'cash' }),
  ];
  const rows = financeCashMovementRows(state);
  assert.equal(rows.reduce((sum, row) => sum + row.outflowCents, 0), 10000, 'legacy 1000 + whole payment 6000 + transfer 3000');
  assert.equal(rows.reduce((sum, row) => sum + row.inflowCents, 0), 103000, 'loan plus second transfer leg');
});

test('active budget version controls plan across summary, stages and categories without replacing source lines or forecasts', () => {
  const state = fixture();
  state.treasury!.budgetVersions = [{ id: 'v2', name: 'Approved version', source: 'Decision', taxBasis: 'gross', taxNote: 'VAT included', lines: [{ id: 'budget', name: 'Revised work', amountCents: 30000 }, { id: 'additional', name: 'Additional scope', amountCents: 5000 }], approvedAt: now, approvedBy: actor.name }];
  state.treasury!.activeBudgetVersionId = 'v2';
  const before = structuredClone(state);
  assert.equal(financeTotals(state).plan, 350);
  assert.equal(stageFinanceTotals(state, 'stage').plan, 300);
  assert.equal(costGroupTotals(state).construction.plan, 300);
  assert.equal(costGroupTotals(state).unallocated.plan, 50);
  assert.equal(effectiveBudgetLines(state)[0].forecast, 220, 'a budget revision does not invent a revised cost estimate');
  assert.deepEqual(state, before);
});
