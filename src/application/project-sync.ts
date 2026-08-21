import { mergeProjectStates, synchronizeDerivedProgress } from '../domain/index.ts';
import type { ChangeMetadata } from '../domain/change.ts';
import type { AppState } from '../entities/index.ts';

export interface SyncSnapshot {
  state: AppState;
  revision: number;
  updatedAt?: string;
}

export interface SyncModel extends SyncSnapshot {
  base: AppState;
  dirty: boolean;
  ready: boolean;
  pendingAction: string;
  pendingSummary: string;
}

export type RemoteReconciliation =
  | { kind: 'remote'; model: SyncModel }
  | { kind: 'save'; model: SyncModel }
  | { kind: 'conflict'; model: SyncModel; conflicts: string[] };
export type SaveReconciliation =
  | { kind: 'save'; model: SyncModel }
  | { kind: 'conflict'; model: SyncModel; conflicts: string[] };

export const createSyncModel = (snapshot: SyncSnapshot, dirty = false, ready = false): SyncModel => {
  const state = synchronizeDerivedProgress(snapshot.state);
  return {
    state,
    base: state,
    revision: snapshot.revision,
    updatedAt: snapshot.updatedAt,
    dirty,
    ready,
    pendingAction: 'project_update',
    pendingSummary: 'Обновлены данные проекта',
  };
};

export const applyLocalChange = (model: SyncModel, next: AppState, metadata?: ChangeMetadata): SyncModel => {
  const state = synchronizeDerivedProgress(next);
  const activity = state.activity[0];
  const hasNewActivity = activity && activity.id !== model.state.activity[0]?.id;
  return {
    ...model,
    state,
    dirty: true,
    pendingAction: metadata?.action ?? model.pendingAction,
    pendingSummary: metadata?.summary ?? (hasNewActivity ? activity.text : model.pendingSummary),
  };
};

export const applyRemoteSnapshot = (model: SyncModel, remote: SyncSnapshot): SyncModel => {
  const state = synchronizeDerivedProgress(remote.state);
  return { ...model, state, base: state, revision: remote.revision, updatedAt: remote.updatedAt, dirty: false, ready: true };
};

export const reconcileRemoteSnapshot = (model: SyncModel, remote: SyncSnapshot): RemoteReconciliation => {
  if (!model.dirty) return { kind: 'remote', model: applyRemoteSnapshot(model, remote) };
  if (model.revision === remote.revision) return { kind: 'save', model: { ...model, ready: true } };
  if (JSON.stringify(model.state) === JSON.stringify(remote.state)) return { kind: 'remote', model: applyRemoteSnapshot(model, remote) };
  const merged = mergeProjectStates(model.base, model.state, remote.state);
  if (merged.conflicts.length) return { kind: 'conflict', model: { ...model, ready: true }, conflicts: merged.conflicts };
  return {
    kind: 'save',
    model: {
      ...model,
      state: synchronizeDerivedProgress(merged.state),
      base: synchronizeDerivedProgress(remote.state),
      revision: remote.revision,
      updatedAt: remote.updatedAt,
      dirty: true,
      ready: true,
    },
  };
};

export const reconcileSavedSnapshot = (model: SyncModel, sent: AppState, remote: SyncSnapshot): SyncModel => {
  const serverState = synchronizeDerivedProgress(remote.state ?? sent);
  let state = model.state;
  if (model.state === sent) state = serverState;
  else if (remote.state) {
    const merged = mergeProjectStates(sent, model.state, serverState);
    if (!merged.conflicts.length) state = synchronizeDerivedProgress(merged.state);
  }
  return { ...model, state, base: serverState, revision: remote.revision, updatedAt: remote.updatedAt };
};

export const reconcileRevisionConflict = (model: SyncModel, sent: AppState, remote: SyncSnapshot): SaveReconciliation => {
  const merged = mergeProjectStates(model.base, sent, remote.state);
  if (merged.conflicts.length) return { kind: 'conflict', model, conflicts: merged.conflicts };
  return {
    kind: 'save',
    model: {
      ...model,
      state: synchronizeDerivedProgress(merged.state),
      base: synchronizeDerivedProgress(remote.state),
      revision: remote.revision,
      updatedAt: remote.updatedAt,
      dirty: true,
    },
  };
};
