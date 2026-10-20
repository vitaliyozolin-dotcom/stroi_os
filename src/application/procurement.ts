import { transitionProcurement, type ProcurementWorkflowInput } from '../domain/procurement-workflow.ts';
import type { AppState, UserRole } from '../entities/index';
import { prepareRequirement, type RequirementDraft } from '../domain/procurement.ts';
import type { StateChange } from '../domain/change';
import type { Clock, IdGenerator } from './ports';
import { commitStateChange, type StateChangeSink } from './state-change.ts';

export interface CreateRequirementInput { projectId: string; draft: RequirementDraft }
export type ProcurementCommandResult = { ok: true; change: StateChange } | { ok: false; error: string };

export const createProjectRequirement = (state: AppState, input: CreateRequirementInput, identity: { name: string; role: UserRole }, clock: Clock, ids: IdGenerator): ProcurementCommandResult => {
  if (!['management', 'foreman'].includes(identity.role)) return { ok: false, error: 'Создание потребности недоступно для этой роли.' };
  if (input.projectId !== state.project.id) return { ok: false, error: 'Проект изменился. Закройте форму и откройте её заново.' };
  const result = prepareRequirement(state, input.draft, ids.next('supply'), identity.name);
  if (!result.ok) return result;
  const summary = `Создана потребность: ${result.item.item}`;
  return { ok: true, change: {
    action: 'procurement_updated', summary,
    state: { ...state, procurement: [result.item, ...state.procurement], activity: [{ id: ids.next('activity'), timestamp: clock.now(), actor: identity.name, text: summary, tone: 'neutral' }, ...state.activity] },
  } };
};

export const changeProjectProcurement = (state: AppState, input: ProcurementWorkflowInput, identity: { name: string; role: UserRole }, clock: Clock, ids: IdGenerator): { ok: true; change: StateChange | null } | { ok: false; error: string } => {
  if (!['management', 'foreman'].includes(identity.role)) return { ok: false, error: 'Изменение снабжения недоступно для этой роли.' };
  const timestamp = clock.now();
  const result = transitionProcurement(state, input, timestamp, input.action === 'quote' ? ids.next('quote') : '');
  if (!result.ok) return result;
  if (!result.changed) return { ok: true, change: null };
  return { ok: true, change: { action: 'procurement_updated', summary: result.summary, state: { ...state, ...result.patch, activity: [{ id: ids.next('activity'), timestamp, actor: identity.name, text: result.summary, tone: result.tone }, ...state.activity] } } };
};

export const createProcurementUseCases = (state: AppState, identity: { name: string; role: UserRole }, clock: Clock, ids: IdGenerator, sink: StateChangeSink) => ({
  change: (input: ProcurementWorkflowInput) => {
    const result = changeProjectProcurement(state, input, identity, clock, ids);
    if (result.ok && result.change) commitStateChange(result.change, sink);
    return result;
  },
  createRequirement: (input: CreateRequirementInput) => {
    const result = createProjectRequirement(state, input, identity, clock, ids);
    if (result.ok) commitStateChange(result.change, sink);
    return result;
  },
});
