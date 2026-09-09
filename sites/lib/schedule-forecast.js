import { baselineOverview, planDays, planToday, validPlanDate } from './plan-baseline.js';

export const schedulePayload = (value) => value ? {
  kind: value.kind, phase: value.phase, summaryOf: value.summaryOf,
  dependencies: value.dependencies, calendar: value.calendar, daysOff: value.daysOff,
  crew: value.crew, reporterId: value.reporterId,
} : null;
export const sitePayload = (value) => value ? {
  asOf: value.asOf, reviewOn: value.reviewOn, remainingDays: value.remainingDays,
  readyOn: value.readyOn, acceptanceOn: value.acceptanceOn, note: value.note,
  nextAction: value.nextAction, issueOwner: value.issueOwner,
} : null;
export const addScheduleDays = (day, count) => {
  const date = new Date(`${day}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
};
const isWorkday = (day, schedule) => {
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  return !(schedule.daysOff ?? []).includes(day) && (schedule.calendar === 'daily' || schedule.calendar === 'six-day' && weekday !== 0 || schedule.calendar === 'weekdays' && weekday !== 0 && weekday !== 6);
};
const nextWorkday = (day, schedule) => {
  for (let i = 0; i < 4000; i++, day = addScheduleDays(day, 1)) if (isWorkday(day, schedule)) return day;
  throw new Error('В календаре нет доступного рабочего дня');
};
export function confirmedSiteUpdate(stage, today = planToday()) {
  const u = stage.siteUpdate;
  return Boolean(u?.updatedAt && !u.requestId && validPlanDate(u.asOf) && u.asOf <= today && validPlanDate(u.reviewOn) && u.reviewOn >= today
    && planDays(today, u.asOf) <= 7 && Number.isFinite(Date.parse(u.updatedAt)) && planToday(new Date(u.updatedAt)) <= today
    && u.confirmedStatus === stage.status && u.confirmedBlocker === (stage.blocker || '')
    && u.confirmedFacts === JSON.stringify([stage.actualStart || '', stage.completedOn || '', stage.actualEnd || '', stage.acceptedAt || ''])
    && u.confirmedSchedule === JSON.stringify(schedulePayload(stage.schedule)));
}
const completedDate = (s) => s && ['accepted', 'awaiting_inspection'].includes(s.status)
  ? (validPlanDate(s.completedOn) ? s.completedOn : s.status === 'accepted' && validPlanDate(s.actualEnd) ? s.actualEnd : null) : null;

export function forecastSchedule(state, today = planToday()) {
  const stages = state.stages ?? [], byId = new Map(stages.map((s) => [s.id, s]));
  const issues = [], rows = new Map(), visiting = new Set();
  const issue = (stage, code, message) => { if (!issues.some((i) => i.stageId === stage.id && i.code === code)) issues.push({ stageId: stage.id, code, message }); };
  const calculate = (id) => {
    if (rows.has(id)) return rows.get(id);
    const stage = byId.get(id);
    if (!stage) return null;
    if (visiting.has(id)) { issue(stage, 'cycle', 'В связях ППР обнаружен круг'); return null; }
    visiting.add(id);
    const finish = (row) => { visiting.delete(id); rows.set(id, row); return row; };
    const schedule = stage.schedule;
    if (!schedule?.updatedAt) { issue(stage, 'structure', 'Подтвердите тип строки, крупный этап и зависимости'); return finish(null); }
    if (!['work', 'supply', 'control', 'summary'].includes(schedule.kind) || !['daily', 'weekdays', 'six-day'].includes(schedule.calendar)
      || !Array.isArray(schedule.dependencies) || !Array.isArray(schedule.summaryOf) || !Array.isArray(schedule.daysOff) || typeof schedule.crew !== 'string'
      || schedule.dependencies.some((d) => !d || !byId.has(d.stageId) || !['completed', 'accepted'].includes(d.gate) || !Number.isInteger(d.lagDays) || d.lagDays < 0 || d.lagDays > 365)
      || schedule.daysOff.some((day) => !validPlanDate(day))) { issue(stage, 'structure_invalid', 'Структура или календарь ППР требуют исправления'); return finish(null); }
    if (schedule.kind === 'summary') {
      if (!schedule.summaryOf?.length || schedule.summaryOf.some((child) => !byId.has(child) || byId.get(child).schedule?.kind === 'summary')) { issue(stage, 'summary', 'Укажите существующие работы, которые объединяет сводная строка, без вложенных сводных строк'); return finish(null); }
      const children = schedule.summaryOf.map((child) => calculate(child));
      if (children.some((child) => !child)) return finish(null);
      let end = children.map((r) => r.end).sort().at(-1);
      const start = children.map((r) => r.start).filter(Boolean).sort()[0] || end;
      if (['accepted', 'awaiting_inspection'].includes(stage.status)) {
        const fact = completedDate(stage);
        if (!fact || fact < end || fact > today || schedule.summaryOf.some((child) => !completedDate(byId.get(child)) || stage.status === 'accepted' && byId.get(child).status !== 'accepted')) issue(stage, 'summary_fact', 'Факт сводной строки не согласуется с выполнением и приёмкой вложенных работ');
        else end = fact;
      }
      return finish({ id, start, end, source: 'summary', workDates: [], drivingIds: children.filter((r) => r.end === end).map((r) => r.id) });
    }
    const actual = completedDate(stage);
    if (actual) {
      if (actual > today) { issue(stage, 'future_fact', 'Фактическое выполнение указано в будущем'); return finish(null); }
      return finish({ id, start: validPlanDate(stage.actualStart) ? stage.actualStart : actual, end: actual, source: 'fact', workDates: [], drivingIds: [] });
    }
    if (['accepted', 'awaiting_inspection'].includes(stage.status)) { issue(stage, 'fact', 'Выполнение отмечено, но фактическая дата неизвестна'); return finish(null); }
    if (!confirmedSiteUpdate(stage, today)) { issue(stage, 'site', 'Уточните состояние и остаток работ: сведения не подтверждены или устарели'); return finish(null); }
    const update = stage.siteUpdate;
    if (['in_progress', 'rework'].includes(stage.status) && (!validPlanDate(stage.actualStart) || stage.actualStart > update.asOf)) { issue(stage, 'start_fact', 'Работа идёт: подтвердите фактическое начало не позже даты сверки'); return finish(null); }
    if (!Number.isInteger(update.remainingDays) || update.remainingDays < 1 || update.remainingDays > 730) { issue(stage, 'remaining', 'Укажите остаток в рабочих днях; нулевой остаток оформляется выполнением'); return finish(null); }
    if (!validPlanDate(update.readyOn)) { issue(stage, 'ready', 'Укажите, с какого дня доступны работы, поставка или исполнитель'); return finish(null); }
    if (stage.blocker && (!update.nextAction?.trim() || !update.issueOwner?.trim())) issue(stage, 'action', 'Для препятствия нужны следующее действие и ответственный за решение');
    if (schedule.kind === 'work' && !schedule.crew?.trim()) issue(stage, 'crew', 'Укажите бригаду, чтобы проверить параллельную загрузку');
    const starts = [{ day: addScheduleDays(update.asOf, 1), id: null }, { day: update.readyOn, id: null }];
    for (const dependency of schedule.dependencies ?? []) {
      const previous = byId.get(dependency.stageId), row = calculate(dependency.stageId);
      if (!previous || !row) { issue(stage, 'dependency', 'Не хватает сведений о предшествующей работе'); continue; }
      let gate = row.end;
      if (dependency.gate === 'accepted') {
        const acceptedOn = Number.isFinite(Date.parse(previous.acceptedAt || '')) ? planToday(new Date(previous.acceptedAt)) : null;
        if (previous.status === 'accepted' && validPlanDate(acceptedOn) && acceptedOn <= today && acceptedOn >= row.end) gate = acceptedOn;
        else if (previous.status === 'accepted') { issue(stage, 'acceptance_fact', `Приёмка отмечена, но её фактическая дата неизвестна или противоречива: ${previous.name}`); continue; }
        else if (confirmedSiteUpdate(previous, today) && validPlanDate(previous.siteUpdate.acceptanceOn) && previous.siteUpdate.acceptanceOn >= row.end && previous.siteUpdate.acceptanceOn >= today) gate = previous.siteUpdate.acceptanceOn;
        else { issue(stage, 'acceptance', `Уточните дату приёмки: ${previous.name}`); continue; }
      }
      if (validPlanDate(stage.actualStart) && stage.actualStart < addScheduleDays(gate, dependency.lagDays + 1)) issue(stage, 'early_start', `Фактическое начало раньше разрешающей связи с «${previous.name}»; уточните зависимость`);
      starts.push({ day: addScheduleDays(gate, dependency.lagDays + 1), id: dependency.stageId });
    }
    if (issues.some((i) => i.stageId === id)) return finish(null);
    const candidates = starts.map((s) => ({ ...s, day: nextWorkday(s.day, schedule) }));
    const start = candidates.map((s) => s.day).sort().at(-1);
    if ((['not_ready', 'ready', 'blocked'].includes(stage.status) || stage.blocker) && start < today) { issue(stage, 'start_unconfirmed', 'Ожидаемый старт уже прошёл: подтвердите начало либо новую доступность работ'); return finish(null); }
    const workDates = []; let cursor = start;
    for (let count = 0; count < update.remainingDays; count++) { cursor = nextWorkday(cursor, schedule); workDates.push(cursor); cursor = addScheduleDays(cursor, 1); }
    const end = workDates.at(-1);
    if (end < today) { issue(stage, 'elapsed', 'Расчётный срок уже прошёл: подтвердите выполнение или обновите остаток'); return finish(null); }
    return finish({ id, start, end, source: 'calculation', workDates, drivingIds: candidates.filter((s) => s.id && s.day === start).map((s) => s.id) });
  };
  for (const stage of stages) calculate(stage.id);
  const resourceDays = new Map();
  for (const row of rows.values()) {
    if (!row || row.source !== 'calculation') continue;
    const stage = byId.get(row.id), crew = stage.schedule.crew.trim().toLocaleLowerCase('ru');
    if (!crew) continue;
    for (const day of row.workDates) {
      const key = `${crew}:${day}`, other = resourceDays.get(key);
      if (other && other !== stage.id) {
        issue(stage, 'resource', `Бригада «${stage.schedule.crew}» также занята на «${byId.get(other).name}». Согласуйте очередность или другую бригаду`);
        issue(byId.get(other), 'resource', `Конфликт бригады с «${stage.name}»`);
      } else resourceDays.set(key, stage.id);
    }
  }
  const physical = stages.filter((s) => s.schedule?.kind !== 'summary');
  const calculated = [...rows.values()].filter(Boolean);
  const end = stages.length && !issues.length && calculated.length === stages.length ? calculated.map((r) => r.end).sort().at(-1) : null;
  const criticalIds = new Set();
  const mark = (id) => { if (criticalIds.has(id)) return; criticalIds.add(id); for (const parent of rows.get(id)?.drivingIds ?? []) mark(parent); };
  if (end) for (const row of calculated) if (row.end === end) mark(row.id);
  const baseline = baselineOverview(state);
  const actual = Boolean(physical.length && physical.every((s) => completedDate(s)));
  const phases = [...new Set(physical.map((s) => s.schedule?.phase || 'Структура не сверена'))].map((name) => {
    const members = physical.filter((s) => (s.schedule?.phase || 'Структура не сверена') === name);
    return { name, ids: members.map((s) => s.id), accepted: members.filter((s) => s.status === 'accepted').length, completed: members.filter((s) => completedDate(s)).length,
      running: members.filter((s) => ['in_progress', 'rework'].includes(s.status) || s.status === 'blocked' && s.actualStart).map((s) => s.id), blocked: members.filter((s) => s.blocker).map((s) => s.id) };
  });
  return { end, kind: !end ? 'incomplete' : actual ? 'actual' : 'calculated', baselineEnd: baseline.end, baselineShift: planDays(end, baseline.end), currentEnd: baseline.currentEnd,
    issues, rows: calculated, criticalIds: [...criticalIds], phases, accepted: physical.filter((s) => s.status === 'accepted').length, total: physical.length };
}

export function simulateSchedule(state, change, today = planToday()) {
  const copy = structuredClone(state), stage = copy.stages.find((s) => s.id === change.stageId);
  const before = forecastSchedule(state, today);
  if (!stage?.schedule || !stage.siteUpdate || !before.end) return { forecast: null, gainedDays: null };
  stage.siteUpdate.remainingDays = change.remainingDays;
  if (change.crew !== undefined) stage.schedule.crew = change.crew;
  if (change.readyOn !== undefined) stage.siteUpdate.readyOn = change.readyOn;
  stage.siteUpdate.confirmedSchedule = JSON.stringify(schedulePayload(stage.schedule));
  const after = forecastSchedule(copy, today);
  return { forecast: after, gainedDays: planDays(before.end, after.end) };
}
