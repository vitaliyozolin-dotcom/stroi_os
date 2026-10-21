const event = (context, text, tone) => ({ id: context.nextId('activity'), timestamp: context.timestamp, actor: context.actor, text, tone });
const change = (input, context) => ({ patch: input.patch, action: input.action, summary: input.summary, event: input.recordActivity === false ? undefined : event(context, input.summary, input.tone ?? 'neutral') });

export const saveTask = (
  state,
  input,
  context,
) => {
  const task = input.task;
  const summary = `${input.isNew ? 'Создана' : 'Обновлена'} задача «${task.title}»${input.isNew ? ` · ответственный ${task.assigneeName}` : ''}`;
  return change({
    patch: { tasks: input.isNew ? [task, ...state.tasks] : state.tasks.map((item) => item.id === task.id ? task : item) },
    action: input.isNew ? 'task_created' : 'task_updated',
    summary,
  }, context);
};

export const addTaskComment = (
  state,
  input,
  context,
) => {
  const task = state.tasks.find((item) => item.id === input.taskId);
  if (!task) throw new Error('task_not_found');
  const updated = {
    ...task,
    updatedAt: context.timestamp,
    history: [{ id: context.nextId('task-history'), timestamp: context.timestamp, actor: context.actor, kind: 'comment', text: input.text }, ...(task.history ?? [])],
  };
  const summary = `Добавлен комментарий к задаче «${task.title}»`;
  return change({
    patch: { tasks: state.tasks.map((item) => item.id === task.id ? updated : item) },
    action: 'task_comment_added',
    summary,
  }, context);
};

export const changeTaskStatus = (state, input, context) => {
  const task = state.tasks.find((item) => item.id === input.taskId);
  if (!task) throw new Error('task_not_found');
  const historyKind = input.source === 'telegram' ? (input.status === 'done' ? 'completed' : 'status') : input.status === 'done' ? 'completed' : task.status === 'done' ? 'reopened' : 'status';
  const updated = {
    ...task,
    ...(input.extra && Object.hasOwn(input.extra, 'completionNote') ? { completionNote: input.extra.completionNote } : {}),
    ...(input.extra && Object.hasOwn(input.extra, 'blockerReason') ? { blockerReason: input.extra.blockerReason } : {}),
    status: input.status,
    updatedAt: context.timestamp,
    completedAt: input.status === 'done' ? context.timestamp : input.source === 'telegram' || input.status === 'canceled' ? task.completedAt : undefined,
    history: [{ id: context.nextId('task-history'), timestamp: context.timestamp, actor: context.actor, kind: historyKind, text: input.text, ...(input.callbackId ? { sourceTelegramCallbackId: input.callbackId } : {}) }, ...(task.history ?? [])],
  };
  const summary = `${input.text}: «${task.title}»`;
  return {
    patch: { tasks: state.tasks.map((item) => item.id === task.id ? updated : item) }, event: event(context, summary, input.status === 'done' ? 'positive' : input.status === 'waiting' ? 'warning' : 'neutral'),
    action: 'task_status_changed',
    summary,
  };
};
