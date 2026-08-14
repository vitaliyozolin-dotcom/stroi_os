export type UserRole = 'management' | 'foreman' | 'client';

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  isOwner: boolean;
}

export type PageId =
  | 'overview'
  | 'project'
  | 'tasks'
  | 'marketing'
  | 'counterparties'
  | 'finance'
  | 'schedule'
  | 'procurement'
  | 'quality'
  | 'client'
  | 'settings';

export type StageStatus =
  | 'not_ready'
  | 'ready'
  | 'in_progress'
  | 'blocked'
  | 'awaiting_inspection'
  | 'accepted'
  | 'rework';

export type CheckpointStatus = 'pending' | 'in_review' | 'accepted' | 'rework';

export type ProcurementStatus =
  | 'need'
  | 'rfq'
  | 'ordered'
  | 'in_transit'
  | 'delivered'
  | 'accepted'
  | 'issued';

export type ExpenseStatus = 'committed' | 'accepted' | 'paid';

export interface HouseProject {
  id: string;
  code: string;
  name: string;
  address: string;
  model: string;
  area: number;
  clientNames: string;
  contractValue: number;
  targetCost: number;
  startDate: string;
  targetDate: string;
  forecastDate: string;
  foreman: string;
  cameraStatus: 'online' | 'offline';
  cameraUrl?: string;
  createdAt?: string;
  source?: string;
  contractNumber?: string;
  status?: 'workspace' | 'draft' | 'active' | 'completed' | 'archived';
}

export interface BudgetMeta {
  version: string;
  source: string;
  importedAt?: string;
  approvedBy?: string;
  approvedAt?: string;
  note?: string;
}

export interface Stage {
  id: string;
  order: number;
  name: string;
  shortName: string;
  status: StageStatus;
  weight: number;
  progress: number;
  planStart: string;
  planEnd: string;
  forecastEnd: string;
  actualEnd?: string;
  responsible: string;
  responsibleId?: string;
  dependencyId?: string;
  dependency?: string;
  blocker?: string;
}

export interface BudgetLine {
  id: string;
  stageIds: string[];
  name: string;
  plan: number;
  forecast: number;
}

export interface FinanceEntry {
  id: string;
  kind: 'expense' | 'income';
  status: ExpenseStatus;
  amount: number;
  date: string;
  stageId?: string;
  budgetLineId?: string;
  counterparty: string;
  counterpartyId?: string;
  description: string;
  document?: string;
  procurementItemId?: string;
  acceptedAmount?: number;
  acceptedAt?: string;
  acceptanceDocument?: string;
  paidAmount?: number;
  paidAt?: string;
  paymentDocument?: string;
}

export interface ProcurementItem {
  id: string;
  stageId: string;
  item: string;
  quantity: number;
  unit: string;
  neededBy: string;
  status: ProcurementStatus;
  budget: number;
  supplier: string;
  supplierId?: string;
  owner: string;
  risk?: string;
  budgetLineId?: string;
  reason?: string;
  deliveryAddress?: string;
  warehouse?: string;
  orderedAt?: string;
  deliveredAt?: string;
}

export type CounterpartyType = 'contractor' | 'supplier' | 'service' | 'client';
export type CounterpartyStatus = 'active' | 'probation' | 'blocked';

export interface CounterpartyProfile {
  id: string;
  name: string;
  type: CounterpartyType;
  status: CounterpartyStatus;
  specialty?: string;
  contactName?: string;
  phone?: string;
  email?: string;
  inn?: string;
  legalName?: string;
  kpp?: string;
  ogrn?: string;
  legalAddress?: string;
  bankName?: string;
  bik?: string;
  settlementAccount?: string;
  correspondentAccount?: string;
  internalOwner?: string;
  paymentTerms?: string;
  warrantyTerms?: string;
  serviceRegion?: string;
  notes?: string;
  tags?: string[];
}

export type QuoteStatus = 'received' | 'selected' | 'rejected';

export interface SupplierQuote {
  id: string;
  procurementItemId: string;
  supplier: string;
  supplierId?: string;
  amount: number;
  deliveryDays: number;
  paymentTerms: string;
  source: string;
  validUntil?: string;
  status: QuoteStatus;
  comment?: string;
}

export type LeadStage = 'new' | 'qualified' | 'site_visit' | 'estimate' | 'negotiation' | 'won' | 'lost';
export type LeadSource = 'website' | 'avito' | 'domclick' | 'referral' | 'telegram' | 'manual';

export interface Lead {
  id: string;
  createdAt: string;
  name: string;
  phone: string;
  email?: string;
  source: LeadSource;
  stage: LeadStage;
  budget?: number;
  houseArea?: number;
  region?: string;
  landStatus?: 'unknown' | 'owned' | 'searching' | 'reserved';
  mortgageStatus?: 'unknown' | 'not_needed' | 'needed' | 'approved';
  nextAction: string;
  nextActionAt?: string;
  owner: string;
  notes?: string;
  projectId?: string;
  lostReason?: string;
}

export type AccountStatus = 'active' | 'invited' | 'disabled';

export interface SystemUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  status: AccountStatus;
  telegram?: string;
  telegramChatId?: string;
  telegramBoundAt?: string;
  lastActiveAt?: string;
  invitedAt?: string;
  webActivatedAt?: string;
  inviteDelivery?: 'sent' | 'not_configured' | 'failed' | 'draft';
}

export interface NotificationSettings {
  channels: {
    email: boolean;
    telegram: boolean;
    browser: boolean;
  };
  events: {
    financeApproval: boolean;
    supplyRisk: boolean;
    qualityRework: boolean;
    leadWithoutAction: boolean;
    scheduleDelay: boolean;
    taskAssigned: boolean;
    taskOverdue: boolean;
    projectActivity: boolean;
  };
}

export type DashboardWidget = 'project' | 'progress' | 'finance' | 'decisions' | 'cashflow' | 'quality' | 'supply' | 'tasks' | 'activity';

export interface AppSettings {
  schemaVersion?: number;
  users: SystemUser[];
  notifications: NotificationSettings;
  dashboardWidgets: DashboardWidget[];
}

export type TaskStatus = 'todo' | 'in_progress' | 'waiting' | 'review' | 'done' | 'canceled';
export type TaskPriority = 'low' | 'normal' | 'high' | 'critical';
export type TaskHistoryKind = 'created' | 'edited' | 'status' | 'assignee' | 'due_date' | 'comment' | 'completed' | 'reopened';

export interface TaskHistoryEvent {
  id: string;
  timestamp: string;
  actor: string;
  kind: TaskHistoryKind;
  text: string;
}

export interface ProjectTask {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  assigneeId: string;
  assigneeName: string;
  reviewerId?: string;
  reviewerName?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  dueDate: string;
  originalDueDate: string;
  completedAt?: string;
  completionNote?: string;
  stageId?: string;
  counterpartyId?: string;
  procurementItemId?: string;
  checkpointId?: string;
  blockerReason?: string;
  rescheduleCount: number;
  attachments?: ProjectAttachment[];
  history: TaskHistoryEvent[];
}

export interface ProjectAttachment {
  id: string;
  key: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  uploadedAt: string;
  uploadedBy: string;
  source: 'telegram' | 'web';
}

export interface FieldReport {
  id: string;
  createdAt: string;
  author: string;
  note: string;
  source: 'telegram' | 'web';
  stageId?: string;
  clientVisible: boolean;
  telegramMessageId?: string;
  attachments: ProjectAttachment[];
}

export interface EvidencePhoto {
  id: string;
  name: string;
  capturedAt: string;
  dataUrl?: string;
  fileKey?: string;
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  uploadedAt?: string;
  uploadedBy?: string;
  source?: 'web' | 'telegram';
}

export interface QualityCheckpoint {
  id: string;
  stageId: string;
  title: string;
  zone: string;
  status: CheckpointStatus;
  requiredShots: string[];
  photos: EvidencePhoto[];
  assignee: string;
  reviewer: string;
  measurement?: string;
  note?: string;
  submittedAt?: string;
  acceptedAt?: string;
  clientVisible: boolean;
}

export interface ProjectDocument {
  id: string;
  name: string;
  type: string;
  updatedAt: string;
  clientVisible: boolean;
  status: 'current' | 'signed' | 'draft';
  category?: 'contract' | 'act' | 'invoice' | 'upd' | 'waybill' | 'specification' | 'other';
  number?: string;
  documentDate?: string;
  direction?: 'incoming' | 'outgoing' | 'internal';
  counterpartyId?: string;
  stageId?: string;
  procurementItemId?: string;
  financeEntryId?: string;
  sentAt?: string;
  receivedAt?: string;
  signedAt?: string;
  storageLocation?: string;
  fileKey?: string;
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  uploadedAt?: string;
  uploadedBy?: string;
}

export interface ClientDecision {
  id: string;
  title: string;
  dueDate: string;
  status: 'waiting' | 'decided';
  choice?: string;
}

export interface ActivityEvent {
  id: string;
  timestamp: string;
  actor: string;
  text: string;
  tone: 'neutral' | 'positive' | 'warning';
}

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
