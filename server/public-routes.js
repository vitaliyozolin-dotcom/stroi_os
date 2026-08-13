const PUBLIC_ROUTES = new Set([
  '/api/health',
  '/api/integrations/telegram/bootstrap',
  '/api/integrations/telegram/update',
  '/api/public/leads',
]);

export const isPublicRoute = (url) => PUBLIC_ROUTES.has(url.pathname);
