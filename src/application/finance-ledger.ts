import type { FinanceLedgerState, FinanceEntry, TreasuryState, UserRole } from '../entities/index';
import { emptyFinanceLedger, validateFinanceLedgerChanges } from '../domain/finance-ledger.js';

export interface FinanceLedgerReadModel {
  project: { id: string }; financeLedger?: FinanceLedgerState; financeEntries: FinanceEntry[]; treasury?: TreasuryState;
  documents: { id: string; fileKey?: string }[];
}
export type FinanceLedgerResult = { ok: true } | { ok: false; error: string };
export interface FinanceLedgerChange { projectId: string; expected: string; financeLedger: FinanceLedgerState; action: 'finance_ledger_updated'; summary: string }
export interface FinanceLedgerRepository {
  read(): { ok: true; snapshot: FinanceLedgerReadModel } | { ok: false; error: string };
  commit(change: FinanceLedgerChange): FinanceLedgerResult;
}
export const financeLedgerSnapshot = (state: FinanceLedgerReadModel) => JSON.stringify([state.project.id, state.financeLedger ?? null, state.financeEntries, state.treasury ?? null, state.documents]);

export const createFinanceLedgerUseCases = (repository: FinanceLedgerRepository, identity: { name: string; role: UserRole; id?: string }) => {
  const save = (nextLedger: FinanceLedgerState, expected: string): FinanceLedgerResult => {
    if (identity.role !== 'management') return { ok: false, error: 'Финансовый журнал доступен управлению.' };
    const read = repository.read(); if (!read.ok) return read;
    if (financeLedgerSnapshot(read.snapshot) !== expected) return { ok: false, error: 'Расчёты, счета или документы обновились. Откройте форму заново; черновик сохранён на экране.' };
    if (JSON.stringify(nextLedger) === JSON.stringify(read.snapshot.financeLedger)) return { ok: true };
    const candidate = { ...read.snapshot, financeLedger: structuredClone(nextLedger) };
    const error = validateFinanceLedgerChanges(read.snapshot, candidate, identity);
    if (error) return { ok: false, error };
    return repository.commit({ projectId: read.snapshot.project.id, expected, financeLedger: candidate.financeLedger, action: 'finance_ledger_updated', summary: 'Обновлены финансовые операции, заявки или условия расчётов' });
  };
  const append = <K extends 'operations' | 'confirmations' | 'allocationEvents'>(key: K, value: NonNullable<FinanceLedgerState[K]>[number], expected: string, reason: string): FinanceLedgerResult => {
    if (identity.role !== 'management') return { ok: false, error: 'Финансовый журнал доступен управлению.' };
    const read = repository.read(); if (!read.ok) return read;
    const ledger = structuredClone(read.snapshot.financeLedger ?? emptyFinanceLedger());
    const existing = (ledger[key] ?? []).find(row => row.id === value.id);
    const commandContent = (row: unknown) => JSON.stringify(row, (key, item) => ['recordedAt', 'recordedBy'].includes(key) ? undefined : item && !Array.isArray(item) && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
    if (existing) return commandContent(existing) === commandContent(value) ? { ok: true } : { ok: false, error: 'ID уже принадлежит другой записи; повтор не изменяет исходную операцию.' };
    return save({ ...ledger, [key]: [...(ledger[key] ?? []), value], changeReason: reason }, expected);
  };
  return {
    save,
    operation: (value: FinanceLedgerState['operations'][number], expected: string, reason = value.source) => append('operations', value, expected, reason),
    confirm: (value: FinanceLedgerState['confirmations'][number], expected: string, reason = value.source) => append('confirmations', value, expected, reason),
    allocate: (value: NonNullable<FinanceLedgerState['allocationEvents']>[number], expected: string, reason = value.source) => append('allocationEvents', value, expected, reason),
  };
};
