import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
test('web and Telegram use shared task and record commands with no runtime TypeScript dependencies', () => {
  assert.match(source('src/application/tasks.ts'), /from '.\/tasks-runtime\.js'/);
  assert.match(source('sites/telegram/business-commands.js'), /from '..\/..\/src\/application\/tasks-runtime\.js'/);
  for (const path of ['src/application/project-documents.ts', 'src/application/field-reports.ts']) {
    assert.match(source(path), /from '.\/project-records\.js'/);
  }
  assert.match(source('sites/telegram/business-commands.js'), /from '..\/..\/src\/application\/project-records\.js'/);
  assert.doesNotMatch(source('sites/telegram/write-actions.js'), /state\.tasks =|state\.fieldReports =|state\.documents =|sourceTelegramCallbackId:/);
  const prepare = source('scripts/prepare-sites-build.mjs'), docker = source('Dockerfile');
  for (const path of ['application/tasks-runtime', 'application/project-records', 'application/module-repository-runtime', 'domain/task-mutations', 'domain/document-records']) {
    const code = source(`src/${path}.js`);
    assert.doesNotMatch(code, /from ['"][^'"]+\.ts['"]|from ['"]react|\bfetch\(|\.DB\b|\.prepare\(|process\.env|\bAppState\b/);
    assert.ok(prepare.includes(`src/${path}.js`));
    assert.ok(docker.includes(`/app/src/${path}.js`));
  }
  assert.ok(prepare.includes('sites/telegram/business-commands.js'));
});

test('App and settings compose dedicated session, project, access and integration boundaries', () => {
  const app = source('src/App.tsx'), settings = source('src/pages/SettingsPage.tsx');
  assert.match(app, /useSession\(\)/);
  assert.match(app, /useWorkspaceProject\(session, role\)/);
  assert.match(app, /<CreateProjectDialog/);
  assert.doesNotMatch(app, /requestApi\(|\/api\/session|setProjectForm|createProjectState\(/);
  for (const name of ['AccessSettings', 'IntegrationSettings', 'NotificationSettingsPanel', 'DashboardSettings']) assert.ok(settings.includes(`<${name}`));
  assert.doesNotMatch(settings, /requestApi\(|\/api\/access|\/api\/integrations/);
  assert.match(settings, /key=\{props\.state\.project\.id\}/);
  assert.match(source('src/presentation/settings/useSettingsRequest.ts'), /snapshot\.projectId === projectId/);
});
