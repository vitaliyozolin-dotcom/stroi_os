import { projectIdentity } from '../access-control.js';
import { addDays } from '../lib/date.js';
import { json } from '../lib/http.js';
import { readJsonBodyLimited } from '../lib/request-body.js';
import { clean, validProjectId } from '../lib/validation.js';
import { unlinkTelegramBinding } from '../telegram/bindings.js';

const MAX_JSON_BODY_BYTES = 32 * 1024;

const sha256 = async (value) => {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, '0')).join('');
};

const shortId = () => crypto.randomUUID().replaceAll('-', '').slice(0, 16);

const readTarget = async (request) => {
  try {
    const payload = await readJsonBodyLimited(request, MAX_JSON_BODY_BYTES);
    const projectId = clean(payload?.projectId, 100);
    const userId = clean(payload?.userId, 100);
    if (!validProjectId(projectId) || !userId) return { response: json({ ok: false, error: 'invalid_link_target' }, 422) };
    return { projectId, userId };
  } catch (error) {
    const tooLarge = error?.message === 'payload_too_large';
    return { response: json({ ok: false, error: tooLarge ? 'payload_too_large' : 'invalid_json' }, tooLarge ? 413 : 400) };
  }
};

export const createTelegramAccessHandlers = ({
  ensureSchema,
  readSnapshot,
  telegramBotUsername,
  mutateProjectFromTelegram,
}) => {
  const authorizedTarget = async (request, env, includeDisabled) => {
    const target = await readTarget(request);
    if (target.response) return target;
    await ensureSchema(env.DB);
    const snapshot = await readSnapshot(env.DB, target.projectId);
    const identity = snapshot ? projectIdentity(request, env, snapshot.state) : null;
    if (!identity?.isOwner) return { response: json({ ok: false, error: 'owner_required' }, 403) };
    const user = (snapshot.state.settings?.users ?? []).find((item) => (
      clean(item.id, 100) === target.userId && (includeDisabled || item.status !== 'disabled')
    ));
    if (!user) return { response: json({ ok: false, error: 'user_not_found' }, 404) };
    return { ...target, identity, user };
  };

  const link = async (request, env) => {
    if (!env.DB || !env.TELEGRAM_BOT_TOKEN) return json({ ok: false, error: 'telegram_not_configured' }, 409);
    try {
      const target = await authorizedTarget(request, env, false);
      if (target.response) return target.response;
      const username = await telegramBotUsername(env);
      if (!username) return json({ ok: false, error: 'telegram_bot_unavailable' }, 502);

      const code = `${shortId()}${shortId()}`;
      const codeHash = await sha256(code);
      const now = new Date();
      const expiresAt = addDays(now, 1).toISOString();
      await env.DB.batch([
        env.DB.prepare(`
          DELETE FROM telegram_link_codes
          WHERE project_id = ? AND system_user_id = ? AND used_at IS NULL
        `).bind(target.projectId, target.userId),
        env.DB.prepare(`
          INSERT INTO telegram_link_codes (
            code_hash, project_id, system_user_id, created_at, expires_at, used_at, claim_id
          ) VALUES (?, ?, ?, ?, ?, NULL, NULL)
        `).bind(codeHash, target.projectId, target.userId, now.toISOString(), expiresAt),
      ]);
      return json({
        ok: true,
        url: `https://t.me/${username}?start=${code}`,
        expiresAt,
        user: { id: target.user.id, name: target.user.name },
      }, 201);
    } catch {
      return json({ ok: false, error: 'telegram_link_failed' }, 500);
    }
  };

  const unlink = async (request, env) => {
    if (!env.DB) return json({ ok: false, error: 'telegram_not_configured' }, 409);
    try {
      const target = await authorizedTarget(request, env, true);
      if (target.response) return target.response;
      const removed = await unlinkTelegramBinding(env.DB, target.projectId, target.userId);
      try {
        await mutateProjectFromTelegram(
          env,
          target.projectId,
          target.identity.name,
          'management',
          'telegram.unlink',
          `Telegram отключён: ${target.user.name}`,
          (state) => {
            state.settings.users = (state.settings?.users ?? []).map((item) => item.id === target.user.id ? {
              ...item,
              telegramChatId: undefined,
              telegramBoundAt: undefined,
            } : item);
            state.activity = [{
              id: `activity-${crypto.randomUUID()}`,
              timestamp: new Date().toISOString(),
              actor: target.identity.name,
              text: `Отключил Telegram пользователя ${target.user.name}`,
              tone: 'neutral',
            }, ...(state.activity ?? [])];
          },
        );
      } catch {
        // Таблица привязок уже атомарно очищена и остаётся источником истины для UI и команд.
      }
      return json({ ok: true, removed: removed.removed, telegram: { status: 'not_connected' } });
    } catch {
      return json({ ok: false, error: 'telegram_unlink_failed' }, 500);
    }
  };

  return { link, unlink };
};
