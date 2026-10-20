import type { ConstructionSnapshot } from './contexts';
export interface StagePlanDraft { planStart: string; planEnd: string; forecastEnd: string; dependencyId: string; responsibleId: string; reason: string }
export const stagePlanSnapshot = (state: ConstructionSnapshot, id: string) => JSON.stringify([state.project.id, state.stages.find(stage => stage.id === id)]);
const validDate = (value: string) => { const date = new Date(`${value}T00:00:00.000Z`); return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value; };
export const planStage = (state: ConstructionSnapshot, stageId: string, draft: StagePlanDraft, expected: string) => {
  const stage = state.stages.find(row => row.id === stageId);
  if (!stage || expected !== stagePlanSnapshot(state, stageId)) return { ok: false as const, error: 'Этап обновился. Откройте редактирование графика заново.' };
  if (![draft.planStart, draft.planEnd, draft.forecastEnd].every(validDate) || draft.planEnd < draft.planStart || draft.forecastEnd < draft.planStart) return { ok: false as const, error: 'Укажите корректные сроки: окончание не раньше начала.' };
  const datesChanged = draft.planStart !== stage.planStart || draft.planEnd !== stage.planEnd || draft.forecastEnd !== stage.forecastEnd;
  if (datesChanged && !draft.reason.trim()) return { ok: false as const, error: 'Укажите причину изменения срока.' };
  const dependency = state.stages.find(row => row.id === draft.dependencyId);
  if (!stage.schedule && draft.dependencyId && (!dependency || dependency.id === stageId || dependency.order >= stage.order)) return { ok: false as const, error: 'Выберите существующий предшествующий этап.' };
  const responsible = state.counterparties.find(row => row.id === draft.responsibleId);
  if (draft.responsibleId && (!responsible || responsible.status === 'blocked' || !['contractor', 'service'].includes(responsible.type))) return { ok: false as const, error: 'Выберите доступного подрядчика или ответственного.' };
  const next = { ...stage, planStart: draft.planStart, planEnd: draft.planEnd, forecastEnd: draft.forecastEnd, dependencyId: stage.schedule ? stage.dependencyId : dependency?.id, dependency: stage.schedule ? stage.dependency : dependency?.name, responsibleId: responsible?.id, responsible: responsible?.name ?? 'Не назначен', planChangeReason: draft.reason.trim() || stage.planChangeReason, forecastReason: draft.reason.trim() || stage.forecastReason };
  return { ok: true as const, changed: JSON.stringify(next) !== JSON.stringify(stage), stages: state.stages.map(row => row.id === stageId ? next : row), summary: `Обновлён график этапа «${stage.name}»`, tone: draft.forecastEnd > draft.planEnd ? 'warning' as const : 'neutral' as const };
};
