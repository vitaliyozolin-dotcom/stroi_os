import { useCallback, useEffect, useRef, useState } from 'react';
import { seedState } from './seed';
import { synchronizeDerivedProgress } from './domain/index';
import type { ChangeMetadata } from './domain/change';
import type { AppState, UserRole } from './entities/index';
import { cacheErrorMessage, syncErrorMessage, type LocalCacheView, type SyncPhase, type SyncView } from './presentation/sync-status';
export type { SyncPhase } from './presentation/sync-status';

import {
  applyLocalChange,
  applyProjectRemote,
  createProjectWorkflow,
  createSyncModel,
  flushProjectChanges,
  hydrateProject,
  keepProjectLocalVersion,
  ProjectCacheError,
  retryProjectSync,
  switchProjectWorkflow,
  useProjectServerVersion,
  type CachedProject,
  type ProjectCacheFactory,
  type ProjectCacheSession,
  type RemoteProjectSnapshot,
  type ProjectListItem,
  type ProjectRepository,
  type ProjectSyncEvent,
  type ProjectSyncWorkflow,
  type SyncModel,
} from './application';

export interface ProjectStateDependencies {
  repository: ProjectRepository;
  cacheFactory: ProjectCacheFactory;
  normalizeState: (state: AppState) => AppState;
}

const cloneSeedProject = (): CachedProject => ({ state: structuredClone(seedState), revision: 0, dirty: false });

export function useProjectState(role: UserRole, actor: string, storageIdentity: string, dependencies: ProjectStateDependencies) {
  const { repository, cacheFactory, normalizeState } = dependencies;
  const initial = useRef(cloneSeedProject());
  initial.current.state = synchronizeDerivedProgress(initial.current.state);
  const [state, setState] = useState<AppState>(initial.current.state);
  const [sync, setSync] = useState<SyncView>({
    phase: 'loading',
    revision: initial.current.revision,
    updatedAt: initial.current.updatedAt,
  });
  const [localCache, setLocalCache] = useState<LocalCacheView>({ phase: 'idle' });
  const [conflict, setConflict] = useState<RemoteProjectSnapshot | null>(null);
  const [projects, setProjects] = useState<ProjectListItem[]>([{
    id: initial.current.state.project.id,
    code: initial.current.state.project.code,
    name: initial.current.state.project.name,
    model: initial.current.state.project.model,
    area: initial.current.state.project.area,
    address: initial.current.state.project.address,
    targetDate: initial.current.state.project.targetDate,
    revision: initial.current.revision,
    updatedAt: initial.current.updatedAt,
  }]);

  const stateRef = useRef(state);
  const baseRef = useRef(initial.current.state);
  const roleRef = useRef(role);
  const actorRef = useRef(actor);
  const revisionRef = useRef(initial.current.revision);
  const updatedAtRef = useRef(initial.current.updatedAt);
  const dirtyRef = useRef(initial.current.dirty);
  const readyRef = useRef(false);
  const savingRef = useRef(false);
  const conflictRef = useRef<RemoteProjectSnapshot | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const cacheSessionRef = useRef<ProjectCacheSession | null>(null);
  const cachePhaseRef = useRef<LocalCacheView['phase']>('idle');
  const pendingSummaryRef = useRef('Обновлены данные проекта');
  const pendingActionRef = useRef('project_update');
  const flushRef = useRef<() => Promise<void>>(async () => undefined);
  const workflowRef = useRef<ProjectSyncWorkflow | null>(null);

  const readModel = useCallback((): SyncModel => ({
    state: stateRef.current,
    base: baseRef.current,
    revision: revisionRef.current,
    updatedAt: updatedAtRef.current,
    dirty: dirtyRef.current,
    ready: readyRef.current,
    pendingAction: pendingActionRef.current,
    pendingSummary: pendingSummaryRef.current,
  }), []);

  const writeModel = useCallback((model: SyncModel, render = true) => {
    stateRef.current = model.state;
    baseRef.current = model.base;
    revisionRef.current = model.revision;
    updatedAtRef.current = model.updatedAt;
    dirtyRef.current = model.dirty;
    readyRef.current = model.ready;
    pendingActionRef.current = model.pendingAction;
    pendingSummaryRef.current = model.pendingSummary;
    if (render) setState(model.state);
  }, []);

  const hydrateRef = useRef<() => Promise<void>>(async () => undefined);

  const queueCache = useCallback((project: CachedProject) => {
    cacheSessionRef.current?.schedule(project);
  }, []);

  const refreshProjects = useCallback(async () => {
    try {
      const items = await repository.list();
      if (items.length) setProjects(items);
    } catch {
      // Текущий проект продолжает работать из своего снимка.
    }
  }, [repository]);

  useEffect(() => {
    roleRef.current = role;
    actorRef.current = actor;
  }, [actor, role]);

  const emitSync = useCallback((event: ProjectSyncEvent) => {
    if (event.phase === 'loading') setSync({ phase: 'loading', revision: event.revision, updatedAt: event.updatedAt });
    else if (event.phase === 'saving') setSync({ phase: 'saving', revision: event.revision, updatedAt: event.updatedAt });
    else if (event.phase === 'saved') setSync({ phase: event.dirty ? 'saving' : 'saved', revision: event.revision, updatedAt: event.updatedAt });
    else if (event.phase === 'conflict') setSync({ phase: 'conflict', revision: event.revision, updatedAt: event.updatedAt, message: `Одновременно изменена одна и та же запись: ${event.conflicts.join(', ')}.` });
    else if (event.context === 'switch_cache') {
      const error = event.error instanceof ProjectCacheError ? event.error : new ProjectCacheError('unavailable', event.error);
      cachePhaseRef.current = 'failed';
      setLocalCache({ phase: 'failed', message: cacheErrorMessage(error) });
      setSync({ phase: 'offline', revision: event.revision, updatedAt: event.updatedAt, message: 'Не удалось загрузить выбранный проект: локальная копия недоступна.' });
    } else setSync({
      phase: 'offline',
      revision: event.revision,
      updatedAt: event.updatedAt,
      message: event.context === 'switch_missing' ? 'Не удалось загрузить выбранный проект.' : event.context === 'switch_cached' ? 'Показана локальная копия проекта.' : syncErrorMessage(event.error, cachePhaseRef.current),
    });
  }, []);

  const workflow: ProjectSyncWorkflow = {
    repository,
    actor: () => actorRef.current,
    role: () => roleRef.current,
    readModel,
    writeModel,
    queueCache,
    cache: () => cacheSessionRef.current,
    conflict: () => conflictRef.current,
    setConflict: (next) => { conflictRef.current = next; setConflict(next); },
    saving: () => savingRef.current,
    setSaving: (next) => { savingRef.current = next; },
    emit: emitSync,
  };
  workflowRef.current = workflow;
  flushRef.current = () => flushProjectChanges(workflow);
  hydrateRef.current = () => hydrateProject(workflow, refreshProjects);

  const applyRemote = useCallback((remote: RemoteProjectSnapshot) => {
    const current = workflowRef.current;
    if (current) applyProjectRemote(current, remote);
  }, []);

  useEffect(() => {
    if (!storageIdentity) return undefined;
    let active = true;
    const cache = cacheFactory.create(storageIdentity, normalizeState, (phase, projectId, error) => {
      if (!active || projectId !== stateRef.current.project.id) return;
      cachePhaseRef.current = phase;
      setLocalCache({ phase, message: phase === 'failed' ? cacheErrorMessage(error) : undefined });
      setSync((current) => current.phase === 'offline'
        ? { ...current, message: syncErrorMessage(new Error('network_error'), phase) }
        : current);
    });
    cacheSessionRef.current = cache;
    cachePhaseRef.current = 'idle';
    setLocalCache({ phase: 'idle' });

    const initialize = async () => {
      let cached = cloneSeedProject();
      try {
        cached = await cache.load();
      } catch (error) {
        const cacheError = error instanceof ProjectCacheError ? error : new ProjectCacheError('unavailable', error);
        cachePhaseRef.current = 'failed';
        setLocalCache({ phase: 'failed', message: cacheErrorMessage(cacheError) });
      }
      if (!active) return;
      const cachedModel = createSyncModel(cached, cached.dirty, false);
      writeModel(cachedModel);
      const normalizedCached = cachedModel.state;
      setProjects([{
        id: normalizedCached.project.id,
        code: normalizedCached.project.code,
        name: normalizedCached.project.name,
        model: normalizedCached.project.model,
        area: normalizedCached.project.area,
        address: normalizedCached.project.address,
        targetDate: normalizedCached.project.targetDate,
        revision: cached.revision,
        updatedAt: cached.updatedAt,
      }]);
      setSync({ phase: 'loading', revision: cached.revision, updatedAt: cached.updatedAt });
      await hydrateRef.current();
    };
    const flushCache = () => { void cache.flush(); };
    window.addEventListener('pagehide', flushCache);
    document.addEventListener('visibilitychange', flushCache);
    void initialize();
    return () => {
      active = false;
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
      window.removeEventListener('pagehide', flushCache);
      document.removeEventListener('visibilitychange', flushCache);
      void cache.flush();
      if (cacheSessionRef.current === cache) cacheSessionRef.current = null;
    };
  }, [cacheFactory, normalizeState, refreshProjects, storageIdentity, writeModel]);

  const updateState = useCallback((next: AppState, metadata?: ChangeMetadata) => {
    const model = applyLocalChange(readModel(), next, metadata);
    writeModel(model);
    queueCache({
      state: model.state,
      revision: revisionRef.current,
      dirty: true,
      updatedAt: updatedAtRef.current,
    });

    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => void flushRef.current(), 650);
  }, [queueCache, readModel, writeModel]);

  const retry = useCallback(() => {
    const current = workflowRef.current;
    if (current) void retryProjectSync(current, refreshProjects);
  }, [refreshProjects]);

  const useServerVersion = useCallback(() => {
    const current = workflowRef.current;
    if (current) useProjectServerVersion(current);
  }, []);

  const keepLocalVersion = useCallback(() => {
    const current = workflowRef.current;
    if (current) void keepProjectLocalVersion(current);
  }, []);

  const switchProject = useCallback(async (projectId: string) => {
    const current = workflowRef.current;
    if (current) await switchProjectWorkflow(current, projectId);
  }, []);

  const createProject = useCallback(async (nextState: AppState) => {
    const current = workflowRef.current;
    if (current) await createProjectWorkflow(current, nextState, refreshProjects);
  }, [refreshProjects]);

  return {
    state,
    updateState,
    sync,
    localCache,
    conflict,
    retry,
    useServerVersion,
    keepLocalVersion,
    applyServerSnapshot: applyRemote,
    projects,
    switchProject,
    createProject,
  };
}
