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
const previousWorkday = (day, schedule) => {
  for (let i = 0; i < 4000; i++, day = addScheduleDays(day, -1)) if (isWorkday(day, schedule)) return day;
  throw new Error('В календаре нет доступного рабочего дня');
};
export const scheduleWorkDates = (start, duration, schedule) => {
  const dates = []; let cursor = start;
  for (let count = 0; count < duration; count++) { cursor = nextWorkday(cursor, schedule); dates.push(cursor); cursor = addScheduleDays(cursor, 1); }
  return dates;
};
/** Earliest working start whose inclusive duration can finish on/after a constraint. */
export const scheduleStartForFinish = (finish, duration, schedule) => {
  let cursor = nextWorkday(finish, schedule);
  for (let count = 1; count < duration; count++) cursor = previousWorkday(addScheduleDays(cursor, -1), schedule);
  return cursor;
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
  const issues = [], rows = new Map(), visiting = new Set(), edges = [];
  const issue = (stage, code, message) => { if (!issues.some((i) => i.stageId === stage.id && i.code === code)) issues.push({ stageId: stage.id, code, message }); };
  const graphSeen = new Set(), graphOpen = new Set();
  const checkGraph = id => {
    if (graphOpen.has(id)) { issue(byId.get(id), 'cycle', 'В связях ППР обнаружен круг'); return; }
    if (graphSeen.has(id) || !byId.has(id)) return;
    graphOpen.add(id);
    const schedule = byId.get(id).schedule;
    for (const child of [...(Array.isArray(schedule?.summaryOf) ? schedule.summaryOf : []), ...(Array.isArray(schedule?.dependencies) ? schedule.dependencies.map(d => d?.stageId) : [])]) checkGraph(child);
    graphOpen.delete(id); graphSeen.add(id);
  };
  for (const stage of stages) checkGraph(stage.id);
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
      || schedule.dependencies.some((d) => !d || !byId.has(d.stageId) || !['FS', 'SS', 'FF'].includes(d.type ?? 'FS')
        || !['completed', 'accepted'].includes(d.gate) || !Number.isInteger(d.lagDays) || d.lagDays < -365 || d.lagDays > 365
        || d.gate === 'accepted' && (d.type === 'SS' || d.lagDays < 0)
        || d.type === 'SS' && byId.get(d.stageId)?.schedule?.kind === 'summary')
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
      if (validPlanDate(stage.actualStart) && stage.actualStart > actual) issue(stage, 'fact_order', 'Фактическое начало позже выполнения: проверьте источник дат');
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
      const type = dependency.type ?? 'FS';
      let gate = row.end;
      if (type === 'SS') {
        if (row.source === 'fact' && !validPlanDate(previous.actualStart)) { issue(stage, 'dependency_start', `Уточните фактическое начало: ${previous.name}`); continue; }
        gate = validPlanDate(previous.actualStart) ? previous.actualStart : row.start;
      } else if (dependency.gate === 'accepted') {
        const acceptedOn = Number.isFinite(Date.parse(previous.acceptedAt || '')) ? planToday(new Date(previous.acceptedAt)) : null;
        if (previous.status === 'accepted' && validPlanDate(acceptedOn) && acceptedOn <= today && acceptedOn >= row.end) gate = acceptedOn;
        else if (previous.status === 'accepted') { issue(stage, 'acceptance_fact', `Приёмка отмечена, но её фактическая дата неизвестна или противоречива: ${previous.name}`); continue; }
        else if (confirmedSiteUpdate(previous, today) && validPlanDate(previous.siteUpdate.acceptanceOn) && previous.siteUpdate.acceptanceOn >= row.end && previous.siteUpdate.acceptanceOn >= today) gate = previous.siteUpdate.acceptanceOn;
        else { issue(stage, 'acceptance', `Уточните дату приёмки: ${previous.name}`); continue; }
      }
      const constraint = addScheduleDays(gate, dependency.lagDays + (type === 'FS' ? 1 : 0));
      if (type !== 'FF' && validPlanDate(stage.actualStart) && stage.actualStart < constraint) issue(stage, 'early_start', `Фактическое начало раньше разрешающей связи с «${previous.name}»; уточните зависимость`);
      starts.push({ day: type === 'FF' ? scheduleStartForFinish(constraint, update.remainingDays, schedule) : constraint, id: dependency.stageId });
      edges.push({ from: previous.id, to: id, type, lagDays: dependency.lagDays, acceptance: dependency.gate === 'accepted' ? gate : null });
    }
    if (issues.some((i) => i.stageId === id)) return finish(null);
    const candidates = starts.map((s) => ({ ...s, day: nextWorkday(s.day, schedule) }));
    const start = candidates.map((s) => s.day).sort().at(-1);
    if ((['not_ready', 'ready', 'blocked'].includes(stage.status) || stage.blocker) && start < today) { issue(stage, 'start_unconfirmed', 'Ожидаемый старт уже прошёл: подтвердите начало либо новую доступность работ'); return finish(null); }
    const workDates = scheduleWorkDates(start, update.remainingDays, schedule);
    const end = workDates.at(-1);
    if (end < today) { issue(stage, 'elapsed', 'Расчётный срок уже прошёл: подтвердите выполнение или обновите остаток'); return finish(null); }
    return finish({ id, start, end, source: 'calculation', workDates, drivingIds: candidates.filter((s) => s.id && s.day === start).map((s) => s.id) });
  };
  for (const stage of stages) calculate(stage.id);
  // Facts stay immutable, but a recorded finish/start cannot silently contradict
  // the newly configured relation. Keep the fact visible and withhold CPM.
  for (const stage of stages) {
    const target = rows.get(stage.id);
    if (target?.source !== 'fact') continue;
    for (const dependency of stage.schedule.dependencies) {
      const previous = byId.get(dependency.stageId), predecessor = rows.get(dependency.stageId);
      if (!predecessor) continue;
      const type = dependency.type ?? 'FS';
      let gate = type === 'SS' ? previous.actualStart || (predecessor.source === 'fact' ? null : predecessor.start) : predecessor.end;
      if (dependency.gate === 'accepted') gate = previous.status === 'accepted' && Number.isFinite(Date.parse(previous.acceptedAt || '')) ? planToday(new Date(previous.acceptedAt)) : previous.siteUpdate?.acceptanceOn;
      const fact = type === 'FF' ? target.end : stage.actualStart;
      if (validPlanDate(fact) && validPlanDate(gate)) {
        if (fact < addScheduleDays(gate, dependency.lagDays + (type === 'FS' ? 1 : 0)))
          issue(stage, 'dependency_fact', `Фактическая дата нарушает связь ${type} с «${previous.name}»; проверьте связь и источник факта`);
        edges.push({ from: previous.id, to: stage.id, type, lagDays: dependency.lagDays, acceptance: dependency.gate === 'accepted' ? gate : null });
      }
    }
  }
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
  // Backward pass over the same working calendars. Fixed facts and acceptance
  // milestones never move; no resource leveling is invented by the CPM pass.
  const criticalIds = new Set(), outgoing = new Map();
  for (const edge of edges) {
    const previous = byId.get(edge.from);
    const ids = previous?.schedule?.kind === 'summary' ? previous.schedule.summaryOf : [edge.from];
    for (const id of ids) { const list = outgoing.get(id) ?? []; list.push(edge); outgoing.set(id, list); }
  }
  for (const row of calculated) Object.assign(row, { latestStart: null, latestEnd: null, totalFloatDays: null, freeFloatDays: null });
  if (end) {
    const anchoredStart = (stage, row) => validPlanDate(stage.actualStart) ? stage.actualStart : row.start;
    const latestPosition = (row, useLatest) => {
      const stage = byId.get(row.id), schedule = stage.schedule;
      const fits = start => {
        const dates = scheduleWorkDates(start, row.workDates.length, schedule), candidate = { start: dates[0], end: dates.at(-1) };
        if (candidate.end > end) return false;
        for (const edge of outgoing.get(row.id) ?? []) {
          const successor = rows.get(edge.to), next = byId.get(edge.to);
          const successorStart = validPlanDate(next.actualStart) ? next.actualStart : useLatest ? successor.latestStart ?? successor.start : successor.start;
          const successorEnd = useLatest ? successor.latestEnd ?? successor.end : successor.end;
          if (edge.acceptance && candidate.end > edge.acceptance) return false;
          const gate = edge.type === 'SS' ? anchoredStart(stage, candidate) : edge.acceptance || candidate.end;
          if (addScheduleDays(gate, edge.lagDays + (edge.type === 'FS' ? 1 : 0)) > (edge.type === 'FF' ? successorEnd : successorStart)) return false;
        }
        return candidate;
      };
      let lo = 0, hi = Math.max(0, planDays(end, row.start)), best = { start: row.start, end: row.end };
      while (lo <= hi) {
        const middle = Math.floor((lo + hi) / 2), candidate = fits(nextWorkday(addScheduleDays(row.start, middle), schedule));
        if (candidate) { best = candidate; lo = middle + 1; } else hi = middle - 1;
      }
      return best;
    };
    for (const row of [...calculated].reverse()) {
      if (row.source !== 'calculation') continue;
      const latest = latestPosition(row, true), free = latestPosition(row, false);
      Object.assign(row, { latestStart: latest.start, latestEnd: latest.end,
        totalFloatDays: Math.max(0, planDays(latest.start, row.start)), freeFloatDays: Math.max(0, planDays(free.start, row.start)) });
      if (row.totalFloatDays === 0) criticalIds.add(row.id);
    }
  }
  const baseline = baselineOverview(state);
  const actual = Boolean(physical.length && physical.every((s) => completedDate(s)));
  const phases = [...new Set(physical.map((s) => s.schedule?.phase || 'Структура не сверена'))].map((name) => {
    const members = physical.filter((s) => (s.schedule?.phase || 'Структура не сверена') === name);
    return { name, ids: members.map((s) => s.id), accepted: members.filter((s) => s.status === 'accepted').length, completed: members.filter((s) => completedDate(s)).length,
      running: members.filter((s) => ['in_progress', 'rework'].includes(s.status) || s.status === 'blocked' && s.actualStart).map((s) => s.id), blocked: members.filter((s) => s.blocker).map((s) => s.id) };
  });
  return { end, kind: !end ? 'incomplete' : actual ? 'actual' : 'calculated', baselineEnd: baseline.end, baselineShift: planDays(end, baseline.end), currentEnd: baseline.currentEnd,
    issues, rows: calculated, criticalIds: [...criticalIds], cpmComplete: Boolean(end), floatCalendar: 'calendar', phases, accepted: physical.filter((s) => s.status === 'accepted').length, total: physical.length };
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
