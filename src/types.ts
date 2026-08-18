// Compatibility facade for existing consumers. New entity imports should use
// the public './entities/index' entrypoint.
export type * from './entities/index';

export type PageId =
  | 'overview'
  | 'project'
  | 'tasks'
  | 'marketing'
  | 'counterparties'
  | 'finance'
  | 'schedule'
  | 'procurement'
  | 'quality'
  | 'client'
  | 'settings';
