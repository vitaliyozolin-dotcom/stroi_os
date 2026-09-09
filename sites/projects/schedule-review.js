import { planToday, planDays, validPlanDate } from '../lib/plan-baseline.js';
import { schedulePayload, sitePayload } from '../lib/schedule-forecast.js';
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const text = (v, max = 2000) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

export function validateScheduleReview(previous, next, identity, now = new Date().toISOString()) {
  const manager = identity.role === 'management', today = planToday(new Date(now));
  const beforeById = new Map((previous?.stages ?? []).map((s) => [s.id, s]));
  const byId = new Map((next.stages ?? []).map((s) => [s.id, s]));
  for (const stage of next.stages ?? []) {
    const before = beforeById.get(stage.id), history = [...(before?.scheduleHistory ?? [])];
    if (stage.schedule === undefined && before?.schedule) stage.schedule = structuredClone(before.schedule);
    if (stage.siteUpdate === undefined && before?.siteUpdate) stage.siteUpdate = structuredClone(before.siteUpdate);
    if (!manager && before?.schedule && ['status', 'actualStart', 'completedOn', 'completionNote', 'blocker'].some((key) => !same(stage[key], before[key]))
      && (!identity.id || identity.id !== before.schedule.reporterId)) return 'Состояние этой работы подтверждает назначенный сотрудник или управление.';
    const structureChanged = !same(schedulePayload(stage.schedule), schedulePayload(before?.schedule));
    if (structureChanged) {
      if (!manager || !stage.schedule) return 'Структуру ППР, связи, календари и ресурсы изменяет управление; удалить сверку нельзя.';
      const s = schedulePayload(stage.schedule);
      if (!['work', 'supply', 'control', 'summary'].includes(s.kind) || !text(s.phase, 100) || !['daily', 'weekdays', 'six-day'].includes(s.calendar)
        || !Array.isArray(s.summaryOf) || !Array.isArray(s.dependencies) || !Array.isArray(s.daysOff) || s.daysOff.length > 366
        || typeof s.crew !== 'string' || s.crew.length > 100 || typeof s.reporterId !== 'string') return 'Заполните тип строки, крупный этап и календарь.';
      if (s.reporterId && !(next.settings?.users ?? []).some((u) => u.id === s.reporterId && u.status === 'active' && ['management', 'foreman'].includes(u.role))) return 'Выберите действующего сотрудника для подтверждения сведений.';
      if (s.kind === 'summary' && (!s.summaryOf.length || s.dependencies.length) || s.kind !== 'summary' && s.summaryOf.length) return 'Сводная строка объединяет работы без собственной длительности и связей; связи задаются вложенным работам.';
      if (s.summaryOf.length > byId.size || new Set(s.summaryOf).size !== s.summaryOf.length || s.summaryOf.some((id) => !byId.has(id) || id === stage.id || byId.get(id).schedule?.kind === 'summary')) return 'Сводная строка должна ссылаться на разные существующие работы, а не на другую сводную строку.';
      if (s.dependencies.length > byId.size || new Set(s.dependencies.map((d) => d?.stageId)).size !== s.dependencies.length
        || s.dependencies.some((d) => !d || !byId.has(d.stageId) || d.stageId === stage.id || !['completed', 'accepted'].includes(d.gate) || !Number.isInteger(d.lagDays) || d.lagDays < 0 || d.lagDays > 365)) return 'Проверьте предшественников, условие выполнения/приёмки и календарный лаг от 0 до 365 дней.';
      if (s.daysOff.some((day) => !validPlanDate(day)) || new Set(s.daysOff).size !== s.daysOff.length) return 'Исключения календаря должны быть уникальными существующими датами.';
      stage.schedule = { ...s, phase: s.phase.trim(), crew: s.crew.trim(), updatedAt: now, updatedBy: identity.name };
      history.push({ at: now, actor: identity.name, kind: 'structure', note: `Структура ППР: ${s.phase}; ${s.kind}; связей: ${s.dependencies.length}; ресурс: ${s.crew || 'не указан'}`, before: schedulePayload(before?.schedule), after: schedulePayload(stage.schedule) });
    } else if (before?.schedule) stage.schedule = structuredClone(before.schedule);
    else if (stage.schedule != null) return 'Не удалось проверить структуру ППР.';
    const payloadChanged = !same(sitePayload(stage.siteUpdate), sitePayload(before?.siteUpdate));
    const request = stage.siteUpdate?.requestId;
    const confirmation = typeof request === 'string' && request.length >= 8 && request.length <= 80 && request !== before?.siteUpdate?.confirmationId;
    if (payloadChanged || confirmation) {
      if (!manager && (!identity.id || identity.role !== 'foreman' || identity.id !== before?.schedule?.reporterId)) return 'Сверять эту работу может только назначенный сотрудник или управление.';
      if (!stage.schedule || !confirmation) return 'Для сохранения сведений подтвердите сверку явно; исходную запись удалить нельзя.';
      const u = sitePayload(stage.siteUpdate), finished = ['accepted', 'awaiting_inspection'].includes(stage.status) || stage.schedule.kind === 'summary';
      if (!validPlanDate(u.asOf) || u.asOf > today || !validPlanDate(u.reviewOn) || u.reviewOn < today || u.reviewOn < u.asOf
        || !validPlanDate(u.readyOn) || !text(u.note) || typeof u.nextAction !== 'string' || u.nextAction.length > 1000 || typeof u.issueOwner !== 'string' || u.issueOwner.length > 120) return 'Укажите срез на конец прошедшего/сегодняшнего дня, следующую сверку, доступность и основание.';
      if (planDays(today, u.asOf) > 7 || planDays(u.reviewOn, u.asOf) > 7) return 'Сведения для прогноза проверяются не реже раза в 7 календарных дней.';
      if (!finished && (!Number.isInteger(u.remainingDays) || u.remainingDays < 1 || u.remainingDays > 730)) return 'Остаток — от 1 до 730 рабочих дней. Завершение фиксируется отдельно.';
      if (finished && u.remainingDays !== null) return 'Для выполненной или сводной строки остаток не указывается.';
      if (u.acceptanceOn && (!validPlanDate(u.acceptanceOn) || u.acceptanceOn < today || stage.completedOn && u.acceptanceOn < stage.completedOn)) return 'Ожидаемая приёмка должна быть не раньше сегодня и выполнения.';
      if (stage.blocker && (!text(u.nextAction, 1000) || !text(u.issueOwner, 120))) return 'Для задержки нужны ближайшее действие и ответственный за решение.';
      stage.siteUpdate = { ...u, note: u.note.trim(), requestId: undefined, confirmationId: request, confirmedStatus: stage.status, confirmedBlocker: stage.blocker || '',
        confirmedFacts: JSON.stringify([stage.actualStart || '', stage.completedOn || '', stage.actualEnd || '', stage.acceptedAt || '']),
        confirmedSchedule: JSON.stringify(schedulePayload(stage.schedule)), updatedAt: now, updatedBy: identity.name };
      history.push({ at: now, actor: identity.name, kind: 'site', note: `Сверка на ${u.asOf}: ${u.note}`, before: sitePayload(before?.siteUpdate), after: sitePayload(stage.siteUpdate) });
    } else if (before?.siteUpdate) stage.siteUpdate = structuredClone(before.siteUpdate);
    else if (stage.siteUpdate != null) return 'Не удалось проверить подтверждение сведений.';
    if (history.length || before?.scheduleHistory) stage.scheduleHistory = history;
    else delete stage.scheduleHistory;
  }
  const visited = new Set(), visiting = new Set(), membership = new Map();
  const visit = (id) => {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    const s = byId.get(id)?.schedule;
    for (const target of [...(s?.summaryOf ?? []), ...(s?.dependencies ?? []).map((d) => d.stageId)]) if (!byId.has(target) || !visit(target)) return false;
    visiting.delete(id); visited.add(id); return true;
  };
  for (const stage of next.stages ?? []) {
    if (!visit(stage.id)) return 'В структуре и связях ППР есть цикл или отсутствующая работа.';
    for (const id of stage.schedule?.summaryOf ?? []) {
      if (byId.get(id)?.schedule?.kind === 'summary' || membership.has(id)) return 'Работа входит только в одну сводную строку; вложенные сводные строки не поддерживаются.';
      membership.set(id, stage.id);
    }
  }
  for (const before of beforeById.values()) if ((before.schedule || before.siteUpdate) && !byId.has(before.id)) return 'Строку со сверкой нельзя удалить вместе с историей.';
  return null;
}
