/** Pure project coordination rules; used by existing transactional automations. */
const active = status => !['done', 'canceled'].includes(status);
const cleanText = value => String(value ?? '').trim();

export const qualityShotTemplate = stage => {
  const name = `${stage?.name ?? ''} ${stage?.shortName ?? ''}`.toLocaleLowerCase('ru');
  if (/фундамент|сва[ийя]/u.test(name)) return ['Общий вид фундамента', 'Узлы и соединения основания', 'Контроль отметок и геометрии'];
  if (/кровл|крыш/u.test(name)) return ['Общий вид кровли', 'Примыкания и проходки', 'Узлы крепления и водоотвода'];
  if (/инженер|электр|водоснаб|канализ|отоплен/u.test(name)) return ['Трассы до закрытия конструкций', 'Соединения и маркировка', 'Результат предусмотренного испытания'];
  if (/контур|перекрыт|обвяз|каркас|sip|сип/u.test(name)) return ['Общий вид конструкций', 'Узлы креплений и соединений', 'Скрываемые слои до закрытия'];
  if (/отдел|фасад/u.test(name)) return ['Общий вид результата', 'Примыкания и качество поверхности'];
  // Unknown work requires the engineer to define its own checklist, not seven invented requirements.
  return [];
};

export const missingQualityShots = point => (point?.requiredShots ?? []).slice((point?.photos ?? []).length);

export const qualityRequestStillNeeded = (state, checkpointId) => {
  if (!state || ['archived', 'completed', 'workspace'].includes(state.project?.status)
    || ['on_hold', 'canceled', 'completed'].includes(state.orderRelations?.status)) return false;
  const point = (state.checkpoints ?? []).find(row => row.id === checkpointId);
  const stage = (state.stages ?? []).find(row => row.id === point?.stageId);
  return Boolean(point && point.status !== 'accepted' && stage && ['in_progress', 'awaiting_inspection', 'rework', 'blocked'].includes(stage.status) && missingQualityShots(point).length);
};

export const buildMeetingBrief = (state, { userId, management = false, today = new Date().toISOString().slice(0, 10), limit = 8 } = {}) => {
  const tasks = (state.tasks ?? []).filter(task => active(task.status))
    .filter(task => management || task.assigneeId === userId)
    .sort((a, b) => {
      const score = t => Number(Boolean(t.blocker) || t.status === 'waiting') * 4 + Number(Boolean(t.dueDate) && t.dueDate < today) * 3 + Number(t.priority === 'high');
      return score(b) - score(a) || (a.dueDate || '9999').localeCompare(b.dueDate || '9999');
    });
  const rows = tasks.slice(0, limit).map(task => `${state.project?.code || 'Объект'} · ${cleanText(task.assigneeName) || 'Ответственный не назначен'} — ${cleanText(task.title)} — ${task.dueDate || 'срок не определён'}${task.dueDate && task.dueDate < today ? ' · просрочено' : task.status === 'waiting' ? ' · ожидание' : ''}`);
  return { rows, remaining: Math.max(0, tasks.length - rows.length) };
};

export const buildMissingMeetingUpdates = (state, options = {}) => {
  const tasks = (state.tasks ?? []).filter(task => active(task.status))
    .filter(task => options.management || task.assigneeId === options.userId)
    .filter(task => !cleanText(task.assigneeId) || !cleanText(task.dueDate));
  return tasks.slice(0, options.limit ?? 8).map(task => `${state.project?.code || 'Объект'} · ${task.title}: ${[!cleanText(task.assigneeId) && 'кто отвечает', !cleanText(task.dueDate) && 'какой срок'].filter(Boolean).join(', ')}?`);
};
