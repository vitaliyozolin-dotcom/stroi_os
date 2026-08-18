import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import worker, { flushTelegramOutbox, initializeBattleRuntime } from '../sites/worker.js';
import { handleCompanyOsExport } from '../sites/company-os-export.js';
import { FileBucket } from './file-bucket.js';
import { PostgresDatabase } from './postgres.js';
import { isPublicRoute } from './public-routes.js';
import { loginPage } from './login-page.js';
import { activationPage, invalidActivationPage } from './access-page.js';
import {
  ACCESS_BODY_LIMIT,
  ACCESS_SCHEMA_VERSION,
  AccessError,
  UserAccessService,
  accessErrorResponse,
} from './user-access.js';
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
const isPlaceholderSecret = (value) => /^replace-with(?:-|$)/i.test(String(value || '').trim());
if (isPlaceholderSecret(appPassword)) throw new Error('APP_PASSWORD placeholder is forbidden');
try {
  const databasePassword = decodeURIComponent(new URL(databaseUrl).password || '');
  if (isPlaceholderSecret(databasePassword)) throw new Error('POSTGRES_PASSWORD placeholder is forbidden');
} catch (error) {
  if (error instanceof Error && error.message.includes('placeholder')) throw error;
}

const database = new PostgresDatabase(databaseUrl);
const userAccess = new UserAccessService({
  database,
  ownerEmail,
  ownerName,
  ownerUsername: appUsername,
  ownerPassword: appPassword,
  publicUrl: process.env.APP_PUBLIC_URL || 'http://localhost',
  sessionTtlMs: Number(process.env.AUTH_SESSION_TTL_HOURS) > 0
    ? Number(process.env.AUTH_SESSION_TTL_HOURS) * 60 * 60_000
    : undefined,
  inviteTtlMs: Number(process.env.AUTH_INVITE_TTL_HOURS) > 0
    ? Number(process.env.AUTH_INVITE_TTL_HOURS) * 60 * 60_000
    : undefined,
});
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
  AUTH_ROSTER_MODE: 'local_password',
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

const readBodyLimited = async (request, maxBytes = ACCESS_BODY_LIMIT) => {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new AccessError('request_too_large', 413);
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new AccessError('request_too_large', 413);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size).toString('utf8');
};

const readFormLimited = async (request) => new URLSearchParams(await readBodyLimited(request));
const readJsonLimited = async (request, maxBytes = 32 * 1024) => {
  try { return JSON.parse(await readBodyLimited(request, maxBytes)); }
  catch (error) {
    if (error instanceof AccessError) throw error;
    throw new AccessError('invalid_json', 400);
  }
};

const jsonNoStore = (body, status = 200) => Response.json(body, {
  status,
  headers: { 'Cache-Control': 'no-store' },
});

const handleAccessApi = async (request, identity) => {
  const url = new URL(request.url);
  if (!identity?.isOwner) return jsonNoStore({ ok: false, error: 'owner_required' }, 403);
  if (request.method !== 'GET' && !hasValidOrigin(request)) return jsonNoStore({ ok: false, error: 'forbidden_origin' }, 403);
  try {
    if (url.pathname === '/api/access/users' && request.method === 'GET') {
      const projectId = String(url.searchParams.get('projectId') || '').trim();
      const users = await userAccess.listProjectAccess(projectId);
      return jsonNoStore({ ok: true, authMode: 'local_password', users });
    }
    if (url.pathname === '/api/access/users' && request.method === 'POST') {
      const body = await readJsonLimited(request);
      const result = await userAccess.createProjectUser({
        projectId: String(body.projectId || '').trim(),
        actorEmail: identity.email,
        actorName: identity.name,
        profile: body.user,
      });
      return jsonNoStore({ ok: true, ...result }, 201);
    }
    const projectAccessMatch = url.pathname.match(/^\/api\/access\/users\/([^/]+)\/projects$/);
    if (projectAccessMatch && request.method === 'GET') {
      const projectId = String(url.searchParams.get('projectId') || '').trim();
      const result = await userAccess.listUserProjectAccess({
        projectId,
        userId: decodeURIComponent(projectAccessMatch[1]),
      });
      return jsonNoStore({ ok: true, ...result });
    }
    if (projectAccessMatch && request.method === 'PUT') {
      const body = await readJsonLimited(request);
      const result = await userAccess.setUserProjectAccess({
        projectId: String(body.projectId || '').trim(),
        userId: decodeURIComponent(projectAccessMatch[1]),
        projectIds: body.projectIds,
        actorEmail: identity.email,
        actorName: identity.name,
      });
      return jsonNoStore({ ok: true, ...result });
    }
    const profileMatch = url.pathname.match(/^\/api\/access\/users\/([^/]+)$/);
    if (profileMatch && request.method === 'PATCH') {
      const body = await readJsonLimited(request);
      const result = await userAccess.updateProjectUser({
        projectId: String(body.projectId || '').trim(),
        userId: decodeURIComponent(profileMatch[1]),
        actorEmail: identity.email,
        actorName: identity.name,
        profile: body.user,
      });
      return jsonNoStore({ ok: true, ...result });
    }
    if (url.pathname === '/api/access/web/invitations' && request.method === 'POST') {
      const body = await readJsonLimited(request);
      const invitation = await userAccess.issueToken({
        projectId: String(body.projectId || '').trim(),
        userId: String(body.userId || '').trim(),
        actorEmail: identity.email,
        purpose: 'activate',
      });
      return jsonNoStore({ ok: true, ...invitation }, 201);
    }
    if (url.pathname === '/api/access/web/reset' && request.method === 'POST') {
      const body = await readJsonLimited(request);
      const invitation = await userAccess.issueToken({
        projectId: String(body.projectId || '').trim(),
        userId: String(body.userId || '').trim(),
        actorEmail: identity.email,
        purpose: 'reset',
      });
      return jsonNoStore({ ok: true, ...invitation }, 201);
    }
    const match = url.pathname.match(/^\/api\/access\/users\/([^/]+)\/(block|unblock|sessions\/revoke)$/);
    if (match && request.method === 'POST') {
      const body = await readJsonLimited(request);
      const userId = decodeURIComponent(match[1]);
      const projectId = String(body.projectId || '').trim();
      if (match[2] === 'sessions/revoke') {
        const count = await userAccess.revokeUserSessions({ projectId, userId, actorEmail: identity.email });
        return jsonNoStore({ ok: true, revokedSessions: count });
      }
      const result = await userAccess.setBlocked({
        projectId, userId, actorEmail: identity.email, blocked: match[2] === 'block',
      });
      return jsonNoStore({ ok: true, ...result });
    }
    return jsonNoStore({ ok: false, error: 'not_found' }, 404);
  } catch (error) {
    return accessErrorResponse(error);
  }
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
    headers.delete('oai-authenticated-user-email');
    headers.delete('oai-authenticated-user-full-name');
    headers.delete('oai-authenticated-user-full-name-encoding');
    headers.delete('oai-authenticated-user-id');
    headers.delete('oai-authenticated-user-is-owner');
    headers.delete('oai-authenticated-user-projects');
    headers.delete('oai-authenticated-user-access-mode');
    headers.set('oai-client-ip', clientKey(incoming));
    const request = new Request(url, {
      method: incoming.method,
      headers,
      body: ['GET', 'HEAD'].includes(incoming.method || 'GET') ? undefined : Readable.toWeb(incoming),
      duplex: 'half',
    });

    if (url.pathname === '/api/company-os/export') {
      return writeResponse(outgoing, await handleCompanyOsExport(request, env));
    }

    if (url.pathname === '/login' && request.method === 'GET') {
      const response = await userAccess.fromRequest(request)
        ? redirect('/')
        : htmlResponse(loginPage());
      return writeResponse(outgoing, response);
    }

    const inviteMatch = url.pathname.match(/^\/invite\/([A-Za-z0-9_-]{40,128})$/);
    if (inviteMatch && ['GET', 'HEAD'].includes(request.method)) {
      try {
        const invite = await userAccess.inspectToken(inviteMatch[1]);
        const response = htmlResponse(activationPage({ token: inviteMatch[1], invite }));
        return writeResponse(outgoing, request.method === 'HEAD'
          ? new Response(null, { status: response.status, headers: response.headers })
          : response);
      } catch {
        const response = htmlResponse(invalidActivationPage(), 410);
        return writeResponse(outgoing, request.method === 'HEAD'
          ? new Response(null, { status: response.status, headers: response.headers })
          : response);
      }
    }

    if (url.pathname === '/api/auth/login' && request.method === 'POST') {
      if (!hasValidOrigin(request)) return writeResponse(outgoing, new Response('Forbidden', { status: 403 }));
      let username = '';
      try {
        const form = await readFormLimited(request);
        username = String(form.get('username') || '').trim();
        const password = String(form.get('password') || '');
        const session = await userAccess.authenticate(username, password, {
          ip: clientKey(incoming), userAgent: request.headers.get('user-agent') || '',
        });
        return writeResponse(outgoing, redirect('/', { 'Set-Cookie': userAccess.cookie(session.token) }));
      } catch (error) {
        const blocked = error instanceof AccessError && error.code === 'rate_limited';
        const status = error instanceof AccessError ? error.status : 500;
        const extra = blocked ? { 'Retry-After': String(error.retryAfter || 900) } : {};
        return writeResponse(outgoing, htmlResponse(loginPage({ username, error: 'invalid', blocked }), status, extra));
      }
    }

    if (url.pathname === '/api/auth/activate' && request.method === 'POST') {
      if (!hasValidOrigin(request)) return writeResponse(outgoing, new Response('Forbidden', { status: 403 }));
      let token = '';
      try {
        const form = await readFormLimited(request);
        token = String(form.get('token') || '');
        const password = String(form.get('password') || '');
        const passwordConfirm = String(form.get('passwordConfirm') || '');
        const session = await userAccess.activate(token, password, passwordConfirm, {
          ip: clientKey(incoming), userAgent: request.headers.get('user-agent') || '',
        });
        return writeResponse(outgoing, redirect('/', { 'Set-Cookie': userAccess.cookie(session.token) }));
      } catch (error) {
        if (error instanceof AccessError && ['weak_password', 'password_mismatch'].includes(error.code)) {
          try {
            const invite = await userAccess.inspectToken(token);
            return writeResponse(outgoing, htmlResponse(activationPage({ token, invite, error: error.code }), error.status));
          } catch { /* Ссылка стала недействительной между проверкой и отправкой формы. */ }
        }
        return writeResponse(outgoing, htmlResponse(invalidActivationPage(), error instanceof AccessError ? error.status : 500));
      }
    }

    if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
      if (!hasValidOrigin(request)) return writeResponse(outgoing, new Response('Forbidden', { status: 403 }));
      await userAccess.revokeRequestSession(request);
      return writeResponse(outgoing, redirect('/login', {
        'Set-Cookie': userAccess.clearCookie(),
        'Clear-Site-Data': '"cache", "storage"',
      }));
    }

    let identity = null;
    if (!isPublicRoute(url)) {
      identity = await userAccess.fromRequest(request);
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
      if (identity.accountId) headers.set('oai-authenticated-user-id', identity.accountId);
      headers.set('oai-authenticated-user-is-owner', identity.isOwner ? 'true' : 'false');
      if (!identity.isOwner) {
        headers.set('oai-authenticated-user-projects', (identity.projectIds ?? []).map((item) => encodeURIComponent(item)).join(','));
        headers.set('oai-authenticated-user-access-mode', 'local-membership');
      }
    }

    if (url.pathname.startsWith('/api/access/')) {
      return writeResponse(outgoing, await handleAccessApi(request, identity));
    }

    const authenticatedRequest = new Request(request, { headers });
    if (request.method === 'GET' && ['/api/health', '/api/readiness'].includes(url.pathname)) {
      const battleResponse = await worker.fetch(authenticatedRequest, env, { waitUntil: trackBackground });
      if (!battleResponse.ok) return writeResponse(outgoing, battleResponse);
      const battle = await battleResponse.json();
      const authSchemaReady = await userAccess.readiness();
      return writeResponse(outgoing, jsonNoStore({ ...battle, authSchemaVersion: ACCESS_SCHEMA_VERSION, authSchemaReady, ok: Boolean(battle.ok && authSchemaReady) }, authSchemaReady ? 200 : 503));
    }
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
await userAccess.initialize();
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