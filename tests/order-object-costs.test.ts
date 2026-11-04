import assert from 'node:assert/strict';
import test from 'node:test';
import { seedState } from '../src/seed.ts';
import { emptyFinanceLedger } from '../src/domain/finance-ledger.js';
import { emptyOrderRelations, validateOrderRelationsChanges } from '../src/domain/order-relations.js';
import { orderObjectCostSources, orderObjectCostSummary, validateOrderObjectCostAllocations } from '../src/domain/order-object-costs.js';
import type { AppState, OrderObjectCostAllocation } from '../src/entities/index.ts';
const manager = { role: 'management', name: 'Owner' };
const fixture = (): AppState => ({ ...structuredClone(seedState), project: { ...seedState.project, id: 'order' },
  budgetLines: [{ id: 'budget-common', name: 'Общая смета', stageIds: [], plan: 900000, forecast: 900000 }],
  financeEntries: [{ id: 'expense-common', kind: 'expense', amount: 800000, description: 'Материалы дома и бани', counterparty: 'Поставщик', status: 'committed', date: '2024-01-01', approvedAt: '2024-01-01', approvedBy: 'Owner' },
    { id: 'customer', kind: 'income', amount: 1200000, description: 'Договор заказчика', counterparty: 'Клиент', status: 'committed', date: '2024-01-01' }],
  financeLedger: { ...emptyFinanceLedger(), operations: [{ id: 'payment-common', kind: 'payment', date: '2024-01-02', amountCents: 30000000,
    accountId: 'account', counterparty: 'Поставщик', description: 'Одна оплата материалов', source: 'Поручение 123', confirmation: 'confirmed', allocations: [{ entryId: 'expense-common', amountCents: 30000000 }] }] },
  orderRelations: { ...emptyOrderRelations(), objects: [
    { id: 'house', assetId: 'asset-house', title: 'Дом', status: 'planned', specifications: [] },
    { id: 'bath', assetId: 'asset-bath', title: 'Баня', status: 'planned', specifications: [] },
  ] },
});
const allocation = (id: string, sourceType: OrderObjectCostAllocation['sourceType'], sourceId: string, objectId: string, amountCents: number): OrderObjectCostAllocation => ({ id, sourceType, sourceId, objectId, amountCents, source: 'Утверждённая расшифровка объёма', status: 'active' });
const record = (old: AppState, rows: OrderObjectCostAllocation[]) => {
  const next = structuredClone(old); next.orderRelations!.costAllocations = rows; next.orderRelations!.changeReason = 'Распределение между домом и баней';
  assert.equal(validateOrderRelationsChanges(old, next, manager, '2024-01-03T12:00:00Z'), ''); return next;
};

test('explicit house/bath budget, commitments and payment shares have separate totals and visible remainder without copying finance', () => {
  const old = fixture(), next = record(old, [
    allocation('b-house', 'budget', 'budget-common', 'house', 60000000), allocation('b-bath', 'budget', 'budget-common', 'bath', 30000000),
    allocation('c-house', 'commitment', 'expense-common', 'house', 50000000), allocation('c-bath', 'commitment', 'expense-common', 'bath', 20000000),
    allocation('p-house', 'payment', 'ledger:payment-common', 'house', 20000000), allocation('p-bath', 'payment', 'ledger:payment-common', 'bath', 10000000),
  ]);
  assert.deepEqual(next.budgetLines, old.budgetLines); assert.deepEqual(next.financeEntries, old.financeEntries); assert.deepEqual(next.financeLedger, old.financeLedger);
  const result = orderObjectCostSummary(next);
  assert.deepEqual(result.totals, { budget: 90000000, commitment: 80000000, payment: 30000000 });
  assert.deepEqual(result.unallocated, { budget: 0, commitment: 10000000, payment: 0 });
  assert.deepEqual(result.objects.map(({ objectId, budget, commitment, payment }) => ({ objectId, budget, commitment, payment })), [
    { objectId: 'house', budget: 60000000, commitment: 50000000, payment: 20000000 }, { objectId: 'bath', budget: 30000000, commitment: 20000000, payment: 10000000 },
  ]);
  assert.equal(next.orderRelations!.history.length, 1); assert.ok(next.orderRelations!.history[0].sections.includes('costAllocations'));
  assert.ok(next.orderRelations!.history[0].changes.some(row => row.path.startsWith('costAllocations/')));
  assert.equal(next.orderRelations!.costAllocations![0].recordedBy, 'Owner');
});

test('customer income, receipt, offsets and loan principal cannot be attributed as supplier costs', () => {
  const state = fixture(); state.financeLedger!.operations.push(
    { ...state.financeLedger!.operations[0], id: 'receipt', kind: 'receipt', amountCents: 60000000, allocations: [] },
    { ...state.financeLedger!.operations[0], id: 'offset', kind: 'offset', allocations: [] },
    { ...state.financeLedger!.operations[0], id: 'loan', kind: 'loan_drawdown', allocations: [], loanId: 'loan-contract' },
    { ...state.financeLedger!.operations[0], id: 'claimed', confirmation: 'claimed', allocations: [] },
  );
  assert.deepEqual(orderObjectCostSources(state).filter(row => row.sourceType === 'payment').map(row => row.sourceId), ['ledger:payment-common']);
  for (const [sourceType, sourceId] of [['commitment', 'customer'], ['payment', 'ledger:receipt'], ['payment', 'ledger:offset'], ['payment', 'ledger:loan'], ['payment', 'ledger:claimed']] as const) {
    const next = structuredClone(state); next.orderRelations!.costAllocations = [allocation('forged', sourceType, sourceId, 'house', 1)];
    assert.match(validateOrderObjectCostAllocations(state, next, manager), /Источник/);
  }
});

test('allocation is exact to cents, cannot exceed source, and does not infer a budget or empty object share', () => {
  const state = fixture(); state.budgetLines[0].plan = 1.01;
  const next = record(state, [allocation('cent-1', 'budget', 'budget-common', 'house', 100), allocation('cent-2', 'budget', 'budget-common', 'bath', 1)]);
  assert.deepEqual(orderObjectCostSummary(next).objects.map(row => row.budget), [100, 1]);
  const over = structuredClone(state); over.orderRelations!.costAllocations = [allocation('too-much', 'budget', 'budget-common', 'house', 102)];
  assert.match(validateOrderObjectCostAllocations(state, over, manager), /превышают/);
  over.orderRelations!.costAllocations![0].amountCents = 1.5;
  assert.ok(validateOrderObjectCostAllocations(state, over, manager));
  const blank = fixture(); blank.budgetLines = [];
  assert.equal(orderObjectCostSummary(blank).totals.budget, null); assert.equal(orderObjectCostSummary(blank).objects[0].payment, null);
});

test('shared payment attribution uses only this order share and legacy reconciliation never doubles an old payment', () => {
  const state = fixture(); const op = state.financeLedger!.operations[0]; op.amountCents = 20000000; op.sharedPaymentId = 'canonical-300000'; op.sharedPaymentSourceKey = 'one-source';
  state.financeEntries[0].paidAmount = 50000; state.financeEntries[0].paidAt = '2024-01-01';
  state.financeLedger!.operations.push({ ...op, id: 'legacy-reconcile', amountCents: 5000000, allocations: [], sharedPaymentId: undefined, sharedPaymentSourceKey: undefined, legacyPayment: { entryId: 'expense-common', paymentId: 'legacy:expense-common' } });
  const sources = orderObjectCostSources(state).filter(row => row.sourceType === 'payment');
  assert.deepEqual(sources.map(row => [row.sourceId, row.amountCents]), [['legacy:expense-common', 5000000], ['ledger:payment-common', 20000000]]);
  assert.equal(orderObjectCostSummary(state).totals.payment, 25000000);
  const next = structuredClone(state); next.orderRelations!.costAllocations = [allocation('attempt-full-master', 'payment', 'ledger:payment-common', 'house', 30000000)];
  assert.match(validateOrderObjectCostAllocations(state, next, manager), /превышают/);
});

test('refunds reduce only explicitly attributed objects and retain an unallocated refund independently of gross payment', () => {
  const original = fixture();
  original.financeLedger!.operations.push({ ...original.financeLedger!.operations[0], id: 'refund', kind: 'supplier_refund', amountCents: 10000000, refundOfOperationId: 'payment-common', allocations: [{ entryId: 'expense-common', amountCents: 10000000 }] });
  const next = record(original, [allocation('house-payment', 'payment', 'ledger:payment-common', 'house', 20000000), allocation('house-refund', 'payment', 'ledger:refund', 'house', 5000000)]);
  const result = orderObjectCostSummary(next);
  assert.equal(result.objects[0].payment, 15000000); assert.equal(result.totals.payment, 20000000); assert.equal(result.unallocated.payment, 5000000);
  assert.equal(result.sources.find(row => row.sourceId === 'ledger:refund')!.remainingCents, 5000000);
  const wrong = structuredClone(original); wrong.orderRelations!.costAllocations = [allocation('house-pay', 'payment', 'ledger:payment-common', 'house', 20000000), allocation('bath-refund', 'payment', 'ledger:refund', 'bath', 1)];
  assert.match(validateOrderObjectCostAllocations(original, wrong, manager), /исходной оплаты/);
});

test('stored allocations cannot be edited or deleted; cancellation and replacement append to the relation audit', () => {
  const old = record(fixture(), [allocation('original', 'budget', 'budget-common', 'house', 20000000)]);
  for (const mutate of [(next: AppState) => { next.orderRelations!.costAllocations = []; }, (next: AppState) => { next.orderRelations!.costAllocations![0].amountCents++; }, (next: AppState) => { next.orderRelations!.costAllocations![0].objectId = 'bath'; }]) {
    const next = structuredClone(old); mutate(next); assert.ok(validateOrderObjectCostAllocations(old, next, manager));
  }
  const rows: OrderObjectCostAllocation[] = [{ ...old.orderRelations!.costAllocations![0], status: 'canceled', canceledReason: 'Исправлена привязка объекта по акту' }, allocation('replacement', 'budget', 'budget-common', 'bath', 20000000)];
  const corrected = record(old, rows);
  assert.equal(corrected.orderRelations!.costAllocations![0].canceledBy, 'Owner');
  assert.equal(corrected.orderRelations!.history.length, 2); assert.equal(orderObjectCostSummary(corrected).objects[0].budget, null); assert.equal(orderObjectCostSummary(corrected).objects[1].budget, 20000000);
  const resurrect = structuredClone(corrected); resurrect.orderRelations!.costAllocations![0].status = 'active';
  assert.ok(validateOrderObjectCostAllocations(corrected, resurrect, manager));
});

test('financial edits cannot silently shrink or delete attributed source, and role/stamp spoofing fail before mutation', () => {
  const old = record(fixture(), [allocation('original', 'commitment', 'expense-common', 'house', 20000000)]);
  const shrink = structuredClone(old); shrink.financeEntries[0].amount = 199999;
  assert.match(validateOrderRelationsChanges(old, shrink, manager, '2024-01-04T12:00:00Z'), /превышают/);
  const missing = structuredClone(old); missing.financeEntries = missing.financeEntries.filter(entry => entry.id !== 'expense-common');
  assert.match(validateOrderRelationsChanges(old, missing, manager), /Источник/);
  const next = fixture(); next.orderRelations!.costAllocations = [allocation('forged', 'budget', 'budget-common', 'house', 1)];
  assert.match(validateOrderObjectCostAllocations(fixture(), next, { role: 'foreman', name: 'Foreman' }), /управление/);
  next.orderRelations!.costAllocations![0].recordedBy = 'Owner'; assert.match(validateOrderObjectCostAllocations(fixture(), next, manager), /сервер/);
});
