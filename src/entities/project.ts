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
