import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import worker from '../sites/worker.js';
import { FileBucket } from './file-bucket.js';
import { PostgresDatabase } from './postgres.js';

const port = Number(process.env.PORT) || 3000;
const clientRoot = resolve(process.env.CLIENT_ROOT || 'dist/client');
const databaseUrl = process.env.DATABASE_URL;
const ownerEmail = process.env.OWNER_EMAIL || 'vitaliyozolin@gmail.com';
const basicUser = process.env.APP_USERNAME || 'vitaliy';
const basicPassword = process.env.APP_PASSWORD;

if (!databaseUrl) throw new Error('DATABASE_URL is required');
if (!basicPassword || basicPassword.length < 16) throw new Error('APP_PASSWORD must contain at least 16 characters');

const database = new PostgresDatabase(databaseUrl);
const bucket = new FileBucket(process.env.FILE_STORAGE_PATH || '/data/files');
const timingSafeEqualText = async (left, right) => {
  const { timingSafeEqual } = await import('node:crypto');
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

const basicIdentity = async (request) => {
  const header = request.headers.get('authorization') || '';
  if (!header.startsWith('Basic ')) return null;
  let decoded = '';
  try { decoded = Buffer.from(header.slice(6), 'base64').toString('utf8'); } catch { return null; }
  const separator = decoded.indexOf(':');
  if (separator < 0) return null;
  const user = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  const validUser = await timingSafeEqualText(user, basicUser);
  const validPassword = await timingSafeEqualText(password, basicPassword);
  return validUser && validPassword ? { email: ownerEmail, name: process.env.OWNER_NAME || 'Виталий Озолин' } : null;
};

const isPublicRoute = (url) => url.pathname === '/api/health' || url.pathname === '/api/integrations/telegram/update';
const unauthorized = () => new Response('Требуется вход в СтройОС', {
  status: 401,
  headers: { 'Content-Type': 'text/plain; charset=utf-8', 'WWW-Authenticate': 'Basic realm="StroiOS", charset="UTF-8"' },
});

const mimeTypes = {
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

const assetPath = (pathname) => {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = resolve(clientRoot, relative);
  if (target !== clientRoot && !target.startsWith(`${clientRoot}${sep}`)) return null;
  return target;
};

const assets = {
  async fetch(request) {
    const url = new URL(request.url);
    const target = assetPath(url.pathname);
    if (!target) return new Response('Not found', { status: 404 });
    try {
      const info = await stat(target);
      if (!info.isFile()) return new Response('Not found', { status: 404 });
      return new Response(Readable.toWeb(createReadStream(target)), {
        headers: {
          'Content-Type': mimeTypes[extname(target).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': target.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
        },
      });
    } catch { return new Response('Not found', { status: 404 }); }
  },
};

const env = {
  ...process.env,
  DB: database,
  BUCKET: bucket,
  ASSETS: assets,
  OWNER_EMAIL: ownerEmail,
  APP_PUBLIC_URL: process.env.APP_PUBLIC_URL || 'http://localhost',
};

const server = createServer(async (incoming, outgoing) => {
  try {
    const protocol = incoming.headers['x-forwarded-proto'] || 'http';
    const host = incoming.headers.host || `localhost:${port}`;
    const url = new URL(incoming.url || '/', `${protocol}://${host}`);
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
      else if (value != null) headers.set(name, value);
    }
    const request = new Request(url, {
      method: incoming.method,
      headers,
      body: ['GET', 'HEAD'].includes(incoming.method || 'GET') ? undefined : Readable.toWeb(incoming),
      duplex: 'half',
    });

    if (!isPublicRoute(url)) {
      const identity = await basicIdentity(request);
      if (!identity) return writeResponse(outgoing, unauthorized());
      headers.set('oai-authenticated-user-email', identity.email);
      headers.set('oai-authenticated-user-full-name', encodeURIComponent(identity.name));
      headers.set('oai-authenticated-user-full-name-encoding', 'percent-encoded-utf-8');
    }

    const authenticatedRequest = new Request(request, { headers });
    const response = await worker.fetch(authenticatedRequest, env, { waitUntil: (promise) => promise.catch(console.error) });
    await writeResponse(outgoing, response);
  } catch (error) {
    console.error(error);
    outgoing.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    outgoing.end(JSON.stringify({ ok: false, error: 'internal_error' }));
  }
});

const writeResponse = async (outgoing, response) => {
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) return outgoing.end();
  Readable.fromWeb(response.body).pipe(outgoing);
};

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    server.close();
    await database.close();
    process.exit(0);
  });
}

await access(clientRoot);
server.listen(port, '0.0.0.0', () => console.log(`stroios listening on ${port}`));
