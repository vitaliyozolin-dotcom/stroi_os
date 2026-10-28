import type { ConstructionSnapshot } from '../contexts';
import type { Stage, StageSchedule, StageSiteUpdate } from '../../entities/index';
export function schedulePayload(value?: StageSchedule): Omit<StageSchedule, 'updatedAt' | 'updatedBy'> | null;
export function sitePayload(value?: StageSiteUpdate): Pick<StageSiteUpdate, 'asOf' | 'reviewOn' | 'remainingDays' | 'readyOn' | 'acceptanceOn' | 'note' | 'nextAction' | 'issueOwner'> | null;
export function addScheduleDays(day: string, count: number): string;
export function scheduleWorkDates(start: string, duration: number, schedule: Pick<StageSchedule, 'calendar' | 'daysOff'>): string[];
export function scheduleStartForFinish(finish: string, duration: number, schedule: Pick<StageSchedule, 'calendar' | 'daysOff'>): string;
export function confirmedSiteUpdate(stage: Stage, today?: string): boolean;
export interface ScheduleForecast {
  end: string | null; kind: 'incomplete' | 'actual' | 'calculated'; baselineEnd: string | null; baselineShift: number | null; currentEnd: string | null;
  issues: { stageId: string; code: string; message: string }[];
  rows: { id: string; start: string; end: string; source: 'fact' | 'calculation' | 'summary'; workDates: string[]; drivingIds: string[];
    latestStart: string | null; latestEnd: string | null; totalFloatDays: number | null; freeFloatDays: number | null }[];
  criticalIds: string[];
  cpmComplete: boolean; floatCalendar: 'calendar';
  phases: { name: string; ids: string[]; accepted: number; completed: number; running: string[]; blocked: string[] }[];
  accepted: number; total: number;
}
export function forecastSchedule(state: ConstructionSnapshot, today?: string): ScheduleForecast;
export function simulateSchedule(state: ConstructionSnapshot, change: { stageId: string; remainingDays: number; crew?: string; readyOn?: string }, today?: string): { forecast: ScheduleForecast | null; gainedDays: number | null };
