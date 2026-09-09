import type { AppState, Stage, StageSchedule, StageSiteUpdate } from '../../src/entities/index';
export function schedulePayload(value?: StageSchedule): Omit<StageSchedule, 'updatedAt' | 'updatedBy'> | null;
export function sitePayload(value?: StageSiteUpdate): Pick<StageSiteUpdate, 'asOf' | 'reviewOn' | 'remainingDays' | 'readyOn' | 'acceptanceOn' | 'note' | 'nextAction' | 'issueOwner'> | null;
export function addScheduleDays(day: string, count: number): string;
export function confirmedSiteUpdate(stage: Stage, today?: string): boolean;
export interface ScheduleForecast {
  end: string | null; kind: 'incomplete' | 'actual' | 'calculated'; baselineEnd: string | null; baselineShift: number | null; currentEnd: string | null;
  issues: { stageId: string; code: string; message: string }[];
  rows: { id: string; start: string; end: string; source: 'fact' | 'calculation' | 'summary'; workDates: string[]; drivingIds: string[] }[];
  criticalIds: string[];
  phases: { name: string; ids: string[]; accepted: number; completed: number; running: string[]; blocked: string[] }[];
  accepted: number; total: number;
}
export function forecastSchedule(state: AppState, today?: string): ScheduleForecast;
export function simulateSchedule(state: AppState, change: { stageId: string; remainingDays: number; crew?: string; readyOn?: string }, today?: string): { forecast: ScheduleForecast | null; gainedDays: number | null };
