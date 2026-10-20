import type { AppState } from '../entities/index';
import type { ProjectScope, SupplySnapshot, SupplyPatch, ConstructionSnapshot, ConstructionPatch, DocumentsSnapshot, DocumentsPatch, ContactsSnapshot, ContactsPatch, SalesSnapshot, SalesPatch, DecisionsSnapshot, DecisionsPatch, SettingsSnapshot, SettingsPatch } from '../domain/contexts.ts';
import { moduleFingerprint, type ModuleRepository } from '../application/module-repository.ts';
import type { StateChangeSink } from '../application/state-change.ts';

interface ProjectModuleAdapter<S extends ProjectScope, P> { select(state: AppState): S; apply(state: AppState, patch: P): AppState; validate?(state: AppState, patch: P): string | undefined }
const createProjectModuleRepository = <S extends ProjectScope, P>(adapter: ProjectModuleAdapter<S, P>, read: () => AppState, sink: StateChangeSink): ModuleRepository<S, P> => {
  const projectId = read().project.id;
  const switched = () => ({ ok: false as const, error: 'Проект изменился. Откройте форму заново.' });
  return {
    read: () => { const state = read(); return state.project.id === projectId ? { ok: true, snapshot: adapter.select(state) } : switched(); },
    commit: change => {
      const state = read();
      if (state.project.id !== projectId || change.projectId !== projectId) return switched();
      if (change.expected !== moduleFingerprint(adapter.select(state))) return { ok: false, error: 'Данные модуля обновились. Повторите действие на свежих данных.' };
      const error = adapter.validate?.(state, change.patch);
      if (error) return { ok: false, error };
      const next = adapter.apply(state, change.patch);
      sink({ ...next, activity: change.event ? [change.event, ...state.activity] : state.activity }, { action: change.action, summary: change.summary });
      return { ok: true };
    },
  };
};
export const supplySnapshot = (s: AppState): SupplySnapshot => ({ project: { id: s.project.id }, procurement: s.procurement, supplierQuotes: s.supplierQuotes, stages: s.stages, counterparties: s.counterparties, budgetLines: s.budgetLines });
export const createSupplyRepository = (read: () => AppState, sink: StateChangeSink) => createProjectModuleRepository<SupplySnapshot, SupplyPatch>({ select: supplySnapshot, apply: (s, p) => ({ ...s, procurement: p.procurement ?? s.procurement, supplierQuotes: p.supplierQuotes ?? s.supplierQuotes }) }, read, sink);
export const constructionSnapshot = (s: AppState): ConstructionSnapshot => ({ project: { id: s.project.id, name: s.project.name, code: s.project.code, address: s.project.address, startDate: s.project.startDate, targetDate: s.project.targetDate, baseline: s.project.baseline, planHistory: s.project.planHistory, planChangeReason: s.project.planChangeReason, siteProgressHistory: s.project.siteProgressHistory, workForecastDate: s.project.workForecastDate, workForecastNote: s.project.workForecastNote, workForecastUpdatedAt: s.project.workForecastUpdatedAt, workForecastUpdatedBy: s.project.workForecastUpdatedBy }, stages: s.stages, tasks: s.tasks, checkpoints: s.checkpoints, counterparties: s.counterparties, procurement: s.procurement, settings: { users: s.settings.users } });
const projectFields = ['startDate', 'targetDate', 'baseline', 'planHistory', 'planChangeReason', 'siteProgressHistory', 'workForecastDate', 'workForecastNote', 'workForecastUpdatedAt', 'workForecastUpdatedBy'] as const;
const ownedProjectPatch = (patch: NonNullable<ConstructionPatch['project']>) => {
  const result: NonNullable<ConstructionPatch['project']> = {};
  for (const key of projectFields) if (Object.hasOwn(patch, key)) Object.assign(result, { [key]: patch[key] });
  return result;
};
export const createConstructionRepository = (read: () => AppState, sink: StateChangeSink) => createProjectModuleRepository<ConstructionSnapshot, ConstructionPatch>({ select: constructionSnapshot, apply: (s, p) => ({ ...s, project: p.project ? { ...s.project, ...ownedProjectPatch(p.project) } : s.project, stages: p.stages ?? s.stages, tasks: p.tasks ?? s.tasks, checkpoints: p.checkpoints ?? s.checkpoints }) }, read, sink);
export const documentsSnapshot = (s: AppState): DocumentsSnapshot => ({ project: { id: s.project.id, code: s.project.code }, documents: s.documents, fieldReports: s.fieldReports, stages: s.stages, counterparties: s.counterparties });
export const createDocumentsRepository = (read: () => AppState, sink: StateChangeSink) => createProjectModuleRepository<DocumentsSnapshot, DocumentsPatch>({ select: documentsSnapshot, apply: (s, p) => ({ ...s, documents: p.documents ?? s.documents, fieldReports: p.fieldReports ?? s.fieldReports }) }, read, sink);
export const contactsSnapshot = (s: AppState): ContactsSnapshot => ({ project: { id: s.project.id }, counterparties: s.counterparties });
export const createContactsRepository = (read: () => AppState, sink: StateChangeSink) => createProjectModuleRepository<ContactsSnapshot, ContactsPatch>({ select: contactsSnapshot, validate: (s, p) => { const ids = new Set(s.documents.map(document => document.id)); for (const document of p.appendDocuments ?? []) { if (ids.has(document.id)) return 'Документ уже добавлен. Обновите карточку.'; ids.add(document.id); } }, apply: (s, p) => ({ ...s, counterparties: p.counterparties ?? s.counterparties, documents: p.appendDocuments ? [...p.appendDocuments, ...s.documents] : s.documents }) }, read, sink);
export const salesSnapshot = (s: AppState): SalesSnapshot => ({ project: { id: s.project.id }, leads: s.leads });
export const createSalesRepository = (read: () => AppState, sink: StateChangeSink) => createProjectModuleRepository<SalesSnapshot, SalesPatch>({ select: salesSnapshot, apply: (s, p) => ({ ...s, leads: p.leads ?? s.leads }) }, read, sink);
export const decisionsSnapshot = (s: AppState): DecisionsSnapshot => ({ project: { id: s.project.id }, decisions: s.decisions });
export const createDecisionsRepository = (read: () => AppState, sink: StateChangeSink) => createProjectModuleRepository<DecisionsSnapshot, DecisionsPatch>({ select: decisionsSnapshot, apply: (s, p) => ({ ...s, decisions: p.decisions ?? s.decisions }) }, read, sink);
export const settingsSnapshot = (s: AppState): SettingsSnapshot => ({ project: { id: s.project.id }, settings: s.settings });
export const createSettingsRepository = (read: () => AppState, sink: StateChangeSink) => createProjectModuleRepository<SettingsSnapshot, SettingsPatch>({ select: settingsSnapshot, apply: (s, p) => ({ ...s, settings: p.settings ?? s.settings }) }, read, sink);
