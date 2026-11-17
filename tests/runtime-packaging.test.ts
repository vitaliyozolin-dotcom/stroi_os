import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Exercise the real production COPY manifest: a source-only test cannot detect a
// server module omitted from the final Docker image.
test('Docker runtime contains the complete worker import graph', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const target = await mkdtemp(join(tmpdir(), 'ikioma-runtime-'));
  try {
    await writeFile(join(target, 'package.json'), '{"type":"module"}');
    const docker = await readFile(join(root, 'Dockerfile'), 'utf8');
    const copies = [...docker.matchAll(/^COPY --from=build \/app\/((?:src|sites)\/\S+) (\.\/\S+)$/gm)];
    assert.ok(copies.length > 0);
    for (const [, source, destination] of copies) {
      const output = join(target, destination);
      await mkdir(dirname(output), { recursive: true });
      await cp(join(root, source), output, { recursive: true });
    }
    const worker = await import(pathToFileURL(join(target, 'sites/worker.js')).href);
    assert.equal(typeof worker.default.fetch, 'function');
  } finally { await rm(target, { recursive: true, force: true }); }
});
