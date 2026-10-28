import type { BudgetLine, FinanceEntry, FinanceLedgerState, ProjectTask, Stage, TreasuryState, UserRole } from '../entities/index';
import { validateTreasuryChanges } from '../domain/treasury.js';

export interface TreasuryReadModel {
  project: { id: string };
  treasury?: TreasuryState;
  financeLedger?: FinanceLedgerState;
  financeEntries: FinanceEntry[];
  budgetLines: BudgetLine[];
  stages: Stage[];
  tasks: ProjectTask[];
}
export interface TreasuryChange {
  projectId: string;
  expected: string;
  treasury: TreasuryState;
  action: 'treasury_updated';
  summary: string;
}
export type TreasuryResult = { ok: true } | { ok: false; error: string };
export interface TreasuryRepository {
  read(): { ok: true; snapshot: TreasuryReadModel } | { ok: false; error: string };
  commit(change: TreasuryChange): TreasuryResult;
}
/** Includes referenced facts: an open plan form cannot unknowingly reuse a settled tranche. */
export const treasurySnapshot = (state: TreasuryReadModel) => JSON.stringify([
  state.project.id, state.treasury ?? null, state.financeLedger ?? null, state.financeEntries, state.budgetLines, state.stages, state.tasks,
]);

export const createTreasuryUseCases = (repository: TreasuryRepository, identity: { name: string; role: UserRole; id?: string }) => ({
  save(next: TreasuryState, expected: string): TreasuryResult {
    if (identity.role !== 'management') return { ok: false, error: 'Финансовое планирование доступно роли «Управление».' };
    const read = repository.read();
    if (!read.ok) return read;
    if (treasurySnapshot(read.snapshot) !== expected) return { ok: false, error: 'Работы или финансовые данные обновились. Откройте форму заново; черновик сохранён на экране.' };
    if (JSON.stringify(next) === JSON.stringify(read.snapshot.treasury)) return { ok: true };
    const candidate = { ...read.snapshot, treasury: structuredClone(next) };
    const error = validateTreasuryChanges(read.snapshot, candidate, identity);
    if (error) return { ok: false, error };
    return repository.commit({ projectId: read.snapshot.project.id, expected,
      treasury: candidate.treasury, action: 'treasury_updated', summary: 'Обновлены счета, платёжный план или финансовый прогноз',
    });
  },
});
