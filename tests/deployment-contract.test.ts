import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const sha256 = (path: string) =>
  createHash('sha256').update(readFileSync(new URL(`../${path}`, import.meta.url))).digest('hex');

test('production images are SHA-addressable and include Telegram modules', () => {
  const dockerfile = source('Dockerfile');
  const compose = source('compose.yaml');
  const caddy = source('deploy/Caddyfile');

  assert.match(dockerfile, /ARG BUILD_SHA=unknown/);
  assert.match(dockerfile, /ENV BUILD_SHA=\$BUILD_SHA/);
  assert.match(dockerfile, /sites\/telegram/);
  assert.match(dockerfile, /sites\/files/);
  assert.match(compose, /^name: stroios/m);
  assert.match(compose, /STROIOS_APP_IMAGE/);
  assert.match(compose, /STROIOS_RELAY_IMAGE/);
  assert.match(caddy, /dynamic a app 3000/);
  assert.match(caddy, /refresh 5s/);
});

test('Sites artifact includes every Telegram module imported by its Worker entrypoint', () => {
  const prepare = source('scripts/prepare-sites-build.mjs');

  for (const moduleName of ['bindings', 'commands', 'connection', 'drafts', 'inbox', 'outbox', 'project-store', 'rendering', 'transport']) {
    assert.match(
      prepare,
      new RegExp(`sites/telegram/${moduleName}\\.js.*dist/server/telegram/${moduleName}\\.js`),
    );
  }
});

test('Sites artifact includes Worker request-boundary modules', () => {
  const prepare = source('scripts/prepare-sites-build.mjs');

  for (const moduleName of ['request-body', 'upload-admission']) {
    assert.match(
      prepare,
      new RegExp(`sites/lib/${moduleName}\\.js.*dist/server/lib/${moduleName}\\.js`),
    );
  }
});

test('Sites artifact includes Worker file-route modules', () => {
  const prepare = source('scripts/prepare-sites-build.mjs');

  for (const moduleName of ['response', 'routes']) {
    assert.match(
      prepare,
      new RegExp(`sites/files/${moduleName}\\.js.*dist/server/files/${moduleName}\\.js`),
    );
  }
});

test('both runtime artifacts include extracted project, access, automation, integration and API boundaries', () => {
  const prepare = source('scripts/prepare-sites-build.mjs');
  const dockerfile = source('Dockerfile');
  for (const modulePath of ['access/session', 'access/users', 'automations/battle', 'feedback/routes', 'integrations/camera', 'integrations/notifications', 'integrations/telegram-access', 'leads/routes', 'projects/routes', 'projects/write', 'routes/api']) {
    assert.match(prepare, new RegExp(`sites/${modulePath}\\.js.*dist/server/${modulePath}\\.js`));
  }
  for (const directory of ['access', 'automations', 'feedback', 'integrations', 'leads', 'projects', 'routes']) {
    assert.match(dockerfile, new RegExp(`sites/${directory} ./sites/${directory}`));
  }
});

test('runtime initializes schema before listening while readiness itself stays read-only', () => {
  const worker = source('sites/worker.js');
  const server = source('server/index.js');

  assert.match(worker, /BATTLE_SCHEMA_KEY = 'battle_schema_version'/);
  assert.match(worker, /export const initializeBattleRuntime/);
  assert.ok(server.indexOf('await initializeBattleRuntime(env)') < server.indexOf('server.listen('));
  const readinessStart = worker.indexOf('export const battleReadiness');
  const readinessEnd = worker.indexOf('const ensureBattleReady', readinessStart);
  const readiness = worker.slice(readinessStart, readinessEnd);
  assert.match(readiness, /SELECT value FROM system_meta/);
  assert.doesNotMatch(readiness, /INSERT|UPDATE|DELETE|CREATE TABLE/);
});

test('deploy builds exact Git content, persists image pointers and rolls back signals', () => {
  const deploy = source('scripts/deploy-production.sh');

  assert.match(deploy, /git archive "\$target_commit"/);
  assert.match(deploy, /git status --porcelain --untracked-files=all/);
  assert.match(deploy, /insecure_placeholder_secret/);
  assert.match(deploy, /"\$previous_commit" == "\$target_commit"/);
  assert.match(deploy, /candidate_tag="stroios-runtime:candidate-/);
  assert.match(deploy, /docker image tag "\$candidate_tag" "\$target_tag"/);
  assert.match(deploy, /write_runtime_images "\$target_tag" "\$target_tag"/);
  assert.match(deploy, /trap 'rollback 129' HUP/);
  assert.match(deploy, /trap 'rollback 143' TERM/);
  assert.match(deploy, /getMe/);
  assert.match(deploy, /getWebhookInfo/);
  assert.match(deploy, /telegram_was_ready/);
  assert.match(deploy, /STROIOS_TELEGRAM_DEGRADED/);
  assert.match(deploy, /telegram_regressed/);
  assert.match(deploy, /public_readiness_check "\$target_commit"/);
  assert.match(deploy, /reload_caddy/);
  assert.match(deploy, /caddy validate --config \/etc\/caddy\/Caddyfile/);
  assert.match(deploy, /STROIOS_DEPLOY_ERROR service_health_failed service=\$service status=\$\{status:-missing\}/);
  assert.match(deploy, /docker inspect --format '\{\{json \.State\.Health\}\}' "\$container"/);
  assert.match(deploy, /logs --no-color --tail=120 "\$service"/);
  assert.match(deploy, /STROIOS_DEPLOY_ERROR internal_readiness_failed/);
  assert.match(deploy, /STROIOS_DEPLOY_ERROR public_readiness_failed status=/);
  assert.match(deploy, /INFRA_APPROVAL_FILE="\/var\/lib\/stroios-deploy\/approved-infra\.sha256"/);
  assert.match(deploy, /candidate_compose_sha.*approved_compose_sha/);
  assert.match(deploy, /candidate_caddy_sha.*approved_caddy_sha/);
  assert.match(deploy, /candidate_deploy_sha.*approved_deploy_sha/);
  assert.match(deploy, /manual_ops_rollout_required/);
  assert.match(deploy, /restored_app_image.*previous_app_image/);
  assert.match(deploy, /write_runtime_images "\$previous_app_tag" "\$previous_relay_tag"/);
  assert.match(deploy, /sync -f "\$temporary"[\s\S]*mv -f -- "\$temporary" \.env[\s\S]*sync -f "\$APP_DIR"/);
  assert.match(deploy, /STROIOS_DEPLOY_ROLLBACK telegram_not_restored/);
  assert.match(deploy, /STROIOS_DEPLOY_ROLLBACK_FAILED/);
  assert.match(deploy, /MAINTENANCE_LOCK_DIR="\/run\/lock\/stroios"/);
  assert.match(deploy, /LOCK_FILE="\$MAINTENANCE_LOCK_DIR\/maintenance\.lock"/);
  assert.match(deploy, /prune_release_tags_under_pressure/);
  assert.match(deploy, /prune_abandoned_candidate_tags/);
  assert.match(deploy, /docker builder prune --all --force/);
  assert.match(deploy, /STROIOS_BACKUP_PRUNE_ONLY=1/);
  assert.equal(
    (deploy.match(/\benv \\\n\s+BACKUP_DIR="\$BACKUP_DIR"/g) ?? []).length,
    2,
    'backup subprocesses must receive readonly names through env',
  );
  assert.doesNotMatch(deploy, /prune_backup_storage\(\) \{\n\s+BACKUP_DIR=/);
  assert.doesNotMatch(deploy, /backup_path="\$\( \\\n\s+BACKUP_DIR=/);
  assert.match(deploy, /\.env\.deploy\.\*/);
  assert.match(deploy, /STROIOS_BACKUP \$backup_path[\s\S]*backups_after_snapshot[\s\S]*docker_after_snapshot/);
  assert.match(deploy, /webhookUrl\.protocol !== "https:"/);
  assert.match(deploy, /body\?\.result\?\.url !== expected/);
  assert.doesNotMatch(deploy, /install -d[^\n]+\/var\/lock/);
  assert.doesNotMatch(deploy, /down -v|volume prune|system prune/);

  const installer = source('scripts/install-timeweb-deploy.sh');
  assert.match(installer, /APPROVE_INFRA_SHA/);
  assert.match(installer, /approved-infra\.sha256/);
  assert.match(installer, /infrastructure_changed=1/);
  assert.match(installer, /Compose\/Caddy изменились\. Выполните ручной инфраструктурный rollout/);
  assert.ok(
    installer.indexOf('candidate_caddy_sha') <
      installer.indexOf('APPROVE_INFRA_SHA'),
  );
  assert.match(installer, /SAFE_BOOTSTRAP_COMPOSE_SHA256/);
  assert.match(installer, /SAFE_BOOTSTRAP_CADDY_SHA256/);
  assert.match(installer, /не разрешает неизвестную версию Compose\/Caddy/);
  assert.match(installer, /sync -f "\$dotenv_tmp"[\s\S]*mv -f -- "\$dotenv_tmp" \.env[\s\S]*sync -f "\$APP_DIR"/);
  assert.match(installer, new RegExp(`SAFE_BOOTSTRAP_COMPOSE_SHA256="${sha256('compose.yaml')}"`));
  assert.match(installer, new RegExp(`SAFE_BOOTSTRAP_CADDY_SHA256="${sha256('deploy/Caddyfile')}"`));
  assert.doesNotMatch(installer, /caddy reload|infra_rollout_completed/);
  assert.ok(
    installer.indexOf('bootstrap_backup=') <
      installer.indexOf('install -o root -g root -m 0640 "$infra_approval_tmp" "$INFRA_APPROVAL_FILE"'),
  );
});

test('backup is verified and never performs an automatic restore', () => {
  const backup = source('scripts/backup.sh');

  assert.match(backup, /pg_dump .*--no-owner --no-acl/);
  assert.match(backup, /pg_restore --list/);
  assert.match(backup, /gzip -t/);
  assert.match(backup, /sha256sum --check/);
  assert.match(backup, /COMPLETE/);
  assert.match(backup, /SOURCE_COMMIT/);
  assert.match(backup, /BACKUP_RETENTION_COUNT/);
  assert.match(backup, /STROIOS_BACKUP_PRUNE_ONLY/);
  assert.match(backup, /mv -- "\$partial" "\$destination"[\s\S]*prune_backup_pressure/);
  assert.match(backup, /prune_backup_pressure "\$required_kb"/);
  assert.match(backup, /insufficient_backup_space_after_snapshot/);
  assert.match(backup, /insufficient_backup_capacity/);
  assert.match(backup, /pg_database_size\(current_database\(\)\)/);
  assert.match(backup, /du -sk \/data\/files/);
  assert.match(backup, /sync -f "\$BACKUP_ROOT"/);
  assert.match(backup, /VERIFIED[\s\S]*mv -- "\$partial" "\$destination"[\s\S]*COMPLETE/);
  assert.match(backup, /snapshot_published.*rm -f -- "\$destination\/COMPLETE"/s);
  assert.match(backup, /STROIOS_MAINTENANCE_LOCK_HELD/);
  assert.match(backup, /\/run\/lock\/stroios/);
  assert.doesNotMatch(backup, /install -d[^\n]+\/var\/lock/);
  assert.doesNotMatch(backup, /pg_restore .*--clean|docker compose down -v/);
});

test('manual database restore requires revoking resurrected access before app start', () => {
  const script = source('scripts/revoke-restored-access.sh');
  const implementation = source('server/revoke-restored-access.js');
  const docs = source('docs/timeweb-autodeploy.md');

  assert.match(script, /stop_app_before_access_revocation/);
  assert.match(script, /run --rm --no-deps app node server\/revoke-restored-access\.js/);
  assert.match(implementation, /BEGIN[\s\S]*UPDATE auth_sessions[\s\S]*UPDATE auth_tokens[\s\S]*DELETE FROM auth_login_limits[\s\S]*COMMIT/);
  assert.match(docs, /После любого ручного восстановления PostgreSQL[\s\S]*revoke-restored-access\.sh/);
});

test('GitHub deploy key is scoped away from checkout and build steps', () => {
  const ci = source('.github/workflows/ci.yml');
  const workflow = source('.github/workflows/deploy-timeweb.yml');
  const manualJob = workflow.slice(
    workflow.indexOf('  manual_validate:'),
    workflow.indexOf('  deploy:'),
  );
  const deployJob = workflow.slice(workflow.indexOf('  deploy:'));
  const configure = workflow.slice(workflow.indexOf('      - name: Configure restricted SSH'));

  assert.doesNotMatch(manualJob, /TIMEWEB_SSH_KEY|production-timeweb/);
  assert.match(ci, /npm run build/);
  assert.match(ci, /import\('\.\/dist\/server\/index\.js'\)/);
  assert.match(manualJob, /npm run build/);
  assert.match(manualJob, /import\('\.\/dist\/server\/index\.js'\)/);
  assert.doesNotMatch(deployJob, /npm ci|docker build|actions\/checkout/);
  assert.match(configure, /TIMEWEB_SSH_KEY: \$\{\{ secrets\.TIMEWEB_SSH_KEY \}\}/);
  assert.match(workflow, /terminal_marker=.*awk/);
  assert.doesNotMatch(workflow, /grep -Fqx "STROIOS_DEPLOY_OK/);
  assert.match(workflow, /needs: \[prepare, manual_validate\]/);
  assert.match(workflow, /actions\/checkout@[0-9a-f]{40}/);
  assert.match(workflow, /actions\/setup-node@[0-9a-f]{40}/);
  assert.match(workflow, /environment: production-timeweb/);
});
