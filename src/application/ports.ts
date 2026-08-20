import type { AppState, UserRole } from '../entities/index';

export interface ProjectSnapshot { state: AppState; revision: number; updatedAt?: string; }
export interface ProjectRepository { load(projectId: string): Promise<ProjectSnapshot | null>; save(input: { state: AppState; expectedRevision: number; actor: string; role: UserRole; action: string; summary: string }): Promise<ProjectSnapshot>; }
export interface ProjectCache { load(projectId?: string): Promise<ProjectSnapshot>; store(snapshot: ProjectSnapshot): Promise<void>; }
export interface SessionProvider { current(): Promise<{ id: string; name: string; role: UserRole } | null>; }
export interface FileRepository { upload(path: string, file: Blob): Promise<{ id: string; key: string }>; }

export interface Clock {
  now(): string;
}

export interface IdGenerator {
  next(prefix: string): string;
}
