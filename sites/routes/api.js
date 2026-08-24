import { json } from '../lib/http.js';

const route = (methods, handler) => ({ methods: new Set(methods), handler });

export const createApiHandler = (handlers) => {
  const routes = new Map([
    ['/api/session', route(['GET'], handlers.session)],
    ['/api/access/users', route(['GET'], handlers.accessUsers)],
    ['/api/state', route(['GET'], handlers.getState)],
    ['/api/projects', route(['GET'], handlers.projects)],
    ['/api/integrations/status', route(['GET'], handlers.integrationStatus)],
    ['/api/integrations/test', route(['POST'], handlers.integrationTest)],
    ['/api/integrations/telegram/select', route(['POST'], handlers.telegramChatSelect)],
    ['/api/integrations/telegram/link', route(['POST'], handlers.telegramLink)],
    ['/api/integrations/telegram/unlink', route(['POST'], handlers.telegramUnlink)],
    ['/api/integrations/telegram/bootstrap', route(['POST'], handlers.telegramBootstrap)],
    ['/api/camera/status', route(['GET'], handlers.cameraStatus)],
    ['/api/camera/view', route(['GET'], handlers.cameraView)],
    ['/api/quality/upload', route(['POST'], handlers.qualityPhotoUpload)],
    ['/api/quality/file', route(['GET'], handlers.qualityPhotoFile)],
    ['/api/documents/upload', route(['POST'], handlers.documentUpload)],
    ['/api/documents/file', route(['GET'], handlers.documentFile)],
    ['/api/field-reports/file', route(['GET'], handlers.fieldReportFile)],
    ['/api/leads', route(['GET', 'POST'], handlers.leadInbox)],
    ['/api/developer-feedback', route(['GET', 'POST'], handlers.developerFeedback)],
    ['/api/audit', route(['GET'], handlers.audit)],
  ]);

  return async (request, env, context) => {
    const url = new URL(request.url);
    if (url.pathname === '/api/public/leads') return handlers.publicLead(request, env);
    const origin = request.headers.get('origin');
    if (origin && origin !== url.origin) return json({ ok: false, error: 'forbidden_origin' }, 403);
    if (url.pathname === '/api/state' && request.method === 'PUT') return handlers.putState(request, env, context);
    if (url.pathname === '/api/integrations/telegram/update' && request.method === 'POST') return handlers.telegramUpdate(request, env, context);
    const target = routes.get(url.pathname);
    if (!target || !target.methods.has(request.method)) return json({ ok: false, error: 'not_found' }, 404);
    return target.handler(request, env);
  };
};
