import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createProjectCache,
  ProjectCacheError,
  ProjectCacheWriter,
  type CachedProject,
} from '../src/projectCache.ts';
import { seedState } from '../src/seed.ts';

class MemoryStorage {
  [key: string]: unknown;
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); Object.defineProperty(this, key, { value, configurable: true, enumerable: true, writable: true }); }
  removeItem(key: string) { this.values.delete(key); delete this[key]; }
}

class FakeRequest<T> extends EventTarget {
  result!: T;
  error: DOMException | null = null;
  success(value: T) { this.result = value; queueMicrotask(() => this.dispatchEvent(new Event('success'))); }
}

class FakeTransaction extends EventTarget {
  error: DOMException | null = null;
  private readonly records: Map<string, unknown>;
  private readonly quotaFailure: boolean;
  constructor(records: Map<string, unknown>, quotaFailure: boolean) {
    super();
    this.records = records;
    this.quotaFailure = quotaFailure;
  }
  objectStore() {
    return {
      get: (key: string) => {
        const request = new FakeRequest<unknown>();
        request.success(this.records.get(key));
        return request;
      },
      put: (value: unknown, key: string) => {
        if (this.quotaFailure) {
          this.error = new DOMException('quota', 'QuotaExceededError');
          queueMicrotask(() => this.dispatchEvent(new Event('abort')));
        } else {
          this.records.set(key, structuredClone(value));
          queueMicrotask(() => this.dispatchEvent(new Event('complete')));
        }
      },
    };
  }
}

class FakeDatabase {
  objectStoreNames = { contains: () => true };
  readonly records: Map<string, unknown>;
  readonly quotaFailure: boolean;
  constructor(records = new Map<string, unknown>(), quotaFailure = false) {
    this.records = records;
    this.quotaFailure = quotaFailure;
  }
  createObjectStore() { return undefined; }
  transaction() { return new FakeTransaction(this.records, this.quotaFailure); }
}

class FakeOpenRequest extends FakeRequest<FakeDatabase> {
  constructor(database: FakeDatabase) {
    super();
    this.result = database;
    queueMicrotask(() => {
      this.dispatchEvent(new Event('upgradeneeded'));
      this.dispatchEvent(new Event('success'));
    });
  }
}

const browser = (database = new FakeDatabase()) => ({
  indexedDB: { open: () => new FakeOpenRequest(database) } as unknown as IDBFactory,
  localStorage: new MemoryStorage() as unknown as Storage,
});

const scopeHash = (value: string) => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

const snapshot = (projectId = 'project-1', revision = 1): CachedProject => {
  const state = structuredClone(seedState);
  state.project.id = projectId;
  return { state, revision, dirty: true };
};

test('migrates a valid legacy localStorage snapshot only after IndexedDB stores it', async () => {
  const environment = browser();
  const identity = 'owner@example.com|management';
  const scope = scopeHash(identity);
  const legacy = snapshot('project-legacy', 7);
  environment.localStorage.setItem(`stroios.work.v17.${scope}.active-project`, 'project-legacy');
  environment.localStorage.setItem(`stroios.work.v17.${scope}.project.project-legacy`, JSON.stringify(legacy));

  const cache = createProjectCache(identity, (state) => state, environment);
  const loaded = await cache.load();

  assert.equal(loaded.state.project.id, 'project-legacy');
  assert.equal(loaded.revision, 7);
  assert.equal(environment.localStorage.getItem(`stroios.work.v17.${scope}.project.project-legacy`), null);
  assert.ok(environment.indexedDB);
});

test('keeps a legacy snapshot when IndexedDB migration cannot write it', async () => {
  const environment = browser(new FakeDatabase(new Map(), true));
  const identity = 'owner@example.com|management';
  const scope = scopeHash(identity);
  const key = `stroios.work.v17.${scope}.project.project-legacy`;
  environment.localStorage.setItem(`stroios.work.v17.${scope}.active-project`, 'project-legacy');
  environment.localStorage.setItem(key, JSON.stringify(snapshot('project-legacy')));

  const cache = createProjectCache(identity, (state) => state, environment);
  await assert.rejects(cache.load(), (error: unknown) => error instanceof ProjectCacheError && error.code === 'quota_exceeded');
  assert.notEqual(environment.localStorage.getItem(key), null);
});

test('reports a corrupt snapshot instead of silently returning seed data', async () => {
  const identity = 'owner@example.com|management';
  const scope = scopeHash(identity);
  const records = new Map<string, unknown>([[`${scope}:broken`, { state: { project: { id: 'broken' } } }]]);
  const cache = createProjectCache(identity, (state) => state, browser(new FakeDatabase(records)));

  await assert.rejects(cache.load('broken'), (error: unknown) => error instanceof ProjectCacheError && error.code === 'corrupt');
});

test('coalesces rapid writes per project and preserves writes across project switches', async () => {
  const saved: CachedProject[] = [];
  const statuses: string[] = [];
  const writer = new ProjectCacheWriter(
    { load: async () => snapshot(), save: async (project) => { saved.push(project); } },
    (status, projectId) => statuses.push(`${status}:${projectId}`),
    60_000,
  );

  writer.schedule(snapshot('project-1', 1));
  writer.schedule(snapshot('project-1', 2));
  writer.schedule(snapshot('project-2', 3));
  await writer.flush();

  assert.deepEqual(saved.map((item) => [item.state.project.id, item.revision]), [['project-1', 2], ['project-2', 3]]);
  assert.ok(statuses.includes('saved:project-1'));
  assert.ok(statuses.includes('saved:project-2'));
});
