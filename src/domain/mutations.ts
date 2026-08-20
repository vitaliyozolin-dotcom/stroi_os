import type { AppState, CheckpointStatus, ProjectTask, TaskStatus } from '../entities/index';
import type { MutationContext, StateChange } from './change';

const addActivity = (state: AppState, context: MutationContext, text: string, tone: 'neutral' | 'positive' | 'warning') => [
  { id: context.nextId('activity'), timestamp: context.timestamp, actor: context.actor, text, tone },
  ...state.activity,
];

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

export const changeCheckpoint = (state: AppState, input: { checkpointId: string; patch: Partial<AppState['checkpoints'][number]>; summary: string; tone?: 'neutral' | 'positive' | 'warning' }, context: MutationContext): StateChange => {
  if (!state.checkpoints.some((item) => item.id === input.checkpointId)) throw new Error('checkpoint_not_found');
  return {
    state: { ...state, checkpoints: state.checkpoints.map((item) => item.id === input.checkpointId ? { ...item, ...input.patch } : item), activity: addActivity(state, context, input.summary, input.tone ?? 'neutral') },
    action: `checkpoint_${String((input.patch.status as CheckpointStatus | undefined) ?? 'updated')}`,
    summary: input.summary,
  };
};
