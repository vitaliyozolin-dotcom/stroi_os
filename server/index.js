import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import worker from '../sites/worker.js';
import { FileBucket } from './file-bucket.js';
import { PostgresDatabase } from './postgres.js';
import { buildInviteUrl, cookieValue, hashPassword, hashToken, newOpaqueToken, normalizeLogin, passwordIssue, verifyPassword } from './auth.js';

const port = Number(process.env.PORT) || 3000;
const clientRoot = resolve(process.env.CLIENT_ROOT || 'dist/client');
const databaseUrl = process.env.DATABASE_URL;
const ownerEmail = process.env.OWNER_EMAIL || 'vitaliyozolin@gmail.com';
const basicUser = process.env.APP_USERNAME || 'vitaliy';
const basicPassword = process.env.APP_PASSWORD;
const sessionCookieName = 'stroios_session';
const sessionDays = 30;
const loginFailures = new Map();

if (!databaseUrl) throw new Error('DATABASE_URL is required');
if (!basicPassword || basicPassword.length < 10) throw new Error('APP_PASSWORD must contain at least 10 characters');

const database = new PostgresDatabase(databaseUrl);
const bucket = new FileBucket(process.env.FILE_STORAGE_PATH || '/data/files');
const ensureAuthSchema = async () => {
  await database.batch([
    database.prepare(`
      CREATE TABLE IF NOT EXISTS app_users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        login TEXT UNIQUE,
        name TEXT NOT NULL,
        password_hash TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_login_at TEXT
      )
    `),
    database.prepare(`
      CREATE TABLE IF NOT EXISTS app_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      )
    `),
    database.prepare(`
      CREATE TABLE IF NOT EXISTS access_invites (
        token_hash TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        email TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT
      )
    `),
  ]);
  const now = new Date().toISOString();
  const existing = await database.prepare(`SELECT id FROM app_users WHERE email = ?`).bind(normalizeLogin(ownerEmail)).first();
  if (!existing) {
    await database.prepare(`
      INSERT INTO app_users (id, email, login, name, password_hash, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
    `).bind('user-owner', normalizeLogin(ownerEmail), normalizeLogin(basicUser), process.env.OWNER_NAME || 'Виталий Озолин', await hashPassword(basicPassword), now, now).run();
  }
};

await ensureAuthSchema();
const sessionIdentity = async (request) => {
  const token = cookieValue(request.headers.get('cookie'), sessionCookieName);
  if (!token) return null;
  const now = new Date().toISOString();
  const row = await database.prepare(`
    SELECT u.id, u.email, u.name, u.status, u.last_login_at, s.expires_at
    FROM app_sessions s
    JOIN app_users u ON u.id = s.user_id
    WHERE s.token_hash = ?
  `).bind(hashToken(token)).first();
  if (!row || row.status !== 'active' || row.expires_at <= now) return null;
  void database.prepare(`UPDATE app_sessions SET last_seen_at = ? WHERE token_hash = ?`).bind(now, hashToken(token)).run().catch(console.error);
  return { id: row.id, email: row.email, name: row.name, lastLoginAt: row.last_login_at || null };
};

const requestIdentity = sessionIdentity;

const authCookie = (token, request, maxAge = sessionDays * 86400) => {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${sessionCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
};

const jsonResponse = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
});

const createSession = async (userId, request) => {
  const token = newOpaqueToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + sessionDays * 86400_000).toISOString();
  await database.prepare(`
    INSERT INTO app_sessions (token_hash, user_id, created_at, expires_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(hashToken(token), userId, now.toISOString(), expiresAt, now.toISOString()).run();
  return authCookie(token, request);
};

const clientAddress = (incoming) => String(incoming.headers['x-forwarded-for'] || incoming.socket.remoteAddress || '').split(',')[0].trim();
const loginBlocked = (address) => {
  const record = loginFailures.get(address);
  if (!record) return false;
  if (record.until <= Date.now()) { loginFailures.delete(address); return false; }
  return record.count >= 8;
};
const recordLoginFailure = (address) => {
  const current = loginFailures.get(address);
  const count = current?.until > Date.now() ? current.count + 1 : 1;
  loginFailures.set(address, { count, until: Date.now() + 15 * 60_000 });
};

const readJson = async (request) => {
  try { return await request.json(); } catch { return null; }
};

const handleLogin = async (request, address) => {
  if (loginBlocked(address)) return jsonResponse({ ok: false, error: 'too_many_attempts' }, 429);
  const payload = await readJson(request);
  const login = normalizeLogin(payload?.login);
  const password = typeof payload?.password === 'string' ? payload.password : '';
  const user = await database.prepare(`
    SELECT id, email, name, password_hash, status FROM app_users WHERE email = ? OR login = ? LIMIT 1
  `).bind(login, login).first();
  if (!user?.password_hash || user.status !== 'active' || !(await verifyPassword(password, user.password_hash))) {
    recordLoginFailure(address);
    return jsonResponse({ ok: false, error: 'invalid_credentials' }, 401);
  }
  loginFailures.delete(address);
  const now = new Date().toISOString();
  await database.prepare(`UPDATE app_users SET last_login_at = ?, updated_at = ? WHERE id = ?`).bind(now, now, user.id).run();
  return jsonResponse({ ok: true, user: { email: user.email, name: user.name } }, 200, { 'Set-Cookie': await createSession(user.id, request) });
};

const handleLogout = async (request) => {
  const token = cookieValue(request.headers.get('cookie'), sessionCookieName);
  if (token) await database.prepare(`DELETE FROM app_sessions WHERE token_hash = ?`).bind(hashToken(token)).run();
  return jsonResponse({ ok: true }, 200, { 'Set-Cookie': authCookie('', request, 0) });
};

const handleInvite = async (request, identity, env) => {
  if (!identity || normalizeLogin(identity.email) !== normalizeLogin(ownerEmail)) return jsonResponse({ ok: false, error: 'owner_required' }, 403);
  const payload = await readJson(request);
  const email = normalizeLogin(payload?.email);
  const name = typeof payload?.name === 'string' ? payload.name.trim().slice(0, 120) : '';
  const projectId = typeof payload?.projectId === 'string' ? payload.projectId.trim().slice(0, 100) : '';
  const role = ['management', 'foreman'].includes(payload?.role) ? payload.role : '';
  if (!/^\S+@\S+\.\S+$/.test(email) || !name || !projectId || !role) return jsonResponse({ ok: false, error: 'invalid_invite' }, 422);
  const token = newOpaqueToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 48 * 3600_000).toISOString();
  await database.prepare(`DELETE FROM access_invites WHERE email = ? AND project_id = ? AND used_at IS NULL`).bind(email, projectId).run();
  await database.prepare(`
    INSERT INTO access_invites (token_hash, project_id, email, name, role, created_by, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(hashToken(token), projectId, email, name, role, identity.email, now.toISOString(), expiresAt).run();
  return jsonResponse({
    ok: true,
    delivery: 'manual',
    inviteUrl: buildInviteUrl(env.APP_PUBLIC_URL, token),
    expiresAt,
  });
};

const handleAcceptInvite = async (request) => {
  const payload = await readJson(request);
  const token = typeof payload?.token === 'string' ? payload.token : '';
  const password = typeof payload?.password === 'string' ? payload.password : '';
  const issue = passwordIssue(password);
  if (!token || issue) return jsonResponse({ ok: false, error: issue || 'invalid_invite' }, 422);
  const now = new Date().toISOString();
  const invite = await database.prepare(`
    SELECT token_hash, email, name, role, expires_at, used_at FROM access_invites WHERE token_hash = ?
  `).bind(hashToken(token)).first();
  if (!invite || invite.used_at || invite.expires_at <= now || !['management', 'foreman'].includes(invite.role)) return jsonResponse({ ok: false, error: 'invite_expired' }, 410);
  const existing = await database.prepare(`SELECT id FROM app_users WHERE email = ?`).bind(invite.email).first();
  const userId = existing?.id || `user-${crypto.randomUUID()}`;
  const passwordHash = await hashPassword(password);
  if (existing) {
    await database.prepare(`UPDATE app_users SET name = ?, password_hash = ?, status = 'active', updated_at = ? WHERE id = ?`).bind(invite.name, passwordHash, now, userId).run();
  } else {
    await database.prepare(`
      INSERT INTO app_users (id, email, name, password_hash, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?)
    `).bind(userId, invite.email, invite.name, passwordHash, now, now).run();
  }
  await database.prepare(`UPDATE access_invites SET used_at = ? WHERE token_hash = ?`).bind(now, invite.token_hash).run();
  return jsonResponse({ ok: true }, 200, { 'Set-Cookie': await createSession(userId, request) });
};

const isPublicRoute = (url) => url.pathname === '/api/health'
  || url.pathname === '/api/session'
  || url.pathname === '/api/auth/login'
  || url.pathname === '/api/auth/accept-invite'
  || url.pathname === '/api/integrations/telegram/update'
  || !url.pathname.startsWith('/api/');
const unauthorized = () => new Response('Требуется вход в ИКИОМА ОС', {
  status: 401,
  headers: { 'Content-Type': 'text/plain; charset=utf-8' },
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

    if (url.pathname === '/api/auth/login' && request.method === 'POST') return writeResponse(outgoing, await handleLogin(request, clientAddress(incoming)));
    if (url.pathname === '/api/auth/accept-invite' && request.method === 'POST') return writeResponse(outgoing, await handleAcceptInvite(request));
    if (url.pathname === '/api/auth/logout' && request.method === 'POST') return writeResponse(outgoing, await handleLogout(request));

    const identity = await requestIdentity(request);
    if (url.pathname === '/api/access/invite' && request.method === 'POST') return writeResponse(outgoing, await handleInvite(request, identity, env));

    if (!isPublicRoute(url)) {
      if (!identity) return writeResponse(outgoing, unauthorized());
    }
    if (identity) {
      headers.set('oai-authenticated-user-email', identity.email);
      headers.set('oai-authenticated-user-full-name', encodeURIComponent(identity.name));
      headers.set('oai-authenticated-user-full-name-encoding', 'percent-encoded-utf-8');
      if (identity.lastLoginAt) headers.set('oai-authenticated-user-last-login-at', identity.lastLoginAt);
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
