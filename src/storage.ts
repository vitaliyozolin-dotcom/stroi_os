import { seedState } from './seed';
import { applyKelosiPpr } from './kelosiPpr';
import type { AppState, UserRole } from './types';
import { clearProjectCache } from './projectCache';

const redirectAfterAuthenticationFailure = (response: Response) => {
  if (response.status !== 401) return;
  clearProjectCache();
  window.location.assign('/login');
};

export interface ProjectListItem {
  id: string;
  code: string;
  name: string;
  model: string;
  area: number;
  address: string;
  targetDate: string;
  revision: number;
  updatedAt?: string;
}

export interface RemoteSnapshot {
  projectId: string;
  state: AppState;
  revision: number;
  updatedAt: string;
  updatedBy: string;
  updatedRole: UserRole;
}

export interface SaveResult {
  projectId: string;
  revision: number;
  updatedAt: string;
  updatedBy: string;
  updatedRole: UserRole;
  state?: AppState;
}

export class RevisionConflictError extends Error {
  current: RemoteSnapshot;

  constructor(current: RemoteSnapshot) {
    super('revision_conflict');
    this.name = 'RevisionConflictError';
    this.current = current;
  }
}

export class StorageRequestError extends Error {
  code: string;

  constructor(code: string) {
    super(code);
    this.name = 'StorageRequestError';
    this.code = code;
  }
}

const cloneSeed = (): AppState => JSON.parse(JSON.stringify(seedState)) as AppState;

export const normalizeAppState = (state: AppState): AppState => {
  const fallback = cloneSeed();
  const sourceWidgets = Array.isArray(state.settings?.dashboardWidgets) ? state.settings.dashboardWidgets : fallback.settings.dashboardWidgets;
  const dashboardWidgets = Number(state.settings?.schemaVersion) >= 2 || sourceWidgets.includes('tasks')
    ? sourceWidgets
    : [...sourceWidgets, 'tasks' as const];
  return {
    ...state,
    budgetMeta: state.budgetMeta ?? fallback.budgetMeta,
    procurement: state.procurement.map((item) => ({
      ...item,
      budgetLineId: item.budgetLineId ?? state.budgetLines.find((line) => line.stageIds.includes(item.stageId))?.id,
      deliveryAddress: item.deliveryAddress ?? `Объект ${state.project.code}`,
    })),
    counterparties: Array.isArray(state.counterparties) ? state.counterparties : fallback.counterparties,
    supplierQuotes: Array.isArray(state.supplierQuotes) ? state.supplierQuotes : fallback.supplierQuotes,
    leads: Array.isArray(state.leads) ? state.leads : fallback.leads,
    tasks: (Array.isArray(state.tasks)
      ? state.tasks
      : state.project.id === fallback.project.id
        ? fallback.tasks
        : []
    ).map((task) => ({
      ...task,
      originalDueDate: task.originalDueDate ?? task.dueDate,
      rescheduleCount: Number(task.rescheduleCount) || 0,
      attachments: Array.isArray(task.attachments) ? task.attachments : [],
      history: Array.isArray(task.history) ? task.history : [],
    })),
    fieldReports: Array.isArray(state.fieldReports) ? state.fieldReports : [],
    settings: {
      schemaVersion: 17,
      users: Array.isArray(state.settings?.users) ? state.settings.users : fallback.settings.users,
      notifications: {
        channels: { ...fallback.settings.notifications.channels, ...state.settings?.notifications?.channels },
        events: { ...fallback.settings.notifications.events, ...state.settings?.notifications?.events },
      },
      dashboardWidgets,
    },
  };
};

export const isAppState = (value: unknown): value is AppState => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AppState>;
  return candidate.version === 1
    && Boolean(candidate.project?.id)
    && Array.isArray(candidate.stages)
    && Array.isArray(candidate.financeEntries)
    && Array.isArray(candidate.procurement)
    && Array.isArray(candidate.checkpoints);
};

export const fetchRemoteProjects = async (): Promise<ProjectListItem[]> => {
  let response: Response;
  try {
    response = await fetch('/api/projects', { headers: { Accept: 'application/json' }, cache: 'no-store' });
  } catch {
    throw new StorageRequestError('network_error');
  }
  if (!response.ok) {
    redirectAfterAuthenticationFailure(response);
    const body = await readError(response);
    throw new StorageRequestError(body.error ?? `http_${response.status}`);
  }
  const body = await response.json() as { projects?: ProjectListItem[] };
  return Array.isArray(body.projects) ? body.projects : [];
};

const readError = async (response: Response) => {
  try {
    return await response.json() as { error?: string; current?: RemoteSnapshot };
  } catch {
    return {};
  }
};

export const fetchRemoteProject = async (projectId: string): Promise<RemoteSnapshot | null> => {
  let response: Response;
  try {
    response = await fetch(`/api/state?projectId=${encodeURIComponent(projectId)}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
  } catch {
    throw new StorageRequestError('network_error');
  }

  if (response.status === 404) return null;
  if (!response.ok) {
    redirectAfterAuthenticationFailure(response);
    const body = await readError(response);
    throw new StorageRequestError(body.error ?? `http_${response.status}`);
  }

  const body = await response.json() as { snapshot?: RemoteSnapshot };
  if (!body.snapshot || !isAppState(body.snapshot.state)) throw new StorageRequestError('invalid_response');

  const normalizedState = normalizeAppState(body.snapshot.state);
  const migratedState = applyKelosiPpr(normalizedState);
  if (migratedState !== normalizedState) {
    try {
      const saved = await saveRemoteProject({
        state: migratedState,
        expectedRevision: body.snapshot.revision,
        actor: 'Система',
        role: 'management',
        action: 'schedule_import',
        summary: 'Импортирован ППР.xlsx в проект Келози',
      });
      return {
        ...body.snapshot,
        ...saved,
        state: saved.state ?? migratedState,
      };
    } catch (error) {
      if (error instanceof RevisionConflictError) {
        return { ...error.current, state: applyKelosiPpr(normalizeAppState(error.current.state)) };
      }
      return { ...body.snapshot, state: migratedState };
    }
  }

  return { ...body.snapshot, state: normalizedState };
};

export const saveRemoteProject = async ({
  state,
  expectedRevision,
  actor,
  role,
  action = 'project_update',
  summary = 'Обновлены данные проекта',
}: {
  state: AppState;
  expectedRevision: number;
  actor: string;
  role: UserRole;
  action?: string;
  summary?: string;
}): Promise<SaveResult> => {
  let response: Response;
  try {
    response = await fetch(`/api/state?projectId=${encodeURIComponent(state.project.id)}`, {
      method: 'PUT',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        projectId: state.project.id,
        expectedRevision,
        state,
        actor,
        role,
        action,
        summary,
      }),
    });
  } catch {
    throw new StorageRequestError('network_error');
  }

  if (response.status === 409) {
    const body = await readError(response);
    if (body.current) throw new RevisionConflictError(body.current);
    throw new StorageRequestError('revision_conflict');
  }
  if (!response.ok) {
    redirectAfterAuthenticationFailure(response);
    const body = await readError(response);
    throw new StorageRequestError(body.error ?? `http_${response.status}`);
  }

  const body = await response.json() as { snapshot?: SaveResult };
  if (!body.snapshot) throw new StorageRequestError('invalid_response');
  return body.snapshot.state && isAppState(body.snapshot.state)
    ? { ...body.snapshot, state: normalizeAppState(body.snapshot.state) }
    : body.snapshot;
};
