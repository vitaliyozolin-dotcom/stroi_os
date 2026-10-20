import assert from 'node:assert/strict';
import test from 'node:test';
import { seedState } from '../src/seed.ts';
import { createProjectRequirement, createProcurementUseCases } from './support/module-project.ts';
import type { CreateRequirementInput } from '../src/application/procurement.ts';
import { readFileSync } from 'node:fs';
const clock = { now: () => '2026-10-20T12:00:00Z' };
const ids = { next: (prefix: string) => `${prefix}-test` };
const identity = { name: 'Прораб', role: 'foreman' as const };
const fixture = () => {
  const state = structuredClone(seedState);
  state.counterparties = [{ id: 'supplier', name: 'Поставщик', type: 'supplier', status: 'active' }];
  return state;
};
const input = (state: ReturnType<typeof fixture>): CreateRequirementInput => ({ projectId: state.project.id, draft: { stageId: state.stages[0].id, item: ' Материал ', quantity: 2.5, unit: ' м² ', neededBy: '2026-11-01', budget: 100.25, supplierId: 'supplier', owner: ' ' } });
test('requirement preserves original state and financial facts, links current stage/budget/supplier and audits', () => {
  const state = fixture(), before = structuredClone(state);
  const result = createProjectRequirement(state, input(state), identity, clock, ids);
  assert.ok(result.ok); if (!result.ok) return;
  assert.deepEqual(state, before);
  const item = result.change.state.procurement[0];
  assert.equal(item.id, 'supply-test'); assert.equal(item.item, 'Материал');
  assert.equal(item.quantity, 2.5); assert.equal(item.unit, 'м²'); assert.equal(item.status, 'need');
  assert.equal(item.owner, identity.name); assert.equal(item.supplierId, 'supplier');
  assert.equal(item.budgetLineId, state.budgetLines.find(line => line.stageIds.includes(item.stageId))?.id);
  assert.deepEqual(result.change.state.financeEntries, state.financeEntries);
  assert.deepEqual(result.change.state.supplierQuotes, state.supplierQuotes);
  assert.equal(result.change.state.activity[0].timestamp, clock.now());
  assert.equal(result.change.action, 'procurement_updated');
});
test('invalid quantities, budgets, dates and missing stage fail without writes', () => {
  for (const invalid of [{ quantity: NaN }, { quantity: Infinity }, { quantity: 0 }, { quantity: -1 }, { budget: NaN }, { budget: -1 }, { budget: Infinity }, { item: ' ' }, { unit: ' ' }, { stageId: 'missing' }, { neededBy: '2026-02-30' }]) {
    const state = fixture(); let writes = 0;
    const command = input(state); command.draft = { ...command.draft, ...invalid };
    assert.equal(createProcurementUseCases(state, identity, clock, ids, () => { writes++; }).createRequirement(command).ok, false);
    assert.equal(writes, 0);
  }
});
test('supplier must remain available and compatible with purchasing', () => {
  for (const mode of ['missing', 'blocked', 'client']) {
    const state = fixture(), command = input(state);
    if (mode === 'missing') state.counterparties = [];
    if (mode === 'blocked') state.counterparties[0].status = 'blocked';
    if (mode === 'client') state.counterparties[0].type = 'client';
    assert.equal(createProjectRequirement(state, command, identity, clock, ids).ok, false);
  }
});
test('client and changed project cannot create a requirement', () => {
  const state = fixture();
  assert.equal(createProjectRequirement(state, input(state), { name: 'Клиент', role: 'client' }, clock, ids).ok, false);
  const command = input(state); state.project.id = 'another';
  assert.equal(createProjectRequirement(state, command, identity, clock, ids).ok, false);
});
test('unselected supplier and unknown date remain explicit and latest unrelated changes survive', () => {
  const state = fixture(), command = input(state); command.draft.supplierId = ''; command.draft.neededBy = ''; command.draft.budget = 0;
  state.activity.unshift({ id: 'latest', actor: 'Другой', text: 'Обновление', timestamp: clock.now(), tone: 'neutral' });
  let writes = 0;
  const result = createProcurementUseCases(state, { ...identity, role: 'management' }, clock, ids, (next, metadata) => {
    writes++; assert.equal(metadata?.action, 'procurement_updated'); assert.equal(next.activity[1].id, 'latest');
  }).createRequirement(command);
  assert.ok(result.ok); if (!result.ok) return;
  assert.equal(writes, 1); assert.equal(result.change.state.procurement[0].supplier, 'Не выбран');
  assert.equal(result.change.state.procurement[0].supplierId, undefined);
  assert.equal(result.change.state.procurement[0].neededBy, '');
});
test('requirement form delegates record construction and retains errors', () => {
  const page = readFileSync(new URL('../src/pages/ProcurementPage.tsx', import.meta.url), 'utf8');
  const handler = page.slice(page.indexOf('  const addRequirement'), page.indexOf('  const moveNext'));
  assert.match(handler, /procurement\.createRequirement/);
  assert.doesNotMatch(handler, /procurement:|activity:|uid\(/);
  assert.match(page, /requirementError && <p role="alert"/);
});
