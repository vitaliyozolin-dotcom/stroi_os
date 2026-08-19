import { applyKelosiPpr } from './kelosiPpr.ts';
import { seedState } from './seed.ts';
import type { AppState } from './entities/index.ts';

const CACHE_ROOT = 'stroios.work.v17.';
const DATABASE_NAME = 'stroios-work-v17';
const DATABASE_VERSION = 1;
const PROJECT_STORE = 'projects';

export interface CachedProject {
  state: AppState;
  revision: number;
  dirty: boolean;
  updatedAt?: string;
}

export type ProjectCacheErrorCode = 'corrupt' | 'quota_exceeded' | 'unavailable';

export class ProjectCacheError extends Error {
  code: ProjectCacheErrorCode;

  constructor(code: ProjectCacheErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'ProjectCacheError';
    this.code = code;
  }
}

export interface ProjectCache {
  load(projectId?: string): Promise<CachedProject>;
  save(project: CachedProject): Promise<void>;
}

export const cloneSeedProject = (): CachedProject => ({ state: structuredClone(seedState), revision: 0, dirty: false });

const scopeHash = (value: string) => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

const isAppState = (value: unknown): value is AppState => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AppState>;
  return candidate.version === 1 && Boolean(candidate.project?.id)
    && Array.isArray(candidate.stages) && Array.isArray(candidate.financeEntries)
    && Array.isArray(candidate.procurement) && Array.isArray(candidate.checkpoints);
};

export const normalizeCachedProject = (value: unknown, normalizeState: (state: AppState) => AppState): CachedProject | null => {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<CachedProject>;
  if (!isAppState(candidate.state)) return null;
  return {
    state: applyKelosiPpr(normalizeState(candidate.state)),
    revision: Number.isInteger(candidate.revision) && Number(candidate.revision) >= 0 ? Number(candidate.revision) : 0,
    dirty: candidate.dirty === true,
    updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : undefined,
  };
};

const cacheError = (error: unknown) => {
  if (error instanceof ProjectCacheError) return error;
  if (error instanceof DOMException && error.name === 'QuotaExceededError') return new ProjectCacheError('quota_exceeded', error);
  return new ProjectCacheError('unavailable', error);
};

const requestResult = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  request.addEventListener('success', () => resolve(request.result), { once: true });
  request.addEventListener('error', () => reject(request.error ?? new Error('indexeddb_request_failed')), { once: true });
});

const transactionDone = (transaction: IDBTransaction) => new Promise<void>((resolve, reject) => {
  transaction.addEventListener('complete', () => resolve(), { once: true });
  transaction.addEventListener('abort', () => reject(transaction.error ?? new Error('indexeddb_transaction_aborted')), { once: true });
  transaction.addEventListener('error', () => reject(transaction.error ?? new Error('indexeddb_transaction_failed')), { once: true });
});

const openDatabase = (factory: IDBFactory) => new Promise<IDBDatabase>((resolve, reject) => {
  const request = factory.open(DATABASE_NAME, DATABASE_VERSION);
  request.addEventListener('upgradeneeded', () => {
    if (!request.result.objectStoreNames.contains(PROJECT_STORE)) request.result.createObjectStore(PROJECT_STORE);
  }, { once: true });
  request.addEventListener('success', () => resolve(request.result), { once: true });
  request.addEventListener('error', () => reject(request.error ?? new Error('indexeddb_open_failed')), { once: true });
  request.addEventListener('blocked', () => reject(new Error('indexeddb_open_blocked')), { once: true });
});

export const createProjectCache = (identity: string, normalizeState: (state: AppState) => AppState, browser: Pick<Window, 'indexedDB' | 'localStorage'> = window): ProjectCache => {
  const scope = scopeHash(identity.trim().toLocaleLowerCase('en-US'));
  const activeProjectKey = `${CACHE_ROOT}${scope}.active-project`;
  const legacyProjectKey = (projectId: string) => `${CACHE_ROOT}${scope}.project.${projectId}`;
  const databaseKey = (projectId: string) => `${scope}:${projectId}`;
  let databasePromise: Promise<IDBDatabase> | null = null;
  const database = () => (databasePromise ??= openDatabase(browser.indexedDB));
  const put = async (project: CachedProject) => {
    const db = await database();
    const transaction = db.transaction(PROJECT_STORE, 'readwrite');
    transaction.objectStore(PROJECT_STORE).put(project, databaseKey(project.state.project.id));
    await transactionDone(transaction);
  };

  return {
    async load(projectId) {
      try {
        const activeProjectId = projectId ?? browser.localStorage.getItem(activeProjectKey) ?? seedState.project.id;
        const db = await database();
        const transaction = db.transaction(PROJECT_STORE, 'readonly');
        const stored = await requestResult(transaction.objectStore(PROJECT_STORE).get(databaseKey(activeProjectId)));
        const cached = stored === undefined ? null : normalizeCachedProject(stored, normalizeState);
        if (stored !== undefined && !cached) throw new ProjectCacheError('corrupt');
        if (cached) return cached;
        const legacyRaw = browser.localStorage.getItem(legacyProjectKey(activeProjectId));
        if (!legacyRaw) return cloneSeedProject();
        let legacy: CachedProject | null;
        try { legacy = normalizeCachedProject(JSON.parse(legacyRaw), normalizeState); }
        catch (error) { throw new ProjectCacheError('corrupt', error); }
        if (!legacy) throw new ProjectCacheError('corrupt');
        await put(legacy);
        browser.localStorage.removeItem(legacyProjectKey(activeProjectId));
        return legacy;
      } catch (error) { throw cacheError(error); }
    },
    async save(project) {
      try {
        await put(project);
        browser.localStorage.setItem(activeProjectKey, project.state.project.id);
      } catch (error) { throw cacheError(error); }
    },
  };
};

export const clearProjectCache = async (browser: Pick<Window, 'indexedDB' | 'localStorage'> = window) => {
  try {
    Object.keys(browser.localStorage).filter((key) => key.startsWith(CACHE_ROOT)).forEach((key) => browser.localStorage.removeItem(key));
  } catch { /* Очистка IndexedDB всё равно продолжается. */ }
  await new Promise<void>((resolve) => {
    try {
      const request = browser.indexedDB.deleteDatabase(DATABASE_NAME);
      request.addEventListener('success', () => resolve(), { once: true });
      request.addEventListener('error', () => resolve(), { once: true });
      request.addEventListener('blocked', () => resolve(), { once: true });
    } catch { resolve(); }
  });
};

export type CacheWriteStatus = 'saving' | 'saved' | 'failed';

export class ProjectCacheWriter {
  private pending = new Map<string, CachedProject>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;
  private readonly cache: ProjectCache;
  private readonly onStatus: (status: CacheWriteStatus, projectId: string, error?: ProjectCacheError) => void;
  private readonly delayMs: number;

  constructor(cache: ProjectCache, onStatus: (status: CacheWriteStatus, projectId: string, error?: ProjectCacheError) => void, delayMs = 120) {
    this.cache = cache;
    this.onStatus = onStatus;
    this.delayMs = delayMs;
  }

  schedule(project: CachedProject) {
    const projectId = project.state.project.id;
    this.pending.set(projectId, project);
    this.onStatus('saving', projectId);
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.delayMs);
  }

  flush(): Promise<void> {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.flushing) return this.flushing;
    this.flushing = this.drain().finally(() => {
      this.flushing = null;
      if (this.pending.size) void this.flush();
    });
    return this.flushing;
  }

  private async drain() {
    while (this.pending.size) {
      const batch = [...this.pending.entries()];
      this.pending.clear();
      for (const [projectId, project] of batch) {
        try {
          await this.cache.save(project);
          if (!this.pending.has(projectId)) this.onStatus('saved', projectId);
        } catch (error) { this.onStatus('failed', projectId, cacheError(error)); }
      }
    }
  }
}
