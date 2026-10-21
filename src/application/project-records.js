import { prepareUploadedDocument, validateDocumentDraft, validUploadedDocumentFile } from '../domain/document-records.js';
import { moduleChange, executeModule } from './module-repository-runtime.js';

// Both entrypoints register against the latest scoped snapshot. Upload and UI
// validation remain outside this synchronous command, before registration.
const register = (repository, context, channel, command) => executeModule(repository, state => {
  try {
    if (!(channel === 'telegram' ? ['management', 'foreman', 'client'] : ['management', 'foreman']).includes(context.identity.role)) throw new Error('Нет прав на запись документов и отчётов.');
    return command(state);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Не удалось зарегистрировать запись.' };
  }
});

export const registerProjectDocument = (repository, input, context, channel = 'web') => register(repository, context, channel, state => {
  if (input.sourceDraftId && state.documents.some(item => item.sourceDraftId === input.sourceDraftId)) return { ok: true, change: null };
  const error = validateDocumentDraft(state, input.draft);
  if (error) throw new Error(error);
  if (!validUploadedDocumentFile(state.project.id, input.file)) throw new Error('Сервер вернул некорректные сведения файла.');
  const now = context.clock.now();
  const document = prepareUploadedDocument(state, input.draft, input.file, input.id ?? context.ids.next('document'), context.identity.name, now);
  if (input.sourceDraftId) Object.assign(document, { sourceDraftId: input.sourceDraftId });
  const summary = `Загружен документ «${document.name}»${input.sourceDraftId ? ' через Telegram' : ''}`;
  return { ok: true, change: moduleChange(state, { documents: [document, ...state.documents] }, input.sourceDraftId ? 'telegram.document.create' : 'document_updated', summary, { ...context, clock: { now: () => now } }) };
});

export const registerFieldReport = (repository, input, context) => register(repository, context, input.source, state => {
  if (!['web', 'telegram'].includes(input.source)) throw new Error('Неизвестный источник отчёта.');
  if (input.sourceDraftId && state.fieldReports.some(item => item.sourceDraftId === input.sourceDraftId)) return { ok: true, change: null };
  if (input.stageId && !state.stages.some(stage => stage.id === input.stageId)) throw new Error('Этап фотоотчёта больше недоступен.');
  if (!Number.isFinite(Date.parse(input.createdAt))) throw new Error('Укажите корректную дату отчёта.');
  for (const file of input.attachments) {
    if (!validUploadedDocumentFile(state.project.id, { key: file.key, name: file.name, type: file.mimeType, size: file.sizeBytes, uploadedAt: file.uploadedAt })) throw new Error('Сервер вернул некорректные сведения файла.');
  }
  if (!input.attachments.length && !input.note.trim()) throw new Error('Напишите запись в дневник.');
  const report = {
    id: input.id ?? context.ids.next('field-report'), createdAt: input.createdAt,
    author: context.identity.name, note: input.note, source: input.source,
    ...(input.stageId ? { stageId: input.stageId } : {}), clientVisible: false,
    ...(input.telegramMessageId ? { telegramMessageId: input.telegramMessageId } : {}),
    ...(input.sourceDraftId ? { sourceDraftId: input.sourceDraftId } : {}),
    attachments: input.attachments,
  };
  const summary = input.source === 'web'
    ? `Добавлен фотоотчёт за ${input.createdAt.slice(0, 10)}: ${input.attachments.length} фото`
    : input.attachments.length ? `Добавлен фотоотчёт через Telegram · ${context.identity.name}` : `Добавлена запись в дневник объекта · ${context.identity.name}`;
  const action = input.source === 'web' ? 'field_report_uploaded' : input.attachments.length ? 'telegram.field_report.create' : 'telegram.note.create';
  return { ok: true, change: moduleChange(state, { fieldReports: [report, ...state.fieldReports] }, action, summary, context) };
});
