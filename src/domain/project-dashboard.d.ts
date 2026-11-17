import type { AppState, StageStatus } from '../entities/index';
import type { AutomaticSchedule } from './construction/index.js';
export function projectScheduleDashboard(state: AppState, forecast: AutomaticSchedule, today: string): { first:string;last:string;contractDelta:number|null;todayPosition:number|null;contractPosition:number|null;rows:{id:string;name:string;status:StageStatus;start:string|null;end:string|null;progress:number;left:number;width:number}[] };
