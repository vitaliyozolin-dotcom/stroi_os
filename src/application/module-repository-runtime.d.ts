import type { ActivityEvent } from '../entities/index';
import type { ProjectScope } from '../domain/contexts';
import type { Clock, IdGenerator } from './ports';
import type { ModuleChange, ModuleRepository, ModuleResult, ModuleFailure } from './module-repository';
export type { ModuleContext, ModuleChange, ModuleRepository } from './module-repository';
export function moduleFingerprint(state: ProjectScope): string;
export function moduleChange<P>(state: ProjectScope, patch: P, action: string, summary: string, context: { identity: { name: string }; clock: Clock; ids: IdGenerator }, tone?: ActivityEvent['tone'], recordActivity?: boolean): ModuleChange<P>;
export function executeModule<S extends ProjectScope, P, R extends ModuleResult<P>>(repository: ModuleRepository<S, P>, command: (state: S) => R): R | ModuleFailure;
