import { transitionProcurement, type ProcurementWorkflowInput } from '../domain/procurement-workflow.ts';
import type { UserRole } from '../entities/index';
import { prepareRequirement, type RequirementDraft } from '../domain/procurement.ts';
import type { SupplySnapshot, SupplyPatch } from '../domain/contexts.ts';
import { moduleChange, executeModule, type ModuleChange, type ModuleRepository } from './module-repository.ts';
import type { Clock, IdGenerator } from './ports.ts';

export interface CreateRequirementInput { projectId: string; draft: RequirementDraft }
export type ProcurementCommandResult = { ok: true; change: ModuleChange<SupplyPatch> } | { ok: false; error: string };

export const createProjectRequirement = (state: SupplySnapshot, input: CreateRequirementInput, identity: { name: string; role: UserRole }, clock: Clock, ids: IdGenerator): ProcurementCommandResult => {
  if (!['management', 'foreman'].includes(identity.role)) return { ok: false, error: 'Создание потребности недоступно для этой роли.' };
  if (input.projectId !== state.project.id) return { ok: false, error: 'Проект изменился. Закройте форму и откройте её заново.' };
  const result = prepareRequirement(state, input.draft, ids.next('supply'), identity.name);
  if (!result.ok) return result;
  const summary = `Создана потребность: ${result.item.item}`;
  return { ok: true, change: moduleChange(state, { procurement: [result.item, ...state.procurement] }, 'procurement_updated', summary, { identity, clock, ids }) };
};

export const changeProjectProcurement = (state: SupplySnapshot, input: ProcurementWorkflowInput, identity: { name: string; role: UserRole }, clock: Clock, ids: IdGenerator): { ok: true; change: ModuleChange<SupplyPatch> | null } | { ok: false; error: string } => {
  if (!['management', 'foreman'].includes(identity.role)) return { ok: false, error: 'Изменение снабжения недоступно для этой роли.' };
  const timestamp = clock.now();
  const result = transitionProcurement(state, input, timestamp, input.action === 'quote' ? ids.next('quote') : '');
  if (!result.ok) return result;
  if (!result.changed) return { ok: true, change: null };
  return { ok: true, change: moduleChange(state, result.patch, 'procurement_updated', result.summary, { identity, clock: { now: () => timestamp }, ids }, result.tone) };
};

export const createProcurementUseCases = (repository: ModuleRepository<SupplySnapshot, SupplyPatch>, identity: { name: string; role: UserRole }, clock: Clock, ids: IdGenerator) => ({
  change: (input: ProcurementWorkflowInput) => executeModule(repository, state => changeProjectProcurement(state, input, identity, clock, ids)),
  createRequirement: (input: CreateRequirementInput) => executeModule(repository, state => createProjectRequirement(state, input, identity, clock, ids)),
});
