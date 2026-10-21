import type { ActivityEvent, UserRole } from '../entities/index';
import type { ProjectScope } from '../domain/contexts.ts';
import type { Clock, IdGenerator } from './ports.ts';

export interface ModuleContext { identity: { name: string; role: UserRole; id?: string; canManageAccess?: boolean }; clock: Clock; ids: IdGenerator }
export interface ModuleChange<Patch> { projectId: string; expected: string; patch: Patch; action: string; summary: string; event?: ActivityEvent }
export type ModuleFailure = { ok: false; error: string };
export type ModuleResult<Patch> = { ok: true; change: ModuleChange<Patch> | null } | ModuleFailure;
/** A successful commit stages an atomic local change. The existing sync workflow
 * owns durable writes, expected revisions, offline recovery and conflict resolution. */
export interface ModuleRepository<Snapshot extends ProjectScope, Patch> {
  read(): { ok: true; snapshot: Snapshot } | ModuleFailure;
  commit(change: ModuleChange<Patch>): { ok: true } | ModuleFailure;
}
export { moduleFingerprint, moduleChange, executeModule } from './module-repository-runtime.js';
