import type { TreasuryState } from '../../entities/index';
import type { FinanceLedgerState } from '../../entities/index';
import type { BudgetLine, BudgetMeta, FinanceEntry, HouseProject, ProjectDocument, ProcurementItem, QualityCheckpoint, Stage, CounterpartyProfile } from '../../entities/index';

/** Financial ownership. Other contexts supply references, never writable patches. */
export interface FinanceOwnedState {
  budgetLines: BudgetLine[];
  budgetMeta: BudgetMeta;
  financeEntries: FinanceEntry[];
}
export type FinancePatch = Partial<FinanceOwnedState>;
export interface FinancePlanningSnapshot extends FinanceOwnedState { projectId: string }
/** Optional read dependency, deliberately excluded from finance patches. */
export interface FinanceSettlementContext { financeLedger?: FinanceLedgerState; treasury?: TreasuryState }
export interface FinanceBudgetContext { treasury?: TreasuryState }
/** Read dependencies for existing shared finance policies. Narrower projections can replace these independently. */
export interface FinanceState extends FinanceOwnedState, FinanceSettlementContext {
  project: Pick<HouseProject, 'id'>;
  documents: ProjectDocument[];
  procurement: ProcurementItem[];
  checkpoints: QualityCheckpoint[];
  stages: Stage[];
  counterparties: CounterpartyProfile[];
}
/** Import reads project evidence and may propose explicit updates outside finance ownership. */
export interface FinanceHistorySnapshot extends FinanceState {
  project: Pick<HouseProject, 'id' | 'targetCost'>;
}
