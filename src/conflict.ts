import type { AppState } from './types';

type KeyedCollection = 'stages'
  | 'budgetLines'
  | 'financeEntries'
  | 'procurement'
  | 'counterparties'
  | 'supplierQuotes'
  | 'leads'
  | 'tasks'
  | 'fieldReports'
  | 'checkpoints'
  | 'documents'
  | 'decisions';

const keyedCollections: KeyedCollection[] = [
  'stages',
  'budgetLines',
  'financeEntries',
  'procurement',
  'counterparties',
  'supplierQuotes',
  'leads',
  'tasks',
  'fieldReports',
  'checkpoints',
  'documents',
  'decisions',
];

const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

const mergeObject = <T>(path: string, base: T, local: T, remote: T, conflicts: string[]): T => {
  const localChanged = !equal(local, base);
  const remoteChanged = !equal(remote, base);
  if (localChanged && remoteChanged && !equal(local, remote)) conflicts.push(path);
  return localChanged ? local : remote;
};

const mergeCollection = <T extends { id: string }>(
  name: string,
  base: T[],
  local: T[],
  remote: T[],
  conflicts: string[],
): T[] => {
  const baseMap = new Map(base.map((item) => [item.id, item]));
  const localMap = new Map(local.map((item) => [item.id, item]));
  const remoteMap = new Map(remote.map((item) => [item.id, item]));
  const orderedIds = [
    ...remote.map((item) => item.id),
    ...local.map((item) => item.id).filter((id) => !remoteMap.has(id)),
    ...base.map((item) => item.id).filter((id) => !remoteMap.has(id) && !localMap.has(id)),
  ];

  return [...new Set(orderedIds)].flatMap((id) => {
    const baseItem = baseMap.get(id);
    const localItem = localMap.get(id);
    const remoteItem = remoteMap.get(id);
    const localChanged = !equal(localItem, baseItem);
    const remoteChanged = !equal(remoteItem, baseItem);
    if (localChanged && remoteChanged && !equal(localItem, remoteItem)) conflicts.push(`${name}.${id}`);
    const chosen = localChanged ? localItem : remoteItem;
    return chosen ? [chosen] : [];
  });
};

export const mergeProjectStates = (base: AppState, local: AppState, remote: AppState) => {
  const conflicts: string[] = [];
  const state: AppState = {
    ...remote,
    version: 1,
    schemaVersion: Math.max(base.schemaVersion ?? 1, local.schemaVersion ?? 1, remote.schemaVersion ?? 1),
    project: mergeObject('project', base.project, local.project, remote.project, conflicts),
    budgetMeta: mergeObject('budgetMeta', base.budgetMeta, local.budgetMeta, remote.budgetMeta, conflicts),
    settings: mergeObject('settings', base.settings, local.settings, remote.settings, conflicts),
    activity: [...local.activity, ...remote.activity]
      .filter((item, index, items) => items.findIndex((candidate) => candidate.id === item.id) === index)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, 300),
  };

  for (const collection of keyedCollections) {
    (state[collection] as Array<{ id: string }>) = mergeCollection(
      collection,
      base[collection] as Array<{ id: string }>,
      local[collection] as Array<{ id: string }>,
      remote[collection] as Array<{ id: string }>,
      conflicts,
    );
  }

  return { state, conflicts };
};
