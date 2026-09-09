import type { AppState, UserRole } from '../entities/index';
import { planToday, validPlanDate } from '../../sites/lib/plan-baseline.js';
import { stageCanStart, stageGaps } from '../../sites/lib/stage-control.js';

export type StageAction = 'start' | 'complete' | 'accept' | 'delay' | 'rework';
export function applyStageControl(state: AppState, id: string, action: StageAction, input: { date: string; note: string; tasks: string[]; blockerResolved?: boolean }, actor: string, role: UserRole, userId?: string): AppState {
  if (role === 'client') throw new Error('Нет прав на изменение этапа.');
  const next = structuredClone(state), stage = next.stages.find((s) => s.id === id);
  if (!stage || stage.status === 'accepted') throw new Error('Этап уже принят или не найден.');
  if (!input.note.trim()) throw new Error('Укажите результат или причину.');
  if (stage.blocker && ['start', 'complete', 'accept'].includes(action) && !input.blockerResolved) throw new Error('Подтвердите, что препятствие устранено.');
  if (!validPlanDate(input.date)) throw new Error('Укажите дату.');
  const today = planToday(), now = new Date().toISOString();
  if (action !== 'delay' && input.date > today) throw new Error('Дата факта не может быть в будущем.');
  if (action === 'delay' && (input.date < today || input.date < stage.planStart)) throw new Error('Ожидаемое окончание должно быть сегодня или позже начала этапа.');
  stage.statusNote = input.note.trim();
  if (action === 'start') {
    stage.actualStart ||= input.date;
    stage.status = 'in_progress'; stage.blocker = undefined;
  } else if (action === 'delay') {
    stage.status = 'blocked'; stage.blocker = input.note.trim();
    stage.forecastEnd = input.date; stage.forecastReason = input.note.trim(); stage.forecastUpdatedAt = now;
  } else if (action === 'rework') {
    if (role !== 'management') throw new Error('Возвращает на доработку управление.');
    stage.status = 'rework'; stage.blocker = input.note.trim(); stage.completedOn = undefined;
  } else {
    for (const task of stageGaps(next, id).tasks.filter((t) => input.tasks.includes(t.id))) {
      if (role !== 'management' && task.assigneeId !== userId) throw new Error('Подтверждайте только свои задачи.');
      task.status = role === 'management' || !task.reviewerId ? 'done' : 'review';
      task.completedAt = task.status === 'done' ? `${input.date}T12:00:00+03:00` : undefined;
      task.completionNote = input.note.trim(); task.updatedAt = now;
      task.history.unshift({ id: crypto.randomUUID(), timestamp: now, actor, kind: 'completed', text: `Отмечено при выполнении этапа: ${input.note.trim()}` });
    }
    stage.completedOn = action === 'accept' ? stage.completedOn || input.date : input.date;
    stage.completionNote = input.note.trim(); stage.blocker = undefined;
    if (stage.actualStart && stage.completedOn < stage.actualStart) throw new Error('Выполнение не может быть раньше фактического начала.');
    if (action === 'accept') {
      const gaps = stageGaps(next, id);
      if (role !== 'management' || gaps.tasks.length || gaps.checkpoints.length) throw new Error('Для приёмки управление завершает задачи и принимает контрольные точки.');
      if (input.date < stage.completedOn) throw new Error('Приёмка не может быть раньше выполнения.');
      stage.status = 'accepted'; stage.actualEnd = stage.completedOn; stage.acceptedAt = `${input.date}T12:00:00+03:00`; stage.acceptedBy = actor;
      const tracking = next.tasks.find((t) => t.id === `auto-stage-${id}`);
      if (tracking) { tracking.status = 'done'; tracking.completedAt = now; tracking.completionNote = input.note.trim(); }
    } else stage.status = 'awaiting_inspection';
  }
  for (const candidate of next.stages) if (candidate.status === 'not_ready' && (candidate.dependencyId || candidate.dependency) && stageCanStart(next, candidate)) candidate.status = 'ready';
  next.activity.unshift({ id: crypto.randomUUID(), timestamp: now, actor, text: `Этап «${stage.name}»: ${input.note.trim()}`, tone: action === 'delay' || action === 'rework' ? 'warning' : 'positive' });
  return next;
}
