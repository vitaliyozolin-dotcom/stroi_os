import { registerFieldReport } from './project-records.js';
import type { FieldReport, UserRole } from '../entities/index';
import { validUploadedDocumentFile } from '../domain/project-documents.ts';
import type { DocumentUploadPort } from './project-documents.ts';
import type { Clock, IdGenerator } from './ports.ts';
import type { DocumentsSnapshot, DocumentsPatch } from '../domain/contexts.ts';
import { type ModuleChange, type ModuleRepository } from './module-repository.ts';
import { planToday, validPlanDate } from '../domain/construction/index.js';
export const uploadFieldReport = async (repository: ModuleRepository<DocumentsSnapshot, DocumentsPatch>, input: { projectId: string; files: File[]; date: string; note: string; stageId: string; sourceLink: string }, identity: { name: string; role: UserRole }, clock: Clock, ids: IdGenerator, uploader: DocumentUploadPort, signal: AbortSignal): Promise<{ ok: true; change: ModuleChange<DocumentsPatch> } | { ok: false; error: string }> => {
 try {
  const readState = () => { const read = repository.read(); if (!read.ok) throw new Error(read.error); return read.snapshot; };
  const check = () => { const state = readState(); if (signal.aborted) throw new Error('Загрузка отменена.'); if (!['management','foreman'].includes(identity.role)) throw new Error('Нет прав на фотоотчёт.'); if (state.project.id !== input.projectId) throw new Error('Проект изменился. Откройте нужный объект и повторите.'); if (input.stageId && !state.stages.some(stage => stage.id === input.stageId)) throw new Error('Этап фотоотчёта больше недоступен.'); if (input.sourceLink && state.fieldReports.some(report => report.note.includes(input.sourceLink))) throw new Error('Отчёт из этого сообщения уже добавлен.'); };
  check();
  if (!input.files.length || input.files.length > 10 || input.files.some(file => file.size > 12*1024*1024 || !/^image\/(jpeg|png|webp)$/.test(file.type))) throw new Error('До 10 фото JPG, PNG или WebP, каждое до 12 МБ.');
  if (!validPlanDate(input.date) || input.date > planToday(new Date(clock.now()))) throw new Error('Укажите дату съёмки не позже сегодня.');
  if (input.sourceLink && !/^https:\/\/t\.me\//.test(input.sourceLink)) throw new Error('Укажите ссылку на сообщение t.me или оставьте поле пустым.');
  const attachments: FieldReport['attachments'] = [];
  for (const source of input.files) {
   const file = await uploader.upload(input.projectId, source, signal); check();
   if (!validUploadedDocumentFile(input.projectId, file) || file.size > 12*1024*1024 || !/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('Сервер вернул некорректные сведения фото.');
   attachments.push({ id: ids.next('attachment'), key: file.key, name: file.name, mimeType: file.type, sizeBytes: file.size, uploadedAt: file.uploadedAt, uploadedBy: identity.name, source: 'web' });
  }
  check();
  const result = registerFieldReport(repository, { createdAt: `${input.date}T12:00:00+03:00`, note: input.note.trim() + (input.sourceLink ? '\nИсточник: '+input.sourceLink : ''), source: 'web', stageId: input.stageId || undefined, attachments }, { identity, clock, ids });
  if (!result.ok) return result;
  if (!result.change) throw new Error('Отчёт уже зарегистрирован.');
  return { ok: true, change: result.change };
 } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'Не удалось сохранить отчёт.' }; }
};
