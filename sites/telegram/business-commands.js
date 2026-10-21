import { createTaskUseCases, taskSnapshot } from '../../src/application/tasks-runtime.js';
import { registerFieldReport, registerProjectDocument } from '../../src/application/project-records.js';

// Called synchronously inside the CAS retry callback, after resolving the actor
// from current project membership. No snapshot or command survives a retry.
const repository = (state, snapshot) => ({
  read: () => ({ ok: true, snapshot }),
  commit: change => {
    for (const key of ['tasks', 'documents', 'fieldReports']) {
      if (Object.hasOwn(change.patch, key)) state[key] = change.patch[key];
    }
    if (change.event) state.activity = [change.event, ...(state.activity ?? [])];
    return { ok: true };
  },
});
const documents = state => ({ project: { id: state.project.id, code: state.project.code }, documents: state.documents ?? [], fieldReports: state.fieldReports ?? [], stages: state.stages ?? [], counterparties: state.counterparties ?? [] });
const context = (user, now, taskId) => ({
  identity: { id: user.id, name: user.name, role: user.role },
  clock: { now: () => now },
  ids: { next: prefix => prefix === 'task' && taskId ? taskId : `${prefix}-${crypto.randomUUID()}` },
});
const checked = result => {
  if (!result.ok) throw new Error('action_denied', { cause: result.error });
  return result.change;
};
export const createTelegramTask = (state, user, draft, now) => {
  const snapshot = { project: state.project, tasks: state.tasks ?? [], settings: { users: state.settings?.users ?? [] }, stages: state.stages ?? [], counterparties: state.counterparties ?? [], procurement: state.procurement ?? [], checkpoints: state.checkpoints ?? [] };
  const commands = createTaskUseCases(repository(state, snapshot), context(user, now, `task-telegram-${draft.id}`), 'telegram');
  return checked(commands.save({ expected: taskSnapshot(snapshot), sourceDraftId: draft.id, draft: {
    title: draft.payload.title, assigneeId: draft.payload.assigneeId, dueDate: draft.payload.dueDate, priority: draft.payload.priority,
    description: '', reviewerId: '', plannedStart: '', baselineEnd: '', baselineNote: '', reason: '', stageId: '', counterpartyId: '', procurementItemId: '', checkpointId: '',
  } }));
};
export const changeTelegramTaskStatus = (state, user, taskId, status, callbackId, now, text) => {
  const snapshot = { project: state.project, tasks: state.tasks ?? [], settings: { users: state.settings?.users ?? [] }, stages: state.stages ?? [], counterparties: state.counterparties ?? [], procurement: state.procurement ?? [], checkpoints: state.checkpoints ?? [] };
  const commands = createTaskUseCases(repository(state, snapshot), context(user, now), 'telegram');
  return checked(commands.status({ taskId, expected: taskSnapshot(snapshot, taskId), status, callbackId, text }));
};
export const registerTelegramReport = (state, user, input, now) => checked(registerFieldReport(repository(state, documents(state)), input, context(user, now)));
export const registerTelegramDocument = (state, user, draft, attachment, now) => checked(registerProjectDocument(repository(state, documents(state)), {
  id: `document-telegram-${draft.id}`, sourceDraftId: draft.id,
  draft: { name: attachment.name.replace(/\.[^.]+$/, ''), category: draft.payload.category, number: '', documentDate: now.slice(0, 10), status: 'current', direction: 'internal', counterpartyId: '', stageId: '', clientVisible: false },
  file: { key: attachment.key, name: attachment.name, type: attachment.mimeType, size: attachment.sizeBytes, uploadedAt: attachment.uploadedAt },
}, context(user, now), 'telegram'));
