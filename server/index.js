import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import worker, { flushTelegramOutbox, initializeBattleRuntime } from '../sites/worker.js';
import { FileBucket } from './file-bucket.js';
import { PostgresDatabase } from './postgres.js';
import { isPublicRoute } from './public-routes.js';
import { createSessionAuth, LoginRateLimiter } from './auth.js';
import { loginPage } from './login-page.js';
import { ensureTelegramWebhook } from './telegram-webhook.js';
import { createBackgroundTaskTracker, createExclusiveTaskRunner } from './background-tasks.js';

const port = Number(process.env.PORT) || 3000;
const clientRoot = resolve(process.env.CLIENT_ROOT || 'dist/client');
const databaseUrl = process.env.DATABASE_URL;
const ownerEmail = process.env.OWNER_EMAIL || 'vitaliyozolin@gmail.com';
const ownerName = process.env.OWNER_NAME || 'Виталий Озолин';
const appUsername = process.env.APP_USERNAME || 'vitaliy';
const appPassword = process.env.APP_PASSWORD;

if (!databaseUrl) throw new Error('DATABASE_URL is required');

const auth = createSessionAuth({
  username: appUsername,
  password: appPassword,
  sessionSecret: process.env.SESSION_SECRET || appPassword,
  email: ownerEmail,
  name: ownerName,
});
const loginLimiter = new LoginRateLimiter();
const database = new PostgresDatabase(databaseUrl);
const bucket = new FileBucket(process.env.FILE_STORAGE_PATH || '/data/files');
const telegramOutboxIntervalMs = Math.max(15_000, Number(process.env.TELEGRAM_OUTBOX_INTERVAL_MS) || 30_000);

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

const htmlResponse = (html, status = 200, extraHeaders = {}) => new Response(html, {
  status,
  headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...extraHeaders,
  },
});

const redirect = (location, headers = {}) => new Response(null, {
  status: 303,
  headers: { Location: location, 'Cache-Control': 'no-store', ...headers },
});

const clientKey = (incoming) => String(incoming.headers['x-forwarded-for'] || incoming.socket.remoteAddress || 'unknown')
  .split(',')[0].trim();

const hasValidOrigin = (request) => {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  try { return new URL(origin).host === new URL(request.url).host; } catch { return false; }
};

const backgroundTasks = createBackgroundTaskTracker();
const trackBackground = backgroundTasks.waitUntil;
let shuttingDown = false;

const waitWithTimeout = async (promise, timeoutMs) => {
  let timeout;
  const result = await Promise.race([
    Promise.resolve(promise).then(() => true),
    new Promise((resolve) => {
      timeout = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  clearTimeout(timeout);
  return result;
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
    headers.set('oai-client-ip', clientKey(incoming));
    const request = new Request(url, {
      method: incoming.method,
      headers,
      body: ['GET', 'HEAD'].includes(incoming.method || 'GET') ? undefined : Readable.toWeb(incoming),
      duplex: 'half',
    });

    if (url.pathname === '/login' && request.method === 'GET') {
      const response = auth.fromRequest(request)
        ? redirect('/')
        : htmlResponse(loginPage());
      return writeResponse(outgoing, response);
    }

    if (url.pathname === '/api/auth/login' && request.method === 'POST') {
      if (!hasValidOrigin(request)) return writeResponse(outgoing, new Response('Forbidden', { status: 403 }));
      const key = clientKey(incoming);
      if (loginLimiter.isBlocked(key)) {
        return writeResponse(outgoing, htmlResponse(loginPage({ error: 'blocked', blocked: true }), 429, { 'Retry-After': '900' }));
      }
      const form = await request.formData();
      const username = String(form.get('username') || '').trim();
      const password = String(form.get('password') || '');
      if (!auth.verifyCredentials(username, password)) {
        loginLimiter.fail(key);
        return writeResponse(outgoing, htmlResponse(loginPage({ username, error: 'invalid' }), 401));
      }
      loginLimiter.success(key);
      return writeResponse(outgoing, redirect('/', { 'Set-Cookie': auth.sessionCookie(request) }));
    }

    if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
      if (!hasValidOrigin(request)) return writeResponse(outgoing, new Response('Forbidden', { status: 403 }));
      return writeResponse(outgoing, redirect('/login', { 'Set-Cookie': auth.clearCookie(request) }));
    }

    if (!isPublicRoute(url)) {
      const identity = auth.fromRequest(request);
      if (!identity) {
        const acceptsHtml = request.method === 'GET' && (request.headers.get('accept') || '').includes('text/html');
        const response = acceptsHtml
          ? redirect('/login')
          : Response.json({ ok: false, error: 'authentication_required' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
        return writeResponse(outgoing, response);
      }
      headers.set('oai-authenticated-user-email', identity.email);
      headers.set('oai-authenticated-user-full-name', encodeURIComponent(identity.name));
      headers.set('oai-authenticated-user-full-name-encoding', 'percent-encoded-utf-8');
    }

    const authenticatedRequest = new Request(request, { headers });
    const response = await worker.fetch(authenticatedRequest, env, { waitUntil: trackBackground });
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

let telegramOutboxTimer;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (telegramOutboxTimer) clearInterval(telegramOutboxTimer);
    const closed = await waitWithTimeout(new Promise((resolveClose) => server.close(resolveClose)), 20_000);
    if (!closed) server.closeAllConnections?.();
    const drained = await backgroundTasks.drain(20_000);
    if (!drained) console.error('background task drain timed out during shutdown');
    await database.close();
    process.exit(0);
  });
}

await initializeBattleRuntime(env);
await access(clientRoot);
server.listen(port, '0.0.0.0', () => {
  console.log(`stroios listening on ${port}`);
  const flushOutbox = createExclusiveTaskRunner(
    () => flushTelegramOutbox(env, 3).catch((error) => {
      console.error(`telegram outbox flush failed: ${error instanceof Error ? error.message : String(error)}`);
    }),
    trackBackground,
  );
  void flushOutbox();
  telegramOutboxTimer = setInterval(() => void flushOutbox(), telegramOutboxIntervalMs);
  trackBackground(ensureTelegramWebhook(process.env)
    .then((status) => {
      if (status.skipped) console.warn(`telegram webhook skipped: ${status.reason}`);
      else console.log(`telegram webhook ready: changed=${Boolean(status.changed)} pending=${status.pendingUpdateCount}`);
    })
    .catch((error) => console.error(`telegram webhook restore failed: ${error instanceof Error ? error.message : String(error)}`)));
});
