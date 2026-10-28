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
await mkdir(`${projectRoot}dist/src/domain`, { recursive: true });
await mkdir(`${projectRoot}dist/src/domain/finance`, { recursive: true });
await mkdir(`${projectRoot}dist/src/domain/construction`, { recursive: true });
await mkdir(`${projectRoot}dist/src/application`, { recursive: true });
await mkdir(`${projectRoot}dist/src/infrastructure`, { recursive: true });
await mkdir(`${projectRoot}dist/server/projects`, { recursive: true });
await mkdir(`${projectRoot}dist/server/routes`, { recursive: true });
await mkdir(`${projectRoot}dist/server/telegram`, { recursive: true });
await mkdir(`${projectRoot}dist/server/runtime`, { recursive: true });

await Promise.all([
  copyFile(`${projectRoot}src/domain/treasury.js`, `${projectRoot}dist/src/domain/treasury.js`),
  copyFile(`${projectRoot}src/domain/finance-ledger.js`, `${projectRoot}dist/src/domain/finance-ledger.js`),
  copyFile(`${projectRoot}src/domain/finance-automation.js`, `${projectRoot}dist/src/domain/finance-automation.js`),
  copyFile(`${projectRoot}src/domain/finance-portfolio.js`, `${projectRoot}dist/src/domain/finance-portfolio.js`),
  copyFile(`${projectRoot}src/domain/treasury-planning.js`, `${projectRoot}dist/src/domain/treasury-planning.js`),
  copyFile(`${projectRoot}src/application/tasks-runtime.js`, `${projectRoot}dist/src/application/tasks-runtime.js`),
  copyFile(`${projectRoot}src/application/module-repository-runtime.js`, `${projectRoot}dist/src/application/module-repository-runtime.js`),
  copyFile(`${projectRoot}src/application/project-records.js`, `${projectRoot}dist/src/application/project-records.js`),
  copyFile(`${projectRoot}src/domain/task-mutations.js`, `${projectRoot}dist/src/domain/task-mutations.js`),
  copyFile(`${projectRoot}src/domain/document-records.js`, `${projectRoot}dist/src/domain/document-records.js`),
  copyFile(`${projectRoot}sites/telegram/business-commands.js`, `${projectRoot}dist/server/telegram/business-commands.js`),
  copyFile(`${projectRoot}sites/runtime/initialization.js`, `${projectRoot}dist/server/runtime/initialization.js`),
  copyFile(`${projectRoot}sites/projects/snapshot.js`, `${projectRoot}dist/server/projects/snapshot.js`),
  copyFile(`${projectRoot}sites/telegram/files.js`, `${projectRoot}dist/server/telegram/files.js`),
  copyFile(`${projectRoot}sites/telegram/visibility.js`, `${projectRoot}dist/server/telegram/visibility.js`),
  copyFile(`${projectRoot}sites/telegram/registration.js`, `${projectRoot}dist/server/telegram/registration.js`),
  copyFile(`${projectRoot}sites/telegram/update-handler.js`, `${projectRoot}dist/server/telegram/update-handler.js`),
  ...['index', 'plan-baseline', 'stage-control', 'schedule-forecast', 'automatic-schedule', 'stage-validation', 'baseline-validation', 'schedule-validation'].map(name => copyFile(`${projectRoot}src/domain/construction/${name}.js`, `${projectRoot}dist/src/domain/construction/${name}.js`)),
  copyFile(`${projectRoot}src/infrastructure/finance-commitment.js`, `${projectRoot}dist/src/infrastructure/finance-commitment.js`),
  copyFile(`${projectRoot}src/application/finance-context-commitment.js`, `${projectRoot}dist/src/application/finance-context-commitment.js`),
  ...['index', 'policy', 'planning', 'state-validation', 'transitions'].map((name) => copyFile(`${projectRoot}src/domain/finance/${name}.js`, `${projectRoot}dist/src/domain/finance/${name}.js`)),
  copyFile(`${projectRoot}src/domain/finance-totals.js`, `${projectRoot}dist/src/domain/finance-totals.js`),
  copyFile(`${projectRoot}sites/company-os-export.js`, `${projectRoot}dist/server/company-os-export.js`),
  copyFile(`${projectRoot}sites/company-os-investor-export.js`, `${projectRoot}dist/server/company-os-investor-export.js`),
  copyFile(`${projectRoot}sites/lib/schedule-forecast.js`, `${projectRoot}dist/server/lib/schedule-forecast.js`),
  copyFile(`${projectRoot}sites/projects/schedule-review.js`, `${projectRoot}dist/server/projects/schedule-review.js`),
  copyFile(`${projectRoot}sites/lib/stage-control.js`, `${projectRoot}dist/server/lib/stage-control.js`),
  copyFile(`${projectRoot}sites/projects/stage-control.js`, `${projectRoot}dist/server/projects/stage-control.js`),
  copyFile(`${projectRoot}sites/lib/plan-baseline.js`, `${projectRoot}dist/server/lib/plan-baseline.js`),
  copyFile(`${projectRoot}sites/projects/baseline.js`, `${projectRoot}dist/server/projects/baseline.js`),
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
  copyFile(`${projectRoot}sites/projects/shared-finance-account.js`, `${projectRoot}dist/server/projects/shared-finance-account.js`),
  copyFile(`${projectRoot}sites/projects/finance-portfolio.js`, `${projectRoot}dist/server/projects/finance-portfolio.js`),
  copyFile(`${projectRoot}sites/projects/finance.js`, `${projectRoot}dist/server/projects/finance.js`),
  copyFile(`${projectRoot}sites/projects/write.js`, `${projectRoot}dist/server/projects/write.js`),
  copyFile(`${projectRoot}sites/routes/api.js`, `${projectRoot}dist/server/routes/api.js`),
  copyFile(`${projectRoot}sites/telegram/attachment-drafts.js`, `${projectRoot}dist/server/telegram/attachment-drafts.js`),
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
  copyFile(`${projectRoot}sites/telegram/write-actions.js`, `${projectRoot}dist/server/telegram/write-actions.js`),
]);
