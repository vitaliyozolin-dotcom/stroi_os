import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBankStatement } from '../src/domain/banking/statement.ts';
import { bankIdentityNamespace, buildBankReconciliation, type BankReconciliationState, type BankRowSelection } from '../src/domain/banking/reconciliation.ts';
import { emptyFinanceLedger, ledgerEffect, validateFinanceLedgerChanges } from '../src/domain/finance-ledger.js';
import { financeCashMovementRows } from '../src/domain/finance.ts';
import type { LedgerOperation } from '../src/entities/index.ts';

const fixture = (): BankReconciliationState => ({ project: { id: 'synthetic-project' }, financeEntries: [], financeLedger: emptyFinanceLedger(), treasury: { version: 1, enabled: true, accounts: [{ id: 'bank-a', name: 'Bank A', currency: 'RUB', legalEntityId: 'company', isProjectDedicated: true }, { id: 'bank-b', name: 'Bank B', currency: 'RUB', legalEntityId: 'company', isProjectDedicated: true }], entryPlans: [], costEstimates: [] } });
const options = { accountId: 'bank-a', fileName: 'synthetic.csv', fileSha256: 'a'.repeat(64), reason: 'Reviewed synthetic statement' };
const preview = (...rows: string[]) => parseBankStatement(`Date;Amount;ID;Purpose\n${rows.join('\n')}`);
const manual = (patch: Partial<LedgerOperation> = {}): LedgerOperation => ({ id: 'manual', kind: 'payment', date: '2026-10-20', amountCents: 10000, accountId: 'bank-a', counterparty: 'Vendor', description: 'Payment', source: 'Evidence', confirmation: 'confirmed', allocations: [], ...patch });

test('repeated and overlapping bank exports create exactly one cash operation per distinct bank ID', () => {
  const state = fixture(), original = structuredClone(state);
  const first = buildBankReconciliation(state, preview('2026-10-20;-100;one;First'), { 2: { action: 'new' } }, options);
  assert.deepEqual(state, original);
  const next = { ...state, financeLedger: first };
  assert.throws(() => buildBankReconciliation(next, preview('2026-10-20;-100;one;First'), { 2: { action: 'new' } }, options), /уже связано/);
  const overlapped = buildBankReconciliation(next, preview('2026-10-20;-100;one;First', '2026-10-20;-100;two;Second'), { 2: { action: 'skip' }, 3: { action: 'new' } }, options);
  assert.equal(overlapped.operations.length, 2);
  assert.equal(ledgerEffect({ ...next, financeLedger: overlapped }).cashMovements.reduce((sum, row) => sum + row.outflowCents, 0), 20000);
  assert.throws(() => buildBankReconciliation(next, preview('2026-10-20;-101;one;Changed'), { 2: { action: 'skip' } }, options), /другой датой, суммой/);
});

test('two distinct bank IDs cannot be concealed by matching the same manual payment twice', () => {
  const state = fixture(); state.financeLedger!.operations.push(manual());
  const original = structuredClone(state);
  assert.throws(() => buildBankReconciliation(state, preview('2026-10-20;-100;one;Payment', '2026-10-20;-100;two;Another payment'), { 2: { action: 'operation', operationId: 'manual' }, 3: { action: 'operation', operationId: 'manual' } }, options), /уже сверена/);
  assert.deepEqual(state, original, 'failed batch cannot leave the first row reconciled');
});

test('opposite bank legs reconcile one internal transfer without creating another transfer', () => {
  const state = fixture(); state.financeLedger!.operations.push(manual({ kind: 'transfer', toAccountId: 'bank-b' }));
  const first = buildBankReconciliation(state, preview('2026-10-20;-100;debit;Transfer'), { 2: { action: 'operation', operationId: 'manual' } }, options);
  const both = buildBankReconciliation({ ...state, financeLedger: first }, preview('2026-10-20;100;credit;Transfer'), { 2: { action: 'operation', operationId: 'manual' } }, { ...options, accountId: 'bank-b' });
  assert.equal(both.operations.length, 1); assert.equal(both.confirmations.length, 2);
  assert.deepEqual(both.confirmations.map(row => row.bankAccountId), ['bank-a', 'bank-b']);
  const candidate = { ...state, financeLedger: both };
  assert.equal(validateFinanceLedgerChanges(state, candidate, { role: 'management', name: 'Reviewer' }), '');
  assert.equal(ledgerEffect(candidate).cashMovements.reduce((sum, row) => sum + row.inflowCents - row.outflowCents, 0), 0);
});

test('reconciling a legacy receipt retains one cash movement and no new settlement', () => {
  const state = fixture();
  state.financeEntries = [{ id: 'income', kind: 'income', status: 'paid', amount: 100, paidAmount: 100, acceptedAmount: 0, date: '2026-10-01', paidAt: '2026-10-20', counterparty: 'Client', description: 'Receipt' }];
  const next = buildBankReconciliation(state, preview('2026-10-20;100;bank-id;Receipt'), { 2: { action: 'legacy', entryId: 'income', paymentId: 'legacy:income' } }, options);
  const candidate = { ...state, financeLedger: next };
  assert.equal(validateFinanceLedgerChanges(state, candidate, { role: 'management', name: 'Reviewer' }), '');
  assert.deepEqual(ledgerEffect(candidate).settlementsByEntry, []);
  assert.equal(ledgerEffect(candidate).cashMovements.length, 0);
  assert.equal(financeCashMovementRows(candidate).reduce((sum, row) => sum + row.inflowCents, 0), 10000);
});

test('wrong direction, invalid actions and parse errors fail atomically without changes', () => {
  const state = fixture(); state.financeLedger!.operations.push(manual());
  const original = structuredClone(state);
  assert.throws(() => buildBankReconciliation(state, preview('2026-10-20;100;credit;Wrong direction'), { 2: { action: 'operation', operationId: 'manual' } }, options), /не совпадает/);
  assert.throws(() => buildBankReconciliation(state, preview('2026-10-20;-100;one;Payment'), { 2: { action: 'surprise' } as unknown as BankRowSelection }, options), /допустимое действие/);
  assert.throws(() => buildBankReconciliation(state, preview('2026-10-20;-100;one;Payment', 'invalid;-100;two;Bad row'), { 2: { action: 'new' } }, options), /Частичный импорт не выполнен/);
  assert.deepEqual(state, original);
});

test('indistinguishable weak rows never collapse silently', () => {
  const state = fixture(), source = preview('2026-10-20;-100;;Same', '2026-10-20;-100;;Same');
  assert.throws(() => buildBankReconciliation(state, source, { 2: { action: 'new' }, 3: { action: 'skip' } }, options), /неоднозначный идентификатор/);
});

test('shared bank identity is stable across projects with different local account IDs', () => {
  const one = fixture(), two = fixture(); two.project!.id = 'another-project';
  one.treasury!.accounts[0].sharedAccountKey = 'same-company-bank';
  two.treasury!.accounts[0] = { ...two.treasury!.accounts[0], id: 'different-local-id', sharedAccountKey: 'same-company-bank' };
  assert.equal(bankIdentityNamespace(one, 'bank-a'), bankIdentityNamespace(two, 'different-local-id'));
  const data = preview('2026-10-20;-100;bank-id;Payment');
  const a = buildBankReconciliation(one, data, { 2: { action: 'new' } }, options);
  const b = buildBankReconciliation(two, data, { 2: { action: 'new' } }, { ...options, accountId: 'different-local-id' });
  assert.equal(a.operations[0].sourceKey, b.operations[0].sourceKey, 'portfolio dedupe sees the same real bank transaction');
});
