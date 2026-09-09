import { planDays, planToday, taskBaselineEnd, validPlanDate } from './plan-baseline.js';

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

export const stageCanStart = (state, stage) => {
  if (stage.schedule) {
    if (!stage.schedule.updatedAt || stage.schedule.kind === 'summary') return false;
    return (stage.schedule.dependencies ?? []).every((dependency) => {
      const previous = (state.stages ?? []).find((s) => s.id === dependency.stageId);
      const complete = (row, seen = new Set()) => {
        if (!row || seen.has(row.id)) return null;
        seen.add(row.id);
        if (row.schedule?.kind === 'summary') {
          const dates = row.schedule.summaryOf.map((id) => complete(state.stages.find((s) => s.id === id), new Set(seen)));
          if (!dates.length || !dates.every(Boolean)) return null;
          const childrenEnd = dates.sort().at(-1), fact = row.completedOn || row.actualEnd;
          if (['accepted', 'awaiting_inspection'].includes(row.status)) return validPlanDate(fact) && fact >= childrenEnd ? fact : null;
          return childrenEnd;
        }
        return ['accepted', 'awaiting_inspection'].includes(row.status) ? row.completedOn || row.actualEnd : null;
      };
      const day = dependency.gate === 'accepted' ? (previous?.status === 'accepted' && Number.isFinite(Date.parse(previous.acceptedAt || '')) ? planToday(new Date(previous.acceptedAt)) : null) : complete(previous);
      return validPlanDate(day) && planDays(planToday(), day) > dependency.lagDays;
    });
  }
  if (!stage.dependencyId && !stage.dependency) return true;
  const previous = (state.stages ?? []).find((s) => stage.dependencyId ? s.id === stage.dependencyId : [s.name, s.shortName].includes(stage.dependency));
  return previous?.status === 'accepted';
};
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
