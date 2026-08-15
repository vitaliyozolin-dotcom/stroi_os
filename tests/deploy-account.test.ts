import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const installer = readFileSync(
  new URL('../scripts/install-timeweb-deploy.sh', import.meta.url),
  'utf8',
);

test('restricted deploy user remains available for SSH keys without a known password', () => {
  assert.doesNotMatch(installer, /passwd\s+--lock/);
  assert.match(installer, /openssl rand -base64 48 \| openssl passwd -6 -stdin/);
  assert.match(installer, /usermod --password "\$deploy_password_hash" "\$DEPLOY_USER"/);
  assert.match(installer, /restrict,command=/);
});
