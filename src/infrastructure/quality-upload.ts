import { requestApi } from './api-http';
import type { QualityUploadPort } from '../application/quality';
import type { EvidencePhoto } from '../entities/index';
export const qualityUploader: QualityUploadPort = {
 async upload(projectId, checkpointId, file, signal) {
  const body = new FormData(); body.append('file', file);
  const response = await requestApi(`/api/quality/upload?projectId=${encodeURIComponent(projectId)}&checkpointId=${encodeURIComponent(checkpointId)}`, { method: 'POST', body, signal });
  const payload = await response.json().catch(() => null) as { ok?: boolean; photo?: EvidencePhoto; error?: string } | null;
  if (!response.ok || !payload?.ok || !payload.photo) throw new Error(payload?.error || 'upload_failed');
  return payload.photo;
 },
};
