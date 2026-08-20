import type { AppState } from '../entities/index';

export interface ChangeMetadata {
  action: string;
  summary: string;
}

export interface StateChange extends ChangeMetadata {
  state: AppState;
}

export interface MutationContext {
  actor: string;
  timestamp: string;
  nextId: (prefix: string) => string;
}
