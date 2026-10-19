import assert from 'node:assert/strict';
import test from 'node:test';
import { allowedPages, isPageId, pageLabels, readWorkspaceRoute, workspacePath, type PageId } from '../src/presentation/navigation.ts';
import { serveSpa } from '../sites/worker.js';

test('all workspace sections round-trip through project paths and entity links', () => {
  for (const page of Object.keys(pageLabels) as PageId[]) {
    const url = new URL(workspacePath('house.1:west', page, 'entry/1 & 2'), 'https://example.test');
    assert.deepEqual(readWorkspaceRoute(url.pathname, url.search), {
      valid: true, projectId: 'house.1:west', page, entityId: 'entry/1 & 2',
    });
  }
});

test('notification query links preserve the project, page and target entity', () => {
  assert.deepEqual(readWorkspaceRoute('/', '?projectId=house-1&page=tasks&entity=task-2'), {
    valid: true, projectId: 'house-1', page: 'tasks', entityId: 'task-2',
  });
  assert.equal(readWorkspaceRoute('/', '?projectId=ikioma-sales&page=marketing').projectId, null);
  assert.deepEqual(readWorkspaceRoute('/', ''), { valid: true, projectId: null, page: null, entityId: null });
});

test('path routing takes precedence over stale query navigation parameters', () => {
  assert.deepEqual(readWorkspaceRoute('/projects/house-1/finance', '?projectId=house-2&page=tasks&entity=entry-3'), {
    valid: true, projectId: 'house-1', page: 'finance', entityId: 'entry-3',
  });
});

test('malformed and unknown routes cannot resolve to a business section', () => {
  for (const path of ['/missing', '/projects/a/no-such-page', '/projects/a/finance/extra', '/projects/%ZZ/tasks', '/projects/a%2Fb/tasks', '/projects/a%20b/tasks']) {
    assert.equal(readWorkspaceRoute(path, '').valid, false, path);
  }
  assert.equal(readWorkspaceRoute('/', '?projectId=a%2Fb&page=tasks').valid, false);
  assert.equal(isPageId('constructor'), false);
  assert.equal(isPageId('__proto__'), false);
});

test('route visibility preserves management, foreman and client boundaries', () => {
  assert.deepEqual(allowedPages('client'), ['client']);
  assert.deepEqual(allowedPages('foreman'), ['overview', 'project', 'tasks', 'schedule', 'procurement', 'quality']);
  assert.ok(allowedPages('management').includes('finance'));
  assert.ok(allowedPages('management').includes('settings'));
  assert.equal(allowedPages('management').includes('client'), false);
});

test('direct workspace URLs serve the application shell, including dotted project IDs', async () => {
  const requests: string[] = [];
  const env = { ASSETS: { fetch: async (request: Request) => {
    const path = new URL(request.url).pathname;
    requests.push(path);
    return new Response(path === '/index.html' ? 'application shell' : 'missing', { status: path === '/index.html' ? 200 : 404 });
  } } };
  for (const path of ['/projects/house-1/finance', '/projects/house.1/tasks']) {
    requests.length = 0;
    const response = await serveSpa(new Request(`https://example.test${path}`), env);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'application shell');
    assert.deepEqual(requests, [path, '/index.html']);
  }
  requests.length = 0;
  assert.equal((await serveSpa(new Request('https://example.test/assets/missing.js'), env)).status, 404);
  assert.deepEqual(requests, ['/assets/missing.js']);
  requests.length = 0;
  assert.equal((await serveSpa(new Request('https://example.test/projects/a/finance', { method: 'POST' }), env)).status, 404);
  assert.deepEqual(requests, ['/projects/a/finance']);
});
