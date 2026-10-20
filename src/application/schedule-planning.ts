import type { AppState, UserRole } from '../entities/index';
import { planStage, type StagePlanDraft } from '../domain/schedule-planning.ts';
import type { Clock, IdGenerator } from './ports';
import type { StateChange } from '../domain/change';
import { commitStateChange, type StateChangeSink } from './state-change.ts';
export interface EditStagePlanInput { stageId: string; expected: string; draft: StagePlanDraft }
export const editProjectStagePlan = (state: AppState, input: EditStagePlanInput, identity: { name: string; role: UserRole }, clock: Clock, ids: IdGenerator): { ok: true; change: StateChange | null } | { ok: false; error: string } => {
  if (identity.role !== 'management') return { ok: false, error: 'Изменение графика недоступно для этой роли.' };
  const result = planStage(state, input.stageId, input.draft, input.expected);
  if (!result.ok) return result;
  if (!result.changed) return { ok: true, change: null };
  return { ok: true, change: { action: 'schedule_updated', summary: result.summary, state: { ...state, stages: result.stages, activity: [{ id: ids.next('activity'), timestamp: clock.now(), actor: identity.name, text: result.summary, tone: result.tone }, ...state.activity] } } };
};
export const createSchedulePlanningUseCases = (state: AppState, identity: { name: string; role: UserRole }, clock: Clock, ids: IdGenerator, sink: StateChangeSink) => ({
  editPlan: (input: EditStagePlanInput) => {
    const result = editProjectStagePlan(state, input, identity, clock, ids);
    if (result.ok && result.change) commitStateChange(result.change, sink);
    return result;
  },
});
