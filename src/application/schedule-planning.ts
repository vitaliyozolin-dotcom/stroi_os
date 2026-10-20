import type { UserRole } from '../entities/index';
import { planStage, type StagePlanDraft } from '../domain/schedule-planning.ts';
import type { Clock, IdGenerator } from './ports.ts';
import type { ConstructionSnapshot, ConstructionPatch } from '../domain/contexts.ts';
import { moduleChange, executeModule, type ModuleChange, type ModuleRepository } from './module-repository.ts';
export interface EditStagePlanInput { stageId: string; expected: string; draft: StagePlanDraft }
export const editProjectStagePlan = (state: ConstructionSnapshot, input: EditStagePlanInput, identity: { name: string; role: UserRole }, clock: Clock, ids: IdGenerator): { ok: true; change: ModuleChange<ConstructionPatch> | null } | { ok: false; error: string } => {
  if (identity.role !== 'management') return { ok: false, error: 'Изменение графика недоступно для этой роли.' };
  const result = planStage(state, input.stageId, input.draft, input.expected);
  if (!result.ok) return result;
  if (!result.changed) return { ok: true, change: null };
  return { ok: true, change: moduleChange(state, { stages: result.stages }, 'schedule_updated', result.summary, { identity, clock, ids }, result.tone) };
};
export const createSchedulePlanningUseCases = (repository: ModuleRepository<ConstructionSnapshot, ConstructionPatch>, identity: { name: string; role: UserRole }, clock: Clock, ids: IdGenerator) => ({
 editPlan: (input: EditStagePlanInput) => executeModule(repository, state => editProjectStagePlan(state, input, identity, clock, ids)),
});
