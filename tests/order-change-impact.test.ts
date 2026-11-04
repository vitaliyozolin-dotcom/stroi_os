import assert from 'node:assert/strict';
import test from 'node:test';
import { orderChangeImpact } from '../src/application/order-change-impact.ts';
import { emptyOrderRelations } from '../src/domain/order-relations.js';
import { emptyTreasury, treasuryScheduleImpact } from '../src/domain/treasury.js';
import { schedulePayload } from '../src/domain/construction/schedule-forecast.js';
import { seedState } from '../src/seed.ts';
import type { AppState, OrderChangeRequest, Stage } from '../src/entities/index.ts';
const manager = { name: 'Owner', role: 'management' as const };
const change: OrderChangeRequest = { id: 'change', title: 'Терраса 24 → 30 м²', reason: 'Пожелание заказчика', status: 'draft', objectIds: ['house'], priceDeltaCents: 6000000, costDeltaCents: 4000000, scheduleDeltaDays: 3, documentIds: [] };
const fixture = (): AppState => {
  const state = structuredClone(seedState); state.project.contractValue = 1000000;
  state.budgetLines = [{ id: 'budget', name: 'Терраса', group: 'Работы', plan: 600000, forecast: 600000, stageIds: [] }];
  state.orderRelations = { ...emptyOrderRelations(), changeRequests: [structuredClone(change)], objects: [{ id: 'house', assetId: 'asset-house', title: 'Дом', status: 'planned', activeSpecificationId: 'v1', specifications: [
    { id: 'v1', version: 1, status: 'approved', title: 'Исходная комплектация', scope: 'Терраса', terraceAreaSqm: 24, documentIds: [] },
    { id: 'v2', version: 2, status: 'draft', title: 'Предложение', scope: 'Расширенная терраса', terraceAreaSqm: 30, changeRequestId: change.id, documentIds: [] },
  ] }], links: [{ id: 'budget-link', kind: 'budget', entityId: 'budget', objectId: 'house' }] };
  return state;
};

test('24-to-30 terrace proposal previews separate price/budget deltas without changing effective terms or facts', () => {
  const state = fixture(), before = structuredClone(state), result = orderChangeImpact(state, change, manager);
  assert.equal(result.ok, true); if (!result.ok) return;
  assert.equal(result.currentPriceCents, 100000000); assert.equal(result.proposedPriceCents, 106000000);
  assert.equal(result.currentBudgetCents, 60000000); assert.equal(result.proposedBudgetCents, 64000000);
  assert.equal(result.specifications[0].current?.terraceAreaSqm, 24); assert.equal(result.specifications[0].proposals[0].terraceAreaSqm, 30);
  assert.deepEqual(state, before);
});

test('change preview uses existing PPR rules, moving only unpaid dependent tranche and preserving contract/fixed facts', () => {
  const state = fixture(), today = '2026-10-28', stamp = `${today}T12:00:00Z`;
  const stage: Stage = { id: 'a', name: 'Терраса', shortName: 'Терраса', order: 1, status: 'not_ready', weight: 1, progress: 0, responsible: 'Foreman', planStart: '2026-10-29', planEnd: '2026-10-30', forecastEnd: '2026-10-30',
    schedule: { kind: 'work', phase: 'Building', summaryOf: [], dependencies: [], calendar: 'daily', daysOff: [], crew: 'a', reporterId: 'foreman', updatedAt: stamp },
    siteUpdate: { asOf: today, reviewOn: '2026-11-02', remainingDays: 2, readyOn: '2026-10-29', acceptanceOn: '2026-11-02', note: 'Site check', nextAction: '', issueOwner: '', updatedAt: stamp, confirmedStatus: 'not_ready', confirmedBlocker: '', confirmedFacts: JSON.stringify(['', '', '', '']), confirmedSchedule: '' } };
  stage.siteUpdate!.confirmedSchedule = JSON.stringify(schedulePayload(stage.schedule)); state.stages = [stage];
  state.orderRelations!.links.push({ id: 'stage-link', kind: 'stage', entityId: 'a', changeRequestId: change.id });
  state.financeEntries = [{ id: 'income', kind: 'income', status: 'committed', date: today, amount: 100, paidAmount: 40, description: 'Остаток клиента', counterparty: 'Клиент', payments: [{ id: 'paid', amount: 40, date: '2026-10-27' }] }, { id: 'fixed', kind: 'expense', status: 'committed', date: today, amount: 100, description: 'Фиксированный платёж', counterparty: 'Поставщик' }];
  state.treasury = { ...emptyTreasury(), enabled: true, accounts: [{ id: 'bank', name: 'Bank', legalEntityId: 'company', currency: 'RUB', isProjectDedicated: true, opening: { asOf: today, amountCents: 5000, confirmed: true, source: 'Statement' } }], entryPlans: [
    { entryId: 'income', source: 'Договор', sourceAccountId: 'bank', tranches: [{ id: 'balance', amountCents: 10000, source: 'Договор', certainty: 'confirmed', contractualDueDate: '2026-10-31', dateRule: { kind: 'stage_end', stageId: 'a', offsetDays: 0, calendar: 'calendar' }, paymentAllocations: [{ paymentId: 'paid', amountCents: 4000 }] }] },
    { entryId: 'fixed', source: 'Договор', sourceAccountId: 'bank', tranches: [{ id: 'fixed', amountCents: 10000, source: 'Договор', certainty: 'confirmed', forecastDate: '2026-10-31', contractualDueDate: '2026-10-31' }] },
  ] };
  const before = structuredClone(state), result = orderChangeImpact(state, change, manager, { stageId: 'a', remainingDays: 5 }, stamp);
  assert.ok(result.ok && result.preview?.ok); if (!result.ok || !result.preview?.ok) return;
  const impact = treasuryScheduleImpact(state, result.preview.state, { today, horizonDays: 14 });
  assert.equal(impact.changes.length, 1); assert.equal(impact.changes[0].amountCents, 6000);
  assert.equal(impact.changes[0].contractualDueDate, '2026-10-31');
  assert.deepEqual(result.preview.state.financeEntries, before.financeEntries); assert.deepEqual(result.preview.state.treasury, before.treasury);
  assert.deepEqual(result.preview.state.project, before.project); assert.deepEqual(state, before);
});

test('unknown pricing, missing budget links and unrelated stages never yield a made-up complete impact', () => {
  const state = fixture(); state.project.unknownFields = ['contractValue']; state.orderRelations!.links = [];
  const result = orderChangeImpact(state, change, manager, { stageId: state.stages[0].id, forecastEnd: '2026-12-01' });
  assert.ok(result.ok); if (!result.ok) return;
  assert.equal(result.currentPriceCents, null); assert.equal(result.proposedPriceCents, null); assert.equal(result.currentBudgetCents, null);
  assert.equal(result.preview?.ok, false); assert.equal(orderChangeImpact(state, change, { name: 'Client', role: 'client' }).ok, false);
});
