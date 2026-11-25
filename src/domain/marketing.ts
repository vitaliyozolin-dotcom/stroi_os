import type { SalesSnapshot } from './contexts';
import type { Lead, LeadSource, LeadStage } from '../entities/index';
import { salesStages, salesLabel } from './sales-workflow.js';
export const marketingStages = salesStages.map(row => row.key);
export const marketingStageLabels = Object.fromEntries(marketingStages.map(stage => [stage, salesLabel(stage)])) as Record<LeadStage, string>;
export const marketingSourceLabels: Record<LeadSource, string> = { website: 'Сайт', avito: 'Авито', domclick: 'Домклик', referral: 'Рекомендация', telegram: 'Telegram', manual: 'Вручную' };
export const leadSnapshot = (state: SalesSnapshot, id: string) => JSON.stringify([state.project.id, state.leads.find(lead => lead.id === id)]);
export type LeadDraft = Omit<Lead, 'id' | 'createdAt' | 'stage' | 'projectId' | 'lostReason'>;
export type LeadQualification = Partial<Pick<Lead, 'landStatus' | 'mortgageStatus' | 'qualification' | 'budget' | 'houseArea' | 'region' | 'owner' | 'projectManager' | 'nextAction' | 'nextActionAt' | 'notes'>>;
const validTimestamp = (value: string) => { const date = value.slice(0, 10), parsed = new Date(`${date}T00:00:00.000Z`); return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date && Number.isFinite(Date.parse(value)); };
const land = ['unknown', 'owned', 'searching', 'reserved'], mortgage = ['unknown', 'not_needed', 'needed', 'approved'];
export const qualificationKeys = ['landStatus', 'mortgageStatus', 'qualification', 'budget', 'houseArea', 'region', 'owner', 'projectManager', 'nextAction', 'nextActionAt', 'notes'];
export const validQualification = (patch: LeadQualification) => (patch.landStatus === undefined || land.includes(patch.landStatus)) && (patch.mortgageStatus === undefined || mortgage.includes(patch.mortgageStatus))
  && [patch.budget, patch.houseArea, patch.qualification?.electricityPowerKw, patch.qualification?.requestedLoan, patch.qualification?.approvedLoan, patch.qualification?.downPayment, patch.qualification?.maternityCapital].every(value => value === undefined || Number.isFinite(value) && value >= 0)
  && Object.values(patch.qualification ?? {}).every(value => typeof value !== 'string' || value.length <= 3000);
export const prepareLead = (draft: LeadDraft, id: string, timestamp: string, actor: string): { ok: true; lead: Lead } | { ok: false; error: string } => {
  if (!draft.name.trim() || !draft.phone.trim()) return { ok: false, error: 'Укажите имя и телефон клиента.' };
  if (!Object.hasOwn(marketingSourceLabels, draft.source) || !validQualification(draft)) return { ok: false, error: 'Выберите допустимые источник, статус участка и финансирование.' };
  if ([draft.budget, draft.houseArea].some(value => value !== undefined && (!Number.isFinite(value) || value < 0))) return { ok: false, error: 'Бюджет и площадь должны быть неотрицательными числами.' };
  if (draft.nextActionAt && !validTimestamp(draft.nextActionAt)) return { ok: false, error: 'Укажите корректный срок следующего шага.' };
  return { ok: true, lead: { id, createdAt: timestamp, name: draft.name.trim(), phone: draft.phone.trim(), email: draft.email?.trim() || undefined, source: draft.source, stage: 'new', stageEnteredAt: timestamp, projectManager: draft.projectManager?.trim(), budget: draft.budget || undefined, houseArea: draft.houseArea || undefined, region: draft.region?.trim() || undefined, landStatus: draft.landStatus, mortgageStatus: draft.mortgageStatus, nextAction: draft.nextAction.trim() || 'Позвонить и квалифицировать заявку', nextActionAt: draft.nextActionAt || undefined, owner: draft.owner.trim() || actor, notes: draft.notes?.trim() || undefined, qualification: draft.qualification } };
};
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export const prepareWebsiteLeads = (value: unknown, existing: Lead[], _actor: string): { ok: true; incoming: Lead[] } | { ok: false; error: string } => {
  if (!record(value) || !Array.isArray(value.leads)) return { ok: false, error: 'Сервер вернул некорректный список заявок.' };
  const seen = new Set(existing.map(lead => lead.id)), incoming: Lead[] = [];
  for (const item of value.leads) {
    if (!record(item) || typeof item.id !== 'string' || !item.id.trim() || typeof item.created_at !== 'string' || !validTimestamp(item.created_at) || typeof item.name !== 'string' || !item.name.trim() || typeof item.phone !== 'string' || !item.phone.trim() || ['email', 'source', 'message'].some(key => item[key] !== undefined && item[key] !== null && typeof item[key] !== 'string')) return { ok: false, error: 'В ответе сервера есть некорректная заявка.' };
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    incoming.push({ id: item.id, createdAt: item.created_at, name: item.name.trim(), phone: item.phone.trim(), email: typeof item.email === 'string' ? item.email.trim() || undefined : undefined, source: typeof item.source === 'string' && Object.hasOwn(marketingSourceLabels, item.source) ? item.source as LeadSource : 'website', stage: marketingStages.includes(item.status as LeadStage) ? item.status as LeadStage : 'new', stageEnteredAt: typeof item.entered_at === 'string' ? item.entered_at : item.created_at, nextAction: 'Позвонить и квалифицировать заявку', owner: '', notes: typeof item.message === 'string' ? item.message.trim() || undefined : undefined });
  }
  return { ok: true, incoming };
};
