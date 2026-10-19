const PUBLIC_ROUTES = new Set([
  '/api/health',
  '/api/readiness',
  '/api/integrations/telegram/bootstrap',
  '/api/integrations/telegram/update',
  '/api/public/leads',
]);

export const isPublicRoute = (url) => PUBLIC_ROUTES.has(url.pathname);

// Exact public branding files; application data and uploads remain authenticated.
const PUBLIC_BRAND_ASSETS = new Set([
  "/brand/icon-maskable-512-20261019.png",
  "/favicon.ico",
  "/manifest.webmanifest",
  "/brand/icon-192-20261019.png",
  "/brand/ikioma-mark-20261019.png",
  "/brand/icon-180-20261019.png",
  "/brand/icon-512-20261019.png",
  "/brand/icon-32-20261019.png",
  "/brand/icon-16-20261019.png",
  "/brand/icon-48-20261019.png"
]);

export const isPublicBrandAsset = (url) => PUBLIC_BRAND_ASSETS.has(url.pathname);
