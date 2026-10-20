import type { ChangeMetadata, MutationContext, StateChange } from '../domain/change';
import type { AppState } from '../entities/index';
import type { Clock, IdGenerator } from './ports';

export type StateChangeSink = (state: AppState, metadata?: ChangeMetadata) => void;

export const createMutationContext = (actor: string, clock: Clock, ids: IdGenerator): MutationContext => ({
  actor,
  timestamp: clock.now(),
  nextId: (prefix) => ids.next(prefix),
});

export const commitStateChange = (change: StateChange, sink: StateChangeSink) => {
  sink(change.state, { action: change.action, summary: change.summary });
};
