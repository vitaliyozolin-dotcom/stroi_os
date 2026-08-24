import { synchronizeDerivedProgress } from '../domain/index.ts';
import type { AppState, UserRole } from '../entities/index.ts';
import { ProjectRevisionConflict } from './ports.ts';
import type { CachedProject, ProjectCacheSession, ProjectRepository, RemoteProjectSnapshot } from './ports.ts';
import {
  applyRemoteSnapshot,
  createSyncModel,
  reconcileRemoteSnapshot,
  reconcileRevisionConflict,
  reconcileSavedSnapshot,
  type SyncModel,
} from './project-sync.ts';

export type ProjectSyncEvent =
  | { phase: 'loading'; revision: number; updatedAt?: string }
  | { phase: 'saving'; revision: number; updatedAt?: string }
  | { phase: 'saved'; revision: number; updatedAt?: string; dirty: boolean }
  | { phase: 'offline'; revision: number; updatedAt?: string; error: unknown; context?: 'switch_cache' | 'switch_missing' | 'switch_cached' }
  | { phase: 'conflict'; revision: number; updatedAt?: string; conflicts: string[] };

export interface ProjectSyncWorkflow {
  repository: ProjectRepository;
  actor(): string;
  role(): UserRole;
  readModel(): SyncModel;
  writeModel(model: SyncModel, render?: boolean): void;
  queueCache(project: CachedProject): void;
  cache(): ProjectCacheSession | null;
  conflict(): RemoteProjectSnapshot | null;
  setConflict(conflict: RemoteProjectSnapshot | null): void;
  saving(): boolean;
  setSaving(saving: boolean): void;
  emit(event: ProjectSyncEvent): void;
}

const cached = (model: SyncModel): CachedProject => ({
  state: model.state,
  revision: model.revision,
  dirty: model.dirty,
  updatedAt: model.updatedAt,
});

export const applyProjectRemote = (workflow: ProjectSyncWorkflow, remote: RemoteProjectSnapshot) => {
  const model = applyRemoteSnapshot(workflow.readModel(), remote);
  workflow.writeModel(model);
  workflow.setConflict(null);
  workflow.emit({ phase: 'saved', revision: remote.revision, updatedAt: remote.updatedAt, dirty: false });
  workflow.queueCache(cached(model));
};

export const flushProjectChanges = async (workflow: ProjectSyncWorkflow) => {
  let model = workflow.readModel();
  if (!model.ready || workflow.saving() || workflow.conflict() || !model.dirty) return;
  workflow.setSaving(true);
  try {
    while ((model = workflow.readModel()).dirty && !workflow.conflict()) {
      const snapshot = synchronizeDerivedProgress(model.state);
      workflow.writeModel({ ...model, state: snapshot, dirty: false }, false);
      workflow.emit({ phase: 'saving', revision: model.revision, updatedAt: model.updatedAt });
      try {
        const result = await workflow.repository.save({
          state: snapshot,
          expectedRevision: model.revision,
          actor: workflow.actor(),
          role: workflow.role(),
          action: model.pendingAction,
          summary: model.pendingSummary,
        });
        const saved = reconcileSavedSnapshot(workflow.readModel(), snapshot, { ...result, state: result.state ?? snapshot });
        workflow.writeModel(saved);
        workflow.queueCache(cached(saved));
        workflow.emit({ phase: 'saved', revision: saved.revision, updatedAt: saved.updatedAt, dirty: saved.dirty });
      } catch (error) {
        const dirty = { ...workflow.readModel(), dirty: true };
        workflow.writeModel(dirty, false);
        if (error instanceof ProjectRevisionConflict) {
          const resolution = reconcileRevisionConflict(dirty, snapshot, error.current);
          if (resolution.kind === 'save') {
            workflow.writeModel(resolution.model);
            workflow.queueCache(cached(resolution.model));
            continue;
          }
          workflow.setConflict(error.current);
          workflow.emit({ phase: 'conflict', revision: dirty.revision, updatedAt: dirty.updatedAt, conflicts: resolution.conflicts });
        } else {
          workflow.emit({ phase: 'offline', revision: dirty.revision, updatedAt: dirty.updatedAt, error });
        }
        break;
      }
    }
  } finally {
    workflow.setSaving(false);
  }
};

export const hydrateProject = async (workflow: ProjectSyncWorkflow, refreshProjects: () => Promise<void>) => {
  const before = workflow.readModel();
  workflow.emit({ phase: 'loading', revision: before.revision, updatedAt: before.updatedAt });
  try {
    const remote = await workflow.repository.load(before.state.project.id);
    workflow.writeModel({ ...workflow.readModel(), ready: true }, false);
    if (!remote) {
      workflow.writeModel({ ...workflow.readModel(), dirty: true }, false);
      await flushProjectChanges(workflow);
      await refreshProjects();
      return;
    }
    const current = workflow.readModel();
    if (current.dirty) {
      const resolution = reconcileRemoteSnapshot(current, remote);
      if (resolution.kind === 'remote') {
        applyProjectRemote(workflow, remote);
        return;
      }
      if (resolution.kind === 'save') {
        workflow.writeModel(resolution.model);
        await flushProjectChanges(workflow);
        await refreshProjects();
        return;
      }
      workflow.setConflict(remote);
      workflow.emit({ phase: 'conflict', revision: current.revision, updatedAt: current.updatedAt, conflicts: resolution.conflicts });
      return;
    }
    applyProjectRemote(workflow, remote);
    await refreshProjects();
  } catch (error) {
    const model = { ...workflow.readModel(), ready: false };
    workflow.writeModel(model, false);
    workflow.emit({ phase: 'offline', revision: model.revision, updatedAt: model.updatedAt, error });
  }
};

export const retryProjectSync = async (workflow: ProjectSyncWorkflow, refreshProjects: () => Promise<void>) => {
  if (workflow.readModel().ready) await flushProjectChanges(workflow);
  else await hydrateProject(workflow, refreshProjects);
};

export const useProjectServerVersion = (workflow: ProjectSyncWorkflow) => {
  const remote = workflow.conflict();
  if (remote) applyProjectRemote(workflow, remote);
};

export const keepProjectLocalVersion = async (workflow: ProjectSyncWorkflow) => {
  const remote = workflow.conflict();
  if (!remote) return;
  const model = { ...workflow.readModel(), revision: remote.revision, updatedAt: remote.updatedAt, dirty: true, pendingSummary: 'Конфликт разрешён: сохранена локальная версия' };
  workflow.setConflict(null);
  workflow.writeModel(model, false);
  workflow.queueCache(cached(model));
  await flushProjectChanges(workflow);
};

export const switchProjectWorkflow = async (workflow: ProjectSyncWorkflow, projectId: string) => {
  if (projectId === workflow.readModel().state.project.id) return;
  await workflow.cache()?.flush();
  const before = workflow.readModel();
  if (before.dirty && before.ready) await flushProjectChanges(workflow);
  workflow.setConflict(null);
  workflow.emit({ phase: 'loading', revision: 0 });
  try {
    const remote = await workflow.repository.load(projectId);
    if (!remote) throw new Error('not_found');
    applyProjectRemote(workflow, remote);
  } catch {
    try {
      const local = workflow.cache();
      if (!local) throw new Error('cache_unavailable');
      const project = await local.load(projectId);
      if (project.state.project.id !== projectId) {
        workflow.emit({ phase: 'offline', revision: workflow.readModel().revision, updatedAt: workflow.readModel().updatedAt, error: new Error('not_found'), context: 'switch_missing' });
        return;
      }
      const model = createSyncModel(project, project.dirty, false);
      workflow.writeModel(model);
      workflow.emit({ phase: 'offline', revision: project.revision, updatedAt: project.updatedAt, error: new Error('network_error'), context: 'switch_cached' });
    } catch (error) {
      workflow.emit({ phase: 'offline', revision: workflow.readModel().revision, updatedAt: workflow.readModel().updatedAt, error, context: 'switch_cache' });
    }
  }
};

export const createProjectWorkflow = async (workflow: ProjectSyncWorkflow, state: AppState, refreshProjects: () => Promise<void>) => {
  const before = workflow.readModel();
  if (before.dirty && before.ready) await flushProjectChanges(workflow);
  const model = createSyncModel({ state, revision: 0 }, true, true);
  model.pendingSummary = `Создан проект ${model.state.project.code}`;
  workflow.setConflict(null);
  workflow.writeModel(model);
  workflow.emit({ phase: 'saving', revision: 0 });
  workflow.queueCache(cached(model));
  await flushProjectChanges(workflow);
  await refreshProjects();
};
