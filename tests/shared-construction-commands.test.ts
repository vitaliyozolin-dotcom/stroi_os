import test from 'node:test';
import assert from 'node:assert/strict';
import { seedState } from '../src/seed.ts';
import { createTaskUseCases, taskSnapshot, type TaskDraft } from '../src/application/tasks.ts';
import { registerFieldReport, registerProjectDocument } from '../src/application/project-records.js';
import { createConstructionRepository, createDocumentsRepository } from '../src/infrastructure/module-project.ts';
import { createTelegramTask, changeTelegramTaskStatus, registerTelegramDocument, registerTelegramReport } from '../sites/telegram/business-commands.js';
import type { AppState, SystemUser } from '../src/entities/index';

const now = '2026-10-21T10:00:00.000Z';
const owner: SystemUser = { id: 'owner', name: 'Владелец', email: 'owner@example.test', role: 'management', status: 'active' };
const foreman: SystemUser = { id: 'foreman', name: 'Прораб', email: 'foreman@example.test', role: 'foreman', status: 'active' };
const context = (identity = owner) => ({ identity, clock: { now: () => now }, ids: { next: (prefix: string) => `${prefix}-shared` } });
const taskDraft: TaskDraft = { title: 'Проверить узел', description: '', priority: 'high', assigneeId: foreman.id, reviewerId: '', dueDate: '2026-10-25', plannedStart: '', baselineEnd: '', baselineNote: '', reason: '', stageId: '', counterpartyId: '', procurementItemId: '', checkpointId: '' };
const state = () => { const s = structuredClone(seedState); s.settings.users = [owner, foreman]; s.tasks = []; s.documents = []; s.fieldReports = []; return s; };
const telegramDraft = { id: 'draft', payload: { ...taskDraft } };

test('web and Telegram create tasks with the same assignment, deadlines and independent acceptance facts', () => {
  let web = state(); const telegram = state();
  const untouched = structuredClone(web);
  const repository = createConstructionRepository(() => web, next => { web = next; });
  const result = createTaskUseCases(repository, context()).save({ expected: taskSnapshot(web), draft: taskDraft });
  assert.ok(result.ok);
  assert.ok(createTelegramTask(telegram, owner, telegramDraft, now));
  for (const key of ['title', 'status', 'priority', 'assigneeId', 'assigneeName', 'dueDate', 'originalDueDate', 'rescheduleCount', 'createdBy'] as const) {
    assert.equal(web.tasks[0][key], telegram.tasks[0][key], key);
  }
  assert.ok(web.tasks[0].baseline);
  assert.equal(telegram.tasks[0].sourceDraftId, telegramDraft.id);
  assert.equal(telegram.tasks[0].baseline, undefined);
  assert.equal(telegram.tasks[0].history[0].actor, owner.name);
  assert.deepEqual(telegram.financeEntries, untouched.financeEntries);
  assert.deepEqual(telegram.checkpoints, untouched.checkpoints);
  const beforeRetry = structuredClone(telegram);
  assert.equal(createTelegramTask(telegram, owner, telegramDraft, now), null);
  assert.deepEqual(telegram, beforeRetry);
});

test('shared task commands preserve channel-specific completion rules and callback idempotency', () => {
  let web = state(); createTelegramTask(web, owner, telegramDraft, now);
  const telegram = structuredClone(web);
  const repository = createConstructionRepository(() => web, next => { web = next; });
  const commands = createTaskUseCases(repository, context(foreman));
  assert.ok(commands.status({ taskId: web.tasks[0].id, expected: taskSnapshot(web, web.tasks[0].id), status: 'done', text: 'Выполнено' }).ok);
  assert.throws(() => changeTelegramTaskStatus(telegram, foreman, telegram.tasks[0].id, 'done', 'callback', now, 'Выполнено'), /action_denied/);
  assert.ok(changeTelegramTaskStatus(telegram, owner, telegram.tasks[0].id, 'done', 'callback', now, 'Выполнено'));
  assert.equal(changeTelegramTaskStatus(telegram, owner, telegram.tasks[0].id, 'done', 'callback', now, 'Выполнено'), null);
  assert.equal(telegram.tasks[0].history.filter(event => event.sourceTelegramCallbackId === 'callback').length, 1);
  assert.equal(telegram.tasks[0].completedAt, now);
  const stale = taskSnapshot(web, web.tasks[0].id); web.tasks[0].title = 'Обновлённая задача';
  assert.equal(commands.status({ taskId: web.tasks[0].id, expected: stale, status: 'review', text: 'Проверить' }).ok, false);
});

test('both document entrypoints register identical private metadata and reject foreign files', () => {
  let web = state(); const telegram = state();
  const file = { key: `${web.project.id}/telegram/draft-contract.pdf`, name: 'contract.pdf', type: 'application/pdf', size: 4, uploadedAt: now };
  const draft = { name: 'contract', category: 'contract' as const, number: '', documentDate: now.slice(0, 10), status: 'current' as const, direction: 'internal' as const, counterpartyId: '', stageId: '', clientVisible: false };
  const repository = createDocumentsRepository(() => web, next => { web = next; });
  const result = registerProjectDocument(repository, { id: 'document-telegram-draft', draft, file }, context());
  assert.ok(result.ok);
  registerTelegramDocument(telegram, owner, { id: 'draft', payload: { category: 'contract' } }, { key: file.key, name: file.name, mimeType: file.type, sizeBytes: file.size, uploadedAt: file.uploadedAt }, now);
  const { sourceDraftId, ...document } = telegram.documents[0];
  assert.equal(sourceDraftId, 'draft');
  assert.deepEqual(document, web.documents[0]);
  const before = structuredClone(web);
  assert.equal(registerProjectDocument(repository, { draft, file: { ...file, key: 'other/private.pdf' } }, context()).ok, false);
  assert.deepEqual(web, before);
  assert.equal(registerProjectDocument(repository, { draft: { ...draft, stageId: 'deleted' }, file }, context()).ok, false);
  assert.equal(registerProjectDocument(repository, { draft, file }, context({ ...foreman, role: 'client' })).ok, false);
});

test('shared diary registration accepts Telegram text/audio, keeps reports private and preserves unrelated data', () => {
  let web = state(); const telegram = state();
  const untouched = structuredClone(telegram);
  const repository = createDocumentsRepository(() => web, next => { web = next; });
  const input = { createdAt: now, note: 'Факт на объекте', source: 'web' as const, attachments: [] };
  assert.ok(registerFieldReport(repository, input, context(foreman)).ok);
  registerTelegramReport(telegram, foreman, { ...input, id: 'report', source: 'telegram', sourceDraftId: 'draft' }, now);
  assert.equal(web.fieldReports[0].note, telegram.fieldReports[0].note);
  assert.equal(telegram.fieldReports[0].clientVisible, false);
  assert.equal(telegram.fieldReports[0].author, foreman.name);
  assert.deepEqual(telegram.financeEntries, untouched.financeEntries);
  assert.deepEqual(telegram.stages, untouched.stages);
  const before = structuredClone(telegram);
  assert.equal(registerTelegramReport(telegram, foreman, { ...input, source: 'telegram', sourceDraftId: 'draft' }, now), null);
  assert.deepEqual(telegram, before);
  assert.equal(registerFieldReport(repository, input, context({ ...foreman, role: 'client' })).ok, false);
  registerTelegramReport(telegram, { ...foreman, role: 'client' }, { ...input, source: 'telegram' }, now);
  assert.equal(telegram.fieldReports[0].clientVisible, false);
  assert.throws(() => registerTelegramReport(telegram, { ...foreman, role: 'unknown' }, { ...input, source: 'telegram' }, now), /action_denied/);
  assert.throws(() => registerTelegramReport(telegram, foreman, { ...input, source: 'telegram', attachments: [{ id: 'audio', key: 'other/audio.ogg', name: 'audio.ogg', mimeType: 'audio/ogg', sizeBytes: 4, uploadedAt: now, uploadedBy: foreman.name, source: 'telegram' }] }, now), /action_denied/);
});
