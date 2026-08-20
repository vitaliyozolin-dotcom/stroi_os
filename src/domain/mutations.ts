import type { AppState, CheckpointStatus, ProjectTask, TaskStatus } from '../entities/index';
import type { MutationContext, StateChange } from './change';

const addActivity = (state: AppState, context: MutationContext, text: string, tone: 'neutral' | 'positive' | 'warning') => [
  { id: context.nextId('activity'), timestamp: context.timestamp, actor: context.actor, text, tone },
  ...state.activity,
];

export const changeProjectState = (
  state: AppState,
  input: {
    patch: Partial<AppState>;
    action: string;
    summary: string;
    tone?: 'neutral' | 'positive' | 'warning';
    recordActivity?: boolean;
  },
  context: MutationContext,
): StateChange => ({
  state: {
    ...state,
    ...input.patch,
    activity: input.recordActivity === false
      ? state.activity
      : addActivity(state, context, input.summary, input.tone ?? 'neutral'),
  },
  action: input.action,
  summary: input.summary,
});

export const saveTask = (
  state: AppState,
  input: { task: ProjectTask; isNew: boolean },
  context: MutationContext,
): StateChange => {
  const task = input.task;
  const summary = `${input.isNew ? 'Создана' : 'Обновлена'} задача «${task.title}»${input.isNew ? ` · ответственный ${task.assigneeName}` : ''}`;
  return changeProjectState(state, {
    patch: { tasks: input.isNew ? [task, ...state.tasks] : state.tasks.map((item) => item.id === task.id ? task : item) },
    action: input.isNew ? 'task_created' : 'task_updated',
    summary,
  }, context);
};

export const addTaskComment = (
  state: AppState,
  input: { taskId: string; text: string },
  context: MutationContext,
): StateChange => {
  const task = state.tasks.find((item) => item.id === input.taskId);
  if (!task) throw new Error('task_not_found');
  const updated: ProjectTask = {
    ...task,
    updatedAt: context.timestamp,
    history: [{ id: context.nextId('task-history'), timestamp: context.timestamp, actor: context.actor, kind: 'comment', text: input.text }, ...task.history],
  };
  const summary = `Добавлен комментарий к задаче «${task.title}»`;
  return changeProjectState(state, {
    patch: { tasks: state.tasks.map((item) => item.id === task.id ? updated : item) },
    action: 'task_comment_added',
    summary,
  }, context);
};

export const changeTaskStatus = (state: AppState, input: { taskId: string; status: TaskStatus; text: string; extra?: Partial<ProjectTask> }, context: MutationContext): StateChange => {
  const task = state.tasks.find((item) => item.id === input.taskId);
  if (!task) throw new Error('task_not_found');
  const historyKind = input.status === 'done' ? 'completed' : task.status === 'done' ? 'reopened' : 'status';
  const updated: ProjectTask = {
    ...task,
    ...input.extra,
    status: input.status,
    updatedAt: context.timestamp,
    completedAt: input.status === 'done' ? context.timestamp : input.status === 'canceled' ? task.completedAt : undefined,
    history: [{ id: context.nextId('task-history'), timestamp: context.timestamp, actor: context.actor, kind: historyKind, text: input.text }, ...task.history],
  };
  const summary = `${input.text}: «${task.title}»`;
  return {
    state: { ...state, tasks: state.tasks.map((item) => item.id === task.id ? updated : item), activity: addActivity(state, context, summary, input.status === 'done' ? 'positive' : input.status === 'waiting' ? 'warning' : 'neutral') },
    action: 'task_status_changed',
    summary,
  };
};

export const changeCheckpoint = (state: AppState, input: { checkpointId: string; patch: Partial<AppState['checkpoints'][number]>; summary: string; tone?: 'neutral' | 'positive' | 'warning'; recordActivity?: boolean }, context: MutationContext): StateChange => {
  if (!state.checkpoints.some((item) => item.id === input.checkpointId)) throw new Error('checkpoint_not_found');
  return {
    state: { ...state, checkpoints: state.checkpoints.map((item) => item.id === input.checkpointId ? { ...item, ...input.patch } : item), activity: input.recordActivity === false ? state.activity : addActivity(state, context, input.summary, input.tone ?? 'neutral') },
    action: `checkpoint_${String((input.patch.status as CheckpointStatus | undefined) ?? 'updated')}`,
    summary: input.summary,
  };
};
