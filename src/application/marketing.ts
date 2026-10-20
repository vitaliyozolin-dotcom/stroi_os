import type { AppState, LeadStage, UserRole } from '../entities/index';
import type { StateChange } from '../domain/change';
import { leadSnapshot, marketingStages, marketingStageLabels, marketingSourceLabels, prepareLead, prepareWebsiteLeads, validQualification, type LeadDraft, type LeadQualification } from '../domain/marketing.ts';
import type { Clock, IdGenerator } from './ports';
import { commitStateChange, type StateChangeSink } from './state-change.ts';
export type MarketingCommand =
  | { action: 'create'; projectId: string; draft: LeadDraft }
  | { action: 'qualify'; leadId: string; expected: string; patch: LeadQualification }
  | { action: 'stage'; leadId: string; expected: string; stage?: LeadStage }
  | { action: 'import'; projectId: string; response: unknown };
export type MarketingResult = { ok: true; change: StateChange | null } | { ok: false; error: string };
export const changeProjectMarketing = (state: AppState, input: MarketingCommand, identity: { name: string; role: UserRole }, clock: Clock, ids: IdGenerator): MarketingResult => {
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
      if (!validQualification(input.patch) || Object.keys(input.patch).some(key => !['landStatus', 'mortgageStatus'].includes(key))) return { ok: false, error: 'Выберите допустимые параметры участка и финансирования.' };
      const next = { ...current, ...input.patch };
      if (JSON.stringify(next) === JSON.stringify(current)) return { ok: true, change: null };
      leads = leads.map(lead => lead.id === current.id ? next : lead); summary = `${current.name}: уточнены параметры участка и финансирования`;
    } else {
      const stage = input.stage ?? (['won', 'lost'].includes(current.stage) ? current.stage : marketingStages[marketingStages.indexOf(current.stage) + 1]);
      if (!marketingStages.includes(stage)) return { ok: false, error: 'Выберите допустимый этап воронки.' };
      if (stage === current.stage) return { ok: true, change: null };
      leads = leads.map(lead => lead.id === current.id ? { ...lead, stage } : lead); summary = `${current.name}: этап «${marketingStageLabels[stage]}»`; tone = stage === 'won' ? 'positive' : 'neutral';
    }
  }
  return { ok: true, change: { action: 'lead_updated', summary, state: { ...state, leads, activity: [{ id: ids.next('activity'), timestamp: clock.now(), actor, text: summary, tone }, ...state.activity] } } };
};
export const createMarketingUseCases = (state: AppState, identity: { name: string; role: UserRole }, clock: Clock, ids: IdGenerator, sink: StateChangeSink) => ({
  execute: (input: MarketingCommand) => { const result = changeProjectMarketing(state, input, identity, clock, ids); if (result.ok && result.change) commitStateChange(result.change, sink); return result; },
});
