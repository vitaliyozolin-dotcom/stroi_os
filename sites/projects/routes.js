import { projectIdentity, stateForRole } from '../access-control.js';
import { json } from '../lib/http.js';
import { clean, validProjectId } from '../lib/validation.js';

export const createProjectReadHandlers = ({ ensureSchema, readSnapshot }) => {
  const getState = async (request, env) => {
    if (!env.DB) return json({ ok: false, error: 'storage_unavailable' }, 503);
    const projectId = clean(new URL(request.url).searchParams.get('projectId'), 100);
    if (!validProjectId(projectId)) return json({ ok: false, error: 'invalid_project' }, 422);
    try {
      await ensureSchema(env.DB);
      const snapshot = await readSnapshot(env.DB, projectId);
      if (!snapshot) return json({ ok: false, error: 'not_found' }, 404);
      const identity = projectIdentity(request, env, snapshot.state);
      if (!identity) return json({ ok: false, error: 'project_access_denied' }, 403);
      return json({ ok: true, snapshot: { ...snapshot, state: stateForRole(snapshot.state, identity), updatedRole: identity.role } });
    } catch {
      return json({ ok: false, error: 'storage_error' }, 500);
    }
  };

  const audit = async (request, env) => {
    if (!env.DB) return json({ ok: false, error: 'storage_unavailable' }, 503);
    const url = new URL(request.url);
    const projectId = clean(url.searchParams.get('projectId'), 100);
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 30));
    if (!validProjectId(projectId)) return json({ ok: false, error: 'invalid_project' }, 422);
    try {
      await ensureSchema(env.DB);
      const snapshot = await readSnapshot(env.DB, projectId);
      const identity = snapshot ? projectIdentity(request, env, snapshot.state) : null;
      if (!identity || identity.role !== 'management') return json({ ok: false, error: 'project_access_denied' }, 403);
      const result = await env.DB.prepare(`
        SELECT id, revision, created_at, actor, role, action, summary, state_bytes
        FROM audit_log
        WHERE project_id = ?
        ORDER BY revision DESC
        LIMIT ?
      `).bind(projectId, limit).all();
      return json({ ok: true, events: result?.results ?? [] });
    } catch {
      return json({ ok: false, error: 'storage_error' }, 500);
    }
  };

  const projects = async (request, env) => {
    if (!env.DB) return json({ ok: false, error: 'storage_unavailable' }, 503);
    try {
      await ensureSchema(env.DB);
      const result = await env.DB.prepare(`
        SELECT project_id, state_json, revision, updated_at
        FROM project_state
        ORDER BY updated_at DESC
        LIMIT 100
      `).all();
      const visible = (result?.results ?? []).flatMap((row) => {
        try {
          const state = JSON.parse(row.state_json);
          if (!projectIdentity(request, env, state)) return [];
          const project = state?.project;
          if (!project?.id || String(project.id).startsWith('__')) return [];
          return [{
            id: project.id,
            code: clean(project.code, 40),
            name: clean(project.name, 120),
            model: clean(project.model, 120),
            area: Number(project.area) || 0,
            address: clean(project.address, 240),
            targetDate: clean(project.targetDate, 40),
            revision: Number(row.revision),
            updatedAt: row.updated_at,
            status: clean(project.status, 40),
          }];
        } catch {
          return [];
        }
      });
      const projects = visible.some((project) => project.status !== 'workspace')
        ? visible.filter((project) => project.status !== 'workspace')
        : visible;
      return json({ ok: true, projects: projects.map(({ status: _status, ...project }) => project) });
    } catch {
      return json({ ok: false, error: 'storage_error' }, 500);
    }
  };

  return { getState, audit, projects };
};
