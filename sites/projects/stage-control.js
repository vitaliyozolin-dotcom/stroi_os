import { planToday, validPlanDate } from '../lib/plan-baseline.js';
import { stageGaps, stageCanStart } from '../lib/stage-control.js';
import { validateScheduleReview } from './schedule-review.js';
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const text = (v) => typeof v === 'string' ? v.trim() : '';
export function validateStageControl(previous, next, identity, now = new Date().toISOString()) {
  const reviewError = validateScheduleReview(previous, next, identity, now);
  if (reviewError) return reviewError;
  if (!previous) return next.stages?.some(s => s.ownerAcceptance) ? 'Подтверждение владельца записывается в существующий этап.' : null;
  const manager = identity.role === 'management', today = planToday(new Date(now));
  const oldProgress = previous.project.siteProgressHistory ?? [], progress = next.project.siteProgressHistory ?? [];
  if (!Array.isArray(progress) || progress.length < oldProgress.length || progress.length > oldProgress.length + 1
    || oldProgress.some((row, i) => !same(row, progress[i]))) return 'История состояния объекта сохраняется; добавьте новую запись.';
  if (progress.length > oldProgress.length) {
    const row = progress.at(-1);
    if (!manager || !row || !text(row.id) || oldProgress.some(old => old.id === row.id)
      || !validPlanDate(row.asOf) || row.asOf > today || oldProgress.at(-1)?.asOf > row.asOf
      || !text(row.source) || row.source.length > 500
      || ![row.completed, row.remaining].every(list => Array.isArray(list) && list.length <= 50 && list.every(item => text(item) && item.length <= 250))
      || !row.completed.length && !row.remaining.length) return 'Управление записывает актуальное состояние с датой, источником и списком работ.';
    row.recordedAt = now; row.recordedBy = identity.name;
  }
  const oldStages = new Map((previous.stages ?? []).map((s) => [s.id, s]));
  const project = next.project, oldProject = previous.project;
  const newForecast = project.workForecastDate !== oldProject.workForecastDate || project.workForecastUpdatedAt !== oldProject.workForecastUpdatedAt;
  if (newForecast) {
    if (!manager || !validPlanDate(project.workForecastDate) || project.workForecastDate < today || !text(project.workForecastNote)) return 'Прогноз работ подтверждает управление: нужны дата и основание.';
    project.workForecastUpdatedAt = now; project.workForecastUpdatedBy = identity.name;
  } else { project.workForecastUpdatedAt = oldProject.workForecastUpdatedAt; project.workForecastUpdatedBy = oldProject.workForecastUpdatedBy; }
  for (const stage of next.stages ?? []) {
    const before = oldStages.get(stage.id);
    if (!before) { if (!manager || stage.status === 'accepted' || stage.ownerAcceptance) return 'Новый этап добавляет управление без подстановки приёмки.'; continue; }
    const statusChanged = stage.status !== before.status;
    const ownerAccepts = Boolean(stage.ownerAcceptance && !before.ownerAcceptance);
    if (before.ownerAcceptance && !same(stage.ownerAcceptance, before.ownerAcceptance)) return 'Сохранённое подтверждение владельца нельзя переписать.';
    if (ownerAccepts) {
      if (!manager || identity.isOwner !== true || !statusChanged || stage.status !== 'accepted' || stage.schedule?.kind === 'summary'
        || !text(stage.ownerAcceptance.note) || stage.ownerAcceptance.note.length > 2000) return 'Владелец лично подтверждает выполнение отдельного этапа.';
      const gaps = stageGaps(next, stage.id);
      stage.ownerAcceptance = { note: text(stage.ownerAcceptance.note), at: now, by: identity.name,
        pendingTaskIds: gaps.tasks.map(t => t.id), pendingCheckpointIds: gaps.checkpoints.map(p => p.id) };
      stage.acceptedAt = now;
      stage.statusNote = `Подтверждение владельца: ${stage.ownerAcceptance.note}`;
    }
    if (!same(stage.completionObservedOn, before.completionObservedOn)) {
      if (stage.status === 'rework' && !stage.completionObservedOn && manager) { /* explicit reopening retains the earlier status history */ }
      else if (!manager || before.completionObservedOn || before.completedOn || stage.completedOn || !statusChanged || !(stage.status === 'awaiting_inspection' || ownerAccepts)
        || !validPlanDate(stage.completionObservedOn) || stage.completionObservedOn > today
        || stage.actualStart && stage.completionObservedOn < stage.actualStart || !text(stage.completionNote)
        || stage.schedule?.kind === 'summary') return 'Для готовности без точной даты нужны дата наблюдения и подтверждение управления.';
    }
    const recovering = manager && text(stage.factRecoveryNote) && ['accepted', 'awaiting_inspection'].includes(before.status) && !statusChanged;
    const fillingFact = (key) => recovering && ['completedOn', 'actualEnd', 'acceptedAt'].includes(key) && !before[key];
    if (stage.factRecoveryNote && (!recovering || typeof stage.factRecoveryNote !== 'string' || stage.factRecoveryNote.length > 2000)) return 'Неизвестные фактические даты выполненной работы уточняет управление с основанием до 2000 символов.';
    if (!statusChanged && ['accepted', 'awaiting_inspection'].includes(before.status) && !before.completedOn && stage.completedOn && !recovering) return 'Неизвестную дату уже выполненной работы уточняет управление с указанием источника.';
    if (recovering && !same(stage.completionNote, before.completionNote)) return 'Уточнение даты не переписывает уже сохранённое подтверждение выполнения.';
    if (before.schedule && ['dependency', 'dependencyId'].some((key) => !same(stage[key], before[key]))) return 'Связи сверенного ППР изменяются в структуре, а не в старом поле предшественника.';
    if (statusChanged && stage.status === 'not_ready' && (before.actualStart || before.completedOn)) return 'Работу с зафиксированным началом или выполнением нельзя отметить как не начатую.';
    if (!manager && statusChanged && stage.status === 'rework') return 'Возвращает этап на доработку управление.';
    if (!manager && ['actualEnd', 'acceptedAt', 'acceptedBy', 'dependency', 'dependencyId', 'responsibleId'].some((key) => !same(stage[key], before[key]))) return 'Приёмку и зависимости изменяет управление.';
    if (before.status === 'accepted' && ['status', 'actualEnd', 'actualStart', 'completedOn', 'completionNote', 'acceptedAt', 'acceptedBy'].some((key) => !same(stage[key], before[key]) && !fillingFact(key))) return 'Сохранённую приёмку нельзя переписать.';
    if (stage.status !== 'accepted' && ['actualEnd', 'acceptedAt', 'acceptedBy'].some((key) => !same(stage[key], before[key]))) return 'Факт приёмки записывается только при принятии этапа.';
    for (const key of ['actualStart', 'completedOn', 'actualEnd']) if (!same(stage[key], before[key]) && stage[key] && (!validPlanDate(stage[key]) || stage[key] > today)) return 'Фактическая дата должна существовать и не быть в будущем.';
    if (before.actualStart && stage.actualStart !== before.actualStart) return 'Зафиксированное начало нельзя удалить или переписать.';
    if (before.completedOn && !stage.completedOn && stage.status !== 'rework') return 'Дата выполнения сохраняется; для повторной работы верните этап на доработку.';
    if (before.completedOn && stage.completedOn && stage.completedOn !== before.completedOn) return 'Дата выполнения уже зафиксирована. Повторную работу оформите через доработку.';
    if (ownerAccepts && stage.completionObservedOn && stage.completedOn && stage.completedOn > stage.completionObservedOn) return 'Работа уже была готова на дату наблюдения; точное завершение не может быть позже.';
    if (recovering) {
      if (!validPlanDate(stage.completedOn) || stage.completedOn > today || stage.actualEnd && stage.actualEnd !== stage.completedOn) return 'Дата выполнения должна существовать, не быть в будущем и совпадать с уже известным фактом.';
      if (stage.completionObservedOn && stage.completedOn > stage.completionObservedOn) return 'Работа уже была готова на дату наблюдения; точное завершение не может быть позже.';
      if (stage.acceptedAt) {
        const acceptedOn = Number.isFinite(Date.parse(stage.acceptedAt)) ? planToday(new Date(stage.acceptedAt)) : '';
        if (!validPlanDate(acceptedOn) || acceptedOn < stage.completedOn || acceptedOn > today) return 'Уточнённая дата приёмки — между выполнением и сегодняшним днём.';
      }
      stage.statusNote = `Уточнение неизвестного факта: ${text(stage.factRecoveryNote)}`;
    }
    if (stage.dependencyId && stage.dependencyId !== before.dependencyId) {
      const visited = new Set([stage.id]); let current = stage;
      while (current.dependencyId) {
        if (visited.has(current.dependencyId)) return 'В зависимостях этапов обнаружен круг.';
        visited.add(current.dependencyId); current = (next.stages ?? []).find((s) => s.id === current.dependencyId);
        if (!current) return 'Предшествующий этап не найден.';
      }
    }
    if (stage.actualStart && stage.completedOn && stage.completedOn < stage.actualStart) return 'Выполнение не может быть раньше начала.';
    if (statusChanged && !(stage.status === 'ready' && stageCanStart(next, stage)) && !text(stage.statusNote)) return 'Укажите результат или причину изменения этапа.';
    if (statusChanged && !['not_ready', 'ready', 'in_progress', 'blocked', 'awaiting_inspection', 'accepted', 'rework'].includes(stage.status)) return 'Неизвестный статус этапа.';
    if (statusChanged && ['awaiting_inspection', 'accepted'].includes(stage.status) && (!(validPlanDate(stage.completedOn) || (stage.status === 'awaiting_inspection' || ownerAccepts) && manager && validPlanDate(stage.completionObservedOn)) || !text(stage.completionNote))) return 'Для завершения нужны фактическая дата или наблюдение управления и подтверждённый результат.';
    if ((statusChanged || recovering) && ['awaiting_inspection', 'accepted'].includes(stage.status) && stage.schedule?.kind === 'summary') {
      if (stage.schedule.summaryOf.some((id) => {
        const child = (next.stages ?? []).find((s) => s.id === id), end = child?.completedOn || child?.actualEnd;
        return !child || !['accepted', 'awaiting_inspection'].includes(child.status) || !validPlanDate(end) || end > stage.completedOn || stage.status === 'accepted' && child.status !== 'accepted';
      })) return 'Сначала подтвердите выполнение вложенных работ; для приёмки сводной строки должны быть приняты все вложенные работы.';
    }
    if (stage.forecastEnd !== before.forecastEnd || stage.forecastUpdatedAt !== before.forecastUpdatedAt) {
      if (!validPlanDate(stage.forecastEnd) || stage.forecastEnd < today || stage.forecastEnd < stage.planStart || !text(stage.forecastReason || stage.planChangeReason)) return 'Для прогноза этапа нужны актуальная дата и причина.';
      stage.forecastUpdatedAt = now; stage.forecastUpdatedBy = identity.name;
    } else { stage.forecastUpdatedAt = before.forecastUpdatedAt; stage.forecastUpdatedBy = before.forecastUpdatedBy; }
    if (statusChanged && stage.status === 'accepted') {
      if (!ownerAccepts && !validPlanDate(before.completedOn || before.actualEnd)) return 'До приёмки должна быть отдельно подтверждена фактическая дата выполнения.';
      const gaps = stageGaps(next, stage.id);
      if (!manager || !ownerAccepts && (gaps.tasks.length || gaps.checkpoints.length) || stage.blocker) return 'Принять этап можно после завершения задач и приёмки контрольных точек либо по личному подтверждению владельца.';
      for (const collection of ['tasks', 'checkpoints']) if ((previous[collection] ?? []).some((item) => item.stageId === stage.id && !(next[collection] ?? []).some((n) => n.id === item.id && n.stageId === stage.id))) return 'Нельзя убрать условия приёмки из этапа при его закрытии.';
      const acceptedOn = Number.isFinite(Date.parse(stage.acceptedAt || '')) ? planToday(new Date(stage.acceptedAt)) : '';
      if (!validPlanDate(acceptedOn) || acceptedOn > today || acceptedOn < (stage.completedOn || stage.completionObservedOn)) return 'Дата приёмки должна быть между выполнением и сегодняшним днём.';
      stage.acceptedBy = identity.name; stage.actualEnd = stage.completedOn;
    }
    const recordedChange = statusChanged || ['blocker', 'forecastEnd', 'actualStart', 'actualEnd', 'acceptedAt', 'completedOn', 'completionNote'].some((key) => !same(stage[key], before[key]));
    stage.statusHistory = [...(before.statusHistory ?? []), ...(recordedChange ? [{ at: now, actor: identity.name, status: stage.status, note: text(stage.statusNote || stage.forecastReason || stage.planChangeReason) || (stage.status === 'ready' ? 'Готов к началу по зависимости' : 'Уточнение этапа'), completedOn: stage.completedOn || before.completedOn || null, ...(stage.completionObservedOn ? { completionObservedOn: stage.completionObservedOn } : {}), ...(ownerAccepts ? { ownerAcceptance: structuredClone(stage.ownerAcceptance) } : {}) }] : [])];
    delete stage.statusNote;
    delete stage.factRecoveryNote;
  }
  for (const before of oldStages.values()) if (before.status === 'accepted' && !(next.stages ?? []).some((s) => s.id === before.id)) return 'Принятый этап нельзя удалить.';
  for (const point of next.checkpoints ?? []) {
    const before = (previous.checkpoints ?? []).find((p) => p.id === point.id);
    if (point.status === 'accepted' && before?.status !== 'accepted') {
      if (!manager || (point.photos ?? []).length < (before?.requiredShots ?? point.requiredShots ?? []).length) return 'Контрольную точку принимает управление после получения обязательных подтверждений.';
      point.acceptedAt = now;
    }
    if (before?.status === 'accepted' && point.status === 'accepted' && ['acceptedAt', 'photos', 'requiredShots', 'measurement'].some((k) => !same(before[k], point[k]))) return 'Принятые подтверждения нельзя переписывать.';
  }
  if (!manager) {
    for (const task of next.tasks ?? []) {
      const before = (previous.tasks ?? []).find((t) => t.id === task.id);
      if (before && (task.reviewerId !== before.reviewerId || task.stageId !== before.stageId || before.reviewerId && task.status === 'done' && before.status !== 'done')) return 'Отдельную проверку задачи нельзя обходить.';
      if (before && task.status === 'canceled' && before.status !== 'canceled') return 'Отмену задачи подтверждает управление.';
    }
    for (const before of previous.checkpoints ?? []) {
      const point = (next.checkpoints ?? []).find((p) => p.id === before.id);
      if (!point || point.stageId !== before.stageId || !same(point.requiredShots, before.requiredShots) || point.status === 'accepted' && before.status !== 'accepted') return 'Условия контроля и приёмку изменяет управление.';
    }
  }
  return null;
}
