import type { CheckpointStatus, ProjectTask, TaskStatus, ActivityEvent } from '../entities/index';
import type { MutationContext } from './change';
import type { ConstructionSnapshot, ConstructionPatch } from './contexts';
export interface ConstructionMutation { patch: ConstructionPatch; action: string; summary: string; event?: ActivityEvent }

const event = (context: MutationContext, text: string, tone: ActivityEvent['tone']): ActivityEvent => ({ id: context.nextId('activity'), timestamp: context.timestamp, actor: context.actor, text, tone });
const change = (input: { patch: ConstructionPatch; action: string; summary: string; tone?: ActivityEvent['tone']; recordActivity?: boolean }, context: MutationContext): ConstructionMutation => ({ patch: input.patch, action: input.action, summary: input.summary, event: input.recordActivity === false ? undefined : event(context, input.summary, input.tone ?? 'neutral') });

export const saveTask = (
  state: ConstructionSnapshot,
  input: { task: ProjectTask; isNew: boolean },
  context: MutationContext,
): ConstructionMutation => {
  const task = input.task;
  const summary = `${input.isNew ? 'Создана' : 'Обновлена'} задача «${task.title}»${input.isNew ? ` · ответственный ${task.assigneeName}` : ''}`;
  return change({
    patch: { tasks: input.isNew ? [task, ...state.tasks] : state.tasks.map((item) => item.id === task.id ? task : item) },
    action: input.isNew ? 'task_created' : 'task_updated',
    summary,
  }, context);
};

export const addTaskComment = (
  state: ConstructionSnapshot,
  input: { taskId: string; text: string },
  context: MutationContext,
): ConstructionMutation => {
  const task = state.tasks.find((item) => item.id === input.taskId);
  if (!task) throw new Error('task_not_found');
  const updated: ProjectTask = {
    ...task,
    updatedAt: context.timestamp,
    history: [{ id: context.nextId('task-history'), timestamp: context.timestamp, actor: context.actor, kind: 'comment', text: input.text }, ...task.history],
  };
  const summary = `Добавлен комментарий к задаче «${task.title}»`;
  return change({
    patch: { tasks: state.tasks.map((item) => item.id === task.id ? updated : item) },
    action: 'task_comment_added',
    summary,
  }, context);
};

export const changeTaskStatus = (state: ConstructionSnapshot, input: { taskId: string; status: TaskStatus; text: string; extra?: Partial<ProjectTask> }, context: MutationContext): ConstructionMutation => {
  const task = state.tasks.find((item) => item.id === input.taskId);
  if (!task) throw new Error('task_not_found');
  const historyKind = input.status === 'done' ? 'completed' : task.status === 'done' ? 'reopened' : 'status';
  const updated: ProjectTask = {
    ...task,
    ...(input.extra && Object.hasOwn(input.extra, 'completionNote') ? { completionNote: input.extra.completionNote } : {}),
    ...(input.extra && Object.hasOwn(input.extra, 'blockerReason') ? { blockerReason: input.extra.blockerReason } : {}),
    status: input.status,
    updatedAt: context.timestamp,
    completedAt: input.status === 'done' ? context.timestamp : input.status === 'canceled' ? task.completedAt : undefined,
    history: [{ id: context.nextId('task-history'), timestamp: context.timestamp, actor: context.actor, kind: historyKind, text: input.text }, ...task.history],
  };
  const summary = `${input.text}: «${task.title}»`;
  return {
    patch: { tasks: state.tasks.map((item) => item.id === task.id ? updated : item) }, event: event(context, summary, input.status === 'done' ? 'positive' : input.status === 'waiting' ? 'warning' : 'neutral'),
    action: 'task_status_changed',
    summary,
  };
};

export const changeCheckpoint = (state: ConstructionSnapshot, input: { checkpointId: string; patch: Partial<ConstructionSnapshot['checkpoints'][number]>; summary: string; tone?: 'neutral' | 'positive' | 'warning'; recordActivity?: boolean }, context: MutationContext): ConstructionMutation => {
  if (!state.checkpoints.some((item) => item.id === input.checkpointId)) throw new Error('checkpoint_not_found');
  return {
    patch: { checkpoints: state.checkpoints.map((item) => item.id === input.checkpointId ? { ...item, ...input.patch } : item) }, event: input.recordActivity === false ? undefined : event(context, input.summary, input.tone ?? 'neutral'),
    action: `checkpoint_${String((input.patch.status as CheckpointStatus | undefined) ?? 'updated')}`,
    summary: input.summary,
  };
};
