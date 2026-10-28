import type { AppState } from '../entities/index';
import { treasurySnapshot, type TreasuryReadModel, type TreasuryRepository } from '../application/treasury.ts';
import type { StateChangeSink } from '../application/state-change.ts';

export const treasuryReadModel = (state: AppState): TreasuryReadModel => ({
  project: { id: state.project.id }, treasury: state.treasury, financeLedger: state.financeLedger,
  financeEntries: state.financeEntries, budgetLines: state.budgetLines, stages: state.stages, tasks: state.tasks,
});

/** The revisioned project repository remains the only persistence boundary. */
export const createProjectTreasuryRepository = (read: () => AppState, sink: StateChangeSink): TreasuryRepository => {
  const projectId = read().project.id;
  const switched = () => ({ ok: false as const, error: 'Проект изменился. Откройте финансовое планирование заново.' });
  return {
    read: () => read().project.id === projectId ? { ok: true, snapshot: treasuryReadModel(read()) } : switched(),
    commit: change => {
      const current = read();
      if (current.project.id !== projectId || change.projectId !== projectId) return switched();
      if (treasurySnapshot(treasuryReadModel(current)) !== change.expected) return { ok: false, error: 'Данные обновились. Повторите действие на свежем снимке.' };
      sink({ ...current, treasury: structuredClone(change.treasury) }, { action: change.action, summary: change.summary });
      return { ok: true };
    },
  };
};
