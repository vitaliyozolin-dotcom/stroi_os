import type { AppState, UserRole } from '../entities/index';
import { planToday, validPlanDate } from '../../sites/lib/plan-baseline.js';
import { stageCanStart, stageGaps } from '../../sites/lib/stage-control.js';
import { addScheduleDays } from '../../sites/lib/schedule-forecast.js';

export type StageAction = 'start' | 'not_started' | 'complete' | 'accept' | 'owner_accept' | 'delay' | 'rework';
export function applyStageControl(state: AppState, id: string, action: StageAction, input: { date: string; note: string; tasks: string[]; completionDateUnknown?: boolean; blockerResolved?: boolean; remainingDays?: number; readyOn?: string; nextAction?: string; issueOwner?: string }, actor: string, role: UserRole, userId?: string): AppState {
  if (role === 'client') throw new Error('Нет прав на изменение этапа.');
  const next = structuredClone(state), stage = next.stages.find((s) => s.id === id);
  if (!stage || stage.status === 'accepted') throw new Error('Этап уже принят или не найден.');
  if (action === 'owner_accept') {
    if (role !== 'management' || userId !== 'owner') throw new Error('Подтверждение по факту доступно владельцу.');
    if (stage.schedule?.kind === 'summary') throw new Error('Подтвердите вложенные работы по отдельности.');
    const today = planToday(), now = new Date().toISOString();
    if (!validPlanDate(input.date) || input.date > today) throw new Error('Укажите дату выполнения не позже сегодня.');
    if (stage.actualStart && (input.completionDateUnknown ? today : input.date) < stage.actualStart) throw new Error('Выполнение не может быть раньше начала.');
    if (input.completionDateUnknown && stage.completedOn) throw new Error('Известная дата выполнения сохраняется.');
    if (!input.completionDateUnknown) {
      if (stage.completedOn && stage.completedOn !== input.date) throw new Error('Известная дата выполнения сохраняется.');
      if (stage.completionObservedOn && input.date > stage.completionObservedOn) throw new Error('Работа уже была готова на дату наблюдения.');
      stage.completedOn = input.date;
    } else stage.completionObservedOn ||= today;
    const note = input.note.trim() || 'Лично подтверждаю: этап выполнен.';
    if (note.length > 2000) throw new Error('Комментарий — до 2000 символов.');
    stage.ownerAcceptance = { note };
    stage.status = 'accepted'; stage.statusNote = `Подтверждение владельца: ${note}`;
    stage.completionNote ||= note; stage.blocker = undefined;
    stage.actualEnd = stage.completedOn; stage.acceptedAt = now; stage.acceptedBy = actor;
    // Subtasks and quality evidence retain their own truthful status.
    const tracking = next.tasks.find(t => t.id === `auto-stage-${id}`);
    if (tracking) { tracking.status = 'done'; tracking.completedAt = now; tracking.completionNote = note; }
    for (const candidate of next.stages) if (!candidate.schedule && candidate.status === 'not_ready' && (candidate.dependencyId || candidate.dependency) && stageCanStart(next, candidate)) candidate.status = 'ready';
    next.activity.unshift({ id: crypto.randomUUID(), timestamp: now, actor, text: `Владелец подтвердил этап «${stage.name}»: ${note}`, tone: 'positive' });
    return next;
  }
  if (role !== 'management' && stage.schedule && (!userId || userId !== stage.schedule.reporterId)) throw new Error('Состояние этой работы подтверждает назначенный сотрудник или управление.');
  if (!input.note.trim()) throw new Error('Укажите результат или причину.');
  if (stage.blocker && ['start', 'complete', 'accept'].includes(action) && !input.blockerResolved) throw new Error('Подтвердите, что препятствие устранено.');
  if (!validPlanDate(input.date)) throw new Error('Укажите дату.');
  if (input.completionDateUnknown && (action !== 'complete' || role !== 'management' || stage.completedOn || input.tasks.length || stage.schedule?.kind === 'summary')) throw new Error('Наблюдение без точной даты фиксирует управление отдельно от закрытия задач и сводных этапов.');
  if (action === 'accept' && !validPlanDate(stage.completedOn || stage.actualEnd)) throw new Error('Сначала подтвердите или уточните фактическую дату выполнения. Дата приёмки её не заменяет.');
  const today = planToday(), now = new Date().toISOString();
  if (action !== 'delay' && input.date > today) throw new Error('Дата факта не может быть в будущем.');
  if (action === 'delay' && (input.date < today || input.date < stage.planStart)) throw new Error('Ожидаемое окончание должно быть сегодня или позже начала этапа.');
  stage.statusNote = input.note.trim();
  if (action === 'not_started') {
    if (stage.actualStart || stage.completedOn || !['not_ready', 'ready', 'blocked'].includes(stage.status)) throw new Error('Начатую или выполненную работу нельзя отметить как не начатую.');
    stage.status = 'not_ready'; stage.blocker = input.note.trim();
  } else if (action === 'start') {
    stage.actualStart ||= input.date;
    stage.status = 'in_progress'; stage.blocker = undefined;
  } else if (action === 'delay') {
    stage.status = 'blocked'; stage.blocker = input.note.trim();
    stage.forecastEnd = input.date; stage.forecastReason = input.note.trim(); stage.forecastUpdatedAt = now;
  } else if (action === 'rework') {
    if (role !== 'management') throw new Error('Возвращает на доработку управление.');
    stage.status = 'rework'; stage.blocker = input.note.trim(); stage.completedOn = undefined; stage.completionObservedOn = undefined;
  } else {
    for (const task of stageGaps(next, id).tasks.filter((t) => input.tasks.includes(t.id))) {
      if (role !== 'management' && task.assigneeId !== userId) throw new Error('Подтверждайте только свои задачи.');
      task.status = role === 'management' || !task.reviewerId ? 'done' : 'review';
      task.completedAt = task.status === 'done' ? `${input.date}T12:00:00+03:00` : undefined;
      task.completionNote = input.note.trim(); task.updatedAt = now;
      task.history.unshift({ id: crypto.randomUUID(), timestamp: now, actor, kind: 'completed', text: `Отмечено при выполнении этапа: ${input.note.trim()}` });
    }
    if (input.completionDateUnknown) stage.completionObservedOn = input.date;
    else stage.completedOn = action === 'accept' ? stage.completedOn || stage.actualEnd! : input.date;
    stage.completionNote = input.note.trim(); stage.blocker = undefined;
    if (stage.actualStart && (stage.completedOn || stage.completionObservedOn || '') < stage.actualStart) throw new Error('Выполнение не может быть раньше фактического начала.');
    if (action === 'accept') {
      const gaps = stageGaps(next, id);
      if (role !== 'management' || gaps.tasks.length || gaps.checkpoints.length) throw new Error('Для приёмки управление завершает задачи и принимает контрольные точки.');
      if (input.date < stage.completedOn!) throw new Error('Приёмка не может быть раньше выполнения.');
      stage.status = 'accepted'; stage.actualEnd = stage.completedOn; stage.acceptedAt = `${input.date}T12:00:00+03:00`; stage.acceptedBy = actor;
      const tracking = next.tasks.find((t) => t.id === `auto-stage-${id}`);
      if (tracking) { tracking.status = 'done'; tracking.completedAt = now; tracking.completionNote = input.note.trim(); }
    } else stage.status = 'awaiting_inspection';
  }
  if (stage.schedule && input.remainingDays !== undefined && ['start', 'delay'].includes(action)) {
    if (!Number.isInteger(input.remainingDays) || input.remainingDays < 1 || input.remainingDays > 730) throw new Error('Остаток — от 1 до 730 рабочих дней.');
    if (!validPlanDate(input.readyOn)) throw new Error('Укажите дату доступности работ.');
    if (action === 'delay' && (!input.nextAction?.trim() || !input.issueOwner?.trim())) throw new Error('Укажите ближайшее действие и ответственного за задержку.');
    stage.siteUpdate = { asOf: today, reviewOn: addScheduleDays(today, 7), remainingDays: input.remainingDays, readyOn: input.readyOn!, acceptanceOn: '', note: input.note.trim(), nextAction: input.nextAction?.trim() || '', issueOwner: input.issueOwner?.trim() || '', requestId: crypto.randomUUID() };
  }
  for (const candidate of next.stages) if (!candidate.schedule && candidate.status === 'not_ready' && (candidate.dependencyId || candidate.dependency) && stageCanStart(next, candidate)) candidate.status = 'ready';
  next.activity.unshift({ id: crypto.randomUUID(), timestamp: now, actor, text: `Этап «${stage.name}»: ${input.note.trim()}`, tone: action === 'delay' || action === 'rework' ? 'warning' : 'positive' });
  return next;
}
