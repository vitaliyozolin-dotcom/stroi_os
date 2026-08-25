import { authenticatedIdentity, projectIdentity } from '../access-control.js';
import { json, publicLeadResponse } from '../lib/http.js';
import { readJsonBodyLimited } from '../lib/request-body.js';
import { clean, normalizeClientAddress, validProjectId } from '../lib/validation.js';

const MAX_JSON_BODY_BYTES = 32 * 1024;
const PUBLIC_LEAD_PROJECT_ID = 'ikioma-sales';
const PUBLIC_LEAD_ORIGINS = new Set(['https://ikioma.ru', 'https://www.ikioma.ru']);
const PUBLIC_LEAD_CLIENT_LIMIT = 5;
const PUBLIC_LEAD_RATE_WINDOW_MS = 60_000;
const PUBLIC_LEAD_BODY_LIMIT = 32 * 1024;

const sha256 = async (value) => {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const incrementPublicLeadRateLimit = async (db, key, windowStart, updatedAt) => {
  await db.prepare(`
    INSERT INTO public_lead_rate_limits (key, window_start, attempts, updated_at)
    VALUES (?, ?, 1, ?)
    ON CONFLICT(key, window_start) DO UPDATE SET
      attempts = public_lead_rate_limits.attempts + 1,
      updated_at = excluded.updated_at
  `).bind(key, windowStart, updatedAt).run();
  const row = await db.prepare(`
    SELECT attempts
    FROM public_lead_rate_limits
    WHERE key = ? AND window_start = ?
  `).bind(key, windowStart).first();
  return Number(row?.attempts) || 0;
};

export const claimPublicLeadRateLimit = async (db, clientAddress, now = Date.now()) => {
  const windowTime = Math.floor(now / PUBLIC_LEAD_RATE_WINDOW_MS) * PUBLIC_LEAD_RATE_WINDOW_MS;
  const windowStart = new Date(windowTime).toISOString();
  const updatedAt = new Date(now).toISOString();
  const retryAfter = Math.max(1, Math.ceil((windowTime + PUBLIC_LEAD_RATE_WINDOW_MS - now) / 1000));
  const expiredBefore = new Date(windowTime - 24 * 60 * 60 * 1000).toISOString();
  await db.prepare(`
    DELETE FROM public_lead_rate_limits
    WHERE window_start < ?
  `).bind(expiredBefore).run();

  const clientHash = await sha256(normalizeClientAddress(clientAddress));
  const clientAttempts = await incrementPublicLeadRateLimit(db, `client:${clientHash}`, windowStart, updatedAt);
  if (clientAttempts > PUBLIC_LEAD_CLIENT_LIMIT) return { allowed: false, retryAfter, scope: 'client' };
  return { allowed: true, retryAfter, scope: '' };
};

export const createLeadHandlers = ({
  ensureSchema,
  readSnapshot,
  resolveTelegramConnection,
  telegramSend,
  deepLink,
}) => {
  const telegramOrigin = (env) => clean(env.APP_PUBLIC_URL, 500) || 'https://stroios-work-2026.ozolin.chatgpt.site';

  const inbox = async (request, env) => {
    if (!env.DB) return json({ ok: false, error: 'storage_unavailable' }, 503);
    await ensureSchema(env.DB);
    if (request.method === 'GET') {
      const projectId = clean(new URL(request.url).searchParams.get('projectId'), 100);
      if (!validProjectId(projectId)) return json({ ok: false, error: 'invalid_project' }, 422);
      try {
        const snapshot = await readSnapshot(env.DB, projectId);
        const identity = projectId === PUBLIC_LEAD_PROJECT_ID
          ? authenticatedIdentity(request, env)
          : snapshot ? projectIdentity(request, env, snapshot.state) : null;
        if (!identity || (projectId === PUBLIC_LEAD_PROJECT_ID ? !identity.isOwner : identity.role !== 'management')) {
          return json({ ok: false, error: 'project_access_denied' }, 403);
        }
        const result = await env.DB.prepare(`SELECT id, project_id, created_at, name, phone, email, source, message, status FROM lead_inbox WHERE project_id = ? ORDER BY created_at DESC LIMIT 100`).bind(projectId).all();
        return json({ ok: true, leads: result?.results ?? [] });
      } catch {
        return json({ ok: false, error: 'storage_error' }, 500);
      }
    }
    let payload;
    try {
      payload = await readJsonBodyLimited(request, MAX_JSON_BODY_BYTES);
    } catch (error) {
      return json({ ok: false, error: error?.message === 'payload_too_large' ? 'payload_too_large' : 'invalid_json' }, error?.message === 'payload_too_large' ? 413 : 400);
    }
    const projectId = clean(payload?.projectId, 100);
    const name = clean(payload?.name, 120);
    const phone = clean(payload?.phone, 60);
    const email = clean(payload?.email, 240);
    const source = clean(payload?.source, 40) || 'website';
    const message = clean(payload?.message, 1000);
    if (!validProjectId(projectId) || !name || !phone) return json({ ok: false, error: 'invalid_lead' }, 422);
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    try {
      const snapshot = await readSnapshot(env.DB, projectId);
      const identity = snapshot ? projectIdentity(request, env, snapshot.state) : null;
      if (!identity || identity.role !== 'management') return json({ ok: false, error: 'project_access_denied' }, 403);
      await env.DB.prepare(`INSERT INTO lead_inbox (id, project_id, created_at, name, phone, email, source, message, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new')`).bind(id, projectId, createdAt, name, phone, email || null, source, message || null).run();
      return json({ ok: true, lead: { id, projectId, createdAt, name, phone, email, source, message, status: 'new' } }, 201);
    } catch {
      return json({ ok: false, error: 'storage_error' }, 500);
    }
  };

  const publicLead = async (request, env) => {
    const origin = clean(request.headers.get('origin'), 500);
    if (!PUBLIC_LEAD_ORIGINS.has(origin)) return json({ ok: false, error: 'forbidden_origin' }, 403);
    if (request.method === 'OPTIONS') return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
        'Vary': 'Origin',
      },
    });
    if (request.method !== 'POST') return publicLeadResponse({ ok: false, error: 'method_not_allowed' }, 405, origin);
    if (!env.DB) return publicLeadResponse({ ok: false, error: 'storage_unavailable' }, 503, origin);

    let payload;
    try {
      payload = await readJsonBodyLimited(request, PUBLIC_LEAD_BODY_LIMIT);
    } catch (error) {
      return publicLeadResponse(
        { ok: false, error: error?.message === 'payload_too_large' ? 'payload_too_large' : 'invalid_json' },
        error?.message === 'payload_too_large' ? 413 : 400,
        origin,
      );
    }

    const name = clean(payload?.name, 120);
    const phone = clean(payload?.phone, 60);
    const email = clean(payload?.email, 240);
    const source = clean(payload?.source, 40) || 'website';
    const message = clean(payload?.message, 1000);
    const trap = clean(payload?.company, 120);
    if (trap) return publicLeadResponse({ ok: true }, 202, origin);
    if (!name || phone.replace(/\D/g, '').length < 10 || (email && !/^\S+@\S+\.\S+$/.test(email))) {
      return publicLeadResponse({ ok: false, error: 'invalid_lead' }, 422, origin);
    }

    try {
      await ensureSchema(env.DB);
      const clientAddress = clean(
        request.headers.get('oai-client-ip') || request.headers.get('cf-connecting-ip'),
        200,
      ) || 'unknown';
      const rateLimit = await claimPublicLeadRateLimit(env.DB, clientAddress);
      if (!rateLimit.allowed) {
        return publicLeadResponse(
          { ok: false, error: 'rate_limit_exceeded' },
          429,
          origin,
          { 'Retry-After': String(rateLimit.retryAfter) },
        );
      }
    } catch {
      return publicLeadResponse({ ok: false, error: 'storage_error' }, 500, origin);
    }

    try {
      const duplicateAfter = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const duplicate = await env.DB.prepare(`
        SELECT id FROM lead_inbox
        WHERE project_id = ? AND phone = ? AND created_at >= ?
        LIMIT 1
      `).bind(PUBLIC_LEAD_PROJECT_ID, phone, duplicateAfter).first();
      if (duplicate?.id) return publicLeadResponse({ ok: true, duplicate: true }, 200, origin);

      const id = crypto.randomUUID();
      const createdAt = new Date().toISOString();
      await env.DB.prepare(`
        INSERT INTO lead_inbox (id, project_id, created_at, name, phone, email, source, message, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new')
      `).bind(id, PUBLIC_LEAD_PROJECT_ID, createdAt, name, phone, email || null, source, message || null).run();
      let telegramNotified = false;
      try {
        const connection = await resolveTelegramConnection(env, { discover: false });
        if (env.TELEGRAM_BOT_TOKEN && connection.chat?.id) {
          const details = [
            '🏠 Новая заявка с ikioma.ru',
            `Имя: ${name}`,
            `Телефон: ${phone}`,
            email ? `Email: ${email}` : '',
            `Источник: ${source}`,
            message ? `Комментарий: ${message}` : '',
            `Открыть воронку: ${deepLink(telegramOrigin(env), PUBLIC_LEAD_PROJECT_ID, 'marketing', id)}`,
          ].filter(Boolean).join('\n');
          const notification = await telegramSend(env.TELEGRAM_BOT_TOKEN, connection.chat.id, details, { timeoutMs: 3_000 });
          telegramNotified = notification.ok;
        }
      } catch {
        telegramNotified = false;
      }
      return publicLeadResponse({ ok: true, leadId: id, telegramNotified }, 201, origin);
    } catch {
      return publicLeadResponse({ ok: false, error: 'storage_error' }, 500, origin);
    }
  };

  return { inbox, publicLead };
};
