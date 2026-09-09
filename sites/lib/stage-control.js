import { planDays, planToday, validPlanDate } from './plan-baseline.js';

export const stageCanStart = (state, stage) => {
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
