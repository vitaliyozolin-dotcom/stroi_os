export const validPlanDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
export const planDays = (current, original) => validPlanDate(current) && validPlanDate(original)
  ? Math.round((Date.parse(`${current}T12:00:00Z`) - Date.parse(`${original}T12:00:00Z`)) / 86400000) : null;
export const planToday = (date = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);

// Dates captured by the exact PPR import of 17 August, not current schedule dates.
const kelosiDates = {
  'kelosi-ppr-1': ['2026-08-10', '2026-08-10'],
  'kelosi-ppr-2': ['2026-08-10', '2026-08-25'],
  'kelosi-ppr-2-2': ['2026-08-10', '2026-08-25'],
  'kelosi-ppr-3': ['2026-08-10', '2026-08-15'],
  'kelosi-ppr-3-1': ['2026-08-10', '2026-08-15'],
  'kelosi-ppr-4': ['2026-08-14', '2026-08-16'],
  'kelosi-ppr-5': ['2026-08-16', '2026-08-20'],
  'kelosi-ppr-6': ['2026-08-20', '2026-08-27'],
  'kelosi-ppr-7': ['2026-08-27', '2026-09-10'],
  'kelosi-ppr-7-1': ['2026-08-25', '2026-08-27'],
  'kelosi-ppr-8': ['2026-08-27', '2026-09-10'],
  'kelosi-ppr-9': ['2026-08-27', '2026-09-10'],
};
export function restoreKnownPprBaseline(state) {
  const marker = (state.activity ?? []).find((event) => event.id === 'ppr-kelosi-2026-08-17-v2-exact');
  if ((!marker && !(state.stages ?? []).some((stage) => kelosiDates[stage.id]))
    || ![state.project?.name, state.project?.code, state.project?.address].some((v) => String(v || '').toLocaleLowerCase('ru').includes('келози'))) return state;
  let changed = false;
  const stages = (state.stages ?? []).map((stage) => {
    const dates = kelosiDates[stage.id];
    if (!dates || stage.baseline) return stage;
    changed = true;
    return { ...stage, baseline: { start: dates[0], end: dates[1], source: 'document', note: 'ППР.xlsx · исходная строка, импорт 17.08.2026', recordedAt: marker?.timestamp || '2026-08-17T07:27:00.000Z', recordedBy: 'Импорт ППР' } };
  });
  return changed ? { ...state, stages } : state;
}

export function taskBaselineEnd(task) {
  return validPlanDate(task.baseline?.end) ? task.baseline.end : validPlanDate(task.originalDueDate) ? task.originalDueDate : null;
}

export function taskBaselineDelay(task, today = planToday()) {
  if (task.status === 'canceled') return null;
  let end = today;
  if (task.status === 'done') {
    if (!task.completedAt || !Number.isFinite(Date.parse(task.completedAt))) return null;
    end = planToday(new Date(task.completedAt));
  }
  const days = planDays(end, taskBaselineEnd(task));
  return days === null ? null : Math.max(0, days);
}

export function baselineOverview(state) {
  const stages = state.stages ?? [];
  const dates = stages.map((stage) => stage.baseline?.end).filter(validPlanDate);
  const currentDates = stages.map((stage) => stage.planEnd).filter(validPlanDate);
  const pprComplete = stages.length > 0 && dates.length === stages.length;
  const end = pprComplete ? dates.sort().at(-1) : null;
  const currentComplete = stages.length > 0 && currentDates.length === stages.length;
  const currentEnd = currentComplete ? currentDates.sort().at(-1) : null;
  const shiftedStages = stages.filter((stage) => (planDays(stage.planEnd, stage.baseline?.end) ?? 0) > 0);
  const shiftedTasks = (state.tasks ?? []).filter((task) => task.status !== 'canceled' && (planDays(task.dueDate, taskBaselineEnd(task)) ?? 0) > 0);
  return { end, currentEnd, shift: planDays(currentEnd, end), pprComplete, currentComplete, recorded: dates.length, currentRecorded: currentDates.length, total: stages.length, shiftedStages, shiftedTasks };
}
