import assert from 'node:assert/strict';
import test from 'node:test';
import { seedState, buildStages } from '../src/seed.ts';
import type { AppState } from '../src/entities/index.ts';
import { createFinanceUseCases } from '../src/application/finance.ts';
import type { FinanceRepository, FinanceReadModel } from '../src/application/finance-repository.ts';
import { createProjectFinanceRepository, financeFactsSnapshot } from '../src/infrastructure/finance-project.ts';
import { approveFinanceExpense } from '../src/application/finance-context-facts.ts';
import { validateFinanceChanges } from '../src/domain/finance/index.js';
import { applyLocalChange, createSyncModel } from '../src/application/project-sync.ts';
import { flushProjectChanges, type ProjectSyncWorkflow, type ProjectSyncEvent } from '../src/application/project-sync-workflow.ts';
import { ProjectRevisionConflict, type ProjectRepository, type RemoteProjectSnapshot, type CachedProject } from '../src/application/ports.ts';

const now = '2026-10-20T12:00:00.000Z';
const context = () => { let id = 0; return { identity: { name: 'Управляющий', role: 'management' as const }, clock: { now: () => now }, ids: { next: (prefix: string) => `${prefix}-${++id}` } }; };
const fixture = () => {
  const state = structuredClone(seedState);
  state.project.id = 'finance-test';
  state.stages = [{ ...buildStages('2026-10-01', '2026-12-01')[0], id: 'stage', status: 'accepted' }];
  state.financeEntries = [{ id: 'expense', kind: 'expense', status: 'committed', amount: 100, date: '2026-10-20', description: 'Работы', counterparty: 'Подрядчик', stageId: 'stage' }];
  return state;
};
const fact = (amount: number) => ({ entryId: 'expense', amount, date: '2026-10-20', document: 'Акт / чек', source: 'stage:stage' });
const remote = (state: AppState, revision: number): RemoteProjectSnapshot => ({ state, projectId: state.project.id, revision, updatedAt: now, updatedBy: 'Сервер', updatedRole: 'management' });
const harness = (initial: AppState, remoteRepository: ProjectRepository) => {
  let model = createSyncModel({ state: initial, revision: 7 }, false, true);
  let conflict: RemoteProjectSnapshot | null = null, saving = false;
  const events: ProjectSyncEvent[] = [], cached: CachedProject[] = [];
  const workflow: ProjectSyncWorkflow = {
    repository: remoteRepository, actor: () => 'Управляющий', role: () => 'management',
    readModel: () => model, writeModel: next => { model = next; }, queueCache: next => { cached.push(next); },
    cache: () => null, conflict: () => conflict, setConflict: next => { conflict = next; },
    saving: () => saving, setSaving: next => { saving = next; }, emit: event => { events.push(event); },
  };
  const repository = createProjectFinanceRepository(() => model.state, (next, metadata) => {
    model = applyLocalChange(model, next, metadata);
    workflow.queueCache({ state: model.state, revision: model.revision, dirty: true });
  });
  return { workflow, repository, finance: createFinanceUseCases(repository, context()), model: () => model, conflict: () => conflict, events, cached };
};
const accepted = () => {
  let state = fixture();
  const repository = createProjectFinanceRepository(() => state, next => { state = next; });
  const commands = createFinanceUseCases(repository, context());
  assert.equal(commands.approveExpense('expense').ok, true);
  assert.equal(commands.acceptExpense(fact(100)).ok, true);
  assert.equal(validateFinanceChanges(fixture(), structuredClone(state), context().identity, now), '');
  return state;
};

test('financial workflows run against a minimal scoped repository and propagate commit/read failures', () => {
  const snapshot: FinanceReadModel = {
    project: { id: 'project', code: 'P', targetCost: 0 }, budgetLines: [], budgetMeta: { version: '', source: '' },
    financeEntries: [{ id: 'expense', kind: 'expense', status: 'committed', amount: 100, date: '2026-10-20', description: 'Работы', counterparty: 'Подрядчик' }],
    documents: [], counterparties: [], stages: [], checkpoints: [], procurement: [],
  };
  let commits = 0;
  const repository: FinanceRepository = {
    read: () => ({ ok: true, snapshot }),
    commit: mutation => { commits++; assert.equal(mutation.kind, 'facts'); assert.equal('state' in mutation.change, false); return { ok: false, error: 'repository_conflict' }; },
  };
  assert.deepEqual(createFinanceUseCases(repository, context()).approveExpense('expense'), { ok: false, error: 'repository_conflict' });
  assert.equal(snapshot.financeEntries[0].approvedAt, undefined); assert.equal(commits, 1);
  repository.read = () => ({ ok: false, error: 'project_unavailable' });
  assert.deepEqual(createFinanceUseCases(repository, context()).approveExpense('expense'), { ok: false, error: 'project_unavailable' });
  assert.equal(commits, 1);
});

test('the same repository reads each staged change; consecutive approval, acceptance and payment never overwrite each other', () => {
  let state = fixture(), writes = 0;
  const repository = createProjectFinanceRepository(() => state, next => { state = next; writes++; });
  const commands = createFinanceUseCases(repository, context());
  assert.equal(commands.approveExpense('expense').ok, true);
  assert.deepEqual(commands.approveExpense('expense'), { ok: true, change: null });
  assert.equal(commands.acceptExpense(fact(100)).ok, true);
  assert.equal(commands.recordPayment(fact(40)).ok, true);
  assert.equal(state.financeEntries[0].acceptedAmount, 100); assert.equal(state.financeEntries[0].paidAmount, 40);
  assert.equal(state.documents.length, 2); assert.equal(state.activity.length, 3); assert.equal(writes, 3);
  const projection = repository.read(); assert.ok(projection.ok); if (!projection.ok) return;
  assert.equal('tasks' in projection.snapshot, false); assert.equal('settings' in projection.snapshot, false); assert.equal('activity' in projection.snapshot, false);
});

test('a repository rejects stale evaluated changes and retained handlers after project switching', () => {
  let state = fixture(), writes = 0;
  const repository = createProjectFinanceRepository(() => state, () => { writes++; });
  const commands = createFinanceUseCases(repository, context());
  const result = approveFinanceExpense(financeFactsSnapshot(state), 'expense', context());
  assert.ok(result.ok && result.change); if (!result.ok || !result.change) return;
  state.financeEntries[0].amount = 120;
  assert.equal(repository.commit({ kind: 'facts', change: result.change }).ok, false);
  state = fixture(); state.project.id = 'another-project';
  assert.equal(commands.approveExpense('expense').ok, false);
  assert.equal(repository.commit({ kind: 'facts', change: result.change }).ok, false);
  assert.equal(writes, 0); assert.equal(state.financeEntries[0].approvedAt, undefined);
});

test('offline payment stays dirty in cache and retries with the same revision, audit and one server-owned event', async () => {
  const initial = accepted(), requests: { revision: number; action?: string }[] = [];
  let persisted = structuredClone(initial);
  const remoteRepository: ProjectRepository = {
    list: async () => [], load: async () => null,
    save: async input => {
      requests.push({ revision: input.expectedRevision, action: input.action });
      if (requests.length === 1) throw Error('offline');
      const candidate = structuredClone(input.state);
      assert.equal(validateFinanceChanges(persisted, candidate, context().identity, now), '');
      persisted = candidate;
      return remote(candidate, 8);
    },
  };
  const setup = harness(initial, remoteRepository);
  assert.equal(setup.finance.recordPayment(fact(40)).ok, true);
  assert.equal(setup.model().revision, 7); assert.equal(setup.model().dirty, true);
  assert.equal(setup.cached.at(-1)?.dirty, true);
  await flushProjectChanges(setup.workflow);
  assert.equal(setup.events.at(-1)?.phase, 'offline'); assert.equal(setup.model().dirty, true);
  await flushProjectChanges(setup.workflow);
  assert.deepEqual(requests, [{ revision: 7, action: 'payment_recorded' }, { revision: 7, action: 'payment_recorded' }]);
  assert.equal(setup.model().revision, 8); assert.equal(setup.model().dirty, false);
  assert.equal(setup.events.at(-1)?.phase, 'saved');
  assert.equal(setup.model().state.financeEntries[0].payments?.length, 1);
  assert.equal(setup.model().state.financeEntries[0].payments?.[0].amount, 40);
  assert.equal(setup.model().state.activity.filter(event => event.text.includes('оплачено')).length, 1);
});

test('overlapping remote financial changes stop at conflict without overwriting or retrying money', async () => {
  const initial = accepted(), server = structuredClone(initial);
  Object.assign(server.financeEntries[0], { paidAmount: 20, paidAt: '2026-10-20', paidBy: 'Другой', paymentDocument: 'Другой чек' });
  assert.equal(validateFinanceChanges(initial, server, { name: 'Другой', role: 'management' }, now), '');
  let attempts = 0;
  const setup = harness(initial, { list: async () => [], load: async () => null, save: async () => { attempts++; throw new ProjectRevisionConflict(remote(server, 8)); } });
  assert.equal(setup.finance.recordPayment(fact(30)).ok, true);
  await flushProjectChanges(setup.workflow);
  assert.equal(attempts, 1); assert.equal(setup.events.at(-1)?.phase, 'conflict');
  assert.equal(setup.conflict()?.revision, 8); assert.equal(setup.model().dirty, true);
  assert.equal(setup.model().state.financeEntries[0].paidAmount, 30);
  assert.equal(setup.conflict()?.state.financeEntries[0].paidAmount, 20);
  await flushProjectChanges(setup.workflow); assert.equal(attempts, 1);
});

test('an unrelated remote edit merges before retrying the financial command with the latest revision', async () => {
  const initial = fixture(), server = structuredClone(initial);
  server.project.name = 'Имя изменено другим участником';
  const revisions: number[] = [];
  const setup = harness(initial, { list: async () => [], load: async () => null, save: async input => {
    revisions.push(input.expectedRevision);
    if (revisions.length === 1) throw new ProjectRevisionConflict(remote(server, 8));
    assert.equal(input.state.project.name, server.project.name);
    assert.equal(input.action, 'expense_approved');
    const candidate = structuredClone(input.state);
    assert.equal(validateFinanceChanges(server, candidate, context().identity, now), '');
    return remote(candidate, 9);
  } });
  assert.equal(setup.finance.approveExpense('expense').ok, true);
  await flushProjectChanges(setup.workflow);
  assert.deepEqual(revisions, [7, 8]); assert.equal(setup.model().revision, 9);
  assert.equal(setup.model().dirty, false); assert.equal(setup.conflict(), null);
  assert.equal(setup.model().state.project.name, server.project.name);
  assert.equal(setup.model().state.activity.filter(event => event.text.includes('Утверждён')).length, 1);
});
