import type { BudgetLine, BudgetMeta, FinanceEntry, HouseProject, ProjectDocument, ProcurementItem, QualityCheckpoint, Stage, CounterpartyProfile } from '../../entities/index';

/** Financial ownership. Other contexts supply references, never writable patches. */
export interface FinanceOwnedState {
  budgetLines: BudgetLine[];
  budgetMeta: BudgetMeta;
  financeEntries: FinanceEntry[];
}
export type FinancePatch = Partial<FinanceOwnedState>;
export interface FinancePlanningSnapshot extends FinanceOwnedState { projectId: string }
/** Read dependencies for existing shared finance policies. Narrower projections can replace these independently. */
export interface FinanceState extends FinanceOwnedState {
  project: Pick<HouseProject, 'id'>;
  documents: ProjectDocument[];
  procurement: ProcurementItem[];
  checkpoints: QualityCheckpoint[];
  stages: Stage[];
  counterparties: CounterpartyProfile[];
}
