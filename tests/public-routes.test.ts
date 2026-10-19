import assert from 'node:assert/strict';
import test from 'node:test';

import { isPublicRoute } from '../server/public-routes.js';

test('allows only the explicit VPS ingress routes without application session auth', () => {
  assert.equal(isPublicRoute(new URL('https://example.test/api/health')), true);
  assert.equal(isPublicRoute(new URL('https://example.test/api/readiness')), true);
  assert.equal(isPublicRoute(new URL('https://example.test/api/integrations/telegram/bootstrap')), true);
  assert.equal(isPublicRoute(new URL('https://example.test/api/integrations/telegram/update')), true);
  assert.equal(isPublicRoute(new URL('https://example.test/api/public/leads')), true);

  assert.equal(isPublicRoute(new URL('https://example.test/api/leads')), false);
  assert.equal(isPublicRoute(new URL('https://example.test/api/state')), false);
  assert.equal(isPublicRoute(new URL('https://example.test/')), false);
});

import { isPublicBrandAsset } from '../server/public-routes.js';

test('public branding is an exact allowlist and never includes application data', () => {
  for (const path of ['/favicon.ico?v=20261019', '/manifest.webmanifest', '/brand/ikioma-mark-20261019.png', '/brand/icon-180-20261019.png', '/brand/icon-192-20261019.png', '/brand/icon-512-20261019.png']) {
    assert.equal(isPublicBrandAsset(new URL(path, 'https://example.test')), true, path);
  }
  for (const path of ['/', '/api/state', '/api/access/users', '/brand/private.png', '/brand/../api/state', '/brand/%2e%2e/api/state', '/files/invoice.pdf', '/manifest.webmanifest/extra']) {
    assert.equal(isPublicBrandAsset(new URL(path, 'https://example.test')), false, path);
  }
});
