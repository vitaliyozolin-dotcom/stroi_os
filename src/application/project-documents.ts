import type { AppState, UserRole } from '../entities/index';
import { prepareUploadedDocument, validateDocumentDraft, validUploadedDocumentFile, type DocumentDraft, type UploadedDocumentFile } from '../domain/project-documents.ts';
import type { Clock, IdGenerator } from './ports';
import type { StateChange } from '../domain/change';
import { commitStateChange, type StateChangeSink } from './state-change.ts';
export interface DocumentUploadPort { upload(projectId: string, file: File, signal: AbortSignal): Promise<UploadedDocumentFile> }
export type DocumentUploadResult = { ok: true; change: StateChange } | { ok: false; error: string };
export const uploadProjectDocument = async (readState: () => AppState, input: { projectId: string; draft: DocumentDraft; file: File }, identity: { name: string; role: UserRole }, clock: Clock, ids: IdGenerator, uploader: DocumentUploadPort, sink: StateChangeSink, signal: AbortSignal): Promise<DocumentUploadResult> => {
 try {
  const check = () => { if (signal.aborted) throw new Error('Загрузка отменена.'); if (readState().project.id !== input.projectId) throw new Error('Проект изменился. Откройте загрузку заново.'); if (!['management','foreman'].includes(identity.role)) throw new Error('Нет прав на загрузку документа.'); const error = validateDocumentDraft(readState(), input.draft); if (error) throw new Error(error); };
  check();
  if (input.file.size > 20 * 1024 * 1024) throw new Error('Файл больше 20 МБ.');
  const file = await uploader.upload(input.projectId, input.file, signal);
  check();
  if (!validUploadedDocumentFile(input.projectId, file)) throw new Error('Сервер вернул некорректные сведения файла.');
  const state = readState(), now = clock.now(), document = prepareUploadedDocument(state, input.draft, file, ids.next('document'), identity.name, now), summary = `Загружен документ «${document.name}»`;
  const change: StateChange = { action: 'document_updated', summary, state: { ...state, documents: [document, ...state.documents], activity: [{ id: ids.next('activity'), timestamp: now, actor: identity.name, text: summary, tone: 'neutral' }, ...state.activity] } };
  commitStateChange(change, sink); return { ok: true, change };
 } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'Не удалось загрузить документ.' }; }
};
