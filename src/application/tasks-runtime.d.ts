import type { ProjectTask, TaskPriority, TaskStatus } from '../entities/index';
import type { ConstructionSnapshot, ConstructionPatch } from '../domain/contexts';
import type { ModuleContext, ModuleRepository, ModuleResult } from './module-repository';
export interface TaskDraft { title: string; description: string; priority: TaskPriority; assigneeId: string; reviewerId: string; dueDate: string; plannedStart: string; baselineEnd: string; baselineNote: string; reason: string; stageId: string; counterpartyId: string; procurementItemId: string; checkpointId: string }
export function taskSnapshot(state: Pick<ConstructionSnapshot, 'project' | 'tasks'>, taskId?: string): string;
export function createTaskUseCases(repository: ModuleRepository<ConstructionSnapshot, ConstructionPatch>, context: ModuleContext, channel?: 'web' | 'telegram'): {
 save(input: { taskId?: string; sourceDraftId?: string; expected: string; draft: TaskDraft }): ModuleResult<ConstructionPatch>;
 status(input: { taskId: string; expected: string; status: TaskStatus; text: string; extra?: Pick<Partial<ProjectTask>, 'completionNote' | 'blockerReason'>; callbackId?: string }): ModuleResult<ConstructionPatch>;
 comment(input: { taskId: string; expected: string; text: string }): ModuleResult<ConstructionPatch>;
};
