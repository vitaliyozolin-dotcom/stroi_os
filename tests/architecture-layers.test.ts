import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
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
