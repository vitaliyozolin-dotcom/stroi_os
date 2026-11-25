import type { AppState, ActivityEvent, Lead, LeadStage } from '../entities/index';
export const salesStages: Array<{ key: LeadStage; code: string; label: string }>;
export function salesLabel(stage: LeadStage): string;
export function nextSalesStage(stage: LeadStage): LeadStage;
export function qualificationBlockers(lead: Lead): string[];
export function monthExpired(enteredAt: string, now: string): boolean;
export function migrateLead(lead: Lead, now: string, activity?: ActivityEvent[]): Lead;
export function escrowFundingBlockers(state: AppState): string[];
