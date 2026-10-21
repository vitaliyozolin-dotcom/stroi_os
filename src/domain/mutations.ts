import type { CheckpointStatus, ActivityEvent } from '../entities/index';
import type { MutationContext } from './change';
import type { ConstructionSnapshot, ConstructionPatch } from './contexts';
export interface ConstructionMutation { patch: ConstructionPatch; action: string; summary: string; event?: ActivityEvent }

const event = (context: MutationContext, text: string, tone: ActivityEvent['tone']): ActivityEvent => ({ id: context.nextId('activity'), timestamp: context.timestamp, actor: context.actor, text, tone });

export { saveTask, addTaskComment, changeTaskStatus } from './task-mutations.js';

export const changeCheckpoint = (state: ConstructionSnapshot, input: { checkpointId: string; patch: Partial<ConstructionSnapshot['checkpoints'][number]>; summary: string; tone?: 'neutral' | 'positive' | 'warning'; recordActivity?: boolean }, context: MutationContext): ConstructionMutation => {
  if (!state.checkpoints.some((item) => item.id === input.checkpointId)) throw new Error('checkpoint_not_found');
  return {
    patch: { checkpoints: state.checkpoints.map((item) => item.id === input.checkpointId ? { ...item, ...input.patch } : item) }, event: input.recordActivity === false ? undefined : event(context, input.summary, input.tone ?? 'neutral'),
    action: `checkpoint_${String((input.patch.status as CheckpointStatus | undefined) ?? 'updated')}`,
    summary: input.summary,
  };
};
