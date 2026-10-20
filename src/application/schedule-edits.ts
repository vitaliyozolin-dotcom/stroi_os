import type { StageSchedule, StageSiteUpdate, UserRole } from '../entities/index';
import type { Clock, IdGenerator } from './ports.ts';
import type { ConstructionSnapshot, ConstructionPatch } from '../domain/contexts.ts';
import { moduleChange, executeModule, type ModuleChange, type ModuleRepository } from './module-repository.ts';
import { schedulePayload, sitePayload } from '../domain/construction/index.js';
import { validateStageControl } from '../domain/construction/index.js';
import { validateBaselineChanges } from '../domain/construction/index.js';
export interface BaselineDraft { source: string; note: string; start: string; end: string; targetDate: string; reason: string; stages: { id: string; start: string; end: string }[] }
export const scheduleReviewSource = (stage: ConstructionSnapshot['stages'][number]) => JSON.stringify([sitePayload(stage.siteUpdate), schedulePayload(stage.schedule), stage.status, stage.blocker, stage.actualStart, stage.completedOn, stage.actualEnd, stage.acceptedAt]);
export const scheduleEditSnapshot = (state: ConstructionSnapshot, kind: 'baseline' | 'structure' | 'review' | 'facts' | 'progress' | 'forecast', id = '') => {
 const stage = state.stages.find(row => row.id === id);
 return JSON.stringify([state.project.id, kind === 'forecast' ? [state.project.workForecastDate, state.project.workForecastNote, state.project.workForecastUpdatedAt] : kind === 'progress' ? state.project.siteProgressHistory : kind === 'baseline' ? [state.project.baseline, state.project.targetDate, state.stages.map(row => [row.id, row.baseline])] : kind === 'structure' ? schedulePayload(stage?.schedule) : kind === 'review' ? stage && scheduleReviewSource(stage) : stage]);
};
export type ScheduleEditInput = { expected: string } & (
 | { kind: 'baseline'; draft: BaselineDraft }
 | { kind: 'forecast'; date: string; note: string }
 | { kind: 'progress'; date: string; completed: string; remaining: string; source: string }
 | { kind: 'structure'; stageId: string; structure: StageSchedule; daysOff: string; checked: boolean }
 | { kind: 'review'; stageId: string; form: StageSiteUpdate }
 | { kind: 'facts'; stageId: string; end: string; accepted: string; note: string }
);
export const editProjectSchedule = (state: ConstructionSnapshot, input: ScheduleEditInput, identity: { name: string; role: UserRole; id?: string }, clock: Clock, ids: IdGenerator): { ok: true; change: ModuleChange<ConstructionPatch> | null } | { ok: false; error: string } => {
 try {
  const stageId = input.kind === 'baseline' || input.kind === 'progress' || input.kind === 'forecast' ? '' : input.stageId;
  if (input.expected !== scheduleEditSnapshot(state, input.kind, stageId)) throw new Error('Запись обновилась. Загрузите свежие сведения перед сохранением.');
  if (identity.role !== 'management' && input.kind !== 'review') throw new Error('Изменение доступно управлению.');
  const next = structuredClone(state), now = clock.now(); let summary = '';
  if (input.kind === 'baseline') {
   const form = input.draft; let additions = 0;
   if (!['document','snapshot'].includes(form.source)) throw new Error('Выберите источник исходных дат.');
   const baseline = (start: string, end: string) => ({ start: start || undefined, end, source: form.source as 'document' | 'snapshot', note: form.note.trim(), recordedAt: now, recordedBy: identity.name });
   if (!next.project.baseline && form.end) { next.project.baseline = baseline(form.start, form.end); additions++; }
   for (const stage of next.stages) { const dates = form.stages.find(row => row.id === stage.id); if (!stage.baseline && dates?.end) { stage.baseline = baseline(dates.start, dates.end); additions++; } }
   if (additions && !form.note.trim()) throw new Error('Укажите источник исходных дат: документ или договорённость.');
   if (form.targetDate !== state.project.targetDate && !form.reason.trim()) throw new Error('Укажите причину переноса действующего срока.');
   if (!additions && form.targetDate === state.project.targetDate) return { ok: true, change: null };
   next.project.targetDate = form.targetDate; next.project.planChangeReason = form.reason.trim();
   summary = `План 0: зафиксировано исходных сроков — ${additions}.${form.reason.trim() ? ` Действующая сдача: ${form.targetDate}. ${form.reason.trim()}` : ''}`;
  } else if (input.kind === 'forecast') {
   if (!input.note.trim()) throw new Error('Укажите основание прогноза.');
   if (input.date === state.project.workForecastDate && input.note.trim() === state.project.workForecastNote) return { ok: true, change: null };
   next.project = { ...next.project, workForecastDate: input.date, workForecastNote: input.note.trim(), workForecastUpdatedAt: now };
   summary = `Прогноз окончания работ: ${input.date}. ${input.note.trim()}`;
  } else if (input.kind === 'progress') {
   const split = (value: string) => value.split('\n').map(row => row.trim()).filter(Boolean);
   const completed = split(input.completed), remaining = split(input.remaining);
   if (!input.source.trim() || !completed.length && !remaining.length || [...completed,...remaining].some(row => row.length > 250) || completed.length > 50 || remaining.length > 50) throw new Error('Укажите источник и работы: до 50 пунктов, до 250 символов на пункт.');
   next.project.siteProgressHistory = [...(next.project.siteProgressHistory ?? []), { id: ids.next('site-progress'), asOf: input.date, completed, remaining, source: input.source.trim() }];
   summary = 'Обновлено состояние объекта';
  } else {
   const row = next.stages.find(stage => stage.id === input.stageId);
   if (!row) throw new Error('Этап не найден.');
   if (input.kind === 'structure') {
    if (!input.checked) throw new Error('Подтвердите структуру ППР.');
    row.schedule = { ...schedulePayload(input.structure)!, phase: input.structure.phase.trim(), crew: input.structure.crew.trim(), daysOff: input.daysOff.split(/[\s,;]+/).filter(Boolean) };
    if (JSON.stringify(schedulePayload(row.schedule)) === JSON.stringify(schedulePayload(state.stages.find(stage => stage.id === row.id)?.schedule))) return { ok: true, change: null };
    summary = `Сверена структура этапа «${row.name}»`;
   } else if (input.kind === 'review') {
    if (!row.schedule || identity.role !== 'management' && !(identity.role === 'foreman' && identity.id && identity.id === row.schedule.reporterId)) throw new Error('Состояние подтверждает назначенный сотрудник или управление.');
    row.siteUpdate = { ...sitePayload(input.form)!, note: input.form.note.trim(), remainingDays: ['accepted','awaiting_inspection'].includes(row.status) || row.schedule.kind === 'summary' ? null : input.form.remainingDays, requestId: ids.next('schedule-review') };
    summary = `Подтверждены сведения этапа «${row.name}»`;
   } else {
    if (!input.note.trim()) throw new Error('Укажите основание уточнения.');
    row.completedOn ||= row.actualEnd || input.end;
    if (row.status === 'accepted') { row.actualEnd ||= row.completedOn; if (!row.acceptedAt && input.accepted) row.acceptedAt = `${input.accepted}T12:00:00+03:00`; }
    row.factRecoveryNote = input.note.trim(); summary = `Уточнены неизвестные даты этапа «${row.name}»`;
   }
  }
  // Shared policies validate a disposable copy. Only the server authors trusted stamps/history.
  const error = input.kind === 'baseline' ? validateBaselineChanges(state, structuredClone(next), identity, now) : validateStageControl(state, structuredClone(next), identity, now);
  if (error) throw new Error(error);
  const change = moduleChange(state, { project: next.project, stages: next.stages }, 'schedule_updated', summary, { identity, clock: { now: () => now }, ids });
  return { ok: true, change };
 } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'Не удалось сохранить график.' }; }
};
export const createScheduleEditUseCases = (repository: ModuleRepository<ConstructionSnapshot, ConstructionPatch>, identity: { name: string; role: UserRole; id?: string }, clock: Clock, ids: IdGenerator) => ({ execute: (input: ScheduleEditInput) => executeModule(repository, state => editProjectSchedule(state, input, identity, clock, ids)) });
