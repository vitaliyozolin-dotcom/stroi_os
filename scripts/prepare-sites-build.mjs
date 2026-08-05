import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

await mkdir(`${projectRoot}dist/.openai`, { recursive: true });
await mkdir(`${projectRoot}dist/server`, { recursive: true });

await Promise.all([
  copyFile(`${projectRoot}.openai/hosting.json`, `${projectRoot}dist/.openai/hosting.json`),
  copyFile(`${projectRoot}sites/worker.js`, `${projectRoot}dist/server/index.js`),
  copyFile(`${projectRoot}sites/wrangler.json`, `${projectRoot}dist/server/wrangler.json`),
]);
