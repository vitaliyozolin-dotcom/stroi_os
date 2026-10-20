import { useRef } from 'react';
import type { AppState } from './entities/index';
import type { StateChangeSink } from './application/state-change';

/** Composition only: repositories read the latest draft, including consecutive actions
 * before React renders again. Each repository remains bound to the project it opened on. */
export const useModuleRepository = <R>(create: (read: () => AppState, sink: StateChangeSink) => R, state: AppState, onChange: StateChangeSink): R => {
  const latest = useRef(state);
  latest.current = state;
  return create(() => latest.current, (next, metadata) => { onChange(next, metadata); latest.current = next; });
};
