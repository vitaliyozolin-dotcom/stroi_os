import type { PlanBaseline, PlanChange } from './baseline';

export interface HouseProject {
  workForecastDate?: string;
  workForecastNote?: string;
  workForecastUpdatedAt?: string;
  workForecastUpdatedBy?: string;
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
  baseline?: PlanBaseline;
  planHistory?: PlanChange[];
  planChangeReason?: string;
  foreman: string;
  cameraStatus: 'online' | 'offline';
  cameraUrl?: string;
  createdAt?: string;
  source?: string;
  contractNumber?: string;
  status?: 'workspace' | 'draft' | 'active' | 'completed' | 'archived';
}
