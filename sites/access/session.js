import { authenticatedIdentity, projectIdentity } from '../access-control.js';
import { json } from '../lib/http.js';

export const createSessionHandler = ({ ensureSchema }) => {
  const findIdentityAcrossProjects = async (request, env) => {
    const authenticated = authenticatedIdentity(request, env);
    if (!authenticated) return null;
    if (authenticated.isOwner) return { ...authenticated, id: 'owner', role: 'management', status: 'active' };
    if (!env.DB) return null;
    await ensureSchema(env.DB);
    const result = await env.DB.prepare(`
      SELECT state_json
      FROM project_state
      ORDER BY updated_at DESC
      LIMIT 100
    `).all();
    for (const row of result?.results ?? []) {
      try {
        const identity = projectIdentity(request, env, JSON.parse(row.state_json));
        if (identity) return identity;
      } catch {
        // Повреждённый снимок не должен раскрывать содержимое или ломать остальные membership.
      }
    }
    return null;
  };

  return async (request, env) => {
    try {
      const identity = await findIdentityAcrossProjects(request, env);
      if (!identity) return json({ ok: false, error: 'access_not_assigned' }, 403);
      return json({
        ok: true,
        user: {
          id: identity.id,
          email: identity.email,
          name: identity.name,
          role: identity.role,
          isOwner: identity.isOwner,
        },
      });
    } catch {
      return json({ ok: false, error: 'session_unavailable' }, 503);
    }
  };
};
