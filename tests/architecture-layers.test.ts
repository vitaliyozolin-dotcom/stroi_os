import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const entityFiles = readdirSync(new URL('../src/entities/', import.meta.url), { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
  .map((entry) => entry.name);

const importSpecifier = /^\s*(?:import|export)\s+(?:type\s+)?(?:[^'"\n]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;

test('entities depend only on other files inside the entities layer', () => {
  for (const file of entityFiles) {
    const contents = source(`src/entities/${file}`);
    const specifiers = [...contents.matchAll(importSpecifier)].map((match) => match[1]);
    assert.ok(
      specifiers.every((specifier) => specifier.startsWith('./')),
      `${file} imports a dependency outside src/entities`,
    );
  }
});

test('entity consumers use public layer entrypoints', () => {
  const rootEntries = readdirSync(new URL('../src/', import.meta.url), { withFileTypes: true });
  const pending = rootEntries
    .filter((entry) => entry.isDirectory() && entry.name !== 'entities')
    .map((entry) => `src/${entry.name}`);
  const files = rootEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts') || entry.isFile() && entry.name.endsWith('.tsx'))
    .map((entry) => `src/${entry.name}`);

  while (pending.length) {
    const directory = pending.pop();
    if (!directory) break;
    for (const entry of readdirSync(new URL(`../${directory}/`, import.meta.url), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && /\.tsx?$/.test(entry.name)) files.push(path);
    }
  }

  for (const file of files) {
    const contents = source(file);
    assert.doesNotMatch(contents, /from\s+['"][^'"]*entities\/(?!index(?:['"]|\.ts['"]))[^'"]+['"]/, `${file} bypasses the entities entrypoint`);
    assert.equal(contents.includes("from './types'") || contents.includes("from './types.ts'") || contents.includes("from '../types'") || contents.includes("from '../types.ts'"), false, `${file} imports the removed compatibility facade`);
  }

});

test('navigation types belong to presentation, not entities', () => {
  assert.ok(source('src/presentation/navigation.ts').includes('export type PageId ='));
  for (const file of entityFiles) {
    assert.equal(source(`src/entities/${file}`).includes('PageId'), false, `${file} contains a presentation type`);
  }
});

test('domain slices depend only on entities and their own files', () => {
  const domainFiles = readdirSync(new URL('../src/domain/', import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => entry.name);

  for (const file of domainFiles) {
    const contents = source(`src/domain/${file}`);
    const specifiers = [...contents.matchAll(importSpecifier)].map((match) => match[1]);
    assert.ok(
      specifiers.every((specifier) => specifier.startsWith('./') || specifier === '../entities/index'),
      `${file} imports a dependency outside domain or entities`,
    );
  }
});

test('business pages persist project changes through StateChange sinks', () => {
  const pages = [
    'TasksPage.tsx',
    'QualityPage.tsx',
    'FinancePage.tsx',
    'ProcurementPage.tsx',
    'SchedulePage.tsx',
    'ProjectPage.tsx',
    'CounterpartiesPage.tsx',
    'MarketingPage.tsx',
    'ClientPage.tsx',
    'SettingsPage.tsx',
  ];

  for (const page of pages) {
    const contents = source(`src/pages/${page}`);
    assert.doesNotMatch(contents, /\bonChange\(\{\s*\.\.\.state/, `${page} writes AppState directly`);
    assert.match(contents, /commitStateChange|create[A-Z][A-Za-z0-9_]+Commands/, `${page} bypasses StateChange metadata`);
  }
});

test('UI delegates HTTP transport to infrastructure', () => {
  for (const file of ['src/App.tsx', ...readdirSync(new URL('../src/pages/', import.meta.url)).filter((name) => name.endsWith('.tsx')).map((name) => `src/pages/${name}`), ...readdirSync(new URL('../src/components/', import.meta.url)).filter((name) => name.endsWith('.tsx')).map((name) => `src/components/${name}`)]) {
    assert.doesNotMatch(source(file), /\bfetch\(/, `${file} performs HTTP transport directly`);
  }
});

test('project synchronization is runtime-neutral and the storage compatibility facade stays removed', () => {
  const sync = source('src/application/project-sync.ts');
  assert.doesNotMatch(sync, /from ['"]react|\bfetch\(|\bwindow\.|\bdocument\.|indexedDB/);
  assert.match(sync, /reconcileRemoteSnapshot/);
  assert.match(sync, /reconcileRevisionConflict/);

  assert.equal(existsSync(new URL('../src/storage.ts', import.meta.url)), false);
});

test('App composes project adapters while the synchronization hook depends only on application ports', () => {
  const app = source('src/App.tsx');
  const hook = source('src/useProjectState.ts');
  const ports = source('src/application/ports.ts');

  assert.match(ports, /interface ProjectRepository/);
  assert.match(ports, /interface ProjectCacheFactory/);
  assert.match(ports, /class ProjectRevisionConflict/);
  assert.match(app, /projectStateDependencies/);
  assert.match(hook, /dependencies: ProjectStateDependencies/);
  assert.match(hook, /repository\.(?:list|load|save)/);
  assert.match(hook, /cacheFactory\.create/);
  assert.match(source('src/application/project-sync-workflow.ts'), /flushProjectChanges/);
  assert.doesNotMatch(hook, /from ['"].*infrastructure|fetchRemoteProject|fetchRemoteProjects|saveRemoteProject|RevisionConflictError|createProjectCache|ProjectCacheWriter/);
});
