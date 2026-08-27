import { projectIdentity } from '../access-control.js';
import { json } from '../lib/http.js';
import { clean, validProjectId } from '../lib/validation.js';

export const createAccessUsersHandler = ({ ensureSchema, readSnapshot }) => async (request, env) => {
  const projectId = clean(new URL(request.url).searchParams.get('projectId'), 100);
  if (!validProjectId(projectId)) return json({ ok: false, error: 'invalid_project' }, 422);
  try {
    await ensureSchema(env.DB);
    const snapshot = await readSnapshot(env.DB, projectId);
    const identity = snapshot ? projectIdentity(request, env, snapshot.state) : null;
    if (!identity?.isOwner) return json({ ok: false, error: 'owner_required' }, 403);
    const result = await env.DB.prepare(`
      SELECT system_user_id,bound_at,username,updated_at
      FROM telegram_bindings WHERE project_id = ? ORDER BY updated_at DESC
    `).bind(projectId).all();
    const telegramByUser = new Map();
    for (const binding of result?.results ?? []) {
      if (!telegramByUser.has(binding.system_user_id)) telegramByUser.set(binding.system_user_id, binding);
    }
    const users = (snapshot.state.settings?.users ?? []).map((user) => {
      const binding = telegramByUser.get(user.id);
      return {
        userId: user.id,
        web: { status: 'not_issued' },
        telegram: binding ? {
          status: 'connected', boundAt: binding.bound_at, username: clean(binding.username, 120) || undefined,
        } : { status: 'not_connected' },
      };
    });
    return json({ ok: true, authMode: 'sites_sso', users });
  } catch {
    return json({ ok: false, error: 'access_storage_error' }, 500);
  }
};
