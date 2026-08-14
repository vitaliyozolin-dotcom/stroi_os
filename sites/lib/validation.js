export const clean = (value, max = 240) => (
  typeof value === 'string' ? value.trim().slice(0, max) : ''
);

export const validProjectId = (value) => /^[a-zA-Z0-9._:-]{1,100}$/.test(value);

const ipv4Address = (value) => {
  const parts = String(value || '').split('.');
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255)
    ? parts.map((part) => String(Number(part))).join('.')
    : '';
};

export const normalizeClientAddress = (value) => {
  const candidate = clean(value, 200).split(',')[0].trim().replace(/^\[|\]$/g, '').split('%')[0];
  const ipv4 = ipv4Address(candidate);
  if (ipv4) return ipv4;
  const mapped = candidate.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped) return ipv4Address(mapped[1]) || 'unknown';
  if (!candidate.includes(':')) return 'unknown';
  try {
    const canonical = new URL(`http://[${candidate}]`).hostname.slice(1, -1);
    const [leftRaw, rightRaw = ''] = canonical.split('::');
    const left = leftRaw ? leftRaw.split(':') : [];
    const right = rightRaw ? rightRaw.split(':') : [];
    if (left.length + right.length > 8) return 'unknown';
    const expanded = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
    if (expanded.length !== 8 || expanded.some((part) => !/^[0-9a-f]{1,4}$/i.test(part))) return 'unknown';
    return `${expanded.slice(0, 4).map((part) => part.padStart(4, '0').toLowerCase()).join(':')}::/64`;
  } catch {
    return 'unknown';
  }
};

const bytesOf = (value) => value instanceof Uint8Array
  ? value
  : value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : ArrayBuffer.isView(value)
      ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      : new Uint8Array();

const startsWith = (bytes, signature) => signature.every((value, index) => bytes[index] === value);
const asciiAt = (bytes, offset, value) => Array.from(value).every((character, index) => bytes[offset + index] === character.charCodeAt(0));
const extensionOf = (name) => clean(name, 240).toLocaleLowerCase('en-US').split('.').pop() || '';
const declaredMime = (file) => clean(file?.type, 120).toLocaleLowerCase('en-US').split(';')[0];
const neutralMime = (value) => !value || value === 'application/octet-stream';

export const detectRasterImageType = (value) => {
  const bytes = bytesOf(value);
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WEBP')) return 'image/webp';
  return '';
};

export const rasterImageMimeType = (file, value) => {
  const detected = detectRasterImageType(value);
  const extension = extensionOf(file?.name);
  const declared = declaredMime(file);
  const extensions = detected === 'image/jpeg' ? ['jpg', 'jpeg'] : detected === 'image/png' ? ['png'] : detected === 'image/webp' ? ['webp'] : [];
  if (!detected || !extensions.includes(extension)) return '';
  return neutralMime(declared) || declared === detected ? detected : '';
};

const zipSignature = (bytes) => startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])
  || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])
  || startsWith(bytes, [0x50, 0x4b, 0x07, 0x08]);
const oleSignature = (bytes) => startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

const documentFormats = {
  pdf: { mime: 'application/pdf', declared: ['application/pdf'], magic: (bytes) => asciiAt(bytes, 0, '%PDF-') },
  jpg: { mime: 'image/jpeg', declared: ['image/jpeg'], magic: (bytes) => detectRasterImageType(bytes) === 'image/jpeg' },
  jpeg: { mime: 'image/jpeg', declared: ['image/jpeg'], magic: (bytes) => detectRasterImageType(bytes) === 'image/jpeg' },
  png: { mime: 'image/png', declared: ['image/png'], magic: (bytes) => detectRasterImageType(bytes) === 'image/png' },
  webp: { mime: 'image/webp', declared: ['image/webp'], magic: (bytes) => detectRasterImageType(bytes) === 'image/webp' },
  doc: { mime: 'application/msword', declared: ['application/msword'], magic: oleSignature },
  xls: { mime: 'application/vnd.ms-excel', declared: ['application/vnd.ms-excel'], magic: oleSignature },
  docx: {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    declared: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/zip'],
    magic: zipSignature,
  },
  xlsx: {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    declared: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/zip'],
    magic: zipSignature,
  },
};

export const documentMimeType = (file, value) => {
  const format = documentFormats[extensionOf(file?.name)];
  if (!format) return '';
  const bytes = bytesOf(value);
  const declared = declaredMime(file);
  if (!format.magic(bytes) || (!neutralMime(declared) && !format.declared.includes(declared))) return '';
  return format.mime;
};

export const supportedDocument = (file, value) => Boolean(documentMimeType(file, value));

export const safeFileName = (value) => {
  const normalized = clean(value, 180).replace(/[^\p{L}\p{N}._ -]+/gu, '_').replace(/\s+/g, ' ').trim();
  return normalized || 'document';
};
