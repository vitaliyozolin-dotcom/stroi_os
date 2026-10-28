import type { ConstructionSnapshot, ConstructionPatch } from '../domain/contexts.ts';
import type { UserRole } from '../entities/index';
import { schedulePayload, validateStageControl } from '../domain/construction/index.js';
import { editProjectSchedule, type ScheduleEditInput } from './schedule-edits.ts';
import { editProjectStagePlan, type EditStagePlanInput } from './schedule-planning.ts';
import { applyStageControl, stageCommandSnapshot, type StageControlInput } from './stage-control.ts';

type Identity = { name: string; role: UserRole; id?: string };
export type SchedulePaymentPreview<S> = { ok: true; state: S } | { ok: false; error: string };
const runtime = (now: string) => ({ clock: { now: () => now }, ids: { next: (prefix: string) => `preview-${prefix}` } });

// Disposable candidates use the real command and server policy. They are never sent
// to a repository: confirmation/history stamps here mean "if this draft is saved".
function validatePreview<S extends ConstructionSnapshot>(state: S, patch: ConstructionPatch, identity: Identity, now: string): SchedulePaymentPreview<S> {
  const candidate = structuredClone({ ...state, ...patch, project: { ...state.project, ...patch.project } }) as S;
  const reviewer = { ...identity, isOwner: identity.role === 'management' && identity.id === 'owner' };
  const error = validateStageControl(state, candidate, reviewer, now);
  return error ? { ok: false, error } : { ok: true, state: candidate };
}

export function previewScheduleEdit<S extends ConstructionSnapshot>(state: S, input: ScheduleEditInput, identity: Identity, now: string): SchedulePaymentPreview<S> {
  if (identity.role !== 'management') return { ok: false, error: 'Финансовое влияние доступно управлению.' };
  const { clock, ids } = runtime(now), result = editProjectSchedule(state, input, identity, clock, ids);
  if (!result.ok) return result;
  return validatePreview(state, result.change?.patch ?? {}, identity, now);
}

export function previewStagePlan<S extends ConstructionSnapshot>(state: S, input: EditStagePlanInput, identity: Identity, now: string): SchedulePaymentPreview<S> {
  const { clock, ids } = runtime(now), result = editProjectStagePlan(state, input, identity, clock, ids);
  if (!result.ok) return result;
  return validatePreview(state, result.change?.patch ?? {}, identity, now);
}

export function previewStageControl<S extends ConstructionSnapshot>(state: S, input: StageControlInput, identity: Identity, now: string): SchedulePaymentPreview<S> {
  if (identity.role !== 'management') return { ok: false, error: 'Финансовое влияние доступно управлению.' };
  if (input.expected !== stageCommandSnapshot(state, input.stageId)) return { ok: false, error: 'Этап обновился. Откройте форму заново.' };
  try {
    const result = applyStageControl(state, input.stageId, input.action, input.input, identity.name, identity.role, identity.id, runtime(now));
    return validatePreview(state, { stages: result.snapshot.stages, tasks: result.snapshot.tasks }, identity, now);
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'Заполните сведения об этапе.' }; }
}

/** Same temporary change used by simulateSchedule; keeps the existing dated review. */
export function previewScheduleRecovery<S extends ConstructionSnapshot>(state: S, change: { stageId: string; remainingDays: number; crew?: string }): SchedulePaymentPreview<S> {
  const candidate = structuredClone(state), stage = candidate.stages.find(row => row.id === change.stageId);
  if (!stage?.schedule || !stage.siteUpdate || !Number.isInteger(change.remainingDays) || change.remainingDays < 1 || change.remainingDays > 730) return { ok: false, error: 'Укажите работу и корректный остаток.' };
  stage.siteUpdate.remainingDays = change.remainingDays;
  if (change.crew !== undefined) stage.schedule.crew = change.crew;
  stage.siteUpdate.confirmedSchedule = JSON.stringify(schedulePayload(stage.schedule));
  return { ok: true, state: candidate };
}
