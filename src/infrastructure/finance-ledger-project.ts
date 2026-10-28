import type { AppState } from '../entities/index';
import type { StateChangeSink } from '../application/state-change.ts';
import { financeLedgerSnapshot, type FinanceLedgerReadModel, type FinanceLedgerRepository } from '../application/finance-ledger.ts';

export const financeLedgerReadModel = (state: AppState): FinanceLedgerReadModel => ({ project: { id: state.project.id }, financeLedger: state.financeLedger, financeEntries: state.financeEntries, treasury: state.treasury, documents: state.documents });
export const createProjectFinanceLedgerRepository = (read: () => AppState, sink: StateChangeSink): FinanceLedgerRepository => {
  const projectId = read().project.id;
  const switched = () => ({ ok: false as const, error: 'Проект изменился. Откройте финансовый журнал заново.' });
  return {
    read: () => read().project.id === projectId ? { ok: true, snapshot: financeLedgerReadModel(read()) } : switched(),
    commit: change => {
      const current = read();
      if (current.project.id !== projectId || change.projectId !== projectId) return switched();
      if (financeLedgerSnapshot(financeLedgerReadModel(current)) !== change.expected) return { ok: false, error: 'Финансовые данные обновились. Повторите действие на свежем снимке.' };
      sink({ ...current, financeLedger: structuredClone(change.financeLedger) }, { action: change.action, summary: change.summary });
      return { ok: true };
    },
  };
};
