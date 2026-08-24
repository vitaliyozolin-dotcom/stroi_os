import { projectIdentity } from '../access-control.js';
import { json } from '../lib/http.js';
import { clean, validProjectId } from '../lib/validation.js';

export const createCameraHandlers = ({ ensureSchema, readSnapshot }) => {
  const authorized = async (request, env) => {
    const projectId = clean(new URL(request.url).searchParams.get('projectId'), 100);
    if (!validProjectId(projectId)) return { response: json({ ok: false, error: 'invalid_project' }, 422) };
    await ensureSchema(env.DB);
    const snapshot = await readSnapshot(env.DB, projectId);
    const identity = snapshot ? projectIdentity(request, env, snapshot.state) : null;
    if (!identity) return { response: json({ ok: false, error: 'project_access_denied' }, 403) };
    return { snapshot };
  };

  const status = async (request, env) => {
    if (!env.DB) return json({ ok: false, error: 'storage_unavailable' }, 503);
    try {
      const result = await authorized(request, env);
      if (result.response) return result.response;
      return json({
        ok: true,
        camera: {
          configured: Boolean(env.CAMERA_VIEW_URL),
          online: Boolean(env.CAMERA_VIEW_URL && result.snapshot.state?.project?.cameraStatus === 'online'),
          label: clean(env.CAMERA_LABEL, 80) || 'Камера 01',
        },
      });
    } catch {
      return json({ ok: false, error: 'camera_status_unavailable' }, 503);
    }
  };

  const view = async (request, env) => {
    if (!env.CAMERA_VIEW_URL || !env.DB) return json({ ok: false, error: 'camera_not_configured' }, 409);
    try {
      const result = await authorized(request, env);
      if (result.response) return result.response;
      const target = new URL(env.CAMERA_VIEW_URL);
      if (!['https:', 'http:'].includes(target.protocol)) return json({ ok: false, error: 'invalid_camera_url' }, 500);
      return Response.redirect(target.toString(), 302);
    } catch {
      return json({ ok: false, error: 'camera_unavailable' }, 503);
    }
  };

  return { status, view };
};
