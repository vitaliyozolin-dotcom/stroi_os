import type { ActivityEvent } from './activity';
import type { FieldReport, ProjectDocument } from './content';
import type { CounterpartyProfile } from './counterparty';
import type { ClientDecision } from './decision';
import type { BudgetLine, BudgetMeta, FinanceEntry } from './finance';
import type { Lead } from './lead';
import type { ProcurementItem, SupplierQuote } from './procurement';
import type { HouseProject } from './project';
import type { QualityCheckpoint } from './quality';
import type { Stage } from './stage';
import type { ProjectTask } from './task';
import type { AppSettings } from './user';

export interface AppState {
  version: 1;
  schemaVersion?: number;
  project: HouseProject;
  budgetMeta: BudgetMeta;
  stages: Stage[];
  budgetLines: BudgetLine[];
  financeEntries: FinanceEntry[];
  procurement: ProcurementItem[];
  counterparties: CounterpartyProfile[];
  supplierQuotes: SupplierQuote[];
  leads: Lead[];
  tasks: ProjectTask[];
  fieldReports: FieldReport[];
  settings: AppSettings;
  checkpoints: QualityCheckpoint[];
  documents: ProjectDocument[];
  decisions: ClientDecision[];
  activity: ActivityEvent[];
}
