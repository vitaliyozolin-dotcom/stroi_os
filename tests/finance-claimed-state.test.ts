import test from 'node:test';
import assert from 'node:assert/strict';
import { seedState } from '../src/seed.ts';
import type { AppState } from '../src/entities/index.ts';
import { paidAmountFor, payableAmountFor, outstandingAmountFor, financeTotals } from '../src/domain/finance-totals.js';
import { paymentMovements } from '../src/domain/finance.ts';
import { validateFinanceChanges } from '../src/domain/finance/index.js';
import { financeFactsSnapshot, applyFinanceFactsResult } from '../src/infrastructure/finance-project.ts';
import { recordFinancePayment } from '../src/application/finance-context-facts.ts';
const now = '2026-10-28T12:00:00Z', actor = { name: 'Owner', role: 'management' as const };
const context = { identity: actor, clock: { now: () => now }, ids: { next: (prefix: string) => `${prefix}-claimed-test` } };
const fixture = (): AppState => ({ ...structuredClone(seedState), financeLedger: undefined, financeEntries: [{ id: 'e', kind: 'expense', status: 'paid', amount: 100, acceptedAmount: 0, paidAmount: 100, paidAt: '2026-10-20', date: '2026-10-01', description: 'Work', counterparty: 'Vendor', approvedAt: now }],
  treasury: { version: 1, enabled: true, accounts: [{ id: 'bank', name: 'Bank', currency: 'RUB', legalEntityId: 'company' }], costEstimates: [], entryPlans: [{ entryId: 'e', source: 'Claim', tranches: [], paymentFacts: [{ paymentId: 'legacy:e', confirmation: 'claimed', cashTreatment: 'account', accountId: 'bank', source: 'Unconfirmed assertion' }] }] } });
const input = (amount: number) => ({ entryId: 'e', amount, date: '2026-10-28', document: 'ПП' });

test('treasury-only unconfirmed legacy facts agree across cards, remaining debt, history and payment command without changing raw history', () => {
  const state = fixture(), entry = state.financeEntries[0];
  assert.equal(paidAmountFor(entry), 100); assert.equal(paidAmountFor(entry, state), 0); assert.equal(payableAmountFor(entry, state), 100); assert.equal(outstandingAmountFor(entry, state), 100); assert.equal(financeTotals(state).paid, 0);
  assert.equal(paymentMovements(entry, state).length, 0); assert.equal(paymentMovements(entry).length, 1);
  const result = recordFinancePayment(financeFactsSnapshot(state), input(100), context); assert.ok(result.ok && result.change);
  const applied = applyFinanceFactsResult(state, result); assert.ok(applied.ok && applied.change); if (!applied.ok || !applied.change) return;
  const next = applied.change.state; assert.equal(validateFinanceChanges(state, next, actor, now), '');
  assert.equal(next.financeEntries[0].paidAmount, 200); assert.equal(next.financeEntries[0].legacyPayment?.amount, 100); assert.equal(paidAmountFor(next.financeEntries[0], next), 100);
  assert.deepEqual(paymentMovements(next.financeEntries[0], next).map(row => row.amount), [100]);
  const confirmed = structuredClone(next); confirmed.treasury!.entryPlans[0].paymentFacts![0].confirmation = 'confirmed';
  assert.match(validateFinanceChanges(next, confirmed, actor, now), /превышает обязательство/);
});

test('unconfirmed legacy reference cannot absorb an excessive new payment and confirmation change invalidates an old command snapshot', () => {
  const state = fixture(), forged = structuredClone(state); forged.financeEntries[0].paidAmount = 201; forged.financeEntries[0].paidAt = '2026-10-28'; forged.financeEntries[0].paymentDocument = 'ПП';
  assert.match(validateFinanceChanges(state, forged, actor, now), /остаток/); assert.equal(forged.financeEntries[0].payments, undefined);
  const result = recordFinancePayment(financeFactsSnapshot(state), input(100), context);
  state.treasury!.entryPlans[0].paymentFacts![0].confirmation = 'confirmed'; assert.equal(applyFinanceFactsResult(state, result).ok, false);
});

test('mapped loan interest cannot be paid through legacy command or raw server write, even with several schedule links', () => {
  const state = fixture(); state.financeEntries[0].paidAmount = 0; state.financeEntries[0].status = 'committed'; state.treasury!.entryPlans[0].paymentFacts = [];
  state.financeLedger = { version: 1, operations: [], confirmations: [], requests: [], retentions: [], loans: [{ id: 'loan', name: 'Loan', counterparty: 'Owner', direction: 'borrowed', accountId: 'bank', principalCents: 100000, source: 'Agreement', status: 'active', schedule: [
    { id: 'first-interest', kind: 'interest', entryId: 'e', amountCents: 5000, date: '2026-10-28' }, { id: 'second-interest', kind: 'interest', entryId: 'e', amountCents: 5000, date: '2026-11-28' },
  ] }] };
  const result = recordFinancePayment(financeFactsSnapshot(state), input(50), context); assert.equal(result.ok, false); if (!result.ok) assert.match(result.error, /Проценты по займу/);
  const forged = structuredClone(state); Object.assign(forged.financeEntries[0], { paidAmount: 50, paidAt: '2026-10-28', paymentDocument: 'ПП' }); assert.match(validateFinanceChanges(state, forged, actor, now), /Проценты по займу/);
});
