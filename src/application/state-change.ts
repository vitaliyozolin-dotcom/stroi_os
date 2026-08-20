import { changeProjectState } from '../domain/mutations.ts';
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

export const createPageStateSink = (
  current: AppState,
  defaults: ChangeMetadata,
  context: MutationContext,
  sink: StateChangeSink,
): ((next: AppState) => void) => (next) => {
  const activity = next.activity[0];
  const hasNewActivity = activity && activity.id !== current.activity[0]?.id;
  commitStateChange(changeProjectState(current, {
    patch: next,
    action: defaults.action,
    summary: hasNewActivity ? activity.text : defaults.summary,
    recordActivity: false,
  }, context), sink);
};
