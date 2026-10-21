import type { ProjectTask, TaskStatus } from '../entities/index';
import type { ConstructionSnapshot } from './contexts';
import type { MutationContext } from './change';
import type { ConstructionMutation } from './mutations';
export type { ConstructionMutation } from './mutations';
export function saveTask(state: ConstructionSnapshot, input: { task: ProjectTask; isNew: boolean }, context: MutationContext): ConstructionMutation;
export function addTaskComment(state: ConstructionSnapshot, input: { taskId: string; text: string }, context: MutationContext): ConstructionMutation;
export function changeTaskStatus(state: ConstructionSnapshot, input: { taskId: string; status: TaskStatus; text: string; extra?: Partial<ProjectTask>; source?: 'web' | 'telegram'; callbackId?: string }, context: MutationContext): ConstructionMutation;
