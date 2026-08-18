import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

await mkdir(`${projectRoot}dist/.openai`, { recursive: true });
await mkdir(`${projectRoot}dist/server`, { recursive: true });
await mkdir(`${projectRoot}dist/server/files`, { recursive: true });
await mkdir(`${projectRoot}dist/server/lib`, { recursive: true });
await mkdir(`${projectRoot}dist/server/telegram`, { recursive: true });

await Promise.all([
  copyFile(`${projectRoot}.openai/hosting.json`, `${projectRoot}dist/.openai/hosting.json`),
  copyFile(`${projectRoot}sites/worker.js`, `${projectRoot}dist/server/index.js`),
  copyFile(`${projectRoot}sites/access-control.js`, `${projectRoot}dist/server/access-control.js`),
  copyFile(`${projectRoot}sites/wrangler.json`, `${projectRoot}dist/server/wrangler.json`),
  copyFile(`${projectRoot}sites/files/response.js`, `${projectRoot}dist/server/files/response.js`),
  copyFile(`${projectRoot}sites/files/routes.js`, `${projectRoot}dist/server/files/routes.js`),
  copyFile(`${projectRoot}sites/lib/date.js`, `${projectRoot}dist/server/lib/date.js`),
  copyFile(`${projectRoot}sites/lib/http.js`, `${projectRoot}dist/server/lib/http.js`),
  copyFile(`${projectRoot}sites/lib/request-body.js`, `${projectRoot}dist/server/lib/request-body.js`),
  copyFile(`${projectRoot}sites/lib/upload-admission.js`, `${projectRoot}dist/server/lib/upload-admission.js`),
  copyFile(`${projectRoot}sites/lib/validation.js`, `${projectRoot}dist/server/lib/validation.js`),
  copyFile(`${projectRoot}sites/telegram/bindings.js`, `${projectRoot}dist/server/telegram/bindings.js`),
  copyFile(`${projectRoot}sites/telegram/drafts.js`, `${projectRoot}dist/server/telegram/drafts.js`),
  copyFile(`${projectRoot}sites/telegram/inbox.js`, `${projectRoot}dist/server/telegram/inbox.js`),
  copyFile(`${projectRoot}sites/telegram/outbox.js`, `${projectRoot}dist/server/telegram/outbox.js`),
  copyFile(`${projectRoot}sites/telegram/transport.js`, `${projectRoot}dist/server/telegram/transport.js`),
]);
