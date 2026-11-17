import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filePreviewKind } from '../src/domain/file-preview.js';

test('preview trusts signatures instead of filename or uploaded MIME', () => {
  const bytes = new TextEncoder().encode('<html><script>');
  assert.equal(filePreviewKind(bytes, 'contract.pdf').kind, 'download');
  assert.equal(filePreviewKind(bytes, 'photo.png').kind, 'download');
  assert.equal(filePreviewKind(bytes, 'note.txt').kind, 'text');
  assert.equal(filePreviewKind(new TextEncoder().encode('%PDF-1.7'), 'contract').mime, 'application/pdf');
  assert.equal(filePreviewKind(new Uint8Array([255, 216, 255]), 'photo').mime, 'image/jpeg');
});

test('svg and unknown files are downloads, while supported raster headers display', () => {
  assert.equal(filePreviewKind(new TextEncoder().encode('<svg onload='), 'photo.svg').kind, 'download');
  assert.equal(filePreviewKind(new Uint8Array([137,80,78,71,13,10,26,10]), 'scan.png').kind, 'image');
  assert.equal(filePreviewKind(new TextEncoder().encode('RIFFxxxxWEBP'), 'scan.webp').kind, 'image');
  assert.equal(filePreviewKind(new Uint8Array(), 'empty.pdf').kind, 'download');
});
