import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchRemoteProject,
  fetchRemoteProjects,
  normalizeAppState,
  RevisionConflictError,
  saveRemoteProject,
  type RemoteSnapshot,
  type ProjectListItem,
} from './storage';
import {
  cloneSeedProject,
  createProjectCache,
  ProjectCacheError,
  ProjectCacheWriter,
  type CachedProject,
} from './projectCache';
import { synchronizeDerivedProgress } from './domain/index';
import type { ChangeMetadata } from './domain/change';
import type { AppState, UserRole } from './entities/index';

import {
  applyLocalChange,
  applyRemoteSnapshot,
  createSyncModel,
  reconcileRemoteSnapshot,
  reconcileRevisionConflict,
  reconcileSavedSnapshot,
  type SyncModel,
} from './application';
export type SyncPhase = 'loading' | 'saved' | 'saving' | 'offline' | 'conflict';

export interface SyncView {
  phase: SyncPhase;
  revision: number;
  updatedAt?: string;
  message?: string;
}

export interface LocalCacheView {
  phase: 'idle' | 'saving' | 'saved' | 'failed';
  message?: string;
}

const errorMessage = (error: unknown, cachePhase: LocalCacheView['phase']) => {
  if (error instanceof Error && error.message === 'payload_too_large') return 'Данные слишком велики для сохранения. Проверьте вложения.';
  if (cachePhase === 'failed') return 'Сервер недоступен, локальная копия тоже не сохранена. Не закрывайте вкладку.';
  if (cachePhase === 'saving') return 'Нет связи с сервером. Локальная копия ещё сохраняется на этом устройстве.';
  return 'Нет связи с сервером. Изменения сохранены на этом устройстве и ждут синхронизации.';
};

const cacheErrorMessage = (error?: ProjectCacheError) => error?.code === 'quota_exceeded'
  ? 'Локальная копия не сохранена: в хранилище браузера закончилось место.'
  : error?.code === 'corrupt'
    ? 'Локальная копия повреждена и не была загружена.'
    : 'Локальная копия недоступна в этом браузере.';

export function useProjectState(role: UserRole, actor: string, storageIdentity = '') {
  const initial = useRef(cloneSeedProject());
  initial.current.state = synchronizeDerivedProgress(initial.current.state);
  const [state, setState] = useState<AppState>(initial.current.state);
  const [sync, setSync] = useState<SyncView>({
    phase: 'loading',
    revision: initial.current.revision,
    updatedAt: initial.current.updatedAt,
  });
  const [localCache, setLocalCache] = useState<LocalCacheView>({ phase: 'idle' });
  const [conflict, setConflict] = useState<RemoteSnapshot | null>(null);
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
  const conflictRef = useRef<RemoteSnapshot | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const cacheWriterRef = useRef<ProjectCacheWriter | null>(null);
  const cachePhaseRef = useRef<LocalCacheView['phase']>('idle');
  const pendingSummaryRef = useRef('Обновлены данные проекта');
  const pendingActionRef = useRef('project_update');
  const flushRef = useRef<() => Promise<void>>(async () => undefined);

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
    cacheWriterRef.current?.schedule(project);
  }, []);

  const refreshProjects = useCallback(async () => {
    try {
      const items = await fetchRemoteProjects();
      if (items.length) setProjects(items);
    } catch {
      // Текущий проект продолжает работать из своего снимка.
    }
  }, []);

  useEffect(() => {
    roleRef.current = role;
    actorRef.current = actor;
  }, [actor, role]);

  const applyRemote = useCallback((remote: RemoteSnapshot) => {
    const model = applyRemoteSnapshot(readModel(), remote);
    writeModel(model);
    setSync({ phase: 'saved', revision: remote.revision, updatedAt: remote.updatedAt });
    queueCache({ state: model.state, revision: remote.revision, dirty: false, updatedAt: remote.updatedAt });
  }, [queueCache, readModel, writeModel]);

  flushRef.current = async () => {
    if (!readyRef.current || savingRef.current || conflictRef.current || !dirtyRef.current) return;
    savingRef.current = true;

    try {
      while (dirtyRef.current && !conflictRef.current) {
        dirtyRef.current = false;
        const snapshot = synchronizeDerivedProgress(stateRef.current);
        stateRef.current = snapshot;
        const expectedRevision = revisionRef.current;
        const summary = pendingSummaryRef.current;
        setSync({ phase: 'saving', revision: expectedRevision, updatedAt: updatedAtRef.current });

        try {
          const result = await saveRemoteProject({
            state: snapshot,
            expectedRevision,
            actor: actorRef.current,
            role: roleRef.current,
            action: pendingActionRef.current,
            summary,
          });
          const saved = reconcileSavedSnapshot(readModel(), snapshot, { ...result, state: result.state ?? snapshot });
          writeModel(saved);
          queueCache({
            state: stateRef.current,
            revision: result.revision,
            dirty: dirtyRef.current,
            updatedAt: result.updatedAt,
          });
          setSync({ phase: dirtyRef.current ? 'saving' : 'saved', revision: result.revision, updatedAt: result.updatedAt });
        } catch (error) {
          dirtyRef.current = true;
          if (error instanceof RevisionConflictError) {
            const resolution = reconcileRevisionConflict(readModel(), snapshot, error.current);
            if (resolution.kind === 'save') {
              writeModel(resolution.model);
              queueCache({
                state: resolution.model.state,
                revision: error.current.revision,
                dirty: true,
                updatedAt: error.current.updatedAt,
              });
              continue;
            }
            conflictRef.current = error.current;
            setConflict(error.current);
            setSync({
              phase: 'conflict',
              revision: revisionRef.current,
              updatedAt: updatedAtRef.current,
              message: `Одновременно изменена одна и та же запись: ${resolution.conflicts.join(', ')}.`,
            });
          } else {
            setSync({
              phase: 'offline',
              revision: revisionRef.current,
              updatedAt: updatedAtRef.current,
              message: errorMessage(error, cachePhaseRef.current),
            });
          }
          break;
        }
      }
    } finally {
      savingRef.current = false;
    }
  };

  hydrateRef.current = async () => {
    setSync((current) => ({ ...current, phase: 'loading', message: undefined }));
    try {
      const remote = await fetchRemoteProject(stateRef.current.project.id);
      readyRef.current = true;

      if (!remote) {
        dirtyRef.current = true;
        await flushRef.current();
        await refreshProjects();
        return;
      }

      if (dirtyRef.current) {
        const resolution = reconcileRemoteSnapshot(readModel(), remote);
        if (resolution.kind === 'remote') {
          applyRemote(remote);
          return;
        }
        if (resolution.kind === 'save') {
          writeModel(resolution.model);
          await flushRef.current();
          await refreshProjects();
          return;
        }
        conflictRef.current = remote;
        setConflict(remote);
        setSync({
          phase: 'conflict',
          revision: revisionRef.current,
          updatedAt: updatedAtRef.current,
          message: `Одновременно изменена одна и та же запись: ${resolution.conflicts.join(', ')}.`,
        });
        return;
      }

      applyRemote(remote);
      await refreshProjects();
    } catch (error) {
      readyRef.current = false;
      setSync({
        phase: 'offline',
        revision: revisionRef.current,
        updatedAt: updatedAtRef.current,
        message: errorMessage(error, cachePhaseRef.current),
      });
    }
  };

  useEffect(() => {
    if (!storageIdentity) return undefined;
    let active = true;
    const cache = createProjectCache(storageIdentity, normalizeAppState);
    const writer = new ProjectCacheWriter(cache, (phase, projectId, error) => {
      if (!active || projectId !== stateRef.current.project.id) return;
      cachePhaseRef.current = phase;
      setLocalCache({ phase, message: phase === 'failed' ? cacheErrorMessage(error) : undefined });
      setSync((current) => current.phase === 'offline'
        ? { ...current, message: errorMessage(new Error('network_error'), phase) }
        : current);
    });
    cacheWriterRef.current = writer;
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
    const flushCache = () => { void writer.flush(); };
    window.addEventListener('pagehide', flushCache);
    document.addEventListener('visibilitychange', flushCache);
    void initialize();
    return () => {
      active = false;
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
      window.removeEventListener('pagehide', flushCache);
      document.removeEventListener('visibilitychange', flushCache);
      void writer.flush();
      if (cacheWriterRef.current === writer) cacheWriterRef.current = null;
    };
  }, [refreshProjects, storageIdentity, writeModel]);

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
    if (readyRef.current) void flushRef.current();
    else void hydrateRef.current();
  }, []);

  const useServerVersion = useCallback(() => {
    const current = conflictRef.current;
    if (!current) return;
    conflictRef.current = null;
    setConflict(null);
    applyRemote(current);
  }, [applyRemote]);

  const keepLocalVersion = useCallback(() => {
    const current = conflictRef.current;
    if (!current) return;
    revisionRef.current = current.revision;
    updatedAtRef.current = current.updatedAt;
    conflictRef.current = null;
    setConflict(null);
    dirtyRef.current = true;
    pendingSummaryRef.current = 'Конфликт разрешён: сохранена локальная версия';
    queueCache({
      state: stateRef.current,
      revision: current.revision,
      dirty: true,
      updatedAt: current.updatedAt,
    });
    void flushRef.current();
  }, [queueCache]);

  const switchProject = useCallback(async (projectId: string) => {
    if (projectId === stateRef.current.project.id) return;
    await cacheWriterRef.current?.flush();
    if (dirtyRef.current && readyRef.current) await flushRef.current();
    setSync({ phase: 'loading', revision: 0 });
    setConflict(null);
    conflictRef.current = null;
    try {
      const remote = await fetchRemoteProject(projectId);
      if (!remote) throw new Error('not_found');
      readyRef.current = true;
      applyRemote(remote);
    } catch {
      const cache = createProjectCache(storageIdentity, normalizeAppState);
      let cached: CachedProject;
      try {
        cached = await cache.load(projectId);
      } catch (error) {
        const cacheError = error instanceof ProjectCacheError ? error : new ProjectCacheError('unavailable', error);
        cachePhaseRef.current = 'failed';
        setLocalCache({ phase: 'failed', message: cacheErrorMessage(cacheError) });
        setSync((current) => ({ ...current, phase: 'offline', message: 'Не удалось загрузить выбранный проект: локальная копия недоступна.' }));
        return;
      }
      if (cached.state.project.id !== projectId) {
        setSync((current) => ({ ...current, phase: 'offline', message: 'Не удалось загрузить выбранный проект.' }));
        return;
      }
      const cachedModel = createSyncModel(cached, cached.dirty, false);
      writeModel(cachedModel);
      setSync({ phase: 'offline', revision: cached.revision, updatedAt: cached.updatedAt, message: 'Показана локальная копия проекта.' });
    }
  }, [applyRemote, storageIdentity, writeModel]);

  const createProject = useCallback(async (nextState: AppState) => {
    if (dirtyRef.current && readyRef.current) await flushRef.current();
    const model = createSyncModel({ state: nextState, revision: 0 }, true, true);
    model.pendingSummary = `Создан проект ${model.state.project.code}`;
    writeModel(model);
    conflictRef.current = null;
    setConflict(null);
    setSync({ phase: 'saving', revision: 0 });
    queueCache({ state: model.state, revision: 0, dirty: true });
    await flushRef.current();
    await refreshProjects();
  }, [queueCache, refreshProjects, writeModel]);

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
