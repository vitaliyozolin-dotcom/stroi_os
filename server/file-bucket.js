import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { link, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const bodyToReadable = (body) => {
  if (body instanceof ArrayBuffer) return Readable.from([Buffer.from(body)]);
  if (ArrayBuffer.isView(body)) return Readable.from([Buffer.from(body.buffer, body.byteOffset, body.byteLength)]);
  if (body && typeof body.getReader === 'function') return Readable.fromWeb(body);
  if (body && typeof body.pipe === 'function') return body;
  return Readable.from([Buffer.from(body ?? '')]);
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
    const directory = dirname(target);
    const temporary = `${target}.upload-${randomUUID()}.tmp`;
    const metadataTarget = `${target}.meta.json`;
    const metadataTemporary = `${metadataTarget}.upload-${randomUUID()}.tmp`;
    const digest = createHash('sha256');
    const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : Number.POSITIVE_INFINITY;
    let size = 0;
    const inspect = new Transform({
      transform(chunk, encoding, callback) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
        size += buffer.byteLength;
        if (size > maxBytes) return callback(new Error('payload_too_large'));
        digest.update(buffer);
        callback(null, buffer);
      },
    });
    await mkdir(directory, { recursive: true });
    let dataLinked = false;
    let metadataLinked = false;
    try {
      await pipeline(bodyToReadable(body), inspect, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
      const metadata = JSON.stringify({
        httpMetadata: options.httpMetadata ?? {},
        customMetadata: options.customMetadata ?? {},
        httpEtag: `\"${digest.digest('hex')}\"`,
        sizeBytes: size,
      });
      await writeFile(metadataTemporary, metadata, { flag: 'wx', mode: 0o600 });
      await link(temporary, target);
      dataLinked = true;
      await link(metadataTemporary, metadataTarget);
      metadataLinked = true;
      await Promise.allSettled([unlink(temporary), unlink(metadataTemporary)]);
    } catch (error) {
      await Promise.allSettled([
        unlink(temporary),
        unlink(metadataTemporary),
        ...(metadataLinked ? [unlink(metadataTarget)] : []),
        ...(dataLinked ? [unlink(target)] : []),
      ]);
      throw error;
    }
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
