import assert from 'node:assert/strict';
import test from 'node:test';
import { seedState } from '../src/seed.ts';
import { procurementSnapshot, type ProcurementWorkflowInput } from '../src/domain/procurement-workflow.ts';
import { createProcurementUseCases } from './support/module-project.ts';
const clock = { now: () => '2026-10-20T12:00:00Z' }, ids = { next: (prefix: string) => `${prefix}-test` };
const fixture = () => { const state = structuredClone(seedState); state.counterparties = [{ id: 'vendor', name: 'Поставщик', type: 'supplier', status: 'active' }]; state.procurement = [{ id: 'item', stageId: state.stages[0].id, item: 'Материал', quantity: 1, unit: 'шт', neededBy: '', status: 'need', budget: 0, supplier: 'Не выбран', owner: 'Прораб', risk: 'Риск' }]; state.supplierQuotes = []; return state; };
const useCases = (state: ReturnType<typeof fixture>, role: 'management' | 'foreman' | 'client' = 'management') => createProcurementUseCases(state, { name: 'Автор', role }, clock, ids, () => {});
const quoteInput = (state: ReturnType<typeof fixture>): ProcurementWorkflowInput => ({ action: 'quote', itemId: 'item', expected: procurementSnapshot(state, 'item'), supplierId: 'vendor', amount: 100, deliveryDays: 2, paymentTerms: '  По счёту ', source: '', comment: ' ' });
test('step 1: quote creation normalizes metadata, advances only need to rfq and audits without financial changes', () => {
 const state = fixture(), before = structuredClone(state), result = useCases(state, 'foreman').change(quoteInput(state));
 assert.ok(result.ok && result.change); if (!result.ok || !result.change) return;
 assert.deepEqual(state, before); const next = result.change.state;
 assert.equal(next.procurement[0].status, 'rfq'); assert.equal(next.supplierQuotes[0].paymentTerms, 'По счёту'); assert.equal(next.supplierQuotes[0].source, 'Коммерческое предложение'); assert.equal(next.supplierQuotes[0].comment, undefined); assert.deepEqual(next.financeEntries, state.financeEntries); assert.equal(next.activity[0].timestamp, clock.now());
});
test('step 1: invalid quotes, unavailable suppliers, stale forms and clients fail', () => {
 for (const override of [{ amount: NaN }, { amount: 0 }, { amount: Infinity }, { deliveryDays: NaN }, { deliveryDays: -1 }, { deliveryDays: 1.5 }, { paymentTerms: ' ' }, { supplierId: 'missing' }]) { const state = fixture(); assert.equal(useCases(state).change({ ...quoteInput(state), ...override } as ProcurementWorkflowInput).ok, false); }
 const state = fixture(), input = quoteInput(state); state.procurement[0].status = 'ordered'; assert.equal(useCases(state).change(input).ok, false);
 assert.equal(useCases(fixture(), 'client').change(quoteInput(fixture())).ok, false);
 const blocked = fixture(), command = quoteInput(blocked); blocked.counterparties[0].status = 'blocked'; assert.equal(useCases(blocked).change(command).ok, false);
});
const withQuotes = () => { const state = fixture(); state.supplierQuotes = [{ id: 'q1', procurementItemId: 'item', supplierId: 'vendor', supplier: 'Поставщик', amount: 100, deliveryDays: 1, paymentTerms: 'По счёту', source: 'КП', status: 'received' }, { id: 'other', procurementItemId: 'other-item', supplier: 'Другой', amount: 50, deliveryDays: 0, paymentTerms: 'По счёту', source: 'КП', status: 'received' }]; return state; };
test('step 2: selection is scoped to one requirement and repeat produces no write or audit', () => {
 const state = withQuotes(), command: ProcurementWorkflowInput = { action: 'select', itemId: 'item', quoteId: 'q1', expected: procurementSnapshot(state, 'item', true) };
 const result = useCases(state).change(command); assert.ok(result.ok && result.change); if (!result.ok || !result.change) return;
 const next = result.change.state; assert.equal(next.procurement[0].supplierId, 'vendor'); assert.equal(next.procurement[0].budget, 100); assert.equal(next.supplierQuotes[1].status, 'received'); assert.deepEqual(next.financeEntries, state.financeEntries);
 const repeat = useCases(next).change({ ...command, expected: procurementSnapshot(next, 'item', true) }); assert.ok(repeat.ok); if (repeat.ok) assert.equal(repeat.change, null);
 assert.equal(useCases(state).change({ ...command, quoteId: 'other' }).ok, false);
 state.supplierQuotes[0].amount = 200; assert.equal(useCases(state).change(command).ok, false);
});
test('step 2: ambiguous legacy supplier never silently selects another card', () => { const state = withQuotes(); delete state.supplierQuotes[0].supplierId; state.counterparties.push({ ...state.counterparties[0], id: 'duplicate' }); assert.equal(useCases(state).change({ action: 'select', itemId: 'item', quoteId: 'q1', expected: procurementSnapshot(state, 'item', true) }).ok, false); });
test('step 3: full progression preserves timestamps, clears risk at acceptance and stops at issued', () => {
 let state = fixture();
 for (const status of ['rfq', 'ordered', 'in_transit', 'delivered', 'accepted', 'issued']) { const previous = state, result = useCases(state).change({ action: 'advance', itemId: 'item', expected: procurementSnapshot(state, 'item') }); assert.ok(result.ok && result.change); if (!result.ok || !result.change) return; state = result.change.state; assert.equal(state.procurement[0].status, status); assert.deepEqual(state.financeEntries, previous.financeEntries); }
 assert.equal(state.procurement[0].orderedAt, '2026-10-20'); assert.equal(state.procurement[0].deliveredAt, '2026-10-20'); assert.equal(state.procurement[0].risk, undefined);
 const repeat = useCases(state).change({ action: 'advance', itemId: 'item', expected: procurementSnapshot(state, 'item') }); assert.ok(repeat.ok); if (repeat.ok) assert.equal(repeat.change, null);
});
test('step 3: changed project/record and removed requirement reject stale commands', () => { const state = fixture(), command: ProcurementWorkflowInput = { action: 'advance', itemId: 'item', expected: procurementSnapshot(state, 'item') }; state.project.id = 'another'; assert.equal(useCases(state).change(command).ok, false); state.procurement = []; assert.equal(useCases(state).change(command).ok, false); });
