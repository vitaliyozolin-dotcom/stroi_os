import { mergeProjectStates, synchronizeDerivedProgress } from '../domain/index.ts';
import type { ChangeMetadata } from '../domain/change.ts';
import type { AppState, StageSchedule, StageSiteUpdate } from '../entities/index.ts';
import { schedulePayload, sitePayload } from '../domain/construction/index.js';

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
  if (JSON.stringify(model.state) === JSON.stringify(remote.state)) return { kind: 'remote', model: applyRemoteSnapshot(model, remote) };
  if (model.revision === remote.revision) return { kind: 'save', model: { ...model, ready: true } };
  const merged = mergeProjectStates(model.base, model.state, remote.state);
  if (merged.conflicts.length) return { kind: 'conflict', model: { ...model, ready: true }, conflicts: merged.conflicts };
  const mergedState = synchronizeDerivedProgress(merged.state);
  if (JSON.stringify(mergedState) === JSON.stringify(remote.state)) return { kind: 'remote', model: applyRemoteSnapshot(model, remote) };
  return {
    kind: 'save',
    model: {
      ...model,
      state: mergedState,
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
const acknowledgeServerFields = (sent: AppState, local: AppState, server: AppState) => {
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
  // A later local partial payment keeps its aggregate amount, date and evidence.
  // Its first receipt and audit metadata come only from the acknowledged server
  // write, so the next save appends precisely the remaining payment delta.
  for (const savedEntry of server.financeEntries) {
    const sentEntry = base.financeEntries.find(entry => entry.id === savedEntry.id);
    const localEntry = current.financeEntries.find(entry => entry.id === savedEntry.id);
    if (!sentEntry || !localEntry) continue;
    const before = sentEntry as unknown as Record<string, unknown>;
    const item = localEntry as unknown as Record<string, unknown>;
    const saved = savedEntry as unknown as Record<string, unknown>;
    for (const field of ['payments', 'legacyPayment', 'dueDateHistory', 'costGroupHistory']) {
      if (saved[field] !== undefined) {
        before[field] = structuredClone(saved[field]);
        item[field] = structuredClone(saved[field]);
      } else { delete before[field]; delete item[field]; }
    }
    // These fields also appear on an optimistic, not-yet-sent action. A server
    // response to an earlier write must not erase that newer local action.
    for (const field of ['createdBy', 'approvedAt', 'approvedBy', 'paidBy', 'acceptedBy']) {
      const locallyChanged = before[field] !== item[field];
      if (saved[field] !== undefined) {
        before[field] = structuredClone(saved[field]);
        if (!locallyChanged) item[field] = structuredClone(saved[field]);
      } else {
        delete before[field];
        if (!locallyChanged) delete item[field];
      }
    }
    // The trusted boundary can make the legacy acceptance fallback explicit.
    // Adopt that value only if no newer local acceptance changed it.
    if (before.acceptedAmount === item.acceptedAmount && saved.acceptedAmount !== undefined) {
      before.acceptedAmount = saved.acceptedAmount;
      item.acceptedAmount = saved.acceptedAmount;
    }
  }
  // Treasury history is stamped only by the server. A second edit made while
  // this write was in flight keeps its fields, but must inherit that receipt.
  if (base.treasury && current.treasury && server.treasury) {
    const changed = JSON.stringify(base.treasury) !== JSON.stringify(current.treasury);
    if (server.treasury.history !== undefined) {
      base.treasury.history = structuredClone(server.treasury.history);
      current.treasury.history = structuredClone(server.treasury.history);
    }
    delete base.treasury.changeReason;
    if (!changed) delete current.treasury.changeReason;
  }
  // Advanced journals keep business fields from any newer local action; only
  // server-owned receipt fields are acknowledged by stable record identity.
  const acknowledgeRecords = (before: unknown, local: unknown, saved: unknown, key = 'id') => {
    if (!Array.isArray(before) || !Array.isArray(local) || !Array.isArray(saved)) return;
    for (const receipt of saved as Record<string, unknown>[]) {
      const first = before.find(row => row[key] === receipt[key]) as Record<string, unknown> | undefined;
      const latest = local.find(row => row[key] === receipt[key]) as Record<string, unknown> | undefined;
      if (!first || !latest) continue;
      if (key === 'riskId') {
        for (const field of ['acknowledged', 'snoozedUntil']) {
          const locallyChanged = first[field] !== latest[field];
          if (receipt[field] !== undefined) {
            first[field] = structuredClone(receipt[field]);
            if (!locallyChanged) latest[field] = structuredClone(receipt[field]);
          } else { delete first[field]; if (!locallyChanged) delete latest[field]; }
        }
      }
      for (const field of ['recordedAt', 'recordedBy', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy', 'approvedAt', 'approvedBy', 'firstSeenAt', 'lastSeenAt', 'resolvedAt', 'snapshot', 'history']) {
        if (receipt[field] !== undefined) { first[field] = structuredClone(receipt[field]); latest[field] = structuredClone(receipt[field]); }
        else if (field === 'resolvedAt') { delete first[field]; delete latest[field]; }
      }
    }
  };
  if (base.treasury && current.treasury && server.treasury) {
    for (const collection of ['inventoryLots', 'inventoryMovements', 'budgetVersions', 'savedScenarios'] as const) {
      acknowledgeRecords(base.treasury[collection], current.treasury[collection], server.treasury[collection]);
    }
  }
  if (base.financeLedger && current.financeLedger && server.financeLedger) {
    const changed = JSON.stringify(base.financeLedger) !== JSON.stringify(current.financeLedger);
    for (const collection of ['operations', 'confirmations', 'allocationEvents', 'requests', 'retentions', 'loans'] as const) {
      acknowledgeRecords(base.financeLedger[collection], current.financeLedger[collection], server.financeLedger[collection]);
    }
    if (server.financeLedger.history) {
      base.financeLedger.history = structuredClone(server.financeLedger.history);
      current.financeLedger.history = structuredClone(server.financeLedger.history);
    }
    delete base.financeLedger.changeReason;
    if (!changed) delete current.financeLedger.changeReason;
  }
  if (base.financeAutomation && current.financeAutomation && server.financeAutomation) {
    acknowledgeRecords(base.financeAutomation.reviews, current.financeAutomation.reviews, server.financeAutomation.reviews, 'riskId');
  }
  return { base, current };
};

export const reconcileSavedSnapshot = (model: SyncModel, sent: AppState, remote: SyncSnapshot): SyncModel => {
  const serverState = synchronizeDerivedProgress(remote.state ?? sent);
  let state = model.state;
  if (model.state === sent) state = serverState;
  else if (remote.state) {
    const accepted = acknowledgeServerFields(sent, model.state, serverState);
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
