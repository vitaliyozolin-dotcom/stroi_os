export type LeadStage = 'new' | 'qualified' | 'site_visit' | 'estimate' | 'negotiation' | 'preparation' | 'won' | 'lost';
export type LeadSource = 'website' | 'avito' | 'domclick' | 'referral' | 'telegram' | 'manual';

export interface LeadQualificationDetails {
  sourceOrderObjectId?: string;
  address?: string;
  cadastralNumber?: string;
  projectModel?: string;
  completionScope?: string;
  desiredMoveInDate?: string;
  budgetScope?: string;
  landOwner?: string;
  groundInfo?: string;
  groundSource?: 'client' | 'report' | 'unknown';
  accessRoad?: string;
  electricity?: 'unknown' | 'connected' | 'planned' | 'absent';
  electricityPowerKw?: number;
  water?: 'unknown' | 'well' | 'network' | 'planned' | 'absent';
  sewage?: 'unknown' | 'existing' | 'planned' | 'absent';
  bank?: string;
  mortgageProgram?: string;
  requestedLoan?: number;
  approvedLoan?: number;
  approvalExpiresOn?: string;
  downPayment?: number;
  downPaymentSource?: string;
  downPaymentConfirmed?: boolean;
  maternityCapital?: number;
  additionalRequirements?: string;
  sourceNote?: string;
  updatedAt?: string;
  updatedBy?: string;
}
export interface Lead {
  qualification?: LeadQualificationDetails;
  preparedAt?: string;
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
