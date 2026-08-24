import { seedState } from '../seed';
import { applyKelosiPpr } from '../kelosiPpr';
import type { AppState } from '../entities/index';
import { clearProjectCache } from './project-cache';
import { normalizeAppStateWithFallback } from '../domain/index';
import { ProjectRevisionConflict } from '../application/ports';
import type { ProjectListItem, ProjectRepository, RemoteProjectSnapshot, SavedProjectSnapshot, SaveProjectInput } from '../application/ports';

const redirectAfterAuthenticationFailure = (response: Response) => {
  if (response.status !== 401) return;
  clearProjectCache();
  window.location.assign('/login');
};

export type RemoteSnapshot = RemoteProjectSnapshot;
export type SaveResult = SavedProjectSnapshot;
export type { ProjectListItem };
export { ProjectRevisionConflict as RevisionConflictError };

export class StorageRequestError extends Error {
  code: string;

  constructor(code: string) {
    super(code);
    this.name = 'StorageRequestError';
    this.code = code;
  }
}

const cloneSeed = (): AppState => JSON.parse(JSON.stringify(seedState)) as AppState;

export const normalizeAppState = (state: AppState): AppState =>
  normalizeAppStateWithFallback(state, cloneSeed());

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
      if (error instanceof ProjectRevisionConflict) {
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
}: SaveProjectInput): Promise<SavedProjectSnapshot> => {
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
    if (body.current) throw new ProjectRevisionConflict(body.current);
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

export const projectRepository: ProjectRepository = {
  list: fetchRemoteProjects,
  load: fetchRemoteProject,
  save: saveRemoteProject,
};
