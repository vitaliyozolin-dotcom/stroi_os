import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { normalizeClientAddress } from '../sites/lib/validation.js';

export const ACCESS_SESSION_COOKIE = 'stroios_session';
export const ACCESS_SESSION_TTL_MS = 12 * 60 * 60_000;
export const ACCESS_SESSION_IDLE_MS = 60 * 60_000;
export const ACCESS_INVITE_TTL_MS = 7 * 24 * 60 * 60_000;
export const ACCESS_RESET_TTL_MS = 60 * 60_000;
export const ACCESS_BODY_LIMIT = 16 * 1024;
export const ACCESS_SCHEMA_VERSION = 2;

const scrypt = promisify(scryptCallback);
const PASSWORD_MIN_LENGTH = 15;
const PASSWORD_MAX_LENGTH = 128;
const PASSWORD_MAX_BYTES = 512;
const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 3;
const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_BLOCK_MS = 15 * 60_000;
const LOGIN_LIMIT = 5;
const LOGIN_LIMIT_RETENTION_MS = 24 * 60 * 60_000;
const UNKNOWN_LOGIN_IP_BUCKETS = 4_096;
const MAX_CONCURRENT_PASSWORD_JOBS = 4;

const clean = (value, max = 240) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const placeholderSecret = (value) => /^replace-with(?:-|$)/i.test(clean(value, 500));
export const normalizeAccessEmail = (value) => clean(value, 240).toLocaleLowerCase('en-US');
export const hashAccessToken = (value) => createHash('sha256').update(String(value)).digest('hex');

export const normalizeAccessAddress = normalizeClientAddress;

const safeEqual = (left, right) => {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
};

const passwordProblem = (password) => {
  if (typeof password !== 'string') return 'weak_password';
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) return 'weak_password';
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) return 'weak_password';
  return '';
};

export const validateAccessPassword = (password) => passwordProblem(password);

export const hashAccessPassword = async (password, salt = randomBytes(16)) => {
  const problem = passwordProblem(password);
  if (problem) throw new AccessError(problem, 422);
  const derived = await scrypt(password, salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${Buffer.from(derived).toString('base64url')}`;
};

export const verifyAccessPassword = async (password, encoded) => {
  if (typeof password !== 'string' || Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) return false;
  const [algorithm, n, r, p, salt, expected] = String(encoded || '').split('$');
  if (algorithm !== 'scrypt' || Number(n) !== SCRYPT_N || Number(r) !== SCRYPT_R || Number(p) !== SCRYPT_P || !salt || !expected) return false;
  const expectedBuffer = Buffer.from(expected, 'base64url');
  if (expectedBuffer.length !== SCRYPT_KEY_LENGTH) return false;
  try {
    const derived = await scrypt(password, Buffer.from(salt, 'base64url'), expectedBuffer.length, {
      N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT_MAXMEM,
    });
    return timingSafeEqual(Buffer.from(derived), expectedBuffer);
  } catch {
    return false;
  }
};

export class AccessError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'AccessError';
    this.code = code;
    this.status = status;
  }
}

export const parseCookieHeader = (header) => Object.fromEntries(
  String(header || '').split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf('=');
    return index < 0 ? [part, ''] : [part.slice(0, index), part.slice(index + 1)];
  }),
);

const validPublicBase = (value) => {
  let url;
  try { url = new URL(value); } catch { throw new Error('APP_PUBLIC_URL must be a valid URL'); }
  const local = ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error('APP_PUBLIC_URL must use HTTPS outside localhost');
  }
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url;
};

const accessSchema = [
  `CREATE TABLE IF NOT EXISTS auth_users (
    id TEXT PRIMARY KEY, email_normalized TEXT UNIQUE NOT NULL, email TEXT NOT NULL, name TEXT NOT NULL,
    password_hash TEXT, status TEXT NOT NULL, activated_at TEXT, password_changed_at TEXT,
    last_login_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS auth_memberships (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, system_user_id TEXT NOT NULL,
    auth_user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    role TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(project_id, system_user_id), UNIQUE(project_id, auth_user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS auth_tokens (
    token_hash TEXT PRIMARY KEY, auth_user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    membership_id TEXT NOT NULL REFERENCES auth_memberships(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL, system_user_id TEXT NOT NULL, purpose TEXT NOT NULL,
    created_by_email TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
    used_at TEXT, revoked_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS auth_sessions (
    id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL,
    auth_user_id TEXT REFERENCES auth_users(id) ON DELETE CASCADE,
    principal_email TEXT NOT NULL, principal_name TEXT NOT NULL, is_owner BOOLEAN NOT NULL,
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, revoked_at TEXT,
    ip_hash TEXT, user_agent_hash TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS auth_login_limits (
    key_hash TEXT PRIMARY KEY, attempts INTEGER NOT NULL, window_started_at TEXT NOT NULL,
    blocked_until TEXT, updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS auth_audit (
    id TEXT PRIMARY KEY, created_at TEXT NOT NULL, actor_email TEXT NOT NULL,
    target_user_id TEXT, project_id TEXT, action TEXT NOT NULL, metadata_json TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS auth_sessions_active_idx ON auth_sessions(token_hash, expires_at) WHERE revoked_at IS NULL',
  'CREATE INDEX IF NOT EXISTS auth_tokens_membership_idx ON auth_tokens(membership_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS auth_memberships_user_idx ON auth_memberships(auth_user_id, status)',
  'CREATE INDEX IF NOT EXISTS auth_login_limits_updated_idx ON auth_login_limits(updated_at)',
];

const projectUser = (state, userId) => (state?.settings?.users ?? []).find((item) => clean(item.id, 100) === userId);
const allowedRole = (role) => ['management', 'foreman', 'client'].includes(role);
const validAccessEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

const identityFromSessionRow = (row) => ({
  accountId: row.auth_user_id || null,
  email: normalizeAccessEmail(row.principal_email),
  name: clean(row.principal_name, 120),
  isOwner: row.is_owner === true || row.is_owner === 'true' || row.is_owner === 1,
});

export class UserAccessService {
  constructor({
    database,
    ownerEmail,
    ownerName,
    ownerUsername,
    ownerPassword,
    publicUrl,
    sessionTtlMs = ACCESS_SESSION_TTL_MS,
    inviteTtlMs = ACCESS_INVITE_TTL_MS,
    resetTtlMs = ACCESS_RESET_TTL_MS,
    passwordVerifier = verifyAccessPassword,
    passwordHasher = hashAccessPassword,
    maxConcurrentPasswordJobs = MAX_CONCURRENT_PASSWORD_JOBS,
  }) {
    if (!database?.pool) throw new Error('PostgreSQL pool is required');
    if (!ownerPassword || ownerPassword.length < 16 || placeholderSecret(ownerPassword)) {
      throw new Error('APP_PASSWORD must contain at least 16 non-placeholder characters');
    }
    this.pool = database.pool;
    this.ownerEmail = normalizeAccessEmail(ownerEmail);
    this.ownerName = clean(ownerName, 120) || this.ownerEmail;
    this.ownerUsername = clean(ownerUsername, 120);
    this.ownerPassword = ownerPassword;
    this.publicBase = validPublicBase(publicUrl);
    this.secureCookie = this.publicBase.protocol === 'https:';
    this.sessionTtlMs = sessionTtlMs;
    this.sessionIdleMs = ACCESS_SESSION_IDLE_MS;
    this.inviteTtlMs = inviteTtlMs;
    this.resetTtlMs = resetTtlMs;
    this.passwordVerifier = passwordVerifier;
    this.passwordHasher = passwordHasher;
    this.maxConcurrentPasswordJobs = Math.max(1, Math.min(32, Number(maxConcurrentPasswordJobs) || MAX_CONCURRENT_PASSWORD_JOBS));
    this.passwordJobs = 0;
    this.dummyPasswordHash = null;
    this.activationInFlight = new Set();
    this.lastLoginLimitCleanupAt = 0;
  }

  async initialize() {
    for (const sql of accessSchema) await this.pool.query(sql);
    await this.transaction(async (client) => {
      const marker = await client.query("SELECT value FROM system_meta WHERE key='auth_schema_version' FOR UPDATE");
      const previousVersion = Number(marker.rows[0]?.value) || 0;
      const now = new Date().toISOString();
      if (previousVersion < 2) {
        await client.query(
          'UPDATE auth_tokens SET revoked_at=COALESCE(revoked_at,$1) WHERE used_at IS NULL AND revoked_at IS NULL',
          [now],
        );
        await client.query('DELETE FROM auth_login_limits');
      }
      await client.query(`
        INSERT INTO system_meta (key,value,updated_at) VALUES ('auth_schema_version',$1,$2)
        ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=EXCLUDED.updated_at
      `, [String(ACCESS_SCHEMA_VERSION), now]);
    });
    const ownerMarker = await this.pool.query("SELECT value FROM system_meta WHERE key='owner_auth_hash' LIMIT 1");
    const ownerPasswordUnchanged = ownerMarker.rows[0]?.value
      ? await verifyAccessPassword(this.ownerPassword, ownerMarker.rows[0].value)
      : false;
    if (!ownerPasswordUnchanged) {
      const now = new Date().toISOString();
      const ownerAuthHash = await hashAccessPassword(this.ownerPassword);
      await this.pool.query('UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,$1) WHERE is_owner=TRUE', [now]);
      await this.pool.query(`
        INSERT INTO system_meta (key,value,updated_at) VALUES ('owner_auth_hash',$1,$2)
        ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=EXCLUDED.updated_at
      `, [ownerAuthHash, now]);
    }
    this.dummyPasswordHash = await hashAccessPassword(randomBytes(24).toString('base64url'));
  }

  async readiness() {
    const result = await this.pool.query("SELECT value FROM system_meta WHERE key='auth_schema_version' LIMIT 1");
    return result.rows[0]?.value === String(ACCESS_SCHEMA_VERSION);
  }

  async transaction(callback) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  cookie(token) {
    const secure = this.secureCookie ? '; Secure' : '';
    return `${ACCESS_SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(this.sessionTtlMs / 1000)}${secure}`;
  }

  clearCookie() {
    const secure = this.secureCookie ? '; Secure' : '';
    return `${ACCESS_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
  }

  tokenFromRequest(request) {
    return parseCookieHeader(request.headers.get('cookie'))[ACCESS_SESSION_COOKIE] || '';
  }

  async createSession(identity, { ip = '', userAgent = '' } = {}, client = this.pool) {
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.sessionTtlMs);
    await client.query(`
      INSERT INTO auth_sessions (
        id, token_hash, auth_user_id, principal_email, principal_name, is_owner,
        created_at, expires_at, last_seen_at, revoked_at, ip_hash, user_agent_hash
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$7,NULL,$9,$10)
    `, [
      randomUUID(), hashAccessToken(token), identity.accountId || null,
      identity.email, identity.name, Boolean(identity.isOwner), now.toISOString(), expiresAt.toISOString(),
      ip ? hashAccessToken(`ip:${ip}`) : null,
      userAgent ? hashAccessToken(`ua:${userAgent}`) : null,
    ]);
    return { token, identity };
  }

  async fromRequest(request) {
    const token = this.tokenFromRequest(request);
    if (!token || token.length > 128) return null;
    const now = new Date().toISOString();
    const idleAfter = new Date(Date.now() - this.sessionIdleMs).toISOString();
    const result = await this.pool.query(`
      SELECT s.auth_user_id, s.principal_email, s.principal_name, s.is_owner
      FROM auth_sessions s
      LEFT JOIN auth_users u ON u.id = s.auth_user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2 AND s.last_seen_at > $3
        AND (s.is_owner = TRUE OR (
          u.status = 'active' AND EXISTS (
            SELECT 1 FROM auth_memberships m WHERE m.auth_user_id = u.id AND m.status = 'active'
          )
        ))
      LIMIT 1
    `, [hashAccessToken(token), now, idleAfter]);
    const row = result.rows[0];
    if (!row) return null;
    void this.pool.query('UPDATE auth_sessions SET last_seen_at = $1 WHERE token_hash = $2', [now, hashAccessToken(token)]).catch(() => undefined);
    const identity = identityFromSessionRow(row);
    if (!identity.isOwner && identity.accountId) {
      const memberships = await this.pool.query(
        "SELECT project_id FROM auth_memberships WHERE auth_user_id=$1 AND status='active' ORDER BY project_id",
        [identity.accountId],
      );
      identity.projectIds = memberships.rows.map((item) => clean(item.project_id, 100)).filter(Boolean);
    }
    return identity;
  }

  async revokeRequestSession(request) {
    const token = this.tokenFromRequest(request);
    if (!token || token.length > 128) return;
    await this.pool.query(
      'UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, $1) WHERE token_hash = $2',
      [new Date().toISOString(), hashAccessToken(token)],
    );
  }

  loginRateKey(identifier) {
    return hashAccessToken(`login:${normalizeAccessEmail(identifier)}`);
  }

  ipRateKey(ip, unknownAccount = false) {
    const address = normalizeAccessAddress(ip);
    if (!unknownAccount) return hashAccessToken(`ip:${address}`);
    const digest = hashAccessToken(`unknown-ip:${address}`);
    const bucket = Number.parseInt(digest.slice(0, 8), 16) % UNKNOWN_LOGIN_IP_BUCKETS;
    return hashAccessToken(`unknown-ip-bucket:${bucket}`);
  }

  async cleanupLoginLimits(now = new Date()) {
    if (now.getTime() - this.lastLoginLimitCleanupAt < 60_000) return;
    const cutoff = new Date(now.getTime() - LOGIN_LIMIT_RETENTION_MS).toISOString();
    const nowIso = now.toISOString();
    await this.pool.query(`
      DELETE FROM auth_login_limits
      WHERE updated_at < $1 AND (blocked_until IS NULL OR blocked_until < $2)
    `, [cutoff, nowIso]);
    this.lastLoginLimitCleanupAt = now.getTime();
  }

  async reserveLoginAttempt(keys, now = new Date()) {
    const windowStart = new Date(now.getTime() - LOGIN_WINDOW_MS).toISOString();
    const nowIso = now.toISOString();
    const uniqueKeys = [...new Set(keys)].sort();
    return this.transaction(async (client) => {
      await client.query(`
        SELECT pg_advisory_xact_lock(hashtext(key_hash))
        FROM unnest($1::text[]) AS item(key_hash)
        ORDER BY key_hash
      `, [uniqueKeys]);
      const existing = await client.query(
        'SELECT blocked_until FROM auth_login_limits WHERE key_hash = ANY($1) FOR UPDATE',
        [uniqueKeys],
      );
      if (existing.rows.some((row) => row.blocked_until && row.blocked_until > nowIso)) return true;
      const result = await client.query(`
        WITH input AS (
          SELECT DISTINCT key_hash FROM unnest($1::text[]) AS item(key_hash) ORDER BY key_hash
        )
        INSERT INTO auth_login_limits (key_hash,attempts,window_started_at,blocked_until,updated_at)
        SELECT key_hash,1,$2,NULL,$2 FROM input
        ON CONFLICT(key_hash) DO UPDATE SET
          attempts = CASE
            WHEN auth_login_limits.window_started_at < $3 OR auth_login_limits.blocked_until <= $2 THEN 1
            ELSE auth_login_limits.attempts + 1
          END,
          window_started_at = CASE
            WHEN auth_login_limits.window_started_at < $3 OR auth_login_limits.blocked_until <= $2 THEN $2
            ELSE auth_login_limits.window_started_at
          END,
          blocked_until = CASE
            WHEN (CASE
              WHEN auth_login_limits.window_started_at < $3 OR auth_login_limits.blocked_until <= $2 THEN 1
              ELSE auth_login_limits.attempts + 1
            END) > $4 THEN $5
            ELSE NULL
          END,
          updated_at = $2
        RETURNING attempts,blocked_until
      `, [uniqueKeys, nowIso, windowStart, LOGIN_LIMIT, new Date(now.getTime() + LOGIN_BLOCK_MS).toISOString()]);
      return result.rows.some((row) => row.blocked_until && row.blocked_until > nowIso);
    });
  }

  async releaseSuccessfulLogin(keys, client = this.pool) {
    const now = new Date().toISOString();
    await client.query(`
      UPDATE auth_login_limits SET
        attempts=GREATEST(attempts - 1,0),
        blocked_until=CASE WHEN GREATEST(attempts - 1,0) <= $3 THEN NULL ELSE blocked_until END,
        updated_at=$2
      WHERE key_hash = ANY($1)
    `, [keys, now, LOGIN_LIMIT]);
    await client.query(`
      DELETE FROM auth_login_limits
      WHERE key_hash = ANY($1) AND attempts = 0 AND (blocked_until IS NULL OR blocked_until <= $2)
    `, [keys, now]);
  }

  async clearLoginLimits(keys, client = this.pool) {
    if (!keys.length) return;
    await client.query('DELETE FROM auth_login_limits WHERE key_hash = ANY($1)', [keys]);
  }

  async runPasswordWork(callback) {
    if (this.passwordJobs >= this.maxConcurrentPasswordJobs) throw new AccessError('rate_limited', 429);
    this.passwordJobs += 1;
    try {
      return await callback();
    } finally {
      this.passwordJobs -= 1;
    }
  }

  async runReservedPasswordWork(keys, callback) {
    try {
      return await this.runPasswordWork(callback);
    } catch (error) {
      if (error instanceof AccessError && error.code === 'rate_limited') {
        await this.releaseSuccessfulLogin(keys);
      }
      throw error;
    }
  }

  async authenticate(identifier, password, context = {}) {
    const login = clean(identifier, 240);
    if (!login || typeof password !== 'string' || Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) {
      throw new AccessError('invalid_credentials', 401);
    }
    const now = new Date();
    await this.cleanupLoginLimits(now);
    const normalized = normalizeAccessEmail(login);
    const reservedOwner = safeEqual(normalized, this.ownerEmail) || safeEqual(login, this.ownerUsername);
    let session = null;
    let user = null;
    if (!reservedOwner) {
      const result = await this.pool.query(`
        SELECT u.id, u.email_normalized, u.name, u.password_hash, u.status
        FROM auth_users u
        WHERE u.email_normalized = $1
        LIMIT 1
      `, [normalized]);
      user = result.rows[0] || null;
    }
    const knownAccount = Boolean(reservedOwner || user);
    const ipKey = this.ipRateKey(context.ip, !knownAccount);
    const accountRateKey = reservedOwner
      ? this.loginRateKey(this.ownerEmail)
      : user?.email_normalized
        ? this.loginRateKey(user.email_normalized)
        : '';
    const keys = [ipKey];
    if (await this.reserveLoginAttempt(keys, now)) throw new AccessError('rate_limited', 429);
    if (reservedOwner) {
      const valid = await this.runReservedPasswordWork(keys, async () => {
        await this.passwordVerifier(password, this.dummyPasswordHash);
        return (safeEqual(login, this.ownerUsername) || safeEqual(normalized, this.ownerEmail))
          && safeEqual(password, this.ownerPassword);
      });
      if (valid) {
        const identity = { accountId: null, email: this.ownerEmail, name: this.ownerName, isOwner: true };
        session = await this.transaction(async (client) => {
          await this.releaseSuccessfulLogin(keys, client);
          await this.clearLoginLimits(accountRateKey ? [accountRateKey] : [], client);
          return this.createSession(identity, context, client);
        });
      }
    } else {
      const observedHash = user?.password_hash || null;
      const valid = await this.runReservedPasswordWork(keys, () => this.passwordVerifier(password, observedHash || this.dummyPasswordHash));
      if (valid && observedHash) {
        session = await this.transaction(async (client) => {
          const locked = (await client.query(`
            SELECT id,email_normalized,name,password_hash,status FROM auth_users WHERE id=$1 FOR UPDATE
          `, [user.id])).rows[0];
          if (!locked || locked.status !== 'active' || locked.password_hash !== observedHash) return null;
          const membership = await client.query(
            "SELECT 1 FROM auth_memberships WHERE auth_user_id=$1 AND status='active' LIMIT 1",
            [locked.id],
          );
          if (!membership.rowCount) return null;
          const identity = { accountId: locked.id, email: locked.email_normalized, name: locked.name, isOwner: false };
          await client.query('UPDATE auth_users SET last_login_at=$1,updated_at=$1 WHERE id=$2', [new Date().toISOString(), locked.id]);
          await this.releaseSuccessfulLogin(keys, client);
          await this.clearLoginLimits(accountRateKey ? [accountRateKey] : [], client);
          return this.createSession(identity, context, client);
        });
      }
    }

    if (!session) {
      if (accountRateKey) await this.reserveLoginAttempt([accountRateKey], new Date());
      if (reservedOwner || user) {
        await this.audit(this.pool, { actorEmail: normalized, targetUserId: user?.id, action: 'login_failed', metadata: { ipHash: ipKey } });
      }
      throw new AccessError('invalid_credentials', 401);
    }

    await this.audit(this.pool, { actorEmail: session.identity.email, targetUserId: session.identity.accountId, action: 'login_succeeded' });
    return session;
  }

  async loadProject(client, projectId, lock = false) {
    const result = await client.query(
      `SELECT state_json, revision FROM project_state WHERE project_id = $1${lock ? ' FOR UPDATE' : ''}`,
      [projectId],
    );
    const row = result.rows[0];
    if (!row) throw new AccessError('project_not_found', 404);
    let state;
    try { state = JSON.parse(row.state_json); } catch { throw new AccessError('project_state_invalid', 500); }
    return { state, revision: Number(row.revision) || 0 };
  }

  validateProjectUser(state, userId) {
    const user = projectUser(state, clean(userId, 100));
    if (!user) throw new AccessError('user_not_found', 404);
    const email = normalizeAccessEmail(user.email);
    if (!email || !email.includes('@') || !allowedRole(user.role)) throw new AccessError('invalid_user_profile', 422);
    if (email === this.ownerEmail) throw new AccessError('owner_account_reserved', 409);
    const duplicates = (state.settings?.users ?? []).filter((item) => normalizeAccessEmail(item.email) === email);
    if (duplicates.length > 1) throw new AccessError('duplicate_email', 409);
    return { ...user, id: clean(user.id, 100), email, name: clean(user.name, 120), role: user.role };
  }

  validateEditableProfile(state, profile, currentUserId = '') {
    const name = clean(profile?.name, 120);
    const email = normalizeAccessEmail(profile?.email);
    const role = clean(profile?.role, 40);
    const telegram = clean(profile?.telegram, 120);
    if (!name || !validAccessEmail(email) || !allowedRole(role)) throw new AccessError('invalid_user_profile', 422);
    if (email === this.ownerEmail) throw new AccessError('owner_account_reserved', 409);
    const duplicate = (state.settings?.users ?? []).find((item) => (
      clean(item.id, 100) !== currentUserId && normalizeAccessEmail(item.email) === email
    ));
    if (duplicate) throw new AccessError('duplicate_email', 409);
    return { name, email, role, telegram: telegram || undefined };
  }

  addProfileActivity(state, actor, text, now) {
    state.activity = [{
      id: randomUUID(), timestamp: now, actor: clean(actor, 160) || 'Владелец', text, tone: 'neutral',
    }, ...(Array.isArray(state.activity) ? state.activity : [])].slice(0, 300);
  }

  async createProjectUser({ projectId, actorEmail, actorName, profile }) {
    const normalizedProjectId = clean(projectId, 100);
    return this.transaction(async (client) => {
      const project = await this.loadProject(client, normalizedProjectId, true);
      const editable = this.validateEditableProfile(project.state, profile);
      const now = new Date().toISOString();
      const user = {
        id: `user-${randomUUID()}`,
        ...editable,
        status: 'invited',
        invitedAt: now,
        inviteDelivery: 'draft',
      };
      const nextState = structuredClone(project.state);
      nextState.settings = { ...nextState.settings, users: [...(nextState.settings?.users ?? []), user] };
      const summary = `Добавлен участник ${user.name} · веб-доступ ещё не выдан`;
      this.addProfileActivity(nextState, actorName || actorEmail, summary, now);
      const snapshot = await this.saveProjectAccessMutation(client, normalizedProjectId, project.revision, nextState, {
        actor: actorName || actorEmail,
        action: 'access.profile_create',
        summary,
      });
      await this.audit(client, {
        actorEmail, projectId: normalizedProjectId, action: 'profile_created',
        metadata: { systemUserId: user.id, email: user.email, role: user.role },
      });
      return { user, snapshot };
    });
  }

  async updateProjectUser({ projectId, userId, actorEmail, actorName, profile }) {
    const normalizedProjectId = clean(projectId, 100);
    const normalizedUserId = clean(userId, 100);
    return this.transaction(async (client) => {
      const project = await this.loadProject(client, normalizedProjectId, true);
      const current = projectUser(project.state, normalizedUserId);
      if (!current) throw new AccessError('user_not_found', 404);
      if (normalizedUserId === 'user-owner' || normalizeAccessEmail(current.email) === this.ownerEmail) {
        throw new AccessError('owner_account_reserved', 409);
      }
      const editable = this.validateEditableProfile(project.state, profile, normalizedUserId);
      const previousEmail = normalizeAccessEmail(current.email);
      const emailChanged = previousEmail !== editable.email;
      const roleChanged = current.role !== editable.role;
      const now = new Date().toISOString();

      const emailLocks = [...new Set([previousEmail, editable.email].filter(Boolean))].sort();
      for (const email of emailLocks) {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [email]);
      }

      const membership = (await client.query(`
        SELECT m.*,u.email_normalized,u.password_hash,u.status AS account_status
        FROM auth_memberships m
        JOIN auth_users u ON u.id=m.auth_user_id
        WHERE m.project_id=$1 AND m.system_user_id=$2
        FOR UPDATE OF m,u
      `, [normalizedProjectId, normalizedUserId])).rows[0] || null;

      let nextStatus = current.status;
      let targetAccountId = membership?.auth_user_id || null;
      const affectedAccountIds = new Set();
      if (membership) {
        affectedAccountIds.add(membership.auth_user_id);
        let targetAccount = membership;
        if (emailChanged) {
          targetAccount = (await client.query(
            'SELECT id,email_normalized,password_hash,status FROM auth_users WHERE email_normalized=$1 FOR UPDATE',
            [editable.email],
          )).rows[0] || null;
          if (!targetAccount) {
            targetAccount = {
              id: randomUUID(), email_normalized: editable.email, password_hash: null, status: 'pending',
            };
            await client.query(`
              INSERT INTO auth_users (
                id,email_normalized,email,name,password_hash,status,activated_at,password_changed_at,
                last_login_at,created_at,updated_at
              ) VALUES ($1,$2,$2,$3,NULL,'pending',NULL,NULL,NULL,$4,$4)
            `, [targetAccount.id, editable.email, editable.name, now]);
          }
          const duplicateMembership = await client.query(`
            SELECT id FROM auth_memberships
            WHERE project_id=$1 AND auth_user_id=$2 AND system_user_id<>$3
            LIMIT 1
          `, [normalizedProjectId, targetAccount.id, normalizedUserId]);
          if (duplicateMembership.rowCount) throw new AccessError('duplicate_email', 409);
          targetAccountId = targetAccount.id;
          affectedAccountIds.add(targetAccount.id);
        }

        const disabled = current.status === 'disabled' || membership.status === 'disabled';
        const targetAccountStatus = emailChanged ? targetAccount.status : membership.account_status;
        const accountActive = Boolean(targetAccount.password_hash && targetAccountStatus === 'active');
        const membershipStatus = disabled ? 'disabled' : accountActive ? 'active' : 'pending';
        nextStatus = disabled ? 'disabled' : accountActive ? 'active' : 'invited';
        await client.query(`
          UPDATE auth_memberships
          SET auth_user_id=$1,role=$2,status=$3,updated_at=$4
          WHERE id=$5
        `, [targetAccountId, editable.role, membershipStatus, now, membership.id]);
        await client.query(
          'UPDATE auth_users SET email=$1,name=$2,updated_at=$3 WHERE id=$4',
          [editable.email, editable.name, now, targetAccountId],
        );

        const accessChanged = emailChanged || roleChanged || membership.status !== membershipStatus;
        if (accessChanged) {
          const accountIds = [...affectedAccountIds];
          await client.query(`
            UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,$1)
            WHERE auth_user_id=ANY($2::text[]) AND revoked_at IS NULL
          `, [now, accountIds]);
          await client.query(`
            UPDATE auth_tokens SET revoked_at=COALESCE(revoked_at,$1)
            WHERE membership_id=$2 AND used_at IS NULL AND revoked_at IS NULL
          `, [now, membership.id]);
        }
      }

      const user = {
        ...current,
        ...editable,
        id: normalizedUserId,
        status: nextStatus,
      };
      const nextState = structuredClone(project.state);
      nextState.settings.users = nextState.settings.users.map((item) => item.id === normalizedUserId ? user : item);
      const summary = `Обновлены роль и доступ пользователя ${user.name}`;
      this.addProfileActivity(nextState, actorName || actorEmail, summary, now);
      const snapshot = await this.saveProjectAccessMutation(client, normalizedProjectId, project.revision, nextState, {
        actor: actorName || actorEmail,
        action: 'access.profile_update',
        summary,
      });
      await this.audit(client, {
        actorEmail, targetUserId: targetAccountId, projectId: normalizedProjectId, action: 'profile_updated',
        metadata: {
          systemUserId: normalizedUserId,
          emailChanged,
          roleChanged,
          email: user.email,
          role: user.role,
        },
      });
      return { user, snapshot };
    });
  }

  async ensureAccountAndMembership(client, projectId, user, now, status = 'pending') {
    let account = (await client.query('SELECT * FROM auth_users WHERE email_normalized = $1 FOR UPDATE', [user.email])).rows[0];
    if (!account) {
      const id = randomUUID();
      await client.query(`
        INSERT INTO auth_users (id,email_normalized,email,name,password_hash,status,activated_at,password_changed_at,last_login_at,created_at,updated_at)
        VALUES ($1,$2,$2,$3,NULL,'pending',NULL,NULL,NULL,$4,$4)
      `, [id, user.email, user.name, now]);
      account = { id, email_normalized: user.email, name: user.name, password_hash: null, status: 'pending' };
    } else {
      await client.query('UPDATE auth_users SET email = $1, name = $2, updated_at = $3 WHERE id = $4', [user.email, user.name, now, account.id]);
    }

    const duplicate = await client.query(
      'SELECT id FROM auth_memberships WHERE project_id = $1 AND auth_user_id = $2 AND system_user_id <> $3 LIMIT 1',
      [projectId, account.id, user.id],
    );
    if (duplicate.rowCount) throw new AccessError('duplicate_email', 409);

    let membership = (await client.query(
      'SELECT * FROM auth_memberships WHERE project_id = $1 AND system_user_id = $2 FOR UPDATE',
      [projectId, user.id],
    )).rows[0];
    if (!membership) {
      membership = { id: randomUUID() };
      await client.query(`
        INSERT INTO auth_memberships (id,project_id,system_user_id,auth_user_id,role,status,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
      `, [membership.id, projectId, user.id, account.id, user.role, status, now]);
    } else {
      if (membership.auth_user_id !== account.id) {
        await client.query('UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at,$1) WHERE auth_user_id = $2', [now, membership.auth_user_id]);
      }
      await client.query(`
        UPDATE auth_memberships SET auth_user_id=$1, role=$2, status=$3, updated_at=$4 WHERE id=$5
      `, [account.id, user.role, status, now, membership.id]);
    }
    return { account, membership };
  }

  async issueToken({ projectId, userId, actorEmail, purpose = 'activate' }) {
    if (!['activate', 'reset'].includes(purpose)) throw new AccessError('invalid_token_purpose', 422);
    const rawToken = randomBytes(32).toString('base64url');
    const nowDate = new Date();
    const expiresAt = new Date(nowDate.getTime() + (purpose === 'reset' ? this.resetTtlMs : this.inviteTtlMs));
    const now = nowDate.toISOString();
    const result = await this.transaction(async (client) => {
      const project = await this.loadProject(client, clean(projectId, 100), true);
      const user = this.validateProjectUser(project.state, userId);
      if (user.status === 'disabled') throw new AccessError('user_disabled', 409);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [user.email]);
      const existingAccount = (await client.query(
        'SELECT id,password_hash,status,activated_at FROM auth_users WHERE email_normalized=$1 FOR UPDATE',
        [user.email],
      )).rows[0];
      if (purpose === 'reset' && (!existingAccount?.password_hash || existingAccount.status !== 'active')) {
        throw new AccessError('access_not_active', 409);
      }
      const existingActiveAccount = purpose === 'activate' && existingAccount?.password_hash && existingAccount.status === 'active';
      if (existingActiveAccount) {
        const { account } = await this.ensureAccountAndMembership(client, projectId, user, now, 'active');
        await client.query(
          'UPDATE auth_tokens SET revoked_at=$1 WHERE auth_user_id=$2 AND used_at IS NULL AND revoked_at IS NULL',
          [now, account.id],
        );
        if (user.status !== 'active') {
          const nextState = structuredClone(project.state);
          nextState.settings.users = nextState.settings.users.map((item) => item.id === user.id ? {
            ...item, status: 'active', webActivatedAt: existingAccount.activated_at || now, inviteDelivery: 'sent',
          } : item);
          await this.saveProjectAccessMutation(client, projectId, project.revision, nextState, {
            actor: actorEmail,
            action: 'access.membership_grant',
            summary: `Добавлен веб-доступ к проекту: ${user.name}`,
          });
        }
        await this.audit(client, {
          actorEmail, targetUserId: account.id, projectId, action: 'existing_account_granted',
          metadata: { systemUserId: user.id },
        });
        return { user, existingAccount: true };
      }
      const desiredStatus = purpose === 'reset' ? 'active' : 'pending';
      const { account, membership } = await this.ensureAccountAndMembership(client, projectId, user, now, desiredStatus);
      await client.query(
        'UPDATE auth_tokens SET revoked_at=$1 WHERE auth_user_id=$2 AND used_at IS NULL AND revoked_at IS NULL',
        [now, account.id],
      );
      await client.query(`
        INSERT INTO auth_tokens (
          token_hash,auth_user_id,membership_id,project_id,system_user_id,purpose,
          created_by_email,created_at,expires_at,used_at,revoked_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,NULL)
      `, [hashAccessToken(rawToken), account.id, membership.id, projectId, user.id, purpose, actorEmail, now, expiresAt.toISOString()]);
      await this.audit(client, {
        actorEmail, targetUserId: account.id, projectId,
        action: purpose === 'reset' ? 'password_reset_issued' : 'invite_issued',
        metadata: { systemUserId: user.id, expiresAt: expiresAt.toISOString() },
      });
      return { user, existingAccount: false };
    });
    if (result.existingAccount) {
      return {
        url: new URL('/login', this.publicBase).toString(),
        expiresAt: null,
        login: result.user.email,
        purpose: 'existing',
        existingAccount: true,
      };
    }
    const url = new URL(`/invite/${rawToken}`, this.publicBase).toString();
    return { url, expiresAt: expiresAt.toISOString(), login: result.user.email, purpose, existingAccount: false };
  }

  async inspectToken(rawToken) {
    if (!rawToken || rawToken.length > 128) throw new AccessError('invite_invalid', 410);
    const result = await this.pool.query(`
      SELECT t.auth_user_id,t.project_id,t.system_user_id,t.purpose,t.expires_at,t.used_at,t.revoked_at,
             u.email_normalized,u.name,m.role,m.status AS membership_status
      FROM auth_tokens t
      JOIN auth_users u ON u.id=t.auth_user_id
      JOIN auth_memberships m ON m.id=t.membership_id
      WHERE t.token_hash=$1 LIMIT 1
    `, [hashAccessToken(rawToken)]);
    const row = result.rows[0];
    if (!row || row.used_at || row.revoked_at || row.expires_at <= new Date().toISOString()) throw new AccessError('invite_invalid', 410);
    const project = await this.loadProject(this.pool, row.project_id);
    const user = this.validateProjectUser(project.state, row.system_user_id);
    if (user.status === 'disabled' || user.email !== normalizeAccessEmail(row.email_normalized)) throw new AccessError('invite_invalid', 410);
    return {
      accountId: row.auth_user_id, projectId: row.project_id, userId: row.system_user_id, purpose: row.purpose,
      expiresAt: row.expires_at, email: user.email, name: user.name, role: user.role,
      projectName: clean(project.state?.project?.name || project.state?.project?.code, 160),
    };
  }

  async activate(rawToken, password, passwordConfirm, context = {}) {
    const claim = hashAccessToken(rawToken || '');
    if (this.activationInFlight.has(claim)) throw new AccessError('activation_in_progress', 409);
    this.activationInFlight.add(claim);
    try {
      return await this.activateOnce(rawToken, password, passwordConfirm, context);
    } finally {
      this.activationInFlight.delete(claim);
    }
  }

  async activateOnce(rawToken, password, passwordConfirm, context = {}) {
    if (password !== passwordConfirm) throw new AccessError('password_mismatch', 422);
    const problem = passwordProblem(password);
    if (problem) throw new AccessError(problem, 422);
    const inspected = await this.inspectToken(rawToken);
    const passwordHash = await this.runPasswordWork(() => this.passwordHasher(password));
    const now = new Date().toISOString();
    return this.transaction(async (client) => {
      const project = await this.loadProject(client, inspected.projectId, true);
      const account = (await client.query(
        'SELECT id,email_normalized,name,status FROM auth_users WHERE id=$1 FOR UPDATE',
        [inspected.accountId],
      )).rows[0];
      const tokenResult = await client.query(`
        SELECT t.*,m.role,m.status AS membership_status
        FROM auth_tokens t JOIN auth_memberships m ON m.id=t.membership_id
        WHERE t.token_hash=$1 AND t.auth_user_id=$2 FOR UPDATE OF t,m
      `, [hashAccessToken(rawToken), inspected.accountId]);
      const token = tokenResult.rows[0];
      if (!account || !token || token.project_id !== inspected.projectId || token.used_at || token.revoked_at || token.expires_at <= now) throw new AccessError('invite_invalid', 410);
      const user = this.validateProjectUser(project.state, token.system_user_id);
      if (user.status === 'disabled' || user.email !== normalizeAccessEmail(account.email_normalized)) throw new AccessError('invite_invalid', 410);

      await client.query(`
        UPDATE auth_users SET password_hash=$1,status='active',activated_at=COALESCE(activated_at,$2),
          password_changed_at=$2,updated_at=$2 WHERE id=$3
      `, [passwordHash, now, token.auth_user_id]);
      await client.query("UPDATE auth_memberships SET status='active',role=$1,updated_at=$2 WHERE id=$3", [user.role, now, token.membership_id]);
      await client.query(`
        UPDATE auth_tokens SET revoked_at=$1
        WHERE auth_user_id=$2 AND token_hash<>$3 AND used_at IS NULL AND revoked_at IS NULL
      `, [now, token.auth_user_id, token.token_hash]);
      await client.query('UPDATE auth_tokens SET used_at=$1 WHERE token_hash=$2 AND used_at IS NULL', [now, token.token_hash]);
      await client.query('UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,$1) WHERE auth_user_id=$2', [now, token.auth_user_id]);

      const nextState = structuredClone(project.state);
      nextState.settings.users = nextState.settings.users.map((item) => item.id === user.id ? {
        ...item, status: 'active', webActivatedAt: now, inviteDelivery: 'sent',
      } : item);
      await this.saveProjectAccessMutation(client, token.project_id, project.revision, nextState, {
        actor: user.name, action: token.purpose === 'reset' ? 'access.password_reset' : 'access.activate',
        summary: token.purpose === 'reset' ? `Пароль обновлён: ${user.name}` : `Веб-доступ активирован: ${user.name}`,
      });
      await this.audit(client, {
        actorEmail: user.email, targetUserId: token.auth_user_id, projectId: token.project_id,
        action: token.purpose === 'reset' ? 'password_reset_completed' : 'invite_activated',
        metadata: { systemUserId: user.id },
      });
      const identity = { accountId: token.auth_user_id, email: user.email, name: user.name, isOwner: false };
      return this.createSession(identity, context, client);
    });
  }

  async saveProjectAccessMutation(client, projectId, revision, state, { actor, action, summary }) {
    const now = new Date().toISOString();
    const stateJson = JSON.stringify(state);
    const saved = await client.query(`
      UPDATE project_state SET state_json=$1,revision=$2,updated_at=$3,updated_by=$4,updated_role='management'
      WHERE project_id=$5 AND revision=$6
    `, [stateJson, revision + 1, now, actor, projectId, revision]);
    if (saved.rowCount !== 1) throw new AccessError('revision_conflict', 409);
    await client.query(`
      INSERT INTO audit_log (id,project_id,revision,created_at,actor,role,action,summary,state_bytes)
      VALUES ($1,$2,$3,$4,$5,'management',$6,$7,$8)
    `, [randomUUID(), projectId, revision + 1, now, actor, action, summary, Buffer.byteLength(stateJson)]);
    return {
      projectId,
      revision: revision + 1,
      updatedAt: now,
      updatedBy: actor,
      updatedRole: 'management',
      state,
    };
  }

  async listProjectAccess(projectId) {
    const project = await this.loadProject(this.pool, clean(projectId, 100));
    const result = await this.pool.query(`
      SELECT m.system_user_id,m.status AS membership_status,u.status AS account_status,u.email_normalized,
        u.password_hash,u.activated_at,u.last_login_at,
        t.created_at AS invited_at,t.expires_at,t.used_at,t.revoked_at,t.purpose
      FROM auth_memberships m JOIN auth_users u ON u.id=m.auth_user_id
      LEFT JOIN LATERAL (
        SELECT created_at,expires_at,used_at,revoked_at,purpose FROM auth_tokens
        WHERE membership_id=m.id ORDER BY created_at DESC LIMIT 1
      ) t ON TRUE
      WHERE m.project_id=$1
    `, [projectId]);
    const byId = new Map(result.rows.map((row) => [row.system_user_id, row]));
    const now = new Date().toISOString();
    return (project.state.settings?.users ?? []).map((user) => {
      const row = byId.get(user.id);
      const profileMatchesAccount = normalizeAccessEmail(user.email) === normalizeAccessEmail(row?.email_normalized);
      let status = 'not_issued';
      if (user.status === 'disabled' || row?.membership_status === 'disabled') status = 'blocked';
      else if (profileMatchesAccount && row?.account_status === 'active' && row?.password_hash && row?.membership_status === 'active' && user.status === 'active') status = 'active';
      else if (profileMatchesAccount && row?.expires_at && !row.used_at && !row.revoked_at && row.expires_at > now) status = 'pending';
      else if (profileMatchesAccount && row?.expires_at && !row.used_at) status = 'expired';
      return {
        userId: user.id,
        web: {
          status, invitedAt: row?.invited_at || undefined, expiresAt: row?.expires_at || undefined,
          activatedAt: row?.activated_at || user.webActivatedAt || undefined,
          lastLoginAt: row?.last_login_at || undefined,
        },
        telegram: {
          status: user.telegramBoundAt ? 'connected' : 'not_connected',
          boundAt: user.telegramBoundAt || undefined,
          username: clean(user.telegram, 120) || undefined,
        },
      };
    });
  }

  async setBlocked({ projectId, userId, actorEmail, blocked }) {
    const now = new Date().toISOString();
    return this.transaction(async (client) => {
      const project = await this.loadProject(client, clean(projectId, 100), true);
      const user = this.validateProjectUser(project.state, userId);
      const membership = (await client.query(
        'SELECT m.*,u.password_hash,u.status AS account_status FROM auth_memberships m JOIN auth_users u ON u.id=m.auth_user_id WHERE m.project_id=$1 AND m.system_user_id=$2 FOR UPDATE',
        [projectId, user.id],
      )).rows[0];
      if (membership) {
        const nextStatus = blocked ? 'disabled' : membership.password_hash && membership.account_status === 'active' ? 'active' : 'pending';
        await client.query('UPDATE auth_memberships SET status=$1,updated_at=$2 WHERE id=$3', [nextStatus, now, membership.id]);
        await client.query('UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,$1) WHERE auth_user_id=$2', [now, membership.auth_user_id]);
        if (blocked) await client.query('UPDATE auth_tokens SET revoked_at=COALESCE(revoked_at,$1) WHERE membership_id=$2 AND used_at IS NULL', [now, membership.id]);
      }
      const nextState = structuredClone(project.state);
      const activeAfter = !blocked && Boolean(membership?.password_hash && membership?.account_status === 'active');
      nextState.settings.users = nextState.settings.users.map((item) => item.id === user.id ? {
        ...item, status: blocked ? 'disabled' : activeAfter ? 'active' : 'invited',
      } : item);
      await this.saveProjectAccessMutation(client, projectId, project.revision, nextState, {
        actor: actorEmail, action: blocked ? 'access.block' : 'access.unblock',
        summary: blocked ? `Веб-доступ заблокирован: ${user.name}` : `Веб-доступ разблокирован: ${user.name}`,
      });
      await this.audit(client, { actorEmail, targetUserId: membership?.auth_user_id, projectId, action: blocked ? 'access_blocked' : 'access_unblocked', metadata: { systemUserId: user.id } });
      return { status: blocked ? 'blocked' : activeAfter ? 'active' : 'not_issued' };
    });
  }

  async revokeUserSessions({ projectId, userId, actorEmail }) {
    const now = new Date().toISOString();
    const result = await this.pool.query(`
      UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,$1)
      WHERE auth_user_id=(SELECT auth_user_id FROM auth_memberships WHERE project_id=$2 AND system_user_id=$3)
        AND revoked_at IS NULL
    `, [now, projectId, userId]);
    await this.audit(this.pool, { actorEmail, projectId, action: 'sessions_revoked', metadata: { systemUserId: userId, count: result.rowCount } });
    return result.rowCount;
  }

  async audit(client, { actorEmail, targetUserId = null, projectId = null, action, metadata = {} }) {
    await client.query(`
      INSERT INTO auth_audit (id,created_at,actor_email,target_user_id,project_id,action,metadata_json)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
    `, [randomUUID(), new Date().toISOString(), clean(actorEmail, 240) || 'system', targetUserId, projectId, action, JSON.stringify(metadata)]);
  }
}

export const accessErrorResponse = (error) => {
  if (error instanceof AccessError) return Response.json({ ok: false, error: error.code }, { status: error.status, headers: { 'Cache-Control': 'no-store' } });
  console.error(error);
  return Response.json({ ok: false, error: 'access_storage_error' }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
};
