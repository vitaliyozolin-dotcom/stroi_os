import { registerProjectDocument } from './project-records.js';
import type { UserRole } from '../entities/index';
import { validateDocumentDraft, validUploadedDocumentFile, type DocumentDraft, type UploadedDocumentFile } from '../domain/project-documents.ts';
import type { Clock, IdGenerator } from './ports.ts';
import type { DocumentsSnapshot, DocumentsPatch } from '../domain/contexts.ts';
import { type ModuleChange, type ModuleRepository } from './module-repository.ts';
export interface DocumentUploadPort { upload(projectId: string, file: File, signal: AbortSignal): Promise<UploadedDocumentFile> }
export type DocumentUploadResult = { ok: true; change: ModuleChange<DocumentsPatch> } | { ok: false; error: string };
export const uploadProjectDocument = async (repository: ModuleRepository<DocumentsSnapshot, DocumentsPatch>, input: { projectId: string; draft: DocumentDraft; file: File }, identity: { name: string; role: UserRole }, clock: Clock, ids: IdGenerator, uploader: DocumentUploadPort, signal: AbortSignal): Promise<DocumentUploadResult> => {
 try {
  const readState = () => { const read = repository.read(); if (!read.ok) throw new Error(read.error); return read.snapshot; };
  const check = () => { if (signal.aborted) throw new Error('Загрузка отменена.'); if (readState().project.id !== input.projectId) throw new Error('Проект изменился. Откройте загрузку заново.'); if (!['management','foreman'].includes(identity.role)) throw new Error('Нет прав на загрузку документа.'); const error = validateDocumentDraft(readState(), input.draft); if (error) throw new Error(error); };
  check();
  if (input.file.size > 20 * 1024 * 1024) throw new Error('Файл больше 20 МБ.');
  const file = await uploader.upload(input.projectId, input.file, signal);
  check();
  if (!validUploadedDocumentFile(input.projectId, file)) throw new Error('Сервер вернул некорректные сведения файла.');
  const result = registerProjectDocument(repository, { draft: input.draft, file }, { identity, clock, ids });
  if (!result.ok) return result;
  if (!result.change) throw new Error('Документ уже зарегистрирован.');
  return { ok: true, change: result.change };
 } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'Не удалось загрузить документ.' }; }
};
