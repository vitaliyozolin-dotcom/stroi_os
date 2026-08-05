import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';

const bodyToBuffer = async (body) => {
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (body && typeof body.getReader === 'function') {
    const chunks = [];
    for await (const chunk of Readable.fromWeb(body)) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
  if (body && typeof body.pipe === 'function') {
    const chunks = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
  return Buffer.from(body ?? '');
};

export class FileBucket {
  constructor(root) {
    this.root = resolve(root);
  }

  pathFor(key) {
    const target = resolve(this.root, key);
    if (target !== this.root && !target.startsWith(`${this.root}${sep}`)) throw new Error('invalid_file_key');
    return target;
  }

  async put(key, body, options = {}) {
    const target = this.pathFor(key);
    const buffer = await bodyToBuffer(body);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, buffer, { flag: 'wx' });
    await writeFile(`${target}.meta.json`, JSON.stringify({
      httpMetadata: options.httpMetadata ?? {},
      customMetadata: options.customMetadata ?? {},
      httpEtag: `\"${createHash('sha256').update(buffer).digest('hex')}\"`,
    }));
  }

  async get(key) {
    const target = this.pathFor(key);
    try {
      await stat(target);
      const metadata = JSON.parse(await readFile(`${target}.meta.json`, 'utf8').catch(() => '{}'));
      return {
        body: Readable.toWeb(createReadStream(target)),
        httpEtag: metadata.httpEtag,
        httpMetadata: metadata.httpMetadata ?? {},
        customMetadata: metadata.customMetadata ?? {},
        writeHttpMetadata(headers) {
          if (metadata.httpMetadata?.contentType) headers.set('Content-Type', metadata.httpMetadata.contentType);
          if (metadata.httpMetadata?.contentDisposition) headers.set('Content-Disposition', metadata.httpMetadata.contentDisposition);
        },
      };
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }
}
