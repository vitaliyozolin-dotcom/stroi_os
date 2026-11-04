import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyOrderRelations, normalizeOrderRelations, validateOrderRelationsChanges, prepareOrderRelationsUpdate,
  orderContractTotals, orderContractValueCents, orderDirectoryReferences, createOrderSpecificationVersion,
  upsertOrderRelation, type OrderRelationsProject } from '../src/domain/order-relations.js';
import type { OrderContract, OrderSpecification, OrderChangeRequest } from '../src/entities/index.ts';
import { emptyFinanceLedger, ledgerEntryPaidCents } from '../src/domain/finance-ledger.js';

const owner = { role: 'management', name: 'Owner', email: 'owner@example.test' }, now = '2026-11-04T12:00:00Z';
const fixture = (): OrderRelationsProject => ({ project: { id: 'order-one', contractValue: 12345, unknownFields: ['area', 'contractValue'] },
  documents: [{ id: 'doc' }], stages: [{ id: 'stage' }], budgetLines: [{ id: 'budget' }], tasks: [{ id: 'task' }], procurement: [{ id: 'purchase' }],
  counterparties: [{ id: 'local-party' }], leads: [{ id: 'lead' }], financeEntries: [],
  orderRelations: { ...emptyOrderRelations(), customerId: 'customer', objects: [{ id: 'scope', assetId: 'asset', title: 'House', status: 'planned', specifications: [] }] } });
const contract = (id = 'contract', extra: Partial<OrderContract> = {}): OrderContract => ({ id, kind: 'customer', title: 'Construction', partyIds: ['customer'], objectIds: ['scope'], currency: 'RUB', amountCents: 1_000_000_00, status: 'signed', signedDate: '2026-11-01', documentIds: ['doc'], source: 'Signed original', ...extra });
const specification = (extra: Partial<OrderSpecification> = {}): OrderSpecification => ({ id: 'spec-1', version: 1, status: 'approved', title: 'Original specification', scope: 'Build a house', houseAreaSqm: 100, plannedStart: '2026-11-10', plannedEnd: '2027-02-10', source: 'Customer confirmation', documentIds: ['doc'], ...extra });
const change = (extra: Partial<OrderChangeRequest> = {}): OrderChangeRequest => ({ id: 'change', title: 'Additional terrace', reason: 'Customer request', status: 'approved', objectIds: ['scope'], priceDeltaCents: 100_000_00, costDeltaCents: 60_000_00, scheduleDeltaDays: 5, documentIds: ['doc'], source: 'Confirmed amendment', ...extra });
const saved = (value = fixture()) => { assert.equal(validateOrderRelationsChanges(null, value, owner, now), ''); return value; };
const edit = (value: OrderRelationsProject) => { const result = structuredClone(value); result.orderRelations!.changeReason = 'Documented change'; return result; };

test('optional order relations preserve legacy projects and unknown draft facts', () => {
  const legacy = fixture(); delete legacy.orderRelations;
  const before = structuredClone(legacy);
  assert.equal(validateOrderRelationsChanges(null, legacy, owner, now), ''); assert.deepEqual(legacy, before);
  assert.equal(normalizeOrderRelations(undefined), undefined); assert.equal(normalizeOrderRelations(null), undefined);
  const draft = fixture(); assert.equal(validateOrderRelationsChanges(null, draft, owner), '');
  assert.equal(draft.project.contractValue, 12345); assert.equal(draft.orderRelations!.history.length, 0);
  assert.equal(orderContractValueCents(draft.orderRelations), null);
  assert.deepEqual(normalizeOrderRelations({ version: 1, status: 'draft', mode: 'client_land' }), emptyOrderRelations());
});

test('client preparation is pure; server stamps actors and append-only change evidence', () => {
  const state = saved(), before = structuredClone(state), relations = structuredClone(state.orderRelations!);
  relations.participants.push({ id: 'payer', partyId: 'customer', role: 'payer' });
  const prepared = prepareOrderRelationsUpdate(state, relations, owner, 'Customer pays for construction');
  assert.equal(prepared.ok, true); assert.deepEqual(state, before);
  if (!prepared.ok) return;
  assert.equal(prepared.orderRelations.history.length, 1);
  const next = { ...state, orderRelations: prepared.orderRelations };
  assert.equal(validateOrderRelationsChanges(state, next, owner, '2026-11-04T13:00:00Z'), '');
  const history = next.orderRelations.history;
  assert.equal(history.length, 2); assert.equal(history[1].by, 'Owner'); assert.equal(history[1].actorEmail, owner.email);
  assert.deepEqual(history[1].sections, ['participants']); assert.equal(history[1].changes[0].path, 'participants/payer');
  assert.equal(history[1].changes[0].before, null); assert.deepEqual(history[1].changes[0].after, relations.participants[0]);
  const repeat = structuredClone(next);
  assert.equal(validateOrderRelationsChanges(next, repeat, owner, '2026-11-04T14:00:00Z'), ''); assert.equal(repeat.orderRelations.history.length, 2);
});

test('history deletion, forged stamps, absent reasons and unauthorized edits fail before mutation', () => {
  const before = saved();
  const cases: [OrderRelationsProject, RegExp][] = [];
  const removed = edit(before); delete removed.orderRelations; cases.push([removed, /удалить/]);
  const history = edit(before); history.orderRelations!.history = []; cases.push([history, /История/]);
  const stamps = edit(before); stamps.orderRelations!.objects[0].recordedBy = 'Impersonated'; cases.push([stamps, /сервер/]);
  const noReason = structuredClone(before); noReason.orderRelations!.mode = 'ready_sale'; cases.push([noReason, /причину/]);
  for (const [next, expected] of cases) { const snapshot = structuredClone(next); assert.match(validateOrderRelationsChanges(before, next, owner, now), expected); assert.deepEqual(next, snapshot); }
  const next = edit(before); next.orderRelations!.mode = 'ready_sale';
  assert.match(validateOrderRelationsChanges(before, next, { role: 'foreman' }, now), /Управление/);
  assert.equal(validateOrderRelationsChanges(before, structuredClone(before), { role: 'foreman' }, now), '');
});

test('blank draft contract amount is unknown; signed contracts require evidence and exact money', () => {
  const state = fixture(); state.orderRelations!.contracts = [contract('draft', { status: 'draft', amountCents: undefined, signedDate: undefined, documentIds: [], source: undefined })];
  assert.equal(validateOrderRelationsChanges(null, state, owner), ''); assert.equal(orderContractTotals(state.orderRelations).customerCents, null);
  state.orderRelations!.contracts[0].status = 'signed'; assert.match(validateOrderRelationsChanges(null, state, owner), /подписанного/);
  state.orderRelations!.contracts = [contract('zero', { amountCents: 0 })]; assert.equal(validateOrderRelationsChanges(null, state, owner), '');
  for (const amountCents of [0.1, -1, Number.MAX_SAFE_INTEGER + 1]) {
    state.orderRelations!.contracts[0].amountCents = amountCents; assert.match(validateOrderRelationsChanges(null, state, owner), /сумму/);
  }
});

test('signed core, party snapshots and original evidence cannot be rewritten or removed', () => {
  const state = fixture(); state.orderRelations!.contracts = [contract('contract', { partySnapshots: [{ partyId: 'customer', name: 'Original customer', partyType: 'person' }] })]; saved(state);
  for (const alter of [
    (next: OrderRelationsProject) => { next.orderRelations!.contracts[0].amountCents = 1; },
    (next: OrderRelationsProject) => { next.orderRelations!.contracts[0].partySnapshots![0].name = 'New person'; },
    (next: OrderRelationsProject) => { next.orderRelations!.contracts[0].status = 'draft'; },
    (next: OrderRelationsProject) => { next.orderRelations!.contracts = []; },
    (next: OrderRelationsProject) => { next.orderRelations!.customerId = 'other-customer'; },
  ]) { const next = edit(state); alter(next); assert.notEqual(validateOrderRelationsChanges(state, next, owner, now), ''); }
  const next = edit(state);
  next.documents = [{ id: 'doc', fileKey: 'different-file' } as { id: string }];
  assert.match(validateOrderRelationsChanges(state, next, owner, now), /Документ.*защищён/);
});

test('contract pricing is opt-in; full replacement amounts count once and never mix suppliers or finance', () => {
  const state = fixture(); state.orderRelations!.contracts = [contract(), contract('supplier', { kind: 'supplier', amountCents: 500_000_00 }), contract('loan', { kind: 'finance', amountCents: 700_000_00 })]; saved(state);
  assert.equal(state.project.contractValue, 12345); assert.equal(orderContractValueCents(state.orderRelations), null);
  const next = edit(state); next.orderRelations!.contractPricing = true; next.orderRelations!.changeRequests.push(change());
  next.orderRelations!.contracts.push(contract('replacement', { supersedesId: 'contract', changeRequestId: 'change', amountCents: 1_100_000_00 }));
  assert.equal(validateOrderRelationsChanges(state, next, owner, now), '');
  assert.equal(next.project.contractValue, 1_100_000); assert.deepEqual(next.project.unknownFields, ['area']);
  assert.deepEqual(orderContractTotals(next.orderRelations), { customerCents: 1_100_000_00, supplierCents: 500_000_00, financeCents: 700_000_00 });
  assert.equal(next.orderRelations!.contracts[0].amountCents, 1_000_000_00); assert.deepEqual(next.financeEntries, state.financeEntries);
  const branch = edit(next); branch.orderRelations!.contracts.push(contract('parallel-replacement', { supersedesId: 'contract', changeRequestId: 'change' }));
  assert.match(validateOrderRelationsChanges(next, branch, owner, now), /подписанная следующая/);
});

test('missing pricing evidence and precision overflow are rejected instead of silently becoming zero', () => {
  const state = fixture(); state.orderRelations!.contractPricing = true;
  assert.match(validateOrderRelationsChanges(null, state, owner), /подписанный клиентский/);
  delete state.orderRelations!.contractPricing;
  state.orderRelations!.contracts = [contract('supplier-one', { kind: 'supplier', amountCents: Number.MAX_SAFE_INTEGER }), contract('supplier-two', { kind: 'supplier', amountCents: 1 })];
  assert.match(validateOrderRelationsChanges(null, state, owner), /точный диапазон/);
  state.orderRelations!.contractPricing = true; state.orderRelations!.contracts = [contract('large-price', { amountCents: 9007199254740893 })];
  assert.match(validateOrderRelationsChanges(null, state, owner), /точного отображения копеек/);
});

test('approved specifications stay immutable; replacement needs a later version and matching approval', () => {
  const state = fixture(), scope = state.orderRelations!.objects[0]; scope.specifications = [specification()]; scope.activeSpecificationId = 'spec-1'; saved(state);
  const tamper = edit(state); tamper.orderRelations!.objects[0].specifications[0].houseAreaSqm = 120;
  assert.match(validateOrderRelationsChanges(state, tamper, owner, now), /Утверждённая комплектация/);
  const next = edit(state), objectScope = next.orderRelations!.objects[0];
  const draft = createOrderSpecificationVersion(objectScope, 'spec-2', 'change');
  assert.equal(draft.version, 2); assert.equal(draft.status, 'draft'); assert.equal(draft.approvedAt, undefined); assert.equal(draft.recordedAt, undefined);
  next.orderRelations!.changeRequests = [change()]; objectScope.specifications.push({ ...draft, status: 'approved', scope: 'House with terrace', source: 'Approved amendment', documentIds: ['doc'] }); objectScope.activeSpecificationId = 'spec-2';
  assert.equal(validateOrderRelationsChanges(state, next, owner, now), '');
  assert.deepEqual(next.orderRelations!.objects[0].specifications[0], state.orderRelations!.objects[0].specifications[0]);
  const rewind = edit(next); rewind.orderRelations!.objects[0].activeSpecificationId = 'spec-1'; assert.match(validateOrderRelationsChanges(next, rewind, owner, now), /Замена действующей/);
  const missingApproval = edit(state); missingApproval.orderRelations!.objects[0].specifications.push({ ...draft, status: 'approved' });
  assert.match(validateOrderRelationsChanges(state, missingApproval, owner, now), /согласованного изменения/);
});

test('approved change deltas and result history cannot overwrite contracts, costs or baseline automatically', () => {
  const state = fixture(); state.orderRelations!.changeRequests = [change()]; saved(state);
  const next = edit(state); next.orderRelations!.changeRequests[0].status = 'applied'; next.orderRelations!.changeRequests[0].implementationNote = 'Separate specification and contract versions prepared';
  assert.equal(validateOrderRelationsChanges(state, next, owner, now), '');
  assert.equal(next.project.contractValue, state.project.contractValue); assert.deepEqual(next.budgetLines, state.budgetLines); assert.deepEqual(next.financeEntries, state.financeEntries);
  const tamper = edit(next); tamper.orderRelations!.changeRequests[0].priceDeltaCents = 1;
  assert.match(validateOrderRelationsChanges(next, tamper, owner, now), /защищены/);
});

test('mortgage approval never creates cash; funded requires an existing actual project receipt', () => {
  const state = fixture(); state.orderRelations!.mortgages = [{ id: 'mortgage', bankPartyId: 'bank', borrowerPartyIds: ['customer'], program: 'Family mortgage', fundingRoute: 'escrow', status: 'approved', requestedAmountCents: 700_000_00, approvedAmountCents: 650_000_00, decisionDate: '2026-11-02', documentIds: ['doc'], source: 'Bank decision' }]; saved(state);
  assert.deepEqual(state.financeEntries, []); assert.equal(state.orderRelations!.mortgages[0].approvedAt, now);
  const noCash = edit(state); Object.assign(noCash.orderRelations!.mortgages[0], { status: 'funded', fundedDate: '2026-11-03' });
  assert.match(validateOrderRelationsChanges(state, noCash, owner, now), /уже записанным поступлением/);
  const paid = edit(state); paid.financeEntries = [{ id: 'receipt', kind: 'income', amount: 650_000, paidAmount: 650_000, status: 'paid' }];
  Object.assign(paid.orderRelations!.mortgages[0], { status: 'funded', financeEntryId: 'receipt', fundedDate: '2026-11-03' });
  assert.equal(validateOrderRelationsChanges(state, paid, owner, now), ''); assert.equal(paid.financeEntries.length, 1);
  const rewrite = edit(paid); rewrite.orderRelations!.mortgages[0].approvedAmountCents = 700_000_00;
  assert.match(validateOrderRelationsChanges(paid, rewrite, owner, now), /решение банка защищено/);
  const wrongProject = edit(state); wrongProject.orderRelations!.mortgages[0].financeEntryId = 'foreign-receipt';
  assert.match(validateOrderRelationsChanges(state, wrongProject, owner, now), /текущего заказа/);
});

test('cancellation preserves signed agreements, obligations and ledger history', () => {
  const state = fixture(); state.financeEntries = [{ id: 'owed', kind: 'expense', amount: 1000 }]; state.financeLedger = { operations: [{ id: 'payment' }] }; state.orderRelations!.contracts = [contract()]; saved(state);
  const canceled = edit(state); canceled.orderRelations!.status = 'canceled';
  assert.equal(validateOrderRelationsChanges(state, canceled, owner, now), '');
  assert.equal(canceled.project.status, 'archived');
  assert.deepEqual(canceled.financeEntries, state.financeEntries); assert.deepEqual(canceled.financeLedger, state.financeLedger); assert.deepEqual(canceled.orderRelations!.contracts, state.orderRelations!.contracts);
  const removed = edit(state); removed.orderRelations!.status = 'canceled'; removed.financeEntries = [];
  assert.match(validateOrderRelationsChanges(state, removed, owner, now), /не удаляет финансовые/);
  const reopen = edit(canceled); reopen.orderRelations!.status = 'active'; assert.match(validateOrderRelationsChanges(canceled, reopen, owner, now), /Отменённый/);
});

test('termination preserves contract terms and requires approved closure; obligations remain separate', () => {
  const state = fixture(); state.orderRelations!.contractPricing = true; state.orderRelations!.contracts = [contract()]; state.financeEntries = [{ id: 'refund', kind: 'expense', amount: 1000 }]; saved(state);
  const next = edit(state); next.orderRelations!.changeRequests = [change({ id: 'termination', title: 'Termination', priceDeltaCents: -1_000_000_00 })];
  Object.assign(next.orderRelations!.contracts[0], { status: 'terminated', closureChangeId: 'termination', closedReason: 'Signed termination agreement' });
  assert.equal(validateOrderRelationsChanges(state, next, owner, now), ''); assert.equal(next.project.contractValue, 0);
  assert.equal(next.orderRelations!.contracts[0].amountCents, 1_000_000_00); assert.equal(next.financeEntries![0].amount, 1000);
});

test('all links and source documents resolve only against current authoritative registers', () => {
  const state = fixture();
  for (const [kind, entityId] of [['stage', 'stage'], ['budget', 'budget'], ['finance', 'receipt'], ['procurement', 'purchase'], ['task', 'task'], ['document', 'doc'], ['lead', 'lead'], ['counterparty', 'local-party']] as const) {
    state.financeEntries = [{ id: 'receipt', kind: 'income' }];
    state.orderRelations!.links = [{ id: `link-${kind}`, kind, entityId, objectId: 'scope' }];
    assert.equal(validateOrderRelationsChanges(null, state, owner), '');
    state.orderRelations!.links[0].entityId = 'foreign-id'; assert.match(validateOrderRelationsChanges(null, state, owner), /текущего заказа/);
  }
  state.orderRelations!.links = []; state.orderRelations!.contracts = [contract('bad-doc', { documentIds: ['foreign-doc'] })];
  assert.match(validateOrderRelationsChanges(null, state, owner), /документ другого заказа/);
  state.orderRelations!.contracts = []; state.orderRelations!.links = [{ id: 'effective-budget-link', kind: 'budget', entityId: 'new-approved-line', objectId: 'scope' }];
  Object.assign(state, { treasury: { activeBudgetVersionId: 'budget-version', budgetVersions: [{ id: 'budget-version', lines: [{ id: 'new-approved-line', name: 'Approved scope addition', amountCents: 10000 }] }] } });
  assert.equal(validateOrderRelationsChanges(null, state, owner), '');
});

test('one physical asset can serve later orders, while duplicate scope or duplicate party-role is rejected', () => {
  const first = fixture(), later = fixture(); later.project.id = 'later-order'; later.orderRelations!.mode = 'additional_work';
  assert.equal(validateOrderRelationsChanges(null, first, owner), ''); assert.equal(validateOrderRelationsChanges(null, later, owner), '');
  later.orderRelations!.objects.push({ ...later.orderRelations!.objects[0], id: 'duplicate-scope' });
  assert.match(validateOrderRelationsChanges(null, later, owner), /уже связан/);
  first.orderRelations!.participants = [{ id: 'customer-role', partyId: 'customer', role: 'customer' }, { id: 'payer-role', partyId: 'customer', role: 'payer' }];
  assert.equal(validateOrderRelationsChanges(null, first, owner), '');
  first.orderRelations!.participants.push({ id: 'duplicate-role', partyId: 'customer', role: 'payer' });
  assert.match(validateOrderRelationsChanges(null, first, owner), /Од.*участник.*ролью/);
  assert.deepEqual(orderDirectoryReferences(first.orderRelations), [{ id: 'customer', kind: 'party' }, { id: 'asset', kind: 'asset' }]);
});

test('warranty stays available after completion and closed facts cannot disappear', () => {
  const state = fixture(); Object.assign(state.orderRelations!.objects[0], { status: 'completed', actualStart: '2026-09-01', actualEnd: '2026-11-01' }); state.orderRelations!.status = 'completed'; saved(state);
  const next = edit(state); next.orderRelations!.warrantyCases = [{ id: 'warranty', objectId: 'scope', title: 'Window adjustment', description: 'Closing resistance', status: 'open', openedDate: '2026-11-03', documentIds: ['doc'] }];
  assert.equal(validateOrderRelationsChanges(state, next, owner, now), '');
  const closed = edit(next); Object.assign(closed.orderRelations!.warrantyCases[0], { status: 'closed', resolvedDate: '2026-11-04', resolution: 'Adjusted hinges', source: 'Customer acceptance' });
  assert.equal(validateOrderRelationsChanges(next, closed, owner, now), ''); assert.equal(closed.orderRelations!.warrantyCases[0].closedAt, now);
  const erased = edit(closed); erased.orderRelations!.warrantyCases = []; assert.match(validateOrderRelationsChanges(closed, erased, owner, now), /гарантийное/);
});

test('draft mutation helper clones instead of modifying shared state', () => {
  const relations = emptyOrderRelations(), next = upsertOrderRelation(relations, 'participants', { id: 'customer-role', partyId: 'customer', role: 'customer' });
  assert.equal(relations.participants.length, 0); assert.equal(next.participants.length, 1);
  const updated = upsertOrderRelation(next, 'participants', { ...next.participants[0], notes: 'Primary contact' });
  assert.equal(updated.participants.length, 1); assert.equal(next.participants[0].notes, undefined);
});

test('order lifecycle projects to the existing project status while hold stays explicit in relations', () => {
  const state = saved(); assert.equal(state.project.status, 'draft');
  const active = edit(state); active.orderRelations!.status = 'active';
  const prepared = prepareOrderRelationsUpdate(state, active.orderRelations!, owner, 'Start order');
  assert.equal(prepared.ok, true); if (prepared.ok) assert.equal(prepared.projectStatus, 'active');
  assert.equal(validateOrderRelationsChanges(state, active, owner, now), ''); assert.equal(active.project.status, 'active');
  const hold = edit(active); hold.orderRelations!.status = 'on_hold';
  assert.equal(validateOrderRelationsChanges(active, hold, owner, now), ''); assert.equal(hold.project.status, 'active'); assert.equal(hold.orderRelations!.status, 'on_hold');
});

test('mortgage funding accepts confirmed journal receipts and keeps historical funding after a full refund', () => {
  const state = fixture(); state.financeEntries = [{ id: 'income', kind: 'income', amount: 500, paidAmount: 0 }];
  state.orderRelations!.mortgages = [{ id: 'mortgage', program: 'Bank', bankPartyId: 'bank', borrowerPartyIds: ['customer'], approvedAmountCents: 50000, decisionDate: '2026-11-01', fundedDate: '2026-11-02', financeEntryId: 'income', status: 'funded', documentIds: ['doc'], source: 'Bank decision and receipt' }];
  state.financeLedger = { ...emptyFinanceLedger(), operations: [{ id: 'receipt', kind: 'receipt', date: '2026-11-02', amountCents: 50000, confirmation: 'confirmed', allocations: [{ entryId: 'income', amountCents: 50000 }] }] } as typeof state.financeLedger;
  assert.equal(validateOrderRelationsChanges(null, state, owner, now), ''); assert.equal(state.financeEntries[0].paidAmount, 0);
  const refunded = structuredClone(state);
  (refunded.financeLedger!.operations as unknown[]).push({ id: 'refund', kind: 'customer_refund', date: '2026-11-03', amountCents: 50000, confirmation: 'confirmed', refundOfOperationId: 'receipt', allocations: [{ entryId: 'income', amountCents: 50000 }] });
  assert.equal(ledgerEntryPaidCents(refunded as never, 'income'), 0);
  assert.equal(validateOrderRelationsChanges(state, refunded, owner, now), ''); assert.equal(refunded.orderRelations!.mortgages[0].status, 'funded');
});

test('claimed legacy receipts, noncash offset and malformed journals cannot prove mortgage funding', () => {
  const state = fixture(); state.financeEntries = [{ id: 'income', kind: 'income', amount: 500, paidAmount: 500 }];
  state.orderRelations!.mortgages = [{ id: 'mortgage', program: 'Bank', bankPartyId: 'bank', borrowerPartyIds: ['customer'], approvedAmountCents: 50000, decisionDate: '2026-11-01', fundedDate: '2026-11-02', financeEntryId: 'income', status: 'funded', documentIds: ['doc'], source: 'Bank decision' }];
  Object.assign(state, { treasury: { entryPlans: [{ entryId: 'income', paymentFacts: [{ paymentId: 'legacy:income', confirmation: 'claimed' }] }] } });
  assert.match(validateOrderRelationsChanges(null, state, owner, now), /уже записанным поступлением/);
  Object.assign(state, { treasury: undefined }); state.financeEntries[0].paidAmount = 0;
  state.financeLedger = { ...emptyFinanceLedger(), operations: [{ id: 'offset', kind: 'offset', date: '2026-11-02', amountCents: 50000, confirmation: 'confirmed', allocations: [{ entryId: 'income', amountCents: 50000 }] }] } as typeof state.financeLedger;
  assert.match(validateOrderRelationsChanges(null, state, owner, now), /уже записанным поступлением/);
  state.financeLedger = { operations: [] }; assert.match(validateOrderRelationsChanges(null, state, owner, now), /структура финансового журнала/);
});

test('object cost allocations share the order audit and cannot be removed on a later ordinary edit', () => {
  const state = fixture(); state.financeEntries = [{ id: 'expense', kind: 'expense', amount: 1000 }]; saved(state);
  const next = edit(state); next.orderRelations!.costAllocations = [{ id: 'share', objectId: 'scope', sourceType: 'commitment', sourceId: 'expense', amountCents: 60000, source: 'Confirmed house share', status: 'active' }];
  assert.equal(validateOrderRelationsChanges(state, next, owner, now), '');
  assert.equal(next.orderRelations!.costAllocations[0].recordedAt, now);
  assert.ok(next.orderRelations!.history.at(-1)!.sections.includes('costAllocations'));
  assert.deepEqual(next.financeEntries, state.financeEntries);
  const removed = edit(next); delete removed.orderRelations!.costAllocations;
  assert.match(validateOrderRelationsChanges(next, removed, owner, now), /нельзя удалить/);
});
