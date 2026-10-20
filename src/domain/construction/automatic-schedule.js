import { baselineOverview, planDays, planToday, validPlanDate } from './plan-baseline.js';
import { addScheduleDays, confirmedSiteUpdate, forecastSchedule } from './schedule-forecast.js';

const finished = (stage) => ['accepted', 'awaiting_inspection'].includes(stage.status);
const normalize = (value) => String(value || '').toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/[^а-яa-z0-9]+/g, ' ').trim();
const workday = (day, calendar, daysOff) => {
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  return !daysOff.includes(day) && (calendar === 'daily' || calendar === 'six-day' && weekday !== 0 || calendar === 'weekdays' && weekday !== 0 && weekday !== 6);
};
const calendarFor = (stage) => ({ calendar: stage.schedule?.calendar || 'daily', daysOff: stage.schedule?.daysOff || [] });
export function plannedStageDays(stage) {
  const span = planDays(stage.planEnd, stage.planStart), { calendar, daysOff } = calendarFor(stage);
  if (span === null || span < 0 || span > 730 || !['daily', 'weekdays', 'six-day'].includes(calendar) || daysOff.some(day => !validPlanDate(day))) return null;
  let days = 0;
  for (let i = 0; i <= span; i++) if (workday(addScheduleDays(stage.planStart, i), calendar, daysOff)) days++;
  return days || null;
}

// A read-only planning estimate. It never stamps actual dates, confirms site
// facts, or changes the agreed PPR. The audited forecast remains independent.
export function automaticSchedule(state, today = planToday()) {
  const stages = state.stages || [], byId = new Map(stages.map(stage => [stage.id, stage]));
  const physical = stages.filter(stage => stage.schedule?.kind !== 'summary');
  const unmappedWork = (state.project.siteProgressHistory?.at(-1)?.remaining || []).filter(name => {
    const phrase = normalize(name);
    return !phrase || !physical.some(stage => [stage.name, stage.shortName].some(title => (` ${normalize(title)} `).includes(` ${phrase} `)));
  });
  const strict = forecastSchedule(state, today), issues = [], notes = new Set(), rows = new Map(), visiting = new Set();
  const issue = (stage, message) => { if (!issues.some(item => item.stageId === stage.id && item.message === message)) issues.push({ stageId: stage.id, message }); };
  const calculate = (id) => {
    if (rows.has(id)) return rows.get(id);
    const stage = byId.get(id);
    if (!stage) return null;
    if (visiting.has(id)) { issue(stage, 'В зависимостях обнаружен круг'); return null; }
    visiting.add(id);
    const finish = (row) => { visiting.delete(id); rows.set(id, row); return row; };
    if (stage.schedule?.kind === 'summary') {
      const children = stage.schedule.summaryOf || [];
      if (!children.length || children.some(child => !byId.has(child) || byId.get(child).schedule?.kind === 'summary')) { issue(stage, 'Не указан состав сводного этапа'); return finish(null); }
      const calculated = children.map(calculate);
      if (calculated.some(row => !row)) return finish(null);
      return finish({ id, start: calculated.map(row => row.start).sort()[0], end: calculated.map(row => row.end).sort().at(-1), source: 'summary', remainingDays: 0, workDates: [] });
    }
    if (finished(stage)) {
      const actual = stage.completedOn || stage.actualEnd;
      const acceptance = Number.isFinite(Date.parse(stage.acceptedAt || '')) ? planToday(new Date(stage.acceptedAt)) : null;
      const end = actual || stage.completionObservedOn || acceptance || today;
      if (!validPlanDate(end) || end > today || validPlanDate(stage.actualStart) && stage.actualStart > end) { issue(stage, 'Проверьте даты выполнения'); return finish(null); }
      if (!actual) notes.add('Выполненные этапы исключены из остатка. Дата подтверждения не становится датой выполнения.');
      return finish({ id, start: validPlanDate(stage.actualStart) ? stage.actualStart : end, end, source: actual ? 'fact' : 'observation', remainingDays: 0, workDates: [] });
    }
    const schedule = stage.schedule, { calendar, daysOff } = calendarFor(stage);
    if (schedule && (!schedule.updatedAt || !['work', 'supply', 'control'].includes(schedule.kind)
      || !['daily', 'weekdays', 'six-day'].includes(calendar) || !Array.isArray(schedule.dependencies)
      || daysOff.some(day => !validPlanDate(day)))) { issue(stage, 'Проверьте структуру и календарь этапа'); return finish(null); }
    const fresh = confirmedSiteUpdate(stage, today), update = fresh ? stage.siteUpdate : null;
    const duration = update ? update.remainingDays : plannedStageDays(stage);
    if (!Number.isInteger(duration) || duration < 1 || duration > 731) { issue(stage, 'Не задана длительность оставшейся работы'); return finish(null); }
    if (stage.blocker || stage.status === 'blocked') {
      if (!update || !validPlanDate(update.readyOn) || update.readyOn < today) { issue(stage, 'Неизвестно, когда будет устранена задержка'); return finish(null); }
    }
    if (!fresh) notes.add('Без свежей оценки остатка берём полную длительность этапа из ППР; прошедшие дни сами по себе не означают выполненную работу.');
    if (!schedule) notes.add('Сохраняем параллельность и разрывы между оставшимися работами в ППР. Календарь — каждый день; доступность бригад и поставок нужно уточнять при задержке.');
    let start = today;
    if (validPlanDate(stage.planStart) && stage.planStart > start) start = stage.planStart;
    if (update) {
      if (!validPlanDate(update.readyOn)) { issue(stage, 'Не указана доступность работы'); return finish(null); }
      start = [start, addScheduleDays(update.asOf, 1), update.readyOn].sort().at(-1);
    }
    let dependencies;
    if (schedule) dependencies = schedule.dependencies;
    else if (stage.dependencyId || stage.dependency) {
      const previous = stage.dependencyId ? byId.get(stage.dependencyId) : stages.find(item => [item.name, item.shortName].includes(stage.dependency));
      if (!previous) { issue(stage, 'Не найден предшествующий этап'); return finish(null); }
      dependencies = [{ stageId: previous.id, gate: 'completed', lagDays: 0 }];
    } else {
      // Infer only a provisional sequence from non-overlapping plan intervals;
      // overlapping rows stay parallel. Explicit links always take precedence.
      dependencies = physical.filter(previous => previous.id !== id && !finished(previous) && validPlanDate(previous.planEnd) && validPlanDate(stage.planStart) && previous.planEnd < stage.planStart)
        .map(previous => ({ stageId: previous.id, gate: 'completed', lagDays: planDays(stage.planStart, previous.planEnd) - 1 }));
    }
    for (const dependency of dependencies) {
      if (!dependency || !byId.has(dependency.stageId) || !['completed', 'accepted'].includes(dependency.gate) || !Number.isInteger(dependency.lagDays) || dependency.lagDays < 0 || dependency.lagDays > 730) { issue(stage, 'Некорректная зависимость'); continue; }
      const previous = byId.get(dependency.stageId), row = calculate(dependency.stageId);
      if (!row) { issue(stage, 'Не хватает срока предшествующей работы'); continue; }
      let gate = row.end;
      if (dependency.gate === 'accepted') {
        const acceptance = Number.isFinite(Date.parse(previous.acceptedAt || '')) ? planToday(new Date(previous.acceptedAt)) : null;
        if (previous.status === 'accepted' && validPlanDate(acceptance) && acceptance <= today && acceptance >= row.end) gate = acceptance;
        else if (previous.status === 'accepted' && previous.acceptedAt) { issue(stage, `Проверьте дату приёмки: ${previous.shortName || previous.name}`); continue; }
        else if (previous.status === 'accepted') { gate = today; notes.add('Срок прежней приёмки неизвестен; для будущих работ считаем этап доступным сегодня.'); }
        else if (confirmedSiteUpdate(previous, today) && validPlanDate(previous.siteUpdate.acceptanceOn) && previous.siteUpdate.acceptanceOn >= row.end && previous.siteUpdate.acceptanceOn >= today) gate = previous.siteUpdate.acceptanceOn;
        else { issue(stage, `Нужен срок приёмки: ${previous.shortName || previous.name}`); continue; }
      }
      start = [start, addScheduleDays(gate, dependency.lagDays + 1)].sort().at(-1);
    }
    if (issues.some(item => item.stageId === id)) return finish(null);
    const workDates = [];
    for (let cursor = start, count = 0; workDates.length < duration && count < 5000; cursor = addScheduleDays(cursor, 1), count++) if (workday(cursor, calendar, daysOff)) workDates.push(cursor);
    if (workDates.length !== duration) { issue(stage, 'В календаре недостаточно рабочих дней'); return finish(null); }
    return finish({ id, start: workDates[0], end: workDates.at(-1), source: fresh ? 'remaining' : 'plan', remainingDays: duration, workDates });
  };
  for (const stage of stages) calculate(stage.id);
  const calculated = [...rows.values()].filter(Boolean), resources = new Map();
  for (const row of calculated) {
    const stage = byId.get(row.id), crew = stage.schedule?.crew?.trim().toLocaleLowerCase('ru');
    if (!crew) continue;
    for (const day of row.workDates) {
      const key = `${crew}:${day}`, other = resources.get(key);
      if (other) issue(stage, `Одна бригада одновременно назначена на «${byId.get(other).shortName}»`);
      else resources.set(key, row.id);
    }
  }
  const baselineEnd = baselineOverview(state).end;
  let end = stages.length && calculated.length === stages.length && !issues.length ? calculated.map(row => row.end).sort().at(-1) : null;
  let kind = !end ? 'incomplete' : physical.every(finished) ? physical.every(stage => stage.completedOn || stage.actualEnd) ? 'actual' : 'observed' : 'estimated';
  let resultRows = calculated;
  const useStrict = Boolean(strict.end && !issues.length);
  if (useStrict) {
    end = strict.end; kind = strict.kind === 'actual' ? 'actual' : 'confirmed';
    resultRows = strict.rows.map(row => ({ ...row, source: row.source === 'calculation' ? 'remaining' : row.source, remainingDays: row.workDates.length }));
  }
  return { end, kind, baselineEnd, baselineShift: planDays(end, baselineEnd), rows: resultRows,
    remainingStages: physical.filter(stage => !finished(stage)).length,
    remainingDays: end ? physical.every(finished) ? 0 : Math.max(1, planDays(end, today) + 1) : null,
    issues: useStrict ? [] : issues, notes: useStrict ? [] : [...notes], unmappedWork };
}
