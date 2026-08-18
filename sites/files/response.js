import { safeFileName } from '../lib/validation.js';

export const protectedFileHeaders = (filename, fallbackName, { inlineMime = '' } = {}) => {
  const safeName = safeFileName(filename || fallbackName);
  const fallback = safeName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_') || fallbackName;
  const disposition = inlineMime ? 'inline' : 'attachment';
  return new Headers({
    'Cache-Control': 'private, no-store',
    'Content-Type': inlineMime || 'application/octet-stream',
    'Content-Disposition': `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(safeName)}`,
    'Content-Security-Policy': "sandbox; default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
};
