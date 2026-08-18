import { projectIdentity } from '../access-control.js';
import { json } from '../lib/http.js';
import { readFormDataLimited, readStreamPrefix } from '../lib/request-body.js';
import { claimUploadAdmission } from '../lib/upload-admission.js';
import {
  clean,
  detectRasterImageType,
  documentMimeType,
  rasterImageMimeType,
  safeFileName,
  validProjectId,
} from '../lib/validation.js';
import { protectedFileHeaders } from './response.js';

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_QUALITY_PHOTO_BYTES = 12 * 1024 * 1024;
const MAX_MULTIPART_OVERHEAD_BYTES = 256 * 1024;

export const createFileHandlers = ({ ensureSchema, readSnapshot }) => {
  const qualityPhotoUpload = async (request, env) => {
    if (!env.DB || !env.BUCKET) return json({ ok: false, error: 'storage_unavailable' }, 503);
    const url = new URL(request.url);
    const projectId = clean(url.searchParams.get('projectId'), 100);
    const checkpointId = clean(url.searchParams.get('checkpointId'), 100);
    if (!validProjectId(projectId) || !validProjectId(checkpointId)) return json({ ok: false, error: 'invalid_checkpoint' }, 422);
    try {
      await ensureSchema(env.DB);
      const snapshot = await readSnapshot(env.DB, projectId);
      const identity = snapshot ? projectIdentity(request, env, snapshot.state) : null;
      const checkpoint = (snapshot?.state?.checkpoints ?? []).find((item) => clean(item.id, 100) === checkpointId);
      if (!identity || identity.role === 'client' || !checkpoint) return json({ ok: false, error: 'project_access_denied' }, 403);
      const releaseUpload = claimUploadAdmission();
      if (!releaseUpload) return json({ ok: false, error: 'upload_busy' }, 429);
      try {
        const form = await readFormDataLimited(request, MAX_QUALITY_PHOTO_BYTES + MAX_MULTIPART_OVERHEAD_BYTES);
        const file = form.get('file');
        if (!file || typeof file === 'string' || typeof file.arrayBuffer !== 'function') return json({ ok: false, error: 'file_required' }, 422);
        if (Number(file.size) <= 0 || Number(file.size) > MAX_QUALITY_PHOTO_BYTES) return json({ ok: false, error: 'invalid_file_size' }, 413);
        const prefix = await file.slice(0, 512).arrayBuffer();
        const mimeType = rasterImageMimeType(file, prefix);
        if (!mimeType) return json({ ok: false, error: 'unsupported_file' }, 415);
        const name = safeFileName(file.name);
        const fileKey = `${projectId}/quality/${checkpointId}/${crypto.randomUUID()}-${name}`;
        const uploadedAt = new Date().toISOString();
        await env.BUCKET.put(fileKey, file.stream(), {
          maxBytes: MAX_QUALITY_PHOTO_BYTES,
          httpMetadata: { contentType: mimeType || 'application/octet-stream' },
          customMetadata: { projectId, checkpointId, originalName: name, uploadedBy: identity.id, uploadedAt },
        });
        return json({
          ok: true,
          photo: {
            id: crypto.randomUUID(), name, capturedAt: uploadedAt, fileKey, fileName: name, mimeType,
            sizeBytes: Number(file.size), uploadedAt, uploadedBy: identity.name, source: 'web',
          },
        }, 201);
      } finally {
        releaseUpload();
      }
    } catch (error) {
      if (error?.message === 'payload_too_large') return json({ ok: false, error: 'payload_too_large' }, 413);
      return json({ ok: false, error: 'upload_failed' }, 500);
    }
  };

  const qualityPhotoFile = async (request, env) => {
    if (!env.DB || !env.BUCKET) return json({ ok: false, error: 'storage_unavailable' }, 503);
    const url = new URL(request.url);
    const projectId = clean(url.searchParams.get('projectId'), 100);
    const key = clean(url.searchParams.get('key'), 500);
    if (!validProjectId(projectId) || !key.startsWith(`${projectId}/quality/`)) return json({ ok: false, error: 'invalid_file' }, 422);
    try {
      await ensureSchema(env.DB);
      const snapshot = await readSnapshot(env.DB, projectId);
      const identity = snapshot ? projectIdentity(request, env, snapshot.state) : null;
      if (!identity) return json({ ok: false, error: 'project_access_denied' }, 403);
      const checkpoint = (snapshot.state?.checkpoints ?? []).find((item) => (
        (item.photos ?? []).some((photo) => clean(photo.fileKey, 500) === key)
      ));
      if (!checkpoint || (identity.role === 'client' && !checkpoint.clientVisible)) return json({ ok: false, error: 'file_not_found' }, 404);
      const photo = (checkpoint.photos ?? []).find((item) => clean(item.fileKey, 500) === key);
      const object = await env.BUCKET.get(key);
      if (!object || !photo) return json({ ok: false, error: 'file_not_found' }, 404);
      let body = object.body;
      let mimeType = '';
      if (body?.tee) {
        const [probe, responseBody] = body.tee();
        body = responseBody;
        mimeType = detectRasterImageType(await readStreamPrefix(probe));
      }
      const filename = safeFileName(photo.fileName || photo.name || 'quality-photo');
      const headers = protectedFileHeaders(filename, 'quality-photo', { inlineMime: mimeType });
      if (object.httpEtag) headers.set('ETag', object.httpEtag);
      return new Response(body, { headers });
    } catch {
      return json({ ok: false, error: 'file_unavailable' }, 500);
    }
  };

  const documentUpload = async (request, env) => {
    if (!env.DB || !env.BUCKET) return json({ ok: false, error: 'storage_unavailable' }, 503);
    const projectId = clean(new URL(request.url).searchParams.get('projectId'), 100);
    if (!validProjectId(projectId)) return json({ ok: false, error: 'invalid_project' }, 422);
    try {
      await ensureSchema(env.DB);
      const snapshot = await readSnapshot(env.DB, projectId);
      const identity = snapshot ? projectIdentity(request, env, snapshot.state) : null;
      if (!identity || identity.role === 'client') return json({ ok: false, error: 'project_access_denied' }, 403);
      const releaseUpload = claimUploadAdmission();
      if (!releaseUpload) return json({ ok: false, error: 'upload_busy' }, 429);
      try {
        const form = await readFormDataLimited(request, MAX_FILE_BYTES + MAX_MULTIPART_OVERHEAD_BYTES);
        const file = form.get('file');
        if (!file || typeof file === 'string' || typeof file.arrayBuffer !== 'function') return json({ ok: false, error: 'file_required' }, 422);
        if (Number(file.size) <= 0 || Number(file.size) > MAX_FILE_BYTES) return json({ ok: false, error: 'invalid_file_size' }, 413);
        const prefix = await file.slice(0, 512).arrayBuffer();
        const mimeType = documentMimeType(file, prefix);
        if (!mimeType) return json({ ok: false, error: 'unsupported_file' }, 415);
        const name = safeFileName(file.name);
        const key = `${projectId}/${crypto.randomUUID()}-${name}`;
        const uploadedAt = new Date().toISOString();
        await env.BUCKET.put(key, file.stream(), {
          maxBytes: MAX_FILE_BYTES,
          httpMetadata: { contentType: mimeType },
          customMetadata: { projectId, originalName: name, uploadedBy: identity.id, uploadedAt },
        });
        return json({ ok: true, file: { key, name, type: mimeType, size: Number(file.size), uploadedAt } }, 201);
      } finally {
        releaseUpload();
      }
    } catch (error) {
      if (error?.message === 'payload_too_large') return json({ ok: false, error: 'payload_too_large' }, 413);
      return json({ ok: false, error: 'upload_failed' }, 500);
    }
  };

  const documentFile = async (request, env) => {
    if (!env.DB || !env.BUCKET) return json({ ok: false, error: 'storage_unavailable' }, 503);
    const url = new URL(request.url);
    const projectId = clean(url.searchParams.get('projectId'), 100);
    const key = clean(url.searchParams.get('key'), 500);
    if (!validProjectId(projectId) || !key.startsWith(`${projectId}/`)) return json({ ok: false, error: 'invalid_file' }, 422);
    try {
      await ensureSchema(env.DB);
      const snapshot = await readSnapshot(env.DB, projectId);
      const identity = snapshot ? projectIdentity(request, env, snapshot.state) : null;
      if (!identity) return json({ ok: false, error: 'project_access_denied' }, 403);
      const document = (snapshot.state?.documents ?? []).find((item) => clean(item.fileKey, 500) === key);
      if (!document || (identity.role === 'client' && !document.clientVisible)) return json({ ok: false, error: 'file_not_found' }, 404);
      const object = await env.BUCKET.get(key);
      if (!object) return json({ ok: false, error: 'file_not_found' }, 404);
      const headers = protectedFileHeaders(safeFileName(document.fileName || document.name), 'document');
      if (object.httpEtag) headers.set('ETag', object.httpEtag);
      return new Response(object.body, { headers });
    } catch {
      return json({ ok: false, error: 'file_unavailable' }, 500);
    }
  };

  const fieldReportFile = async (request, env) => {
    if (!env.DB || !env.BUCKET) return json({ ok: false, error: 'storage_unavailable' }, 503);
    const url = new URL(request.url);
    const projectId = clean(url.searchParams.get('projectId'), 100);
    const key = clean(url.searchParams.get('key'), 500);
    if (!validProjectId(projectId) || !key.startsWith(`${projectId}/`)) return json({ ok: false, error: 'invalid_file' }, 422);
    try {
      await ensureSchema(env.DB);
      const snapshot = await readSnapshot(env.DB, projectId);
      const identity = snapshot ? projectIdentity(request, env, snapshot.state) : null;
      if (!identity) return json({ ok: false, error: 'project_access_denied' }, 403);
      const report = (snapshot.state?.fieldReports ?? []).find((item) => (
        (item.attachments ?? []).some((attachment) => clean(attachment.key, 500) === key)
      ));
      if (!report || (identity.role === 'client' && !report.clientVisible)) return json({ ok: false, error: 'file_not_found' }, 404);
      const attachment = (report.attachments ?? []).find((item) => clean(item.key, 500) === key);
      const object = await env.BUCKET.get(key);
      if (!object || !attachment) return json({ ok: false, error: 'file_not_found' }, 404);
      const headers = protectedFileHeaders(safeFileName(attachment.name), 'field-report');
      if (object.httpEtag) headers.set('ETag', object.httpEtag);
      return new Response(object.body, { headers });
    } catch {
      return json({ ok: false, error: 'file_unavailable' }, 500);
    }
  };

  return { qualityPhotoUpload, qualityPhotoFile, documentUpload, documentFile, fieldReportFile };
};
