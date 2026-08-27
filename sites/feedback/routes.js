import { authenticatedIdentity, projectIdentity } from '../access-control.js';
import { json } from '../lib/http.js';
import { readJsonBodyLimited } from '../lib/request-body.js';
import { clean, validProjectId } from '../lib/validation.js';

const MAX_JSON_BODY_BYTES = 32 * 1024;

export const createDeveloperFeedbackHandler = ({ ensureSchema, readSnapshot }) => async (request, env) => {
  if (!env.DB) return json({ ok: false, error: 'storage_unavailable' }, 503);
  const url = new URL(request.url);
  let projectId = clean(url.searchParams.get('projectId'), 120);
  let payload = null;
  if (request.method === 'POST') {
    try {
      payload = await readJsonBodyLimited(request, MAX_JSON_BODY_BYTES);
    } catch (error) {
      return json({ ok: false, error: error?.message === 'payload_too_large' ? 'payload_too_large' : 'invalid_json' }, error?.message === 'payload_too_large' ? 413 : 400);
    }
    projectId = clean(payload?.projectId, 120);
  }
  if (!validProjectId(projectId)) return json({ ok: false, error: 'invalid_project' }, 422);
  try {
    await ensureSchema(env.DB);
    const snapshot = await readSnapshot(env.DB, projectId);
    const identity = snapshot ? projectIdentity(request, env, snapshot.state) : authenticatedIdentity(request, env);
    if (!identity || identity.role !== 'management') return json({ ok: false, error: 'project_access_denied' }, 403);
    if (request.method === 'GET') {
      const result = await env.DB.prepare(`
        SELECT id, project_id, created_at, created_by, page, category, title, details, status
        FROM developer_feedback WHERE project_id = ? ORDER BY created_at DESC LIMIT 50
      `).bind(projectId).all();
      return json({ ok: true, items: (result.results ?? []).map((row) => ({
        id: row.id, projectId: row.project_id, createdAt: row.created_at, createdBy: row.created_by,
        page: row.page, category: row.category, title: row.title, details: row.details, status: row.status,
      })) });
    }
    if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);
    const page = clean(payload?.page, 60);
    const category = clean(payload?.category, 60);
    const title = clean(payload?.title, 160);
    const details = clean(payload?.details, 3000);
    if (!page || !category || !title || !details) return json({ ok: false, error: 'invalid_feedback' }, 422);
    const item = {
      id: crypto.randomUUID(),
      projectId,
      createdAt: new Date().toISOString(),
      createdBy: clean(identity.name || identity.email, 160) || 'Пользователь',
      page,
      category,
      title,
      details,
      status: 'new',
    };
    await env.DB.prepare(`
      INSERT INTO developer_feedback (id, project_id, created_at, created_by, page, category, title, details, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(item.id, item.projectId, item.createdAt, item.createdBy, item.page, item.category, item.title, item.details, item.status).run();
    return json({ ok: true, item }, 201);
  } catch {
    return json({ ok: false, error: 'storage_error' }, 500);
  }
};
