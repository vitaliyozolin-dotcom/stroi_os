export interface PlanBaseline {
  start?: string;
  end: string;
  source: 'initial' | 'document' | 'snapshot';
  note: string;
  recordedAt: string;
  recordedBy: string;
}

export interface PlanChange {
  at: string;
  actor: string;
  field: string;
  before: string;
  after: string;
  reason: string;
}
