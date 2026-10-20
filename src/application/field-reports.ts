import type { AppState, FieldReport, UserRole } from '../entities/index';
import { validUploadedDocumentFile } from '../domain/project-documents.ts';
import type { DocumentUploadPort } from './project-documents';
import type { Clock, IdGenerator } from './ports';
import type { StateChange } from '../domain/change';
import { commitStateChange, type StateChangeSink } from './state-change.ts';
import { planToday, validPlanDate } from '../../sites/lib/plan-baseline.js';
export const uploadFieldReport = async (readState: () => AppState, input: { projectId: string; files: File[]; date: string; note: string; stageId: string; sourceLink: string }, identity: { name: string; role: UserRole }, clock: Clock, ids: IdGenerator, uploader: DocumentUploadPort, sink: StateChangeSink, signal: AbortSignal): Promise<{ ok: true; change: StateChange } | { ok: false; error: string }> => {
 try {
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
  check(); const state = readState(), summary = `Добавлен фотоотчёт за ${input.date}: ${input.files.length} фото`;
  const report: FieldReport = { id: ids.next('field-report'), createdAt: `${input.date}T12:00:00+03:00`, author: identity.name, note: input.note.trim() + (input.sourceLink ? '\nИсточник: '+input.sourceLink : ''), source: 'web', stageId: input.stageId || undefined, clientVisible: false, attachments };
  const change: StateChange = { action: 'field_report_uploaded', summary, state: { ...state, fieldReports: [report,...state.fieldReports], activity: [{ id: ids.next('activity'), timestamp: clock.now(), actor: identity.name, text: summary, tone: 'neutral' },...state.activity] } };
  commitStateChange(change, sink); return { ok: true, change };
 } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'Не удалось сохранить отчёт.' }; }
};
