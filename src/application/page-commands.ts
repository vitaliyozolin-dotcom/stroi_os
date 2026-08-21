import type { AppState } from '../entities/index.ts';
import type { Clock, IdGenerator } from './ports.ts';
import { createMutationContext, createPageStateSink, type StateChangeSink } from './state-change.ts';

type PageCommandFactory = (
  current: AppState,
  actor: string,
  clock: Clock,
  ids: IdGenerator,
  sink: StateChangeSink,
) => (next: AppState) => void;

const pageCommand = (action: string, summary: string): PageCommandFactory =>
  (current, actor, clock, ids, sink) => createPageStateSink(
    current,
    { action, summary },
    createMutationContext(actor, clock, ids),
    sink,
  );

export const createFinanceCommands = pageCommand('finance_updated', 'Обновлены финансы проекта');
export const createCounterpartyCommands = pageCommand('counterparty_updated', 'Обновлены контрагенты проекта');
export const createScheduleCommands = pageCommand('schedule_updated', 'Обновлён график проекта');
export const createProcurementCommands = pageCommand('procurement_updated', 'Обновлено снабжение проекта');
export const createClientDecisionCommands = pageCommand('client_decision_updated', 'Обновлено решение клиента');
export const createMarketingCommands = pageCommand('lead_updated', 'Обновлена воронка продаж');
export const createProjectDocumentCommands = pageCommand('document_updated', 'Обновлены документы проекта');
export const createSettingsCommands = pageCommand('settings_updated', 'Обновлены настройки проекта');
