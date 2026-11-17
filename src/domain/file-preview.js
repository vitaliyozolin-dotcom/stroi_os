/** Only known raster and PDF signatures can become active browser previews. */
export function filePreviewKind(bytes, name = '') {
  const starts = (...values) => values.every((value, index) => bytes[index] === value);
  const ascii = (start, count) => String.fromCharCode(...Array.from(bytes.slice(start, start + count)));
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { kind: 'image', mime: 'image/png' };
  if (starts(0xff, 0xd8, 0xff)) return { kind: 'image', mime: 'image/jpeg' };
  if (['GIF87a', 'GIF89a'].includes(ascii(0, 6))) return { kind: 'image', mime: 'image/gif' };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return { kind: 'image', mime: 'image/webp' };
  if (ascii(0, 5) === '%PDF-') return { kind: 'pdf', mime: 'application/pdf' };
  if (/\.(txt|md|csv|log)$/i.test(name)) return { kind: 'text', mime: 'text/plain;charset=utf-8' };
  return { kind: 'download', mime: 'application/octet-stream' };
}
