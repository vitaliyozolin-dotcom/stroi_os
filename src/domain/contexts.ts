import type { AppSettings, BudgetLine, ClientDecision, CounterpartyProfile, FieldReport, HouseProject, Lead, ProcurementItem, ProjectDocument, ProjectTask, QualityCheckpoint, Stage, SupplierQuote } from '../entities/index';

export interface ProjectScope { project: { id: string } }
export interface SupplySnapshot extends ProjectScope { procurement: ProcurementItem[]; supplierQuotes: SupplierQuote[]; stages: Stage[]; counterparties: CounterpartyProfile[]; budgetLines: BudgetLine[] }
export interface SupplyPatch { procurement?: ProcurementItem[]; supplierQuotes?: SupplierQuote[] }
export type ConstructionProject = Pick<HouseProject, 'id' | 'name' | 'code' | 'address' | 'startDate' | 'targetDate' | 'baseline' | 'planHistory' | 'planChangeReason' | 'siteProgressHistory' | 'workForecastDate' | 'workForecastNote' | 'workForecastUpdatedAt' | 'workForecastUpdatedBy'>;
export interface ConstructionSnapshot { project: ConstructionProject; stages: Stage[]; tasks: ProjectTask[]; checkpoints: QualityCheckpoint[]; counterparties: CounterpartyProfile[]; procurement: ProcurementItem[]; settings: Pick<AppSettings, 'users'> }
export interface ConstructionPatch { project?: Partial<Omit<ConstructionProject, 'id' | 'name' | 'code' | 'address'>>; stages?: Stage[]; tasks?: ProjectTask[]; checkpoints?: QualityCheckpoint[] }
export interface DocumentsSnapshot { project: Pick<HouseProject, 'id' | 'code'>; documents: ProjectDocument[]; fieldReports: FieldReport[]; stages: Stage[]; counterparties: CounterpartyProfile[] }
export interface DocumentsPatch { documents?: ProjectDocument[]; fieldReports?: FieldReport[] }
export interface ContactsSnapshot extends ProjectScope { counterparties: CounterpartyProfile[] }
export interface ContactsPatch { counterparties?: CounterpartyProfile[]; appendDocuments?: ProjectDocument[] }
export interface SalesSnapshot extends ProjectScope { leads: Lead[] }
export interface SalesPatch { leads?: Lead[] }
export interface DecisionsSnapshot extends ProjectScope { decisions: ClientDecision[] }
export interface DecisionsPatch { decisions?: ClientDecision[] }
export interface SettingsSnapshot extends ProjectScope { settings: AppSettings }
export interface SettingsPatch { settings?: AppSettings }
