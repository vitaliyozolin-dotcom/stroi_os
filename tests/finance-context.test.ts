import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { seedState } from '../src/seed.ts';
import type { FinancePlanningSnapshot } from '../src/domain/finance/index.js';
import { budgetLineSnapshot } from '../src/domain/finance/index.js';
import { editFinanceBudgetLine, classifyFinanceContextCosts, setFinanceContextDueDate } from '../src/application/finance-context-planning.ts';
import { applyFinancePlanningResult, financePlanningSnapshot } from '../src/infrastructure/finance-project.ts';
import { editProjectBudgetLine } from './support/finance-project.ts';
const context = { identity: { name: 'Управляющий', role: 'management' as const }, clock: { now: () => '2026-10-20T12:00:00Z' }, ids: { next: (prefix: string) => `${prefix}-test` } };
const snapshot = (): FinancePlanningSnapshot => ({ projectId: 'project-test', budgetLines: [{ id: 'line', name: 'Работы', plan: 100, forecast: 100, stageIds: [], sourcePlan: 100, sourceFact: 30 }], budgetMeta: { source: 'Смета', version: 'v1' }, financeEntries: [{ id: 'entry', kind: 'expense', amount: 50, date: '2026-10-20', status: 'committed', description: 'Работы', counterparty: 'Подрядчик' }] });
const input = (state: FinancePlanningSnapshot) => ({ lineId: 'line', plan: 120, forecast: 130, version: 'v2', source: 'Уточнение', expected: budgetLineSnapshot(state, 'line') });
test('planning runs with owned finance data only and returns a scoped patch/event, never a whole project', () => {
 const state = snapshot(), before = structuredClone(state), result = editFinanceBudgetLine(state, input(state), context);
 assert.ok(result.ok && result.change); if (!result.ok || !result.change) return;
 assert.deepEqual(state, before); assert.equal(result.change.projectId, 'project-test'); assert.equal(result.change.patch.budgetLines?.[0].plan, 120); assert.equal(result.change.patch.budgetLines?.[0].sourceFact, 30); assert.equal(result.change.event.actor, context.identity.name); assert.equal(result.change.event.timestamp, context.clock.now()); assert.equal('state' in result.change, false);
});
test('classification and dates execute without tasks/settings/reports or construction state', () => {
 const state = snapshot();
 const classified = classifyFinanceContextCosts(state, { lines: {line: 'overhead'}, entries: {entry: 'construction'}, expected: JSON.stringify([state.budgetLines,state.financeEntries]) }, context);
 assert.ok(classified.ok && classified.change);
 const dated = setFinanceContextDueDate(state, { entryId: 'entry', date: '2026-11-01', expected: JSON.stringify(state.financeEntries[0]) }, context);
 assert.ok(dated.ok && dated.change); if (!dated.ok || !dated.change) return; assert.equal(dated.change.patch.financeEntries?.[0].dueDate, '2026-11-01');
});
test('project adapter preserves latest nonfinancial state and accepts only owned fields', () => {
 const current = structuredClone(seedState), finance = snapshot(); current.project.id = finance.projectId; current.budgetLines = finance.budgetLines; current.budgetMeta = finance.budgetMeta; current.financeEntries = finance.financeEntries;
 const result = editFinanceBudgetLine(financePlanningSnapshot(current), input(finance), context); assert.ok(result.ok && result.change); if (!result.ok || !result.change) return;
 const patch = { ...result.change.patch, tasks: [], settings: { forged: true }, documents: [] };
 current.activity.unshift({ id: 'parallel', actor: 'Другой', timestamp: context.clock.now(), text: 'Изменена задача', tone: 'neutral' });
 const adapted = applyFinancePlanningResult(current, { ok: true, change: { ...result.change, patch } }); assert.ok(adapted.ok && adapted.change); if (!adapted.ok || !adapted.change) return;
 assert.equal(adapted.change.state.tasks, current.tasks); assert.equal(adapted.change.state.settings, current.settings); assert.equal(adapted.change.state.documents, current.documents); assert.equal(adapted.change.state.activity[1].id, 'parallel'); assert.equal(adapted.change.state.budgetLines[0].plan, 120);
 const other = { ...current, project: { ...current.project, id: 'other' } }; assert.equal(applyFinancePlanningResult(other, result).ok, false);
});
test('compatibility entrypoint produces exactly the same result as context plus adapter', () => {
 const state = structuredClone(seedState), finance = snapshot(); state.project.id = finance.projectId; state.budgetLines = finance.budgetLines; state.budgetMeta = finance.budgetMeta; state.financeEntries = finance.financeEntries;
 const command = input(finance), direct = editProjectBudgetLine(state, command, context), adapted = applyFinancePlanningResult(state, editFinanceBudgetLine(financePlanningSnapshot(state), command, context)); assert.deepEqual(direct, adapted);
 const denied = editFinanceBudgetLine(finance, command, { ...context, identity: { name: 'Клиент', role: 'client' } }); assert.equal(denied.ok, false);
 finance.budgetLines[0].plan = 200; assert.equal(editFinanceBudgetLine(finance, command, context).ok, false);
});
test('financial context and core planning have no dependency on the whole-project state/change contract', () => {
 const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
 for (const file of ['src/domain/finance/context.ts','src/domain/finance/index.d.ts','src/application/finance-context-planning.ts','src/application/finance-context.ts']) assert.doesNotMatch(read(file), /\bAppState\b|\bStateChange\b|infrastructure|from ['"]react/);
});

test('an evaluated finance result cannot overwrite newer finance values', () => {
 const state = structuredClone(seedState), finance = snapshot(); state.project.id = finance.projectId; state.budgetLines = finance.budgetLines; state.budgetMeta = finance.budgetMeta; state.financeEntries = finance.financeEntries;
 const result = editFinanceBudgetLine(financePlanningSnapshot(state), input(finance), context);
 state.financeEntries[0].description = 'Новая финансовая запись';
 const before = structuredClone(state);
 assert.equal(applyFinancePlanningResult(state, result).ok, false);
 assert.deepEqual(state, before);
});
