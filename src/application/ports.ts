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
export interface CachedProject extends ProjectSnapshot { dirty: boolean; }
export type ProjectCacheErrorCode = 'corrupt' | 'quota_exceeded' | 'unavailable';
export class ProjectCacheError extends Error {
  readonly code: ProjectCacheErrorCode;

  constructor(code: ProjectCacheErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'ProjectCacheError';
    this.code = code;
  }
}
export type CacheWriteStatus = 'saving' | 'saved' | 'failed';
export interface ProjectCachePort { load(projectId?: string): Promise<CachedProject>; save(project: CachedProject): Promise<void>; }
export interface ProjectCacheSession { load(projectId?: string): Promise<CachedProject>; schedule(project: CachedProject): void; flush(): Promise<void>; }
export interface ProjectCacheFactory {
  create(identity: string, normalizeState: (state: AppState) => AppState, onStatus: (status: CacheWriteStatus, projectId: string, error?: ProjectCacheError) => void): ProjectCacheSession;
}
export interface SessionProvider { current(): Promise<{ id: string; name: string; role: UserRole } | null>; }
export interface FileRepository { upload(path: string, file: Blob): Promise<{ id: string; key: string }>; }

export interface Clock {
  now(): string;
}

export interface IdGenerator {
  next(prefix: string): string;
}
