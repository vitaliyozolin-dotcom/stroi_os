import { planDays, planToday, taskBaselineEnd, validPlanDate } from './plan-baseline.js';
import { schedulePayload, sitePayload } from './schedule-forecast.js';

// Compare the facts shown by the form, not server stamps or derived progress.
export const stageControlFingerprint = (stage) => JSON.stringify({
  id: stage.id, name: stage.name, status: stage.status, actualStart: stage.actualStart,
  completedOn: stage.completedOn, completionObservedOn: stage.completionObservedOn,
  completionNote: stage.completionNote, acceptedAt: stage.acceptedAt, acceptedBy: stage.acceptedBy,
  actualEnd: stage.actualEnd, blocker: stage.blocker, planStart: stage.planStart,
  planEnd: stage.planEnd, forecastEnd: stage.forecastEnd, responsible: stage.responsible,
  responsibleId: stage.responsibleId, dependencyId: stage.dependencyId, dependency: stage.dependency,
  schedule: schedulePayload(stage.schedule), siteUpdate: sitePayload(stage.siteUpdate),
  ownerAcceptance: stage.ownerAcceptance,
});

// Read-only record status. An unclosed record is not proof of a project delay.
export function recordedScheduleStatus(state, today = planToday()) {
  const stages = state.stages ?? [];
  const tasks = (state.tasks ?? []).filter((t) => !t.id.startsWith('auto-stage-') && t.status !== 'canceled');
  const group = (records, dueDate, baselineDate, reviewStatus, doneStatus) => {
    const open = records.filter((r) => r.status !== reviewStatus && r.status !== doneStatus);
    const rows = open.map((record) => ({ record, days: planDays(today, dueDate(record)), baselineDays: planDays(today, baselineDate(record)) }));
    const overdue = rows.filter((r) => r.days !== null && r.days > 0).sort((a, b) => b.days - a.days);
    const baselineOverdue = rows.filter((r) => r.baselineDays !== null && r.baselineDays > 0).sort((a, b) => b.baselineDays - a.baselineDays);
    return { recordCount: records.length, overdue, baselineOverdue, maxDays: overdue[0]?.days ?? 0, maxBaselineDays: baselineOverdue[0]?.baselineDays ?? 0,
      awaitingReview: records.filter((r) => r.status === reviewStatus).length,
      missingDue: rows.filter((r) => r.days === null).length,
      missingBaseline: rows.filter((r) => r.baselineDays === null).length };
  };
  return { today,
    stages: group(stages, (s) => s.planEnd, (s) => s.baseline?.end, 'awaiting_inspection', 'accepted'),
    tasks: group(tasks, (t) => t.dueDate, taskBaselineEnd, 'review', 'done') };
}

const dependencyCompletedOn = (state, stage, seen = new Set()) => {
  if (!stage || seen.has(stage.id)) return null;
  seen.add(stage.id);
  if (stage.schedule?.kind === 'summary') {
    const dates = (stage.schedule.summaryOf ?? []).map(id => dependencyCompletedOn(state, (state.stages ?? []).find(row => row.id === id), new Set(seen)));
    if (!dates.length || !dates.every(Boolean)) return null;
    const childrenEnd = dates.sort().at(-1), fact = stage.completedOn || stage.actualEnd;
    return ['accepted', 'awaiting_inspection'].includes(stage.status) ? validPlanDate(fact) && fact >= childrenEnd ? fact : null : childrenEnd;
  }
  const fact = stage.completedOn || stage.actualEnd;
  return ['accepted', 'awaiting_inspection'].includes(stage.status) && validPlanDate(fact) ? fact : null;
};

/** Shared by UI commands and every server write path. Forecast dates never unlock a gate. */
export function stageDependencyIssue(state, stage, action = 'start', on = planToday()) {
  if (!validPlanDate(on)) return 'Укажите фактическую дату действия.';
  if (stage.schedule?.kind === 'summary') return action === 'start' ? 'Сводный этап начинается через вложенные работы.' : null;
  if (stage.schedule && !stage.schedule.updatedAt) return 'Сначала подтвердите состав и зависимости этой работы.';
  if (!stage.schedule) {
    if (!stage.dependencyId && !stage.dependency) return null;
    const previous = (state.stages ?? []).find(row => stage.dependencyId ? row.id === stage.dependencyId : [row.name, row.shortName].includes(stage.dependency));
    if (!previous || previous.status !== 'accepted') return `Сначала примите предыдущий этап: ${previous?.shortName || previous?.name || stage.dependency || 'не найден'}.`;
    const acceptedOn = Number.isFinite(Date.parse(previous.acceptedAt || '')) ? planToday(new Date(previous.acceptedAt)) : null;
    return acceptedOn && on < acceptedOn ? 'Дата действия не может быть раньше приёмки предыдущего этапа.' : null;
  }
  for (const dependency of stage.schedule.dependencies ?? []) {
    const previous = (state.stages ?? []).find(row => row.id === dependency.stageId), type = dependency.type ?? 'FS';
    if (!previous || !['FS', 'SS', 'FF'].includes(type) || !['completed', 'accepted'].includes(dependency.gate)
      || !Number.isInteger(dependency.lagDays) || dependency.lagDays < -365 || dependency.lagDays > 365
      || type === 'SS' && previous.schedule?.kind === 'summary'
      || dependency.gate === 'accepted' && (type === 'SS' || dependency.lagDays < 0)) return 'Проверьте зависимость и технологическую паузу в графике.';
    if (type === 'FF' && action === 'start') continue;
    const title = previous.shortName || previous.name;
    let day;
    if (type === 'SS') day = previous.actualStart;
    else if (dependency.gate === 'accepted') day = previous.status === 'accepted' && Number.isFinite(Date.parse(previous.acceptedAt || '')) ? planToday(new Date(previous.acceptedAt)) : null;
    else day = dependencyCompletedOn(state, previous);
    if (!validPlanDate(day)) return `Сначала ${type === 'SS' ? 'подтвердите начало' : dependency.gate === 'accepted' ? 'примите результат' : 'подтвердите выполнение'}: ${title}.`;
    const elapsed = planDays(on, day), required = dependency.lagDays + (type === 'FS' ? 1 : 0);
    if (elapsed < required) return `Не выдержана пауза после «${title}»: ещё ${required - elapsed} кал. дн.`;
  }
  return null;
}
export const stageCanStart = (state, stage, on = planToday()) => !stageDependencyIssue(state, stage, 'start', on);
export const stageGaps = (state, id) => ({
  tasks: (state.tasks ?? []).filter((t) => t.stageId === id && t.id !== `auto-stage-${id}` && !['done', 'canceled'].includes(t.status)),
  checkpoints: (state.checkpoints ?? []).filter((p) => p.stageId === id && p.status !== 'accepted'),
});
export function stageRadar(state, today = planToday()) {
  const unfinished = (state.stages ?? []).filter((s) => s.status !== 'accepted');
  const running = unfinished.filter((s) => !['not_ready', 'ready'].includes(s.status));
  const due = unfinished.filter((s) => validPlanDate(s.planEnd) && planDays(s.planEnd, today) <= 2);
  const upcoming = unfinished.filter((s) => ['ready', 'not_ready'].includes(s.status) && stageCanStart(state, s));
  const forecast = state.project?.workForecastUpdatedAt && validPlanDate(state.project.workForecastDate) ? state.project.workForecastDate : null;
  const bounds = unfinished.filter((s) => s.forecastUpdatedAt && validPlanDate(s.forecastEnd)).map((s) => s.forecastEnd);
  const lowerBound = bounds.sort().at(-1) || null;
  const confirmedAt = Date.parse(state.project?.workForecastUpdatedAt || '');
  const stale = Boolean(forecast && (!Number.isFinite(confirmedAt) || forecast < today || planDays(today, planToday(new Date(confirmedAt))) > 7));
  return { running, due, upcoming, lowerBound, forecast, stale, conflict: Boolean(forecast && lowerBound && forecast < lowerBound), complete: !unfinished.length && Boolean(state.stages?.length) };
}
