import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  detectRasterImageType,
  documentMimeType,
  rasterImageMimeType,
} from '../sites/lib/validation.js';
import { claimUploadAdmission, requestWithBodyLimit } from '../sites/worker.js';

const file = (name: string, type = '') => ({ name, type });
const bytes = (...values: number[]) => new Uint8Array(values);
const text = (value: string) => new TextEncoder().encode(value);
const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const jpeg = bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10);
const png = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00);
const webp = bytes(0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50);
const ole = bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);
const zip = bytes(0x50, 0x4b, 0x03, 0x04, 0x00);

test('quality images require a matching raster extension, MIME and magic signature', () => {
  assert.equal(detectRasterImageType(jpeg), 'image/jpeg');
  assert.equal(rasterImageMimeType(file('photo.jpg', 'image/jpeg'), jpeg), 'image/jpeg');
  assert.equal(rasterImageMimeType(file('photo.jpeg', 'application/octet-stream'), jpeg), 'image/jpeg');
  assert.equal(rasterImageMimeType(file('photo.png', 'image/png'), png), 'image/png');
  assert.equal(rasterImageMimeType(file('photo.webp', 'image/webp'), webp), 'image/webp');

  assert.equal(rasterImageMimeType(file('photo.svg', 'image/svg+xml'), text('<svg><script>alert(1)</script></svg>')), '');
  assert.equal(rasterImageMimeType(file('photo.jpg', 'image/jpeg'), text('<html><script>alert(1)</script>')), '');
  assert.equal(rasterImageMimeType(file('photo.jpg', 'image/png'), png), '');
  assert.equal(rasterImageMimeType(file('photo.png', 'text/html'), png), '');
});

test('documents require extension, compatible MIME and container signature', () => {
  assert.equal(documentMimeType(file('contract.pdf', 'application/pdf'), text('%PDF-1.7\n')), 'application/pdf');
  assert.equal(documentMimeType(file('contract.pdf', 'text/html'), text('<html>')), '');
  assert.equal(documentMimeType(file('contract.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), text('%PDF-1.7\n')), '');

  assert.equal(documentMimeType(file('legacy.doc', 'application/msword'), ole), 'application/msword');
  assert.equal(documentMimeType(file('table.xls', 'application/vnd.ms-excel'), ole), 'application/vnd.ms-excel');
  assert.equal(documentMimeType(file('fake.pdf', 'application/octet-stream'), ole), '');
  assert.equal(documentMimeType(file('letter.docx', 'application/octet-stream'), zip), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(documentMimeType(file('table.xlsx', 'application/zip'), zip), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(documentMimeType(file('archive.zip', 'application/zip'), zip), '');
  assert.equal(documentMimeType(file('page.html', 'application/octet-stream'), text('<html>')), '');
  assert.equal(documentMimeType(file('vector.svg', 'application/octet-stream'), text('<svg>')), '');
});

test('untrusted file endpoints force safe response headers and UI excludes active image types', () => {
  const worker = source('sites/worker.js');
  const fileRoutes = source('sites/files/routes.js');
  const fileResponse = source('sites/files/response.js');
  const requestBody = source('sites/lib/request-body.js');
  const uploadAdmission = source('sites/lib/upload-admission.js');
  const quality = source('src/pages/QualityPage.tsx');
  const project = source('src/pages/ProjectPage.tsx');

  assert.match(worker, /from '\.\/lib\/request-body\.js'/);
  assert.match(worker, /from '\.\/lib\/upload-admission\.js'/);
  assert.match(worker, /from '\.\/files\/routes\.js'/);
  assert.doesNotMatch(worker, /const drainReader =/);
  assert.doesNotMatch(worker, /let activeUploads =/);
  assert.doesNotMatch(worker, /const handleQualityPhotoUpload/);
  assert.doesNotMatch(worker, /const handleDocumentFile/);
  assert.match(fileResponse, /Content-Security-Policy': "sandbox; default-src 'none'/);
  assert.match(fileResponse, /Content-Type': inlineMime \|\| 'application\/octet-stream'/);
  assert.match(fileResponse, /const disposition = inlineMime \? 'inline' : 'attachment'/);
  assert.match(fileRoutes, /mimeType = detectRasterImageType\(await readStreamPrefix\(probe\)\)/);
  assert.match(requestBody, /void reader\.cancel\(\)\.catch\(\(\) => undefined\)/);
  assert.match(requestBody, /export const requestWithBodyLimit = \(request, limit\)/);
  assert.match(fileRoutes, /readFormDataLimited\(request, MAX_QUALITY_PHOTO_BYTES \+ MAX_MULTIPART_OVERHEAD_BYTES\)/);
  assert.match(fileRoutes, /readFormDataLimited\(request, MAX_FILE_BYTES \+ MAX_MULTIPART_OVERHEAD_BYTES\)/);
  assert.match(uploadAdmission, /const MAX_CONCURRENT_UPLOADS = 2/);
  assert.match(fileRoutes, /const releaseUpload = claimUploadAdmission\(\)/);
  assert.match(fileRoutes, /if \(!releaseUpload\) return json\(\{ ok: false, error: 'upload_busy' \}, 429\)/);
  assert.doesNotMatch(worker, /request\.(?:json|formData)\(\)/);
  assert.match(fileRoutes, /const mimeType = documentMimeType\(file, prefix\)/);
  assert.doesNotMatch(fileResponse, /Content-Disposition', `inline;/);
  assert.match(quality, /accept="image\/jpeg,image\/png,image\/webp"/);
  assert.doesNotMatch(quality, /accept="image\/\*"/);
  assert.match(quality, /\^data:image\\\/\(\?:jpeg\|png\|webp\);base64,/);
  assert.match(quality, /window\.open\(source, '_blank', 'noopener,noreferrer'\)/);
  assert.match(project, /Скачать файл/);
});

test('public lead JSON is streamed through a hard body limit before parsing', () => {
  const leads = source('sites/leads/routes.js');
  const requestBody = source('sites/lib/request-body.js');
  assert.match(leads, /const PUBLIC_LEAD_BODY_LIMIT = 32 \* 1024/);
  assert.match(requestBody, /export const readJsonBodyLimited = async \(request, limit\)/);
  assert.match(requestBody, /if \(size > limit\)/);
  assert.match(leads, /payload = await readJsonBodyLimited\(request, PUBLIC_LEAD_BODY_LIMIT\)/);
  assert.match(leads, /error\?\.message === 'payload_too_large' \? 413 : 400/);
});

test('large upload admission leaves two slots and rejects excess work immediately', () => {
  const first = claimUploadAdmission();
  const second = claimUploadAdmission();
  assert.equal(typeof first, 'function');
  assert.equal(typeof second, 'function');
  assert.equal(claimUploadAdmission(), null);
  first?.();
  const replacement = claimUploadAdmission();
  assert.equal(typeof replacement, 'function');
  second?.();
  replacement?.();
});

test('body limiter rejects an oversized delayed producer without cancelling it into a process crash', async () => {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(800));
      setTimeout(() => {
        controller.enqueue(new Uint8Array(800));
        controller.enqueue(new Uint8Array(16));
        controller.close();
      }, 5);
    },
  });
  const request = new Request('https://example.test/upload', {
    method: 'POST', body: source, duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  const limited = requestWithBodyLimit(request, 1_024);
  await assert.rejects(() => limited.arrayBuffer(), /payload_too_large/);
  await new Promise((resolve) => setTimeout(resolve, 20));
});
