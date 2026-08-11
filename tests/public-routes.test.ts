import assert from 'node:assert/strict';
import test from 'node:test';

import { isPublicRoute } from '../server/public-routes.js';

test('allows only the explicit VPS ingress routes without Basic auth', () => {
  assert.equal(isPublicRoute(new URL('https://example.test/api/health')), true);
  assert.equal(isPublicRoute(new URL('https://example.test/api/integrations/telegram/update')), true);
  assert.equal(isPublicRoute(new URL('https://example.test/api/public/leads')), true);

  assert.equal(isPublicRoute(new URL('https://example.test/api/leads')), false);
  assert.equal(isPublicRoute(new URL('https://example.test/api/state')), false);
  assert.equal(isPublicRoute(new URL('https://example.test/')), false);
});
