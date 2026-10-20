import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { seedState, buildStages } from '../src/seed.ts';
import { moduleChange } from '../src/application/module-repository.ts';
import * as adapters from '../src/infrastructure/module-project.ts';
import { createProcurementUseCases } from '../src/application/procurement.ts';
import { procurementSnapshot } from '../src/domain/procurement-workflow.ts';
import { createFinanceUseCases } from '../src/application/finance.ts';
import { createProjectFinanceRepository } from '../src/infrastructure/finance-project.ts';
import { validateFinanceChanges } from '../src/domain/finance/index.js';
import { createTaskUseCases, taskSnapshot, type TaskDraft } from '../src/application/tasks.ts';
import { createQualityUseCases, checkpointSnapshot } from '../src/application/quality.ts';
import { createStageControlUseCases, stageCommandSnapshot } from '../src/application/stage-control.ts';
import { validateStageControl } from '../sites/projects/stage-control.js';
import { createMarketingUseCases } from '../src/application/marketing.ts';
import { createClientDecisionUseCases } from '../src/application/client-decisions.ts';
import { leadSnapshot } from '../src/domain/marketing.ts';
import { clientDecisionSnapshot } from '../src/domain/client-decisions.ts';

const now = '2026-10-20T12:00:00.000Z';
const context = (role: 'management' | 'foreman' | 'client' = 'management', name = 'Управляющий', id = 'owner') => { let next = 0; return { identity: { name, role, id }, clock: { now: () => now }, ids: { next: (prefix: string) => `${prefix}-${++next}` } }; };
const fixture = () => {
 const state = structuredClone(seedState); state.project.id = 'module-test';
 state.stages = [{ ...buildStages('2026-10-01', '2026-12-01')[0], id: 'stage', status: 'in_progress' }];
 state.counterparties = [{ id: 'vendor', name: 'Поставщик', type: 'supplier', status: 'active' }];
 state.settings.users = [{ id: 'owner', name: 'Управляющий', email: 'owner@example.test', role: 'management', status: 'active' }, { id: 'worker', name: 'Прораб', email: 'worker@example.test', role: 'foreman', status: 'active' }];
 state.checkpoints = [{ id: 'point', stageId: 'stage', title: 'Скрытые работы', zone: 'Фундамент', status: 'pending', requiredShots: ['Общий вид'], photos: [], assignee: 'Прораб', reviewer: 'Управляющий', clientVisible: false }];
 state.budgetLines = [{ id: 'line', name: 'Материалы', stageIds: ['stage'], plan: 100, forecast: 100 }];
 return state;
};
const document = { id: 'doc-test', name: 'Акт', type: 'Акт', status: 'current' as const, updatedAt: now, clientVisible: false };
const lead = { id: 'lead', createdAt: now, name: 'Клиент', phone: '123', source: 'manual' as const, stage: 'new' as const, nextAction: 'Звонок', owner: 'Управляющий' };
const decision = { id: 'decision-1', title: 'Отделка', status: 'waiting' as const, dueDate: '2026-10-30', description: 'Выбрать цвет', impact: 'Срок' };
const specifications = [
 { name: 'supply', create: adapters.createSupplyRepository, patch: (s: ReturnType<typeof fixture>) => ({ procurement: [{ id: 'supply', stageId: 'stage', item: 'Бетон', quantity: 1, unit: 'м³', neededBy: '', status: 'need', budget: 10, supplier: 'Не выбран', owner: 'Прораб' }] }), mutate: (s: ReturnType<typeof fixture>) => { s.counterparties[0].status = 'blocked'; } },
 { name: 'construction', create: adapters.createConstructionRepository, patch: (s: ReturnType<typeof fixture>) => ({ stages: [{ ...s.stages[0], status: 'blocked' }], project: { workForecastNote: 'Проверено', targetCost: 0, id: 'forged' } }), mutate: (s: ReturnType<typeof fixture>) => { s.checkpoints[0].note = 'Новая проверка'; } },
 { name: 'documents', create: adapters.createDocumentsRepository, patch: () => ({ documents: [document] }), mutate: (s: ReturnType<typeof fixture>) => { s.documents.push(document); } },
 { name: 'contacts', create: adapters.createContactsRepository, patch: () => ({ appendDocuments: [document] }), mutate: (s: ReturnType<typeof fixture>) => { s.counterparties[0].name = 'Изменён'; } },
 { name: 'sales', create: adapters.createSalesRepository, patch: () => ({ leads: [lead] }), mutate: (s: ReturnType<typeof fixture>) => { s.leads.push(lead); } },
 { name: 'decisions', create: adapters.createDecisionsRepository, patch: () => ({ decisions: [decision] }), mutate: (s: ReturnType<typeof fixture>) => { s.decisions.push(decision); } },
 { name: 'settings', create: adapters.createSettingsRepository, patch: (s: ReturnType<typeof fixture>) => ({ settings: { ...s.settings, dashboardWidgets: [] } }), mutate: (s: ReturnType<typeof fixture>) => { s.settings.notifications.channels.browser = !s.settings.notifications.channels.browser; } },
];
for (const specification of specifications) {
 test(`${specification.name}: scoped read, owned writes, latest audit and financial isolation`, () => {
  let state = fixture(), writes = 0;
  const repository = specification.create(() => state, (next, metadata) => { state = next; writes++; assert.equal(metadata?.action, 'module_test'); });
  const read = repository.read(); assert.ok(read.ok); if (!read.ok) return;
  assert.equal('activity' in read.snapshot, false); assert.equal('financeEntries' in read.snapshot, false);
  const patch = { ...specification.patch(state), financeEntries: [], budgetMeta: { source: 'forged' } };
  const change = moduleChange(read.snapshot, patch, 'module_test', 'Проверка границы', context());
  state.financeEntries.push({ id: 'parallel-finance', kind: 'income', status: 'committed', amount: 10, date: '2026-10-20', description: 'Параллельное поступление', counterparty: 'Клиент' });
  state.activity.unshift({ id: 'parallel', timestamp: now, actor: 'Другой', text: 'Комментарий', tone: 'neutral' });
  const finances = state.financeEntries, budgetMeta = state.budgetMeta, targetCost = state.project.targetCost;
  assert.equal(repository.commit(change).ok, true); assert.equal(writes, 1);
  assert.equal(state.financeEntries, finances); assert.equal(state.budgetMeta, budgetMeta);
  assert.equal(state.project.id, 'module-test'); assert.equal(state.project.targetCost, targetCost);
  assert.equal(state.activity[1].id, 'parallel'); assert.equal(state.activity[0].text, 'Проверка границы');
 });
 test(`${specification.name}: stale inputs and project switches reject without a write`, () => {
  let state = fixture(), writes = 0;
  const repository = specification.create(() => state, () => { writes++; });
  const read = repository.read(); assert.ok(read.ok); if (!read.ok) return;
  const change = moduleChange(read.snapshot, specification.patch(state), 'test', 'Test', context());
  specification.mutate(state); const before = structuredClone(state);
  assert.equal(repository.commit(change).ok, false); assert.deepEqual(state, before);
  state = fixture(); state.project.id = 'another';
  assert.equal(repository.read().ok, false); assert.equal(repository.commit(change).ok, false); assert.equal(writes, 0);
 });
}

test('accepted supply becomes a finance read dependency; ordering and delivery alone never permit payment', () => {
 let state = fixture(); const ctx = context();
 const supply = createProcurementUseCases(adapters.createSupplyRepository(() => state, next => { state = next; }), ctx.identity, ctx.clock, ctx.ids);
 const finance = createFinanceUseCases(createProjectFinanceRepository(() => state, next => { state = next; }), ctx);
 assert.equal(supply.createRequirement({ projectId: state.project.id, draft: { stageId: 'stage', item: 'Бетон', quantity: 1, unit: 'м³', neededBy: '', budget: 50, supplierId: 'vendor', owner: 'Прораб' } }).ok, true);
 const supplyId = state.procurement[0].id;
 state.financeEntries = [{ id: 'expense', kind: 'expense', status: 'committed', amount: 50, date: '2026-10-20', description: 'Бетон', counterparty: 'Поставщик', stageId: 'stage', procurementItemId: supplyId }];
 assert.equal(finance.approveExpense('expense').ok, true);
 const input = { entryId: 'expense', amount: 50, date: '2026-10-20', document: 'УПД', source: `procurement:${supplyId}` };
 for (const status of ['rfq', 'ordered', 'in_transit', 'delivered', 'accepted']) {
  assert.equal(finance.recordPayment(input).ok, false);
  assert.equal(finance.acceptExpense(input).ok, false);
  assert.equal(supply.change({ action: 'advance', itemId: supplyId, expected: procurementSnapshot(state, supplyId) }).ok, true);
  assert.equal(state.procurement[0].status, status);
 }
 const before = structuredClone(state);
 assert.equal(finance.acceptExpense(input).ok, true);
 assert.equal(validateFinanceChanges(before, structuredClone(state), ctx.identity, now), '');
 const accepted = structuredClone(state);
 assert.equal(finance.recordPayment(input).ok, true);
 assert.equal(validateFinanceChanges(accepted, state, ctx.identity, now), '');
 assert.equal(state.financeEntries[0].payments?.length, 1);
});
const draft = (): TaskDraft => ({ title: 'Проверить основание', description: 'Сверить по чертежу', priority: 'normal', assigneeId: 'worker', reviewerId: 'owner', dueDate: '2026-10-25', plannedStart: '', baselineEnd: '', baselineNote: '', reason: '', stageId: 'stage', counterpartyId: '', procurementItemId: '', checkpointId: 'point' });
test('task application owns creation, comments, review, fixed baseline and stale-form rejection', () => {
 let state = fixture(); const ctx = context();
 const repo = adapters.createConstructionRepository(() => state, next => { state = next; });
 const management = createTaskUseCases(repo, ctx), worker = createTaskUseCases(repo, context('foreman', 'Прораб', 'worker'));
 assert.equal(worker.save({ expected: taskSnapshot(state), draft: draft() }).ok, false);
 assert.equal(management.save({ expected: taskSnapshot(state), draft: draft() }).ok, true);
 const id = state.tasks[0].id, base = state.tasks[0].baseline;
 assert.equal(state.tasks[0].assigneeName, 'Прораб'); assert.equal(state.tasks[0].status, 'todo');
 let expected = taskSnapshot(state, id);
 assert.equal(worker.comment({ taskId: id, expected, text: 'Проверил' }).ok, true);
 assert.equal(management.save({ taskId: id, expected, draft: draft() }).ok, false);
 for (const status of ['in_progress', 'review'] as const) assert.equal(worker.status({ taskId: id, expected: taskSnapshot(state, id), status, text: 'Результат' }).ok, true);
 assert.equal(worker.status({ taskId: id, expected: taskSnapshot(state, id), status: 'done', text: 'Приёмка' }).ok, false);
 assert.equal(management.status({ taskId: id, expected: taskSnapshot(state, id), status: 'done', text: 'Принято', extra: { completionNote: 'Замер проверен' } }).ok, true);
 assert.deepEqual(state.tasks[0].baseline, base); assert.equal(state.tasks[0].completedAt, now);
 assert.equal(management.save({ taskId: id, expected: taskSnapshot(state, id), draft: { ...draft(), dueDate: '2026-10-27' } }).ok, false);
 assert.equal(management.save({ taskId: id, expected: taskSnapshot(state, id), draft: { ...draft(), dueDate: '2026-10-27', reason: 'Изменён план' } }).ok, true);
 assert.deepEqual(state.tasks[0].baseline, base); assert.equal(state.tasks[0].originalDueDate, '2026-10-25');
});
const photo = (projectId = 'module-test', checkpointId = 'point') => ({ id: 'photo', name: 'Узел', capturedAt: now, fileKey: `${projectId}/quality/${checkpointId}/photo.jpg`, mimeType: 'image/jpeg', sizeBytes: 4, uploadedAt: now });
test('quality requires evidence and management acceptance and protects accepted evidence', async () => {
 let state = fixture(); const before = structuredClone(state);
 const repository = adapters.createConstructionRepository(() => state, next => { state = next; });
 const owner = createQualityUseCases(repository, context()), worker = createQualityUseCases(repository, context('foreman', 'Прораб', 'worker'));
 assert.equal(owner.update({ checkpointId: 'point', expected: checkpointSnapshot(state, 'point'), patch: { status: 'accepted', clientVisible: true } }).ok, false);
 assert.equal(worker.update({ checkpointId: 'point', expected: checkpointSnapshot(state, 'point'), patch: { status: 'accepted' } }).ok, false);
 const result = await worker.upload({ checkpointId: 'point', expected: checkpointSnapshot(state, 'point'), files: [new File(['test'], 'photo.jpg', { type: 'image/jpeg' })] }, { upload: async () => photo() }, new AbortController().signal);
 assert.ok(result.ok); assert.equal(state.checkpoints[0].photos.length, 1); assert.equal(state.checkpoints[0].status, 'pending');
 assert.equal(worker.update({ checkpointId: 'point', expected: checkpointSnapshot(state, 'point'), patch: { status: 'in_review', submittedAt: now }, summary: 'Отправлено' }).ok, true);
 const pending = structuredClone(state);
 assert.equal(owner.update({ checkpointId: 'point', expected: checkpointSnapshot(state, 'point'), patch: { status: 'accepted', acceptedAt: now, clientVisible: true }, summary: 'Принято' }).ok, true);
 assert.equal(validateStageControl(pending, structuredClone(state), context().identity, now), null);
 assert.equal(owner.update({ checkpointId: 'point', expected: checkpointSnapshot(state, 'point'), patch: { measurement: 'Подменён замер' } }).ok, false);
 assert.deepEqual(state.financeEntries, before.financeEntries);
});
for (const mode of ['cancel', 'foreign', 'changed', 'project', 'stage', 'metadata'] as const) test(`quality upload rejects ${mode} before registering late evidence`, async () => {
 let state = fixture(), writes = 0; const controller = new AbortController();
 const repository = adapters.createConstructionRepository(() => state, () => { writes++; });
 const quality = createQualityUseCases(repository, context());
 const result = await quality.upload({ checkpointId: 'point', expected: checkpointSnapshot(state, 'point'), files: [new File(['test'], 'photo.jpg', { type: 'image/jpeg' })] }, { upload: async () => {
  if (mode === 'cancel') controller.abort();
  if (mode === 'changed') state.checkpoints[0].note = 'Изменено другим';
  if (mode === 'stage') state.stages = [];
  if (mode === 'project') state = { ...state, project: { ...state.project, id: 'other' } };
  return mode === 'metadata' ? { ...photo(), name: '' } : photo(mode === 'foreign' ? 'other' : 'module-test');
 } }, controller.signal);
 assert.equal(result.ok, false); assert.equal(writes, 0); assert.equal(state.checkpoints[0].photos.length, 0);
});

test('sales and client decisions use independent ports and reject forbidden actors', () => {
 let state = fixture(); state.leads = [lead]; state.decisions = [decision]; const ctx = context();
 const salesRepository = adapters.createSalesRepository(() => state, next => { state = next; });
 const clientRepository = adapters.createDecisionsRepository(() => state, next => { state = next; });
 const sales = createMarketingUseCases(salesRepository, ctx.identity, ctx.clock, ctx.ids);
 assert.equal(sales.execute({ action: 'stage', leadId: 'lead', expected: leadSnapshot(state, 'lead'), stage: 'qualified' }).ok, true);
 const denied = createMarketingUseCases(salesRepository, { name: 'Клиент', role: 'client' }, ctx.clock, ctx.ids);
 assert.equal(denied.execute({ action: 'stage', leadId: 'lead', expected: leadSnapshot(state, 'lead'), stage: 'won' }).ok, false);
 const client = createClientDecisionUseCases(clientRepository, { name: 'Клиент', role: 'client' }, ctx.clock, ctx.ids);
 assert.equal(client.confirm({ decisionId: 'decision-1', expected: clientDecisionSnapshot(state, 'decision-1'), choice: 'Графит' }).ok, true);
 assert.equal(state.leads[0].stage, 'qualified'); assert.equal(state.decisions[0].status, 'decided');
});

test('business workflows and context policies cannot depend on the whole project or adapters', () => {
 const core = ['procurement', 'counterparties', 'client-decisions', 'marketing', 'schedule-planning', 'schedule-edits', 'stage-control', 'project-documents', 'field-reports', 'settings', 'tasks', 'quality', 'module-repository'];
 for (const name of core) {
  const code = readFileSync(new URL(`../src/application/${name}.ts`, import.meta.url), 'utf8');
  assert.doesNotMatch(code, /\bAppState\b|\bStateChange\b|StateChangeSink|infrastructure|presentation|from ['"]react|\bfetch\(/, name);
 }
 for (const name of ['procurement', 'procurement-workflow', 'counterparties', 'client-decisions', 'marketing', 'schedule-planning', 'project-documents', 'mutations', 'settings', 'contexts']) {
  const code = readFileSync(new URL(`../src/domain/${name}.ts`, import.meta.url), 'utf8');
  assert.doesNotMatch(code, /\bAppState\b|from ['"][^'"]*(?:application|infrastructure|presentation)|from ['"]react|\bfetch\(/, name);
 }
 for (const name of ['TasksPage', 'QualityPage']) assert.doesNotMatch(readFileSync(new URL(`../src/pages/${name}.tsx`, import.meta.url), 'utf8'), /commitStateChange\(|changeCheckpoint\(|saveTaskChange\(/);
 for (const name of readdirSync(new URL('../src/application/', import.meta.url)).filter(name => name.endsWith('.ts') && !['ports.ts', 'project-sync.ts', 'project-sync-workflow.ts', 'state-change.ts', 'index.ts'].includes(name))) {
  assert.doesNotMatch(readFileSync(new URL(`../src/application/${name}`, import.meta.url), 'utf8'), /\bAppState\b|StateChangeSink/, name);
 }
});

test('contacts append intent cannot replay a document or replace the current registry', () => {
 let state = fixture(), writes = 0;
 const repository = adapters.createContactsRepository(() => state, next => { state = next; writes++; });
 const read = repository.read(); assert.ok(read.ok); if (!read.ok) return;
 const change = moduleChange(read.snapshot, { appendDocuments: [document], documents: [] }, 'document_updated', 'Акт', context());
 assert.equal(repository.commit(change).ok, true);
 assert.equal(repository.commit(change).ok, false);
 assert.equal(state.documents.length, 1); assert.equal(writes, 1);
});

test('construction acceptance remains blocked until tasks and quality have their own truthful accepted facts', () => {
 let state = fixture(); const ctx = context();
 const repository = adapters.createConstructionRepository(() => state, next => { state = next; });
 const tasks = createTaskUseCases(repository, ctx), quality = createQualityUseCases(repository, ctx);
 const stages = createStageControlUseCases(repository, ctx.identity, ctx.clock, ctx.ids);
 assert.equal(tasks.save({ expected: taskSnapshot(state), draft: draft() }).ok, true);
 const taskId = state.tasks[0].id;
 const control = (action: 'complete' | 'accept') => stages.control({ stageId: 'stage', action, expected: stageCommandSnapshot(state, 'stage'), input: { date: '2026-10-20', note: 'Факт проверен', tasks: [] } });
 assert.equal(control('complete').ok, true);
 assert.equal(control('accept').ok, false);
 assert.equal(tasks.status({ taskId, expected: taskSnapshot(state, taskId), status: 'done', text: 'Принято', extra: { completionNote: 'Проверено' } }).ok, true);
 assert.equal(control('accept').ok, false);
 state.checkpoints[0].photos = [photo()];
 assert.equal(quality.update({ checkpointId: 'point', expected: checkpointSnapshot(state, 'point'), patch: { status: 'accepted', acceptedAt: now, clientVisible: true }, summary: 'Принято качество' }).ok, true);
 const before = structuredClone(state);
 assert.equal(control('accept').ok, true);
 assert.equal(validateStageControl(before, structuredClone(state), ctx.identity, now), null);
 assert.equal(state.stages[0].status, 'accepted'); assert.equal(state.tasks[0].status, 'done'); assert.equal(state.checkpoints[0].status, 'accepted');
 assert.deepEqual(state.financeEntries, before.financeEntries);
});

test('construction runtime policies are inward dependencies shared by compatibility routes and UI', async () => {
 const domain = await import('../src/domain/construction/index.js');
 const routes = await import('../sites/projects/stage-control.js');
 const baseline = await import('../sites/projects/baseline.js');
 const schedule = await import('../sites/lib/automatic-schedule.js');
 assert.equal(routes.validateStageControl, domain.validateStageControl);
 assert.equal(baseline.validateBaselineChanges, domain.validateBaselineChanges);
 assert.equal(schedule.automaticSchedule, domain.automaticSchedule);
 const prepare = readFileSync(new URL('../scripts/prepare-sites-build.mjs', import.meta.url), 'utf8');
 const docker = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
 assert.match(docker, /COPY --from=build \/app\/src\/domain\/construction \.\/src\/domain\/construction/);
 assert.match(prepare, /src\/domain\/construction\/\$\{name\}\.js.*dist\/src\/domain\/construction\/\$\{name\}\.js/);
 for (const name of readdirSync(new URL('../src/domain/construction/', import.meta.url)).filter(name => name.endsWith('.js'))) {
  const code = readFileSync(new URL(`../src/domain/construction/${name}`, import.meta.url), 'utf8');
  assert.doesNotMatch(code, /\bfetch\(|\.DB\b|process\.env|infrastructure|from ['"]react|from ['"][^'"]*sites\//, name);
  for (const match of code.matchAll(/from ['"]([^'"]+)['"]/g)) assert.ok(match[1].startsWith('./'), name);
  assert.ok(prepare.includes(`'${name.slice(0, -3)}'`), name);
 }
 for (const name of readdirSync(new URL('../src/application/', import.meta.url)).filter(name => name.endsWith('.ts'))) assert.doesNotMatch(readFileSync(new URL(`../src/application/${name}`, import.meta.url), 'utf8'), /from ['"][^'"]*sites\//, name);
});
