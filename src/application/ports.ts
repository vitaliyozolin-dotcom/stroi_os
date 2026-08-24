import type { AppState, UserRole } from '../entities/index';

export interface ProjectSnapshot { state: AppState; revision: number; updatedAt?: string; }
export interface RemoteProjectSnapshot extends ProjectSnapshot { projectId: string; updatedAt: string; updatedBy: string; updatedRole: UserRole; }
export interface SavedProjectSnapshot { projectId: string; revision: number; updatedAt: string; updatedBy: string; updatedRole: UserRole; state?: AppState; }
export interface ProjectListItem { id: string; code: string; name: string; model: string; area: number; address: string; targetDate: string; revision: number; updatedAt?: string; }
export interface SaveProjectInput { state: AppState; expectedRevision: number; actor: string; role: UserRole; action?: string; summary?: string; }
export interface ProjectRepository { list(): Promise<ProjectListItem[]>; load(projectId: string): Promise<RemoteProjectSnapshot | null>; save(input: SaveProjectInput): Promise<SavedProjectSnapshot>; }
export class ProjectRevisionConflict extends Error {
  readonly current: RemoteProjectSnapshot;

  constructor(current: RemoteProjectSnapshot) {
    super('revision_conflict');
    this.name = 'ProjectRevisionConflict';
    this.current = current;
  }
}
export interface ProjectCache { load(projectId?: string): Promise<ProjectSnapshot>; store(snapshot: ProjectSnapshot): Promise<void>; }
export interface SessionProvider { current(): Promise<{ id: string; name: string; role: UserRole } | null>; }
export interface FileRepository { upload(path: string, file: Blob): Promise<{ id: string; key: string }>; }

export interface Clock {
  now(): string;
}

export interface IdGenerator {
  next(prefix: string): string;
}
