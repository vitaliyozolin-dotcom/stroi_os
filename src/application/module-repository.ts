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
export const moduleFingerprint = (state: ProjectScope) => JSON.stringify(state);
export const moduleChange = <P>(state: ProjectScope, patch: P, action: string, summary: string, context: { identity: { name: string }; clock: Clock; ids: IdGenerator }, tone: ActivityEvent['tone'] = 'neutral', recordActivity = true): ModuleChange<P> => ({
  projectId: state.project.id, expected: moduleFingerprint(state), patch, action, summary,
  event: recordActivity ? { id: context.ids.next('activity'), timestamp: context.clock.now(), actor: context.identity.name, text: summary, tone } : undefined,
});
export const executeModule = <S extends ProjectScope, P, R extends ModuleResult<P>>(repository: ModuleRepository<S, P>, command: (state: S) => R): R | ModuleFailure => {
  const read = repository.read();
  if (!read.ok) return read;
  const result = command(read.snapshot);
  if (!result.ok || !result.change) return result;
  const committed = repository.commit(result.change);
  return committed.ok ? result : committed;
};
