import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyFinanceLedger, effectiveLedgerConfirmation, ledgerEffect, ledgerEntryBalance, validateFinanceLedgerChanges, validateFinanceLedgerShape, type LedgerProject } from '../src/domain/finance-ledger.js';
import { createFinanceLedgerUseCases, financeLedgerSnapshot } from '../src/application/finance-ledger.ts';
import { createProjectFinanceLedgerRepository, financeLedgerReadModel } from '../src/infrastructure/finance-ledger-project.ts';
import type { AppState, LedgerOperation, LedgerLoan, LedgerPaymentRequest } from '../src/entities/index.ts';
const identity = { role: 'management', name: 'Управление', id: 'owner' }, now = '2026-10-28T12:00:00Z';
const fixture = (): LedgerProject => ({ project: { id: 'test-project' }, financeEntries: [
  { id: 'expense', kind: 'expense', amount: 1000, paidAmount: 0, approvedAt: '2026-10-01', description: 'Работы' },
  { id: 'expense2', kind: 'expense', amount: 500, paidAmount: 0, approvedAt: '2026-10-01', description: 'Материалы' },
  { id: 'income', kind: 'income', amount: 2000, paidAmount: 0, description: 'Расчёт заказчика' },
], treasury: { version: 1, enabled: true, accounts: [
  { id: 'bank', name: 'Основной', legalEntityId: 'company', currency: 'RUB', isProjectDedicated: true },
  { id: 'cash', name: 'Касса', legalEntityId: 'company', currency: 'RUB', isProjectDedicated: true },
], costEstimates: [], entryPlans: [] }, financeLedger: { ...emptyFinanceLedger(), changeReason: 'Уточнение расчётов' }, documents: [] });
const payment = (extra: Partial<LedgerOperation> = {}): LedgerOperation => ({ id: 'operation', kind: 'payment', date: '2026-10-20', amountCents: 100000,
  accountId: 'bank', counterparty: 'Подрядчик', description: 'Оплата по договору', source: 'ПП', confirmation: 'confirmed', allocations: [{ entryId: 'expense', amountCents: 100000 }], ...extra });
const verify = (before: LedgerProject, after: LedgerProject, time?: string) => validateFinanceLedgerChanges(before, after, identity, time);

test('one operation settles several obligations and moves company cash exactly once', () => {
  const state = fixture(), next = structuredClone(state); next.financeLedger!.operations = [payment({ allocations: [{ entryId: 'expense', amountCents: 60000 }, { entryId: 'expense2', amountCents: 40000 }] })];
  assert.equal(verify(state, next), ''); const effect = ledgerEffect(next, { today: '2026-10-28' });
  assert.equal(effect.cashMovements.length, 1); assert.equal(effect.cashMovements[0].outflowCents, 100000);
  assert.equal(ledgerEntryBalance(next, 'expense')!.remainingCents, 40000);
  assert.equal(ledgerEntryBalance(next, 'expense2')!.remainingCents, 10000);
});

test('claimed facts close nothing; append-only confirmation activates that same operation', () => {
  const state = fixture(); state.financeLedger!.operations = [payment({ confirmation: 'claimed' })];
  assert.equal(ledgerEntryBalance(state, 'expense')!.remainingCents, 100000); assert.equal(ledgerEffect(state).cashMovements.length, 0);
  const next = structuredClone(state); next.financeLedger!.confirmations.push({ id: 'confirm', operationId: 'operation', confirmation: 'confirmed', source: 'Подтверждение ответственного' });
  assert.equal(verify(state, next), ''); assert.equal(ledgerEntryBalance(next, 'expense')!.remainingCents, 0); assert.equal(ledgerEffect(next).cashMovements.length, 1);
  assert.equal(effectiveLedgerConfirmation(next.financeLedger, next.financeLedger!.operations[0]), 'confirmed');
});

test('unallocated remainder can be assigned later without rewriting the bank event', () => {
  const state = fixture(); state.financeLedger!.operations = [payment({ allocations: [{ entryId: 'expense', amountCents: 50000 }] })];
  const next = structuredClone(state); next.financeLedger!.allocationEvents!.push({ id: 'allocate', operationId: 'operation', source: 'Разнесено по счёту', allocations: [{ entryId: 'expense2', amountCents: 50000 }] });
  assert.equal(verify(state, next), ''); assert.equal(ledgerEffect(next).cashMovements.length, 1); assert.equal(ledgerEntryBalance(next, 'expense2')!.remainingCents, 0);
  const tooMuch = structuredClone(next); tooMuch.financeLedger!.allocationEvents![0].allocations[0].amountCents++;
  assert.match(verify(state, tooMuch), /Распределение превышает/);
});

test('operation and confirmation history cannot be edited, removed or reordered', () => {
  const state = fixture(); state.financeLedger!.operations = [payment()];
  for (const mutate of [(s: LedgerProject) => { s.financeLedger!.operations[0].amountCents = 1; }, (s: LedgerProject) => { s.financeLedger!.operations = []; }]) {
    const next = structuredClone(state); mutate(next); assert.match(verify(state, next), /неизменны/);
  }
});

test('balanced noncash offset reduces both debts and is never labeled paid cash', () => {
  const state = fixture(), next = structuredClone(state); next.financeLedger!.operations = [payment({ kind: 'offset', accountId: undefined, amountCents: 30000, allocations: [{ entryId: 'expense', amountCents: 30000 }, { entryId: 'income', amountCents: 30000 }] })];
  assert.equal(verify(state, next), ''); assert.equal(ledgerEffect(next).cashMovements.length, 0);
  const balance = ledgerEntryBalance(next, 'expense')!; assert.equal(balance.remainingCents, 70000); assert.equal(balance.cashSettledCents, 0); assert.equal(balance.nonCashSettledCents, 30000);
  next.financeLedger!.operations[0].allocations[1].amountCents = 20000; assert.match(verify(state, next), /в равной сумме/);
});

test('supplier refund restores the precise remaining debt and never rewrites the original payment', () => {
  const state = fixture(); state.financeLedger!.operations = [payment()]; const next = structuredClone(state);
  next.financeLedger!.operations.push(payment({ id: 'refund', kind: 'supplier_refund', date: '2026-10-22', amountCents: 20000, refundOfOperationId: 'operation', allocations: [{ entryId: 'expense', amountCents: 20000 }] }));
  assert.equal(verify(state, next), ''); const balance = ledgerEntryBalance(next, 'expense')!; assert.equal(balance.remainingCents, 20000); assert.equal(balance.cashSettledCents, 80000);
  assert.equal(ledgerEffect(next).cashMovements[1].inflowCents, 20000); assert.deepEqual(next.financeLedger!.operations[0], state.financeLedger!.operations[0]);
  const bad = structuredClone(next); bad.financeLedger!.operations[1].allocations[0].entryId = 'expense2'; assert.match(verify(state, bad), /исходной оплате/);
  const excess = structuredClone(next); excess.financeLedger!.operations[1].amountCents = 100001; assert.match(verify(state, excess), /превышает исходную/);
});

test('legacy bank match supplies a fact mapping without a second cash or settlement event', () => {
  const state = fixture(); state.financeEntries[0].paidAmount = 1000;
  state.financeEntries[0].payments = [{ id: 'old', amount: 1000, date: '2026-10-20', document: 'ПП', recordedAt: now, recordedBy: 'Управление' }];
  const next = structuredClone(state); next.financeLedger!.operations = [payment({ confirmation: 'reconciled', sourceKey: 'bank:1', legacyPayment: { entryId: 'expense', paymentId: 'old' }, allocations: [] })];
  assert.equal(verify(state, next), ''); const effect = ledgerEffect(next); assert.equal(effect.cashMovements.length, 0); assert.equal(effect.settlementsByEntry.length, 0); assert.equal(effect.legacyFacts.length, 1);
  assert.equal(ledgerEntryBalance(next, 'expense')!.settledCents, 100000);
  const duplicate = structuredClone(next); duplicate.financeLedger!.operations.push(payment({ id: 'second', confirmation: 'reconciled', sourceKey: 'bank:2', legacyPayment: { entryId: 'expense', paymentId: 'old' }, allocations: [] }));
  assert.match(verify(state, duplicate), /Сверка должна/);
});

test('legacy refund and repayment keep gross history while net settlement respects the obligation', () => {
  const state = fixture(); state.financeEntries[0].paidAmount = 1000; state.financeEntries[0].paidAt = '2026-10-20';
  const next = structuredClone(state); next.financeLedger!.operations = [payment({ id: 'refund', kind: 'supplier_refund', date: '2026-10-22', amountCents: 20000, refundOfLegacyPayment: { entryId: 'expense', paymentId: 'legacy:expense' }, allocations: [{ entryId: 'expense', amountCents: 20000 }] })];
  assert.equal(verify(state, next), ''); assert.equal(ledgerEntryBalance(next, 'expense')!.payableCents, 20000);
  const repaid = structuredClone(next); repaid.financeEntries[0].paidAmount = 1200;
  // Preserve the original legacy identity by introducing the new detailed payment, as normal commands do.
  repaid.financeEntries[0].payments = [{ id: 'new-payment', amount: 200, date: '2026-10-23', document: 'ПП', recordedAt: now, recordedBy: 'Управление' }];
  // Legacy aggregate date becomes unknown after a partial payment: explicit historical reference must stay stable.
  repaid.financeEntries[0].legacyPayment = { amount: 1000, lastRecordedDate: '2026-10-20' };
  assert.equal(ledgerEntryBalance(repaid, 'expense')!.settledCents, 100000);
  assert.equal(verify(next, repaid), '');
});

const loan = (): LedgerLoan => ({ id: 'loan', name: 'Заём участника', counterparty: 'Участник', direction: 'borrowed', accountId: 'bank', principalCents: 500000, source: 'Договор займа', status: 'active', schedule: [
  { id: 'draw', kind: 'drawdown', date: '2026-10-20', amountCents: 500000 }, { id: 'principal', kind: 'principal', date: '2026-11-20', amountCents: 500000 }, { id: 'interest', kind: 'interest', date: '2026-11-20', amountCents: 10000 },
] });
test('loan principal affects cash/debt, not project obligations, while schedule uses exact matching IDs', () => {
  const state = fixture(), next = structuredClone(state); next.financeLedger!.loans = [loan()];
  next.financeLedger!.operations = [payment({ kind: 'loan_drawdown', amountCents: 500000, allocations: [], loanId: 'loan', scheduleItemId: 'draw' })];
  assert.equal(verify(state, next), ''); const effect = ledgerEffect(next, { today: '2026-10-28' });
  assert.equal(effect.cashMovements[0].inflowCents, 500000); assert.deepEqual(effect.settlementsByEntry, []); assert.equal(effect.loanBalances[0].principalCents, 500000);
  assert.deepEqual(effect.futureEvents.map(event => [event.kind, event.amountCents]), [['loan_repayment', 500000], ['interest', 10000]]);
  const bad = structuredClone(next); bad.financeLedger!.operations.push(payment({ id: 'overpay', kind: 'loan_repayment', amountCents: 500001, allocations: [], loanId: 'loan', date: '2026-10-25' }));
  assert.match(verify(state, bad), /возврат превышает долг/);
});

test('transfer has equal opposite account legs, no consolidated cash change, no revenue and no settlements', () => {
  const state = fixture(), next = structuredClone(state); next.financeLedger!.operations = [payment({ kind: 'transfer', toAccountId: 'cash', allocations: [] })];
  assert.equal(verify(state, next), ''); const effect = ledgerEffect(next); assert.equal(effect.cashMovements.length, 2);
  assert.equal(effect.cashMovements.reduce((value, event) => value + event.inflowCents - event.outflowCents, 0), 0); assert.equal(effect.settlementsByEntry.length, 0);
  next.treasury!.accounts[1].legalEntityId = 'other-company'; assert.match(verify(state, next), /одного юрлица/);
});

test('held retentions block ordinary and later allocation payments until explicitly released', () => {
  const state = fixture(); state.financeLedger!.retentions = [{ id: 'retention', entryId: 'expense', amountCents: 20000, status: 'held', source: 'Удержание по договору', releaseDate: '2026-11-20' }];
  assert.equal(ledgerEntryBalance(state, 'expense')!.payableCents, 80000);
  const overpay = structuredClone(state); overpay.financeLedger!.operations = [payment()]; assert.match(verify(state, overpay), /удержанную сумму/);
  const released = structuredClone(state); released.financeLedger!.retentions[0].status = 'released'; released.financeLedger!.operations = [payment({ amountCents: 20000, allocations: [{ entryId: 'expense', retentionId: 'retention', amountCents: 20000 }] })];
  assert.equal(verify(state, released), ''); assert.equal(ledgerEffect(released).retentionPlans[0].amountCents, 0);
  const unassigned = structuredClone(state); unassigned.financeLedger!.operations = [payment({ amountCents: 20000, allocations: [] })];
  const later = structuredClone(unassigned); later.financeLedger!.allocationEvents!.push({ id: 'later', operationId: 'operation', source: 'Разнесение', allocations: [{ entryId: 'expense', retentionId: 'retention', amountCents: 20000 }] });
  assert.match(verify(unassigned, later), /ещё не разрешено/);
});

test('request follows approval lifecycle and paid status requires an actual confirmed linked operation', () => {
  let state = fixture(); const request: LedgerPaymentRequest = { id: 'request', entryId: 'expense', amountCents: 100000, requestedDate: '2026-10-20', desiredDate: '2026-10-22', purpose: 'Расчёт', source: 'Счёт', status: 'draft', accountId: 'bank' };
  for (const status of ['draft', 'submitted', 'approved', 'scheduled', 'executing'] as const) {
    const next = structuredClone(state); next.financeLedger!.requests = [{ ...request, status }]; assert.equal(verify(state, next), ''); state = next;
  }
  const noPayment = structuredClone(state); noPayment.financeLedger!.requests[0].status = 'paid'; assert.match(verify(state, noPayment), /подтверждённой оплаты/);
  const paid = structuredClone(state); paid.financeLedger!.operations = [payment()]; paid.financeLedger!.requests[0] = { ...paid.financeLedger!.requests[0], status: 'paid', operationId: 'operation' }; assert.equal(verify(state, paid), '');
  const bypass = fixture(); bypass.financeLedger!.requests = [{ ...request, status: 'approved' }]; assert.match(verify(fixture(), bypass), /Новая заявка/);
});

test('bank IDs are unique and one operation side cannot absorb two real bank movements', () => {
  const state = fixture(); state.financeLedger!.operations = [payment()];
  const next = structuredClone(state); next.financeLedger!.confirmations = [{ id: 'bank1', operationId: 'operation', confirmation: 'reconciled', source: 'Выписка', sourceKey: 'bank-row1', bankAccountId: 'bank', bankDate: '2026-10-20' }];
  assert.equal(verify(state, next), '');
  const duplicate = structuredClone(next); duplicate.financeLedger!.confirmations.push({ ...duplicate.financeLedger!.confirmations[0], id: 'bank2', sourceKey: 'bank-row2' });
  assert.match(verify(state, duplicate), /уже связана/);
  const wrong = structuredClone(next); wrong.financeLedger!.confirmations[0].bankAccountId = 'cash'; assert.match(verify(state, wrong), /соответствующую сторону/);
});

test('both transfer bank legs can be reconciled once without creating extra movements', () => {
  const state = fixture(); state.financeLedger!.operations = [payment({ kind: 'transfer', toAccountId: 'cash', allocations: [], confirmation: 'reconciled', sourceKey: 'source-row' })];
  const next = structuredClone(state); next.financeLedger!.confirmations = [{ id: 'destination', operationId: 'operation', confirmation: 'reconciled', source: 'Выписка получателя', sourceKey: 'destination-row', bankAccountId: 'cash' }];
  assert.equal(verify(state, next), ''); assert.equal(ledgerEffect(next).cashMovements.length, 2);
});

test('roles, expense approval, factual date, private evidence and exact arithmetic are enforced', () => {
  const state = fixture(), next = structuredClone(state); next.financeLedger!.operations = [payment()];
  assert.match(validateFinanceLedgerChanges(state, next, { role: 'foreman' }), /только управление/);
  const unapproved = structuredClone(next); delete unapproved.financeEntries[0].approvedAt; assert.match(verify(fixture(), unapproved), /утвердите расход/);
  const future = structuredClone(next); future.financeLedger!.operations[0].date = '2026-10-29'; assert.match(verify(state, future, now), /Будущая дата/);
  const unsafe = structuredClone(next); unsafe.financeLedger!.operations[0].amountCents = 1.5; assert.match(verify(state, unsafe), /Проверьте вид/);
  const privateDoc = structuredClone(next); privateDoc.financeLedger!.operations[0].documentId = 'doc'; privateDoc.documents = [{ id: 'doc', fileKey: 'other-project/file.pdf', clientVisible: false }]; assert.match(verify(state, privateDoc), /закрытый оригинал/);
});

test('server authors timestamps/history once and malformed input returns errors rather than throwing', () => {
  const state = fixture(), next = structuredClone(state); next.financeLedger!.operations = [payment({ recordedAt: 'spoof', recordedBy: 'spoof' })];
  const preview = structuredClone(next); assert.equal(verify(state, preview), ''); assert.equal(preview.financeLedger!.operations[0].recordedBy, 'spoof');
  assert.equal(verify(state, next, now), ''); assert.equal(next.financeLedger!.operations[0].recordedBy, identity.name); assert.equal(next.financeLedger!.operations[0].recordedAt, now); assert.equal(next.financeLedger!.history!.length, 1);
  assert.equal(verify(next, structuredClone(next), now), '');
  for (const malformed of [null, {}, { version: 1, operations: null }, { ...emptyFinanceLedger(), operations: [null] }]) {
    const bad = { ...state, financeLedger: malformed } as unknown as LedgerProject; assert.doesNotThrow(() => verify(state, bad)); assert.ok(verify(state, bad));
  }
});

test('a request supports several partial payments while one operation cannot be spent twice across requests', () => {
  const before = fixture(); before.financeLedger!.requests = [{ id: 'request', entryId: 'expense', amountCents: 100000, requestedDate: '2026-10-20', desiredDate: '2026-10-22', purpose: 'Расчёт', source: 'Счёт', status: 'executing', accountId: 'bank' }];
  const partial = structuredClone(before); partial.financeLedger!.operations = [payment({ id: 'first', amountCents: 60000, allocations: [{ entryId: 'expense', amountCents: 60000 }] })];
  partial.financeLedger!.requests[0] = { ...partial.financeLedger!.requests[0], status: 'partially_paid', paymentAllocations: [{ operationId: 'first', amountCents: 60000 }] };
  assert.equal(verify(before, partial), '');
  const paid = structuredClone(partial); paid.financeLedger!.operations.push(payment({ id: 'second', amountCents: 40000, allocations: [{ entryId: 'expense', amountCents: 40000 }] }));
  paid.financeLedger!.requests[0].status = 'paid'; paid.financeLedger!.requests[0].paymentAllocations!.push({ operationId: 'second', amountCents: 40000 });
  assert.equal(verify(partial, paid), ''); assert.equal(ledgerEntryBalance(paid, 'expense')!.remainingCents, 0);
  const rewritten = structuredClone(paid); rewritten.financeLedger!.requests[0].paymentAllocations![0].amountCents = 50000;
  assert.match(verify(partial, rewritten), /на всю сумму|переписывать/);
  const reused = structuredClone(partial); reused.financeLedger!.requests.push({ ...reused.financeLedger!.requests[0], id: 'another', amountCents: 100000, status: 'executing', paymentAllocations: [] });
  const duplicate = structuredClone(reused); duplicate.financeLedger!.requests[1].status = 'partially_paid'; duplicate.financeLedger!.requests[1].paymentAllocations = [{ operationId: 'first', amountCents: 60000 }];
  assert.match(verify(reused, duplicate), /в других заявках/);
});

test('mapped interest settles its sole obligation, suppresses duplicate loan forecast and cannot omit the allocation', () => {
  const before = fixture(), next = structuredClone(before), contract = loan();
  contract.schedule[2].entryId = 'expense2'; next.financeLedger!.loans = [contract];
  next.financeLedger!.operations = [payment({ kind: 'loan_drawdown', amountCents: 500000, allocations: [], loanId: 'loan', scheduleItemId: 'draw' }),
    payment({ id: 'interest-paid', kind: 'interest', amountCents: 10000, loanId: 'loan', scheduleItemId: 'interest', allocations: [{ entryId: 'expense2', amountCents: 10000 }] })];
  assert.equal(verify(before, next), ''); assert.equal(ledgerEffect(next).futureEvents.some(event => event.kind === 'interest'), false); assert.equal(ledgerEntryBalance(next, 'expense2')!.remainingCents, 40000);
  const missing = structuredClone(next); missing.financeLedger!.operations[1].allocations = [];
  assert.match(verify(before, missing), /Распределение процентов/);
  const unrelated = structuredClone(next); unrelated.financeLedger!.operations[1].allocations[0].entryId = 'expense'; assert.match(verify(before, unrelated), /Распределение процентов/);
});

test('loan schedule cannot forecast repayment before drawdown or close with unpaid interest', () => {
  const before = fixture(), next = structuredClone(before); next.financeLedger!.loans = [loan()]; next.financeLedger!.loans[0].schedule[1].date = '2026-10-19';
  assert.match(verify(before, next), /предшествует выдаче/);
  const closed = fixture(); closed.financeLedger!.loans = [{ ...loan(), status: 'closed' }]; assert.match(verify(before, closed), /нельзя закрыть/);
});

test('refund of released retention restores the exact retained remainder without inventing a second debt', () => {
  const before = fixture(); before.financeLedger!.retentions = [{ id: 'held', entryId: 'expense', amountCents: 20000, status: 'released', source: 'Гарантийное удержание', releaseDate: '2026-10-20' }];
  before.financeLedger!.operations = [payment({ amountCents: 20000, allocations: [{ entryId: 'expense', retentionId: 'held', amountCents: 20000 }] })];
  const next = structuredClone(before); next.financeLedger!.operations.push(payment({ id: 'refund-retention', kind: 'supplier_refund', amountCents: 5000, refundOfOperationId: 'operation', allocations: [{ entryId: 'expense', retentionId: 'held', amountCents: 5000 }] }));
  assert.equal(verify(before, next), ''); assert.equal(ledgerEffect(next).retentionPlans[0].amountCents, 5000); assert.equal(ledgerEntryBalance(next, 'expense')!.remainingCents, 85000);
});

test('shape guard rejects nested malformed data before read helpers and all financial evidence stays private and immutable', () => {
  assert.equal(validateFinanceLedgerShape(undefined), ''); assert.equal(validateFinanceLedgerShape(emptyFinanceLedger()), '');
  for (const malformed of [null, { ...emptyFinanceLedger(), operations: [{ ...payment(), allocations: [null] }] }, { ...emptyFinanceLedger(), loans: [{ ...loan(), schedule: [null] }] }, { ...emptyFinanceLedger(), requests: [{ paymentAllocations: [null] }] }]) assert.ok(validateFinanceLedgerShape(malformed));
  const before = fixture(), next = structuredClone(before); next.financeLedger!.loans = [{ ...loan(), documentId: 'doc' }]; next.documents = [{ id: 'doc', fileKey: 'test-project/agreement.pdf', clientVisible: true }];
  assert.match(verify(before, next), /закрытый оригинал/); next.documents[0].clientVisible = false; assert.equal(verify(before, next), '');
  const replaced = structuredClone(next); replaced.documents![0].fileKey = 'test-project/replacement.pdf'; assert.match(verify(next, replaced), /заменить оригинал/);
});

test('ledger commands are idempotent after server stamps and reject stale references or a switched project', () => {
  let current = fixture() as AppState, writes = 0;
  const repository = createProjectFinanceLedgerRepository(() => current, next => { current = next; writes++; });
  const commands = createFinanceLedgerUseCases(repository, { name: 'Управление', role: 'management' });
  const expected = financeLedgerSnapshot(financeLedgerReadModel(current)), operation = payment();
  assert.deepEqual(commands.operation(operation, expected), { ok: true }); assert.equal(writes, 1);
  current.financeLedger!.operations[0].recordedAt = now; current.financeLedger!.operations[0].recordedBy = 'Управление';
  assert.deepEqual(commands.operation(operation, expected), { ok: true }); assert.equal(writes, 1);
  assert.equal(commands.operation({ ...operation, id: 'stale' }, expected).ok, false); assert.equal(writes, 1);
  const restricted = createFinanceLedgerUseCases(repository, { name: 'Мастер', role: 'foreman' }); assert.equal(restricted.operation(operation, expected).ok, false);
  current = { ...current, project: { ...current.project, id: 'different-project' } }; assert.equal(commands.operation(operation, expected).ok, false); assert.equal(writes, 1);
});

test('explicitly claimed legacy payment closes no debt until the same fact is reconciled, and cannot be refunded first', () => {
  const before = fixture(); before.financeEntries[0].paidAmount = 1000; before.financeEntries[0].paidAt = '2026-10-20';
  before.treasury!.entryPlans = [{ entryId: 'expense', tranches: [], paymentFacts: [{ paymentId: 'legacy:expense', accountId: 'bank', cashTreatment: 'account', confirmation: 'claimed', source: 'Заявление' }] }];
  assert.equal(ledgerEntryBalance(before, 'expense')!.remainingCents, 100000); assert.equal(ledgerEntryBalance(before, 'expense')!.cashSettledCents, 0);
  const refund = structuredClone(before); refund.financeLedger!.operations = [payment({ id: 'refund', kind: 'supplier_refund', refundOfLegacyPayment: { entryId: 'expense', paymentId: 'legacy:expense' }, allocations: [{ entryId: 'expense', amountCents: 100000 }] })];
  assert.match(verify(before, refund), /возврат превысит/);
  const next = structuredClone(before); next.financeLedger!.operations = [payment({ confirmation: 'reconciled', sourceKey: 'bank-claim', legacyPayment: { entryId: 'expense', paymentId: 'legacy:expense' }, allocations: [] })];
  assert.equal(verify(before, next), ''); assert.equal(ledgerEntryBalance(next, 'expense')!.remainingCents, 0); assert.equal(ledgerEffect(next).cashMovements.length, 0);
  const duplicate = structuredClone(next); duplicate.financeLedger!.operations.push(payment({ id: 'duplicate-actual' })); assert.match(verify(next, duplicate), /превысит обязательство/);
});

test('new loan interest mapping cannot repurpose preexisting payments or accept ordinary payment allocations', () => {
  const before = fixture(), next = structuredClone(before), contract = loan(); contract.schedule[2].entryId = 'expense2'; next.financeLedger!.loans = [contract];
  before.financeEntries[1].paidAmount = 100; next.financeEntries[1].paidAmount = 100;
  assert.match(verify(before, next), /без сторонних оплат/);
  const mapped = fixture(); mapped.financeLedger!.loans = [contract]; const ordinary = structuredClone(mapped); ordinary.financeLedger!.operations = [payment({ amountCents: 10000, allocations: [{ entryId: 'expense2', amountCents: 10000 }] })];
  assert.match(verify(mapped, ordinary), /Проценты по займу/);
});
