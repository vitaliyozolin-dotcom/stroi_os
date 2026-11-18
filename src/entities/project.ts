import type { ProjectFunding } from './project-funding';
import type { ProjectLifecycle } from './project-lifecycle';
import type { PlanBaseline, PlanChange } from './baseline';

export interface HouseProject {
  funding?: ProjectFunding;
  lifecycle?: ProjectLifecycle;
  siteProgressHistory?: { id: string; asOf: string; completed: string[]; remaining: string[]; source: string; recordedAt?: string; recordedBy?: string }[];
  workForecastDate?: string;
  workForecastNote?: string;
  workForecastUpdatedAt?: string;
  workForecastUpdatedBy?: string;
  id: string;
  code: string;
  name: string;
  /** Previous display names retained for search and historical context. */
  nameAliases?: string[];
  address: string;
  model: string;
  area: number;
  clientNames: string;
  contractValue: number;
  targetCost: number;
  startDate: string;
  targetDate: string;
  forecastDate: string;
  baseline?: PlanBaseline;
  planHistory?: PlanChange[];
  planChangeReason?: string;
  foreman: string;
  cameraStatus: 'online' | 'offline';
  cameraUrl?: string;
  createdAt?: string;
  /** Stable request identity makes a lost creation response safe to retry. */
  creationRequestId?: string;
  /** Legacy numeric slots remain zero while these draft values are unknown. */
  unknownFields?: Array<'area' | 'contractValue' | 'targetCost'>;
  source?: string;
  contractNumber?: string;
  status?: 'workspace' | 'draft' | 'active' | 'completed' | 'archived';
}
