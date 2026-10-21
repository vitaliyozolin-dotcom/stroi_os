import { clean, safeFileName } from '../lib/validation.js';
import { claimUploadAdmission } from '../lib/upload-admission.js';
import { parseTelegramBody, telegramApiUrl, telegramRequest, telegramTransportHeaders } from './transport.js';

const MAX_FILE_BYTES = 20 * 1024 * 1024;

export const telegramFileToR2 = async (env, projectId, fileId, fileName, mimeType, uploadedBy, draftId) => {
  const metadataResponse = await telegramRequest(env.TELEGRAM_BOT_TOKEN, 'getFile', { file_id: fileId });
  const metadataBody = await parseTelegramBody(metadataResponse);
  if (!metadataResponse.ok || !metadataBody?.ok || !metadataBody.result?.file_path) throw new Error('telegram_file_unavailable');
  const declaredSize = Number(metadataBody.result.file_size) || 0;
  if (declaredSize > MAX_FILE_BYTES) throw new Error('telegram_file_too_large');
  const releaseUpload = claimUploadAdmission();
  if (!releaseUpload) throw new Error('upload_busy');
  try {
    const sourceResponse = await fetch(telegramApiUrl(`/file/bot${env.TELEGRAM_BOT_TOKEN}/${metadataBody.result.file_path}`), {
      headers: telegramTransportHeaders(),
      signal: AbortSignal.timeout(60_000),
    });
    if (!sourceResponse.ok || !sourceResponse.body) throw new Error('telegram_file_unavailable');
    const safeName = safeFileName(fileName);
    const stableDraftId = clean(draftId, 80) || crypto.randomUUID();
    const key = `${projectId}/telegram/${stableDraftId}-${safeName}`;
    const uploadedAt = new Date().toISOString();
    await env.BUCKET.put(key, sourceResponse.body, {
      maxBytes: MAX_FILE_BYTES,
      httpMetadata: { contentType: clean(mimeType, 120) || sourceResponse.headers.get('content-type') || 'application/octet-stream' },
      customMetadata: {
        projectId,
        originalName: safeName,
        uploadedBy: clean(uploadedBy, 160),
        uploadedAt,
        source: 'telegram',
      },
    });
    return {
      id: `attachment-telegram-${stableDraftId}`,
      key,
      name: safeName,
      mimeType: clean(mimeType, 120) || sourceResponse.headers.get('content-type') || 'application/octet-stream',
      sizeBytes: declaredSize || Number(sourceResponse.headers.get('content-length')) || 0,
      uploadedAt,
      uploadedBy: clean(uploadedBy, 160),
      source: 'telegram',
    };
  } finally {
    releaseUpload();
  }
};

export const resolveTelegramDraftFile = async (state, draft, loadAttachment) => {
  const isDocument = draft?.kind === 'document';
  const saved = isDocument
    ? (state?.documents ?? []).find((item) => item.sourceDraftId === draft?.id)
    : (state?.fieldReports ?? []).find((item) => item.sourceDraftId === draft?.id);
  if (!saved) return { existing: false, attachment: await loadAttachment(), saved: null };

  const attachment = isDocument
    ? {
      id: `attachment-telegram-${draft.id}`,
      key: clean(saved.fileKey, 500),
      name: clean(saved.fileName, 240) || clean(saved.name, 240) || clean(draft.payload?.fileName, 240) || 'Файл Telegram',
      mimeType: clean(saved.mimeType, 120) || clean(draft.payload?.mimeType, 120) || 'application/octet-stream',
      sizeBytes: Number(saved.sizeBytes) || 0,
      uploadedAt: clean(saved.uploadedAt, 80),
      uploadedBy: clean(saved.uploadedBy, 160),
      source: 'telegram',
    }
    : saved.attachments?.[0] ?? {
      id: `attachment-telegram-${draft.id}`,
      key: '',
      name: clean(draft.payload?.fileName, 240) || 'Файл Telegram',
      mimeType: clean(draft.payload?.mimeType, 120) || 'application/octet-stream',
      sizeBytes: 0,
      uploadedAt: clean(saved.createdAt, 80),
      uploadedBy: clean(saved.author, 160),
      source: 'telegram',
    };
  return { existing: true, attachment, saved };
};
