import type { SupplySnapshot } from './contexts';
import type { ProcurementItem } from '../entities/index';

export interface RequirementDraft {
  stageId: string; item: string; quantity: number; unit: string; neededBy: string;
  budget: number; supplierId: string; owner: string;
}

export const prepareRequirement = (state: SupplySnapshot, input: RequirementDraft, id: string, actor: string): { ok: true; item: ProcurementItem } | { ok: false; error: string } => {
  if (!input.item.trim()) return { ok: false, error: 'Укажите материал или комплект.' };
  if (!Number.isFinite(input.quantity) || input.quantity <= 0) return { ok: false, error: 'Количество должно быть положительным числом.' };
  if (!Number.isFinite(input.budget) || input.budget < 0) return { ok: false, error: 'Бюджет должен быть неотрицательным числом.' };
  if (!input.unit.trim()) return { ok: false, error: 'Укажите единицу измерения.' };
  if (!state.stages.some(stage => stage.id === input.stageId)) return { ok: false, error: 'Выберите существующий этап работ.' };
  if (input.neededBy) {
    const date = new Date(`${input.neededBy}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.neededBy) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== input.neededBy) return { ok: false, error: 'Укажите корректную дату потребности.' };
  }
  const supplier = state.counterparties.find(profile => profile.id === input.supplierId);
  if (input.supplierId && (!supplier || supplier.status === 'blocked' || !['supplier', 'contractor'].includes(supplier.type))) return { ok: false, error: 'Выберите доступного поставщика или подрядчика.' };
  const budgetLine = state.budgetLines.find(line => line.stageIds.includes(input.stageId));
  return { ok: true, item: {
    id, stageId: input.stageId, budgetLineId: budgetLine?.id, item: input.item.trim(),
    quantity: input.quantity, unit: input.unit.trim(), neededBy: input.neededBy, status: 'need',
    budget: input.budget, supplier: supplier?.name ?? 'Не выбран', supplierId: supplier?.id,
    owner: input.owner.trim() || actor,
  } };
};
