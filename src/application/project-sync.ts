import { mergeProjectStates, synchronizeDerivedProgress } from '../domain/index.ts';
import type { ChangeMetadata } from '../domain/change.ts';
import type { AppState, StageSchedule, StageSiteUpdate } from '../entities/index.ts';
import { schedulePayload, sitePayload } from '../../sites/lib/schedule-forecast.js';

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

// Acknowledging our own write must accept server stamps even if another field
// in the same task/project was edited while the request was in flight.
const acknowledgePlanFields = (sent: AppState, local: AppState, server: AppState) => {
  const base = structuredClone(sent), current = structuredClone(local);
  const accept = (sentItem: object, localItem: object, serverItem: object, dateFields: string[]) => {
    const before = sentItem as Record<string, unknown>, item = localItem as Record<string, unknown>, saved = serverItem as Record<string, unknown>;
    const hasNewPlan = dateFields.some((field) => before[field] !== item[field]) || before.planChangeReason !== item.planChangeReason;
    const newStatus = before.status !== item.status || before.statusNote !== item.statusNote;
    const newRecovery = before.factRecoveryNote !== item.factRecoveryNote;
    for (const field of ['schedule', 'siteUpdate'] as const) {
      const payload = (value: unknown) => field === 'schedule' ? schedulePayload(value as StageSchedule | undefined) : sitePayload(value as StageSiteUpdate | undefined);
      const pending = (value: unknown) => (value as { requestId?: string } | undefined)?.requestId;
      const changed = JSON.stringify(payload(before[field])) !== JSON.stringify(payload(item[field])) || pending(before[field]) !== pending(item[field]);
      if (saved[field] !== undefined) {
        before[field] = structuredClone(saved[field]);
        if (!changed) item[field] = structuredClone(saved[field]);
      }
    }
    for (const field of ['baseline', 'originalDueDate', 'planHistory', 'statusHistory', 'scheduleHistory', 'forecastUpdatedAt', 'forecastUpdatedBy', 'workForecastUpdatedAt', 'workForecastUpdatedBy', 'acceptedAt', 'acceptedBy', 'ownerAcceptance']) {
      if (saved[field] !== undefined) { before[field] = structuredClone(saved[field]); item[field] = structuredClone(saved[field]); }
      else if (field === 'planHistory') { delete before[field]; delete item[field]; }
    }
    delete before.planChangeReason;
    if (!hasNewPlan) delete item.planChangeReason;
    delete before.statusNote;
    if (!newStatus) delete item.statusNote;
    delete before.factRecoveryNote;
    if (!newRecovery) delete item.factRecoveryNote;
  };
  accept(base.project, current.project, server.project, ['startDate', 'targetDate']);
  for (const collection of ['tasks', 'stages', 'checkpoints'] as const) {
    const fields = collection === 'tasks' ? ['plannedStart', 'dueDate'] : collection === 'stages' ? ['planStart', 'planEnd'] : [];
    for (const saved of server[collection]) {
      const before = base[collection].find((item) => item.id === saved.id), item = current[collection].find((item) => item.id === saved.id);
      if (before && item) accept(before, item, saved, fields);
    }
  }
  return { base, current };
};

export const reconcileSavedSnapshot = (model: SyncModel, sent: AppState, remote: SyncSnapshot): SyncModel => {
  const serverState = synchronizeDerivedProgress(remote.state ?? sent);
  let state = model.state;
  if (model.state === sent) state = serverState;
  else if (remote.state) {
    const accepted = acknowledgePlanFields(sent, model.state, serverState);
    const merged = mergeProjectStates(accepted.base, accepted.current, serverState);
    state = synchronizeDerivedProgress(merged.conflicts.length ? accepted.current : merged.state);
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
