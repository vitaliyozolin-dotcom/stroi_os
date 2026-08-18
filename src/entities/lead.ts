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
