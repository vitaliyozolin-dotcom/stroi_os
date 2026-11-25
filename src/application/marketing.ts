import { nextSalesStage, qualificationBlockers } from '../domain/sales-workflow.js';
import type { LeadStage, UserRole } from '../entities/index';
import type { SalesSnapshot, SalesPatch } from '../domain/contexts.ts';
import { moduleChange, executeModule, type ModuleChange, type ModuleRepository } from './module-repository.ts';
import { leadSnapshot, marketingStages, marketingStageLabels, marketingSourceLabels, prepareLead, prepareWebsiteLeads, validQualification, qualificationKeys, type LeadDraft, type LeadQualification } from '../domain/marketing.ts';
import type { Clock, IdGenerator } from './ports.ts';
export type MarketingCommand =
  | { action: 'create'; projectId: string; draft: LeadDraft }
  | { action: 'qualify'; leadId: string; expected: string; patch: LeadQualification }
  | { action: 'stage'; leadId: string; expected: string; stage?: LeadStage }
  | { action: 'handoff'; leadId: string; expected: string; targetProjectId: string; preparedAt: string }
  | { action: 'import'; projectId: string; response: unknown };
export type MarketingResult = { ok: true; change: ModuleChange<SalesPatch> | null } | { ok: false; error: string };
export const changeProjectMarketing = (state: SalesSnapshot, input: MarketingCommand, identity: { name: string; role: UserRole }, clock: Clock, ids: IdGenerator): MarketingResult => {
  if (identity.role !== 'management') return { ok: false, error: 'Изменение воронки доступно только управлению.' };
  let leads = state.leads, summary = '', tone: 'neutral' | 'positive' = 'neutral', actor = identity.name;
  if (input.action === 'create' || input.action === 'import') {
    if (input.projectId !== state.project.id) return { ok: false, error: 'Проект изменился. Откройте форму или повторите загрузку.' };
    if (input.action === 'create') {
      const result = prepareLead(input.draft, ids.next('lead'), clock.now(), identity.name);
      if (!result.ok) return result;
      leads = [result.lead, ...leads]; summary = `Новая заявка: ${result.lead.name} · ${marketingSourceLabels[result.lead.source]}`;
    } else {
      const result = prepareWebsiteLeads(input.response, leads, identity.name);
      if (!result.ok) return result;
      if (!result.incoming.length) return { ok: true, change: null };
      leads = [...result.incoming, ...leads]; actor = 'ИКИОМА ОС'; summary = `Из формы сайта получено заявок: ${result.incoming.length}`;
    }
  } else {
    const current = leads.find(lead => lead.id === input.leadId);
    if (!current || input.expected !== leadSnapshot(state, input.leadId)) return { ok: false, error: 'Заявка обновилась. Откройте карточку заново.' };
    if (input.action === 'qualify') {
      if (!validQualification(input.patch) || Object.keys(input.patch).some(key => !qualificationKeys.includes(key))) return { ok: false, error: 'Выберите допустимые параметры участка и финансирования.' };
      const next = { ...current, ...input.patch };
      if (JSON.stringify(next) === JSON.stringify(current)) return { ok: true, change: null };
      leads = leads.map(lead => lead.id === current.id ? next : lead); summary = `${current.name}: уточнены параметры участка и финансирования`;
    } else if (input.action === 'handoff') {
      if (!input.targetProjectId.startsWith('lead-')) return { ok: false, error: 'Некорректная связь с проектом.' };
      leads = leads.map(lead => lead.id === current.id ? { ...lead, stage: 'preparation', stageEnteredAt: input.preparedAt, projectId: input.targetProjectId, preparedAt: input.preparedAt } : lead);
      summary = `${current.name}: передан в подготовку проекта`;
    } else {
      const stage = input.stage ?? nextSalesStage(current.stage);
      if (!marketingStages.includes(stage)) return { ok: false, error: 'Выберите допустимый этап воронки.' };
      if (stage === current.stage) return { ok: true, change: null };
      if (stage === 'qualified' && qualificationBlockers(current).length) return { ok: false, error: qualificationBlockers(current).join(' ') };
      if (['preparation', 'estimate', 'negotiation', 'won', 'escrow_funded'].includes(stage) && !current.projectId) return { ok: false, error: 'Сначала передайте заявку в подготовку проекта.' };
      leads = leads.map(lead => lead.id === current.id ? { ...lead, stage, stageEnteredAt: clock.now() } : lead); summary = `${current.name}: этап «${marketingStageLabels[stage]}»`; tone = stage === 'won' ? 'positive' : 'neutral';
    }
  }
  return { ok: true, change: moduleChange(state, { leads }, 'lead_updated', summary, { identity: { name: actor }, clock, ids }, tone) };
};
export const createMarketingUseCases = (repository: ModuleRepository<SalesSnapshot, SalesPatch>, identity: { name: string; role: UserRole }, clock: Clock, ids: IdGenerator) => ({
 execute: (input: MarketingCommand) => executeModule(repository, state => changeProjectMarketing(state, input, identity, clock, ids)),
});
