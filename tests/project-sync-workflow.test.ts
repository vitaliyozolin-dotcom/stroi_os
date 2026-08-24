import assert from 'node:assert/strict';
import test from 'node:test';

import { applyLocalChange, createSyncModel } from '../src/application/project-sync.ts';
import { flushProjectChanges, switchProjectWorkflow, type ProjectSyncEvent, type ProjectSyncWorkflow } from '../src/application/project-sync-workflow.ts';
import { ProjectRevisionConflict } from '../src/application/ports.ts';
import type { CachedProject, ProjectCacheSession, ProjectRepository, RemoteProjectSnapshot } from '../src/application/ports.ts';
import type { AppState } from '../src/entities/index.ts';
import { seedState } from '../src/seed.ts';

const remote = (state: AppState, revision: number): RemoteProjectSnapshot => ({
  projectId: state.project.id,
  state,
  revision,
  updatedAt: `revision-${revision}`,
  updatedBy: 'Сервер',
  updatedRole: 'management',
});

const harness = (repository: ProjectRepository, initial = createSyncModel({ state: structuredClone(seedState), revision: 1 }, false, true), cache: ProjectCacheSession | null = null) => {
  let model = initial;
  let conflict: RemoteProjectSnapshot | null = null;
  let saving = false;
  const events: ProjectSyncEvent[] = [];
  const cached: CachedProject[] = [];
  const workflow: ProjectSyncWorkflow = {
    repository,
    actor: () => 'Проверяющий',
    role: () => 'management',
    readModel: () => model,
    writeModel: (next) => { model = next; },
    queueCache: (project) => { cached.push(project); },
    cache: () => cache,
    conflict: () => conflict,
    setConflict: (next) => { conflict = next; },
    saving: () => saving,
    setSaving: (next) => { saving = next; },
    emit: (event) => { events.push(event); },
  };
  return { workflow, events, cached, model: () => model, conflict: () => conflict };
};

test('workflow saves the expected revision and keeps audit metadata', async () => {
  const saves: Array<{ revision: number; action?: string; summary?: string }> = [];
  const repository: ProjectRepository = {
    list: async () => [],
    load: async () => null,
    save: async (input) => {
      saves.push({ revision: input.expectedRevision, action: input.action, summary: input.summary });
      return { ...remote(input.state, 2), state: input.state };
    },
  };
  const current = createSyncModel({ state: structuredClone(seedState), revision: 1 }, false, true);
  const next = structuredClone(current.state);
  next.project.name = 'Обновлённый проект';
  const setup = harness(repository, applyLocalChange(current, next, { action: 'project_renamed', summary: 'Проект переименован' }));

  await flushProjectChanges(setup.workflow);

  assert.deepEqual(saves, [{ revision: 1, action: 'project_renamed', summary: 'Проект переименован' }]);
  assert.equal(setup.model().revision, 2);
  assert.equal(setup.model().dirty, false);
  assert.equal(setup.cached.at(-1)?.revision, 2);
  assert.equal(setup.events.at(-1)?.phase, 'saved');
});

test('workflow merges a non-overlapping revision conflict and retries against the new revision', async () => {
  const base = structuredClone(seedState);
  base.tasks.push({ id: 'task-1', title: 'Задача', status: 'todo', priority: 'normal', assigneeId: 'u1', assigneeName: 'Прораб', createdBy: 'Прораб', createdAt: '2026-08-20T09:00:00Z', updatedAt: '2026-08-20T09:00:00Z', dueDate: '2026-08-21', originalDueDate: '2026-08-21', rescheduleCount: 0, history: [] });
  base.procurement.push({ id: 'supply-1', stageId: 'stage-1', item: 'Бетон', quantity: 1, unit: 'м³', neededBy: '2026-08-21', status: 'need', budget: 0, supplier: 'Не выбран', owner: 'Прораб' });
  const local = structuredClone(base);
  local.tasks[0].status = 'in_progress';
  const server = structuredClone(base);
  server.procurement[0].status = 'rfq';
  const revisions: number[] = [];
  const repository: ProjectRepository = {
    list: async () => [],
    load: async () => null,
    save: async (input) => {
      revisions.push(input.expectedRevision);
      if (revisions.length === 1) throw new ProjectRevisionConflict(remote(server, 2));
      return { ...remote(input.state, 3), state: input.state };
    },
  };
  const setup = harness(repository, applyLocalChange(createSyncModel({ state: base, revision: 1 }, false, true), local));

  await flushProjectChanges(setup.workflow);

  assert.deepEqual(revisions, [1, 2]);
  assert.equal(setup.model().state.tasks[0].status, 'in_progress');
  assert.equal(setup.model().state.procurement[0].status, 'rfq');
  assert.equal(setup.model().revision, 3);
  assert.equal(setup.conflict(), null);
});

test('project switching falls back to the selected cached project when remote loading fails', async () => {
  const cachedState = structuredClone(seedState);
  cachedState.project.id = 'project-2';
  const cache: ProjectCacheSession = {
    load: async () => ({ state: cachedState, revision: 7, dirty: true }),
    schedule: () => undefined,
    flush: async () => undefined,
  };
  const repository: ProjectRepository = {
    list: async () => [],
    load: async () => { throw new Error('network_error'); },
    save: async () => { throw new Error('unexpected_save'); },
  };
  const setup = harness(repository, undefined, cache);

  await switchProjectWorkflow(setup.workflow, 'project-2');

  assert.equal(setup.model().state.project.id, 'project-2');
  assert.equal(setup.model().revision, 7);
  assert.equal(setup.model().ready, false);
  assert.equal(setup.events.at(-1)?.phase, 'offline');
  assert.equal(setup.events.at(-1)?.phase === 'offline' ? setup.events.at(-1)?.context : undefined, 'switch_cached');
});
