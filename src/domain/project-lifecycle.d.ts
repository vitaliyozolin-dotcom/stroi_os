import type { AppState, Lead, ProjectLifecycle, UserRole } from '../entities/index';
export interface LifecycleDefinition {key: string; number: string; title: string; result: string; role: string; group: 'preparation'|'handover'; locked?: boolean; documents?: boolean; escrow?: boolean}
export const lifecycleDefinitions: LifecycleDefinition[];
export const lifecyclePhaseLabels: Record<ProjectLifecycle['phase'], string>;
export function createLifecycle(now: string, source?: Partial<ProjectLifecycle>): ProjectLifecycle;
export function lifecycleItemBlockers(state: AppState, key: string): string[];
export function lifecycleGroupProgress(state: AppState, group?: 'preparation'|'handover'): {total:number;completed:number;pending:string[]};
export function constructionLaunchBlockers(state: AppState): string[];
export function validateLifecycleChanges(previous: AppState|null, next: AppState, identity: {role: UserRole; name:string}, now?:string): string;
export function leadProjectIdentity(leadId:string): Promise<{id:string;code:string}>;
export function leadHandoffBlockers(lead:Lead):string[];
export function createLeadProjectState(base:AppState,lead:Lead,identity:{id:string;code:string},actor:string,now:string):AppState;

export function migrateLifecycle(route: ProjectLifecycle | undefined): ProjectLifecycle | undefined;
export function projectLead(state: AppState): Lead | undefined;
export function stepOwner(state: AppState, key: string): string;
export const milestoneKeys: Partial<Record<import('../entities/lead').LeadStage, string>>;
export function completedSalesStage(state: AppState): import('../entities/lead').LeadStage;
