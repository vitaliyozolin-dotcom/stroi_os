import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { FileBucket } from '../server/file-bucket.js';

test('file bucket streams to an atomic file and enforces its own byte ceiling', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stroios-file-bucket-'));
  const bucket = new FileBucket(root);
  try {
    const chunks = Array.from({ length: 32 }, (_, index) => Buffer.alloc(64 * 1024, index));
    await bucket.put('project/document.bin', Readable.toWeb(Readable.from(chunks)), {
      maxBytes: 3 * 1024 * 1024,
      httpMetadata: { contentType: 'application/octet-stream' },
    });
    assert.equal((await readFile(join(root, 'project/document.bin'))).byteLength, 2 * 1024 * 1024);
    assert.equal((await bucket.get('project/document.bin'))?.httpMetadata.contentType, 'application/octet-stream');
    assert.equal((await readdir(join(root, 'project'))).some((name) => name.includes('.upload-')), false);

    await assert.rejects(
      () => bucket.put('project/too-large.bin', Readable.toWeb(Readable.from([
        Buffer.alloc(700 * 1024), Buffer.alloc(700 * 1024),
      ])), { maxBytes: 1024 * 1024 }),
      /payload_too_large/,
    );
    assert.equal(await bucket.get('project/too-large.bin'), null);
    assert.equal((await readdir(join(root, 'project'))).some((name) => name.includes('too-large') || name.includes('.upload-')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
