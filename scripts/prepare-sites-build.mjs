import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

await mkdir(`${projectRoot}dist/.openai`, { recursive: true });
await mkdir(`${projectRoot}dist/server`, { recursive: true });
await mkdir(`${projectRoot}dist/server/files`, { recursive: true });
await mkdir(`${projectRoot}dist/server/feedback`, { recursive: true });
await mkdir(`${projectRoot}dist/server/access`, { recursive: true });
await mkdir(`${projectRoot}dist/server/automations`, { recursive: true });
await mkdir(`${projectRoot}dist/server/integrations`, { recursive: true });
await mkdir(`${projectRoot}dist/server/leads`, { recursive: true });
await mkdir(`${projectRoot}dist/server/lib`, { recursive: true });
await mkdir(`${projectRoot}dist/server/projects`, { recursive: true });
await mkdir(`${projectRoot}dist/server/routes`, { recursive: true });
await mkdir(`${projectRoot}dist/server/telegram`, { recursive: true });

await Promise.all([
  copyFile(`${projectRoot}.openai/hosting.json`, `${projectRoot}dist/.openai/hosting.json`),
  copyFile(`${projectRoot}sites/worker.js`, `${projectRoot}dist/server/index.js`),
  copyFile(`${projectRoot}sites/access-control.js`, `${projectRoot}dist/server/access-control.js`),
  copyFile(`${projectRoot}sites/access/session.js`, `${projectRoot}dist/server/access/session.js`),
  copyFile(`${projectRoot}sites/access/users.js`, `${projectRoot}dist/server/access/users.js`),
  copyFile(`${projectRoot}sites/automations/battle.js`, `${projectRoot}dist/server/automations/battle.js`),
  copyFile(`${projectRoot}sites/wrangler.json`, `${projectRoot}dist/server/wrangler.json`),
  copyFile(`${projectRoot}sites/files/response.js`, `${projectRoot}dist/server/files/response.js`),
  copyFile(`${projectRoot}sites/files/routes.js`, `${projectRoot}dist/server/files/routes.js`),
  copyFile(`${projectRoot}sites/feedback/routes.js`, `${projectRoot}dist/server/feedback/routes.js`),
  copyFile(`${projectRoot}sites/integrations/camera.js`, `${projectRoot}dist/server/integrations/camera.js`),
  copyFile(`${projectRoot}sites/integrations/notifications.js`, `${projectRoot}dist/server/integrations/notifications.js`),
  copyFile(`${projectRoot}sites/integrations/routes.js`, `${projectRoot}dist/server/integrations/routes.js`),
  copyFile(`${projectRoot}sites/integrations/status.js`, `${projectRoot}dist/server/integrations/status.js`),
  copyFile(`${projectRoot}sites/integrations/telegram-access.js`, `${projectRoot}dist/server/integrations/telegram-access.js`),
  copyFile(`${projectRoot}sites/integrations/telegram-bootstrap.js`, `${projectRoot}dist/server/integrations/telegram-bootstrap.js`),
  copyFile(`${projectRoot}sites/leads/routes.js`, `${projectRoot}dist/server/leads/routes.js`),
  copyFile(`${projectRoot}sites/lib/date.js`, `${projectRoot}dist/server/lib/date.js`),
  copyFile(`${projectRoot}sites/lib/http.js`, `${projectRoot}dist/server/lib/http.js`),
  copyFile(`${projectRoot}sites/lib/request-body.js`, `${projectRoot}dist/server/lib/request-body.js`),
  copyFile(`${projectRoot}sites/lib/secret.js`, `${projectRoot}dist/server/lib/secret.js`),
  copyFile(`${projectRoot}sites/lib/upload-admission.js`, `${projectRoot}dist/server/lib/upload-admission.js`),
  copyFile(`${projectRoot}sites/lib/validation.js`, `${projectRoot}dist/server/lib/validation.js`),
  copyFile(`${projectRoot}sites/projects/routes.js`, `${projectRoot}dist/server/projects/routes.js`),
  copyFile(`${projectRoot}sites/projects/write.js`, `${projectRoot}dist/server/projects/write.js`),
  copyFile(`${projectRoot}sites/routes/api.js`, `${projectRoot}dist/server/routes/api.js`),
  copyFile(`${projectRoot}sites/telegram/bindings.js`, `${projectRoot}dist/server/telegram/bindings.js`),
  copyFile(`${projectRoot}sites/telegram/commands.js`, `${projectRoot}dist/server/telegram/commands.js`),
  copyFile(`${projectRoot}sites/telegram/connection.js`, `${projectRoot}dist/server/telegram/connection.js`),
  copyFile(`${projectRoot}sites/telegram/drafts.js`, `${projectRoot}dist/server/telegram/drafts.js`),
  copyFile(`${projectRoot}sites/telegram/inbox.js`, `${projectRoot}dist/server/telegram/inbox.js`),
  copyFile(`${projectRoot}sites/telegram/outbox.js`, `${projectRoot}dist/server/telegram/outbox.js`),
  copyFile(`${projectRoot}sites/telegram/project-store.js`, `${projectRoot}dist/server/telegram/project-store.js`),
  copyFile(`${projectRoot}sites/telegram/read-commands.js`, `${projectRoot}dist/server/telegram/read-commands.js`),
  copyFile(`${projectRoot}sites/telegram/rendering.js`, `${projectRoot}dist/server/telegram/rendering.js`),
  copyFile(`${projectRoot}sites/telegram/transport.js`, `${projectRoot}dist/server/telegram/transport.js`),
  copyFile(`${projectRoot}sites/telegram/webhook.js`, `${projectRoot}dist/server/telegram/webhook.js`),
  copyFile(`${projectRoot}sites/telegram/write-drafts.js`, `${projectRoot}dist/server/telegram/write-drafts.js`),
]);
