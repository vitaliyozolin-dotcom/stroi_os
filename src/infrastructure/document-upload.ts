import { requestApi } from './api-http';
import type { DocumentUploadPort } from '../application/project-documents';
export const documentUploader: DocumentUploadPort = {
 async upload(projectId, file, signal) {
  const payload = new FormData(); payload.append('file', file);
  const response = await requestApi(`/api/documents/upload?projectId=${encodeURIComponent(projectId)}`, { method: 'POST', body: payload, signal });
  const body = await response.json() as { file?: { key: string; name: string; type: string; size: number; uploadedAt: string }; error?: string };
  if (!response.ok || !body.file) throw new Error(body.error ?? 'upload_failed');
  return body.file;
 },
};
