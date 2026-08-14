import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchRemoteProject,
  fetchRemoteProjects,
  loadCachedProject,
  RevisionConflictError,
  saveCachedProject,
  saveRemoteProject,
  setStorageIdentityScope,
  type RemoteSnapshot,
  type ProjectListItem,
} from './storage';
import { mergeProjectStates } from './conflict';
import type { AppState, UserRole } from './types';

export type SyncPhase = 'loading' | 'saved' | 'saving' | 'offline' | 'conflict';

export interface SyncView {
  phase: SyncPhase;
  revision: number;
  updatedAt?: string;
  message?: string;
}

const errorMessage = (error: unknown) => {
  if (error instanceof Error && error.message === 'payload_too_large') return 'Данные слишком велики для сохранения. Проверьте вложения.';
  return 'Нет связи с сервером. Изменения сохранены на этом устройстве и ждут синхронизации.';
};

export function useProjectState(role: UserRole, actor: string, storageIdentity = '') {
  const initial = useRef(loadCachedProject());
  const [state, setState] = useState<AppState>(initial.current.state);
  const [sync, setSync] = useState<SyncView>({
    phase: 'loading',
    revision: initial.current.revision,
    updatedAt: initial.current.updatedAt,
  });
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
  const pendingSummaryRef = useRef('Обновлены данные проекта');
  const flushRef = useRef<() => Promise<void>>(async () => undefined);
  const hydrateRef = useRef<() => Promise<void>>(async () => undefined);

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
    stateRef.current = remote.state;
    baseRef.current = remote.state;
    revisionRef.current = remote.revision;
    updatedAtRef.current = remote.updatedAt;
    dirtyRef.current = false;
    setState(remote.state);
    setSync({ phase: 'saved', revision: remote.revision, updatedAt: remote.updatedAt });
    saveCachedProject({ state: remote.state, revision: remote.revision, dirty: false, updatedAt: remote.updatedAt });
  }, []);

  flushRef.current = async () => {
    if (!readyRef.current || savingRef.current || conflictRef.current || !dirtyRef.current) return;
    savingRef.current = true;

    try {
      while (dirtyRef.current && !conflictRef.current) {
        dirtyRef.current = false;
        const snapshot = stateRef.current;
        const expectedRevision = revisionRef.current;
        const summary = pendingSummaryRef.current;
        setSync({ phase: 'saving', revision: expectedRevision, updatedAt: updatedAtRef.current });

        try {
          const result = await saveRemoteProject({
            state: snapshot,
            expectedRevision,
            actor: actorRef.current,
            role: roleRef.current,
            summary,
          });
          revisionRef.current = result.revision;
          updatedAtRef.current = result.updatedAt;
          const serverState = result.state ?? snapshot;
          if (stateRef.current === snapshot) {
            stateRef.current = serverState;
            setState(serverState);
          } else if (result.state) {
            const merged = mergeProjectStates(snapshot, stateRef.current, result.state);
            if (!merged.conflicts.length) {
              stateRef.current = merged.state;
              setState(merged.state);
            }
          }
          baseRef.current = serverState;
          saveCachedProject({
            state: stateRef.current,
            revision: result.revision,
            dirty: dirtyRef.current,
            updatedAt: result.updatedAt,
          });
          setSync({ phase: dirtyRef.current ? 'saving' : 'saved', revision: result.revision, updatedAt: result.updatedAt });
        } catch (error) {
          dirtyRef.current = true;
          if (error instanceof RevisionConflictError) {
            const merged = mergeProjectStates(baseRef.current, snapshot, error.current.state);
            if (!merged.conflicts.length) {
              stateRef.current = merged.state;
              baseRef.current = error.current.state;
              revisionRef.current = error.current.revision;
              updatedAtRef.current = error.current.updatedAt;
              dirtyRef.current = true;
              setState(merged.state);
              saveCachedProject({
                state: merged.state,
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
              message: `Одновременно изменена одна и та же запись: ${merged.conflicts.join(', ')}.`,
            });
          } else {
            setSync({
              phase: 'offline',
              revision: revisionRef.current,
              updatedAt: updatedAtRef.current,
              message: errorMessage(error),
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

      if (dirtyRef.current && revisionRef.current !== remote.revision) {
        if (JSON.stringify(stateRef.current) === JSON.stringify(remote.state)) {
          applyRemote(remote);
          return;
        }
        const merged = mergeProjectStates(baseRef.current, stateRef.current, remote.state);
        if (!merged.conflicts.length) {
          stateRef.current = merged.state;
          baseRef.current = remote.state;
          revisionRef.current = remote.revision;
          updatedAtRef.current = remote.updatedAt;
          dirtyRef.current = true;
          setState(merged.state);
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
          message: `Одновременно изменена одна и та же запись: ${merged.conflicts.join(', ')}.`,
        });
        return;
      }

      if (dirtyRef.current) {
        await flushRef.current();
      } else {
        applyRemote(remote);
      }
      await refreshProjects();
    } catch (error) {
      readyRef.current = false;
      setSync({
        phase: 'offline',
        revision: revisionRef.current,
        updatedAt: updatedAtRef.current,
        message: errorMessage(error),
      });
    }
  };

  useEffect(() => {
    setStorageIdentityScope(storageIdentity);
    if (!storageIdentity) return undefined;
    const cached = loadCachedProject();
    stateRef.current = cached.state;
    baseRef.current = cached.state;
    revisionRef.current = cached.revision;
    updatedAtRef.current = cached.updatedAt;
    dirtyRef.current = cached.dirty;
    readyRef.current = false;
    setState(cached.state);
    setProjects([{
      id: cached.state.project.id,
      code: cached.state.project.code,
      name: cached.state.project.name,
      model: cached.state.project.model,
      area: cached.state.project.area,
      address: cached.state.project.address,
      targetDate: cached.state.project.targetDate,
      revision: cached.revision,
      updatedAt: cached.updatedAt,
    }]);
    setSync({ phase: 'loading', revision: cached.revision, updatedAt: cached.updatedAt });
    void hydrateRef.current();
    return () => {
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    };
  }, [refreshProjects, storageIdentity]);

  const updateState = useCallback((next: AppState) => {
    const previousActivityId = stateRef.current.activity[0]?.id;
    const nextActivity = next.activity[0];
    if (nextActivity && nextActivity.id !== previousActivityId) pendingSummaryRef.current = nextActivity.text;

    stateRef.current = next;
    dirtyRef.current = true;
    setState(next);
    saveCachedProject({
      state: next,
      revision: revisionRef.current,
      dirty: true,
      updatedAt: updatedAtRef.current,
    });

    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => void flushRef.current(), 650);
  }, []);

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
    saveCachedProject({
      state: stateRef.current,
      revision: current.revision,
      dirty: true,
      updatedAt: current.updatedAt,
    });
    void flushRef.current();
  }, []);

  const switchProject = useCallback(async (projectId: string) => {
    if (projectId === stateRef.current.project.id) return;
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
      const cached = loadCachedProject(projectId);
      if (cached.state.project.id !== projectId) {
        setSync((current) => ({ ...current, phase: 'offline', message: 'Не удалось загрузить выбранный проект.' }));
        return;
      }
      stateRef.current = cached.state;
      baseRef.current = cached.state;
      revisionRef.current = cached.revision;
      updatedAtRef.current = cached.updatedAt;
      dirtyRef.current = cached.dirty;
      readyRef.current = false;
      setState(cached.state);
      setSync({ phase: 'offline', revision: cached.revision, updatedAt: cached.updatedAt, message: 'Показана локальная копия проекта.' });
    }
  }, [applyRemote]);

  const createProject = useCallback(async (nextState: AppState) => {
    if (dirtyRef.current && readyRef.current) await flushRef.current();
    stateRef.current = nextState;
    baseRef.current = nextState;
    revisionRef.current = 0;
    updatedAtRef.current = undefined;
    dirtyRef.current = true;
    readyRef.current = true;
    conflictRef.current = null;
    setConflict(null);
    setState(nextState);
    setSync({ phase: 'saving', revision: 0 });
    saveCachedProject({ state: nextState, revision: 0, dirty: true });
    pendingSummaryRef.current = `Создан проект ${nextState.project.code}`;
    await flushRef.current();
    await refreshProjects();
  }, [refreshProjects]);

  return {
    state,
    updateState,
    sync,
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
