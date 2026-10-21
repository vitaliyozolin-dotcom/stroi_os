import { ensureSchema, ensureBattleReady, battleReadiness, initializeBattleRuntime } from './runtime/initialization.js';
import { readSnapshot } from './projects/snapshot.js';
import { telegramFileToR2, resolveTelegramDraftFile } from './telegram/files.js';
import { telegramAnswerCallback, telegramConfirmVisible, telegramDurableVisibility, requireTelegramVisibility, telegramSendPhoto } from './telegram/visibility.js';
import { createTelegramRegistration } from './telegram/registration.js';
import { createTelegramUpdateProcessor, telegramMessageMentionsBot } from './telegram/update-handler.js';
import { createTelegramWriteActions } from './telegram/write-actions.js';
import { applyBattleAutomations } from './automations/battle.js';
import { createFileHandlers } from './files/routes.js';
import { createDeveloperFeedbackHandler } from './feedback/routes.js';
import { createProjectReadHandlers } from './projects/routes.js';
import { createProjectWriteHandler } from './projects/write.js';
import { createSessionHandler } from './access/session.js';
import { createAccessUsersHandler } from './access/users.js';
import { createCameraHandlers } from './integrations/camera.js';
import { createNotificationService, deepLink } from './integrations/notifications.js';
import { createTelegramAccessHandlers } from './integrations/telegram-access.js';
import { createTelegramBootstrapHandler } from './integrations/telegram-bootstrap.js';
import { createIntegrationHandlers } from './integrations/routes.js';
import { createIntegrationStatus } from './integrations/status.js';
import {
  claimPublicLeadRateLimit as claimPublicLeadRateLimitModule,
  createLeadHandlers,
} from './leads/routes.js';
import { createApiHandler } from './routes/api.js';
import { json } from './lib/http.js';
import {
  requestWithBodyLimit,
} from './lib/request-body.js';
import { claimUploadAdmission } from './lib/upload-admission.js';
import {
  clean,
} from './lib/validation.js';
import {
  flushTelegramOutbox as flushTelegramOutboxModule,
  reviveTelegramOutbox,
} from './telegram/outbox.js';
import {
  claimTelegramUpdate as claimTelegramUpdateModule,
  completeTelegramUpdate,
  failTelegramUpdate,
  readTelegramUpdateStatus,
} from './telegram/inbox.js';
import {
  parseTelegramBody,
  telegramRequest,
  telegramSend,
} from './telegram/transport.js';
import {
  claimTelegramDraft as claimTelegramDraftModule,
  createTelegramDraft as createTelegramDraftModule,
  releaseTelegramDraft as releaseTelegramDraftModule,
  updateTelegramDraft as updateTelegramDraftModule,
} from './telegram/drafts.js';
import {
  bindingForTelegramProject as bindingForTelegramProjectModule,
  bindingsForTelegramUser as bindingsForTelegramUserModule,
  bindingForTelegramUser as bindingForTelegramUserModule,
  selectTelegramBinding,
} from './telegram/bindings.js';
import {
  commandFromText,
  naturalTelegramCommand,
  parseTelegramExpense,
  telegramCommandTargetsBot,
} from './telegram/commands.js';
import { createTelegramConnection } from './telegram/connection.js';
import { createTelegramProjectStore } from './telegram/project-store.js';
import { createTelegramWebhookHandler } from './telegram/webhook.js';
import { createTelegramReadCommands } from './telegram/read-commands.js';
import { createTelegramWriteDrafts } from './telegram/write-drafts.js';
import { createTelegramAttachmentDrafts } from './telegram/attachment-drafts.js';
import {
  renderExpenseDraft,
  renderTaskDraft,
  telegramTaskActionKey,
} from './telegram/rendering.js';

export { battleReadiness, initializeBattleRuntime, resolveTelegramDraftFile, telegramMessageMentionsBot };

const TELEGRAM_MUTATION_NOOP = Symbol('telegram_mutation_noop');

const changes = (result) => Number(result?.meta?.changes ?? result?.changes ?? 0);

export { claimUploadAdmission, requestWithBodyLimit };
export {
  commandFromText,
  naturalTelegramCommand,
  parseTelegramExpense,
  telegramCommandTargetsBot,
  telegramTaskActionKey,
};

const {
  qualityPhotoUpload: handleQualityPhotoUpload,
  qualityPhotoFile: handleQualityPhotoFile,
  documentUpload: handleDocumentUpload,
  documentFile: handleDocumentFile,
  fieldReportFile: handleFieldReportFile,
} = createFileHandlers({ ensureSchema, readSnapshot });

const {
  discoverTelegramChats,
  readObservedTelegramChats,
  readTelegramBot,
  readTelegramConfig,
  rememberTelegramChatCandidates,
  resolveTelegramConnection,
  telegramGroupChatAuthorized,
  verifyAndStoreTelegramChat,
} = createTelegramConnection({ ensureSchema, readSnapshot, reviveTelegramOutbox });

const { getState: handleGetState, audit: handleAudit, projects: handleProjects } = createProjectReadHandlers({ ensureSchema, readSnapshot });
const handleSession = createSessionHandler({ ensureSchema });
const handleAccessUsers = createAccessUsersHandler({ ensureSchema, readSnapshot });
const { status: handleCameraStatus, view: handleCameraView } = createCameraHandlers({ ensureSchema, readSnapshot });


export const flushTelegramOutbox = (env, limit = 10) => flushTelegramOutboxModule(env, limit, ensureSchema);

const sha256 = async (value) => {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, '0')).join('');
};

const { buildPlan: buildNotificationPlan, dispatch: dispatchNotifications } = createNotificationService({
  resolveTelegramConnection,
  sha256,
});

const {
  mutate: mutateProjectFromTelegram,
} = createTelegramProjectStore({ ensureSchema, readSnapshot, changes, mutationNoop: TELEGRAM_MUTATION_NOOP });

const bindingForTelegramProject = (db, telegramUserId, projectId) => (
  bindingForTelegramProjectModule(db, telegramUserId, projectId, ensureSchema)
);

const bindingsForTelegramUser = (db, telegramUserId) => (
  bindingsForTelegramUserModule(db, telegramUserId, ensureSchema)
);

const bindingForTelegramUser = (db, telegramUserId, chatId = '') => (
  bindingForTelegramUserModule(db, telegramUserId, chatId, ensureSchema)
);

export { selectTelegramBinding };

export const createTelegramDraft = createTelegramDraftModule;
export const updateTelegramDraft = updateTelegramDraftModule;
export const claimTelegramDraft = claimTelegramDraftModule;
export const releaseTelegramDraft = releaseTelegramDraftModule;

const telegramOrigin = (env) => clean(env.APP_PUBLIC_URL, 500) || 'https://stroios-work-2026.ozolin.chatgpt.site';

const telegramBotUsername = async (env) => {
  const fromEnv = clean(env.TELEGRAM_BOT_USERNAME, 120).replace(/^@/u, '');
  if (fromEnv) return fromEnv;
  try {
    const stored = await readTelegramConfig(env.DB);
    const configured = clean(stored?.bot?.username, 120).replace(/^@/u, '');
    if (configured) return configured;
  } catch {
    // Имя бота не должно зависеть от доступности служебной записи или Telegram getMe.
  }
  return 'ikioma_bot';
};

const {
  link: handleTelegramLink,
  unlink: handleTelegramUnlink,
} = createTelegramAccessHandlers({ ensureSchema, readSnapshot, telegramBotUsername, mutateProjectFromTelegram });

const { bindTelegramUser } = createTelegramRegistration({ readSnapshot, sha256, mutateProjectFromTelegram });

const telegramReadCommands = createTelegramReadCommands({ readSnapshot, telegramSendPhoto });
export const { projectForBinding } = telegramReadCommands;
const telegramWriteDrafts = createTelegramWriteDrafts({
  createDraft: createTelegramDraft,
  parseExpense: parseTelegramExpense,
  projectForBinding,
  renderExpenseDraft,
  renderTaskDraft,
});
const telegramAttachmentDrafts = createTelegramAttachmentDrafts({
  createDraft: createTelegramDraft,
  projectForBinding,
  telegramBotUsername,
});


const {
  telegramConfirmTask, telegramConfirmNote, telegramConfirmExpense,
  telegramConfirmFile, telegramChangeTaskStatus,
} = createTelegramWriteActions({
  projectForBinding, mutateProjectFromTelegram, TELEGRAM_MUTATION_NOOP,
  dispatchNotifications, telegramOrigin, telegramConfirmVisible,
  requireTelegramVisibility, updateTelegramDraft, resolveTelegramDraftFile,
  telegramFileToR2, telegramDurableVisibility, telegramAnswerCallback,
});

const { processTelegramUpdate } = createTelegramUpdateProcessor({
  readSnapshot, bindingsForTelegramUser, bindingForTelegramUser, bindingForTelegramProject, telegramBotUsername, telegramGroupChatAuthorized, bindTelegramUser, createTelegramDraft, telegramReadCommands, telegramWriteDrafts, telegramAttachmentDrafts, telegramConfirmTask, telegramConfirmNote, telegramConfirmExpense, telegramConfirmFile, telegramChangeTaskStatus,
});

export const claimTelegramUpdate = claimTelegramUpdateModule;

const handleTelegramUpdate = createTelegramWebhookHandler({
  ensureSchema,
  rememberTelegramChatCandidates,
  flushTelegramOutbox,
  claimTelegramUpdate,
  readTelegramUpdateStatus,
  processTelegramUpdate,
  completeTelegramUpdate,
  failTelegramUpdate,
});


const integrationStatus = createIntegrationStatus({ ensureSchema, resolveTelegramConnection });

const {
  status: handleIntegrationStatus,
  test: handleIntegrationTest,
  telegramChatSelect: handleTelegramChatSelect,
} = createIntegrationHandlers({
  integrationStatus,
  resolveTelegramConnection,
  telegramSend,
  reviveTelegramOutbox,
  flushTelegramOutbox,
  readObservedTelegramChats,
  readTelegramBot,
  discoverTelegramChats,
  verifyAndStoreTelegramChat,
});

const handleTelegramBootstrap = createTelegramBootstrapHandler({
  ensureSchema,
  changes,
  resolveTelegramConnection,
  telegramRequest,
  telegramSend,
  parseTelegramBody,
  telegramOrigin,
});

const {
  inbox: handleLeadInbox,
  publicLead: handlePublicLead,
} = createLeadHandlers({
  ensureSchema,
  readSnapshot,
  resolveTelegramConnection,
  telegramSend,
  deepLink,
});

export const claimPublicLeadRateLimit = (...args) => claimPublicLeadRateLimitModule(...args);

const handleDeveloperFeedback = createDeveloperFeedbackHandler({ ensureSchema, readSnapshot });

const handlePutState = createProjectWriteHandler({
  ensureSchema,
  readSnapshot,
  changes,
  applyAutomations: applyBattleAutomations,
  buildNotificationPlan,
  dispatchNotifications,
});

const handleApi = createApiHandler({
  session: handleSession,
  accessUsers: handleAccessUsers,
  getState: handleGetState,
  putState: handlePutState,
  projects: handleProjects,
  integrationStatus: handleIntegrationStatus,
  integrationTest: handleIntegrationTest,
  telegramChatSelect: handleTelegramChatSelect,
  telegramLink: handleTelegramLink,
  telegramUnlink: handleTelegramUnlink,
  telegramBootstrap: handleTelegramBootstrap,
  telegramUpdate: handleTelegramUpdate,
  cameraStatus: handleCameraStatus,
  cameraView: handleCameraView,
  qualityPhotoUpload: handleQualityPhotoUpload,
  qualityPhotoFile: handleQualityPhotoFile,
  documentUpload: handleDocumentUpload,
  documentFile: handleDocumentFile,
  fieldReportFile: handleFieldReportFile,
  leadInbox: handleLeadInbox,
  publicLead: handlePublicLead,
  developerFeedback: handleDeveloperFeedback,
  audit: handleAudit,
});

export const serveSpa = async (request, env) => {
  const assetResponse = await env.ASSETS.fetch(request);
  if (assetResponse.status !== 404 || request.method !== 'GET') return assetResponse;

  const url = new URL(request.url);
  // Project identifiers may contain dots; these are application routes, not assets.
  const workspaceRoute = /^\/projects\/[a-zA-Z0-9._:-]{1,100}\/[^/.]+\/?$/.test(url.pathname);
  if (url.pathname.includes('.') && !workspaceRoute) return assetResponse;

  url.pathname = '/index.html';
  return env.ASSETS.fetch(new Request(url, request));
};

export default {
  async fetch(request, env, context) {
    const requestEnv = context?.waitUntil
      ? { ...env, WAIT_UNTIL: (promise) => context.waitUntil(promise) }
      : env;
    const url = new URL(request.url);
    if ((url.pathname === '/api/readiness' || url.pathname === '/api/health') && request.method === 'GET') {
      const readiness = await battleReadiness(requestEnv);
      return json(readiness, readiness.ok ? 200 : 503);
    }
    try {
      await ensureBattleReady(requestEnv);
      if (requestEnv.DB && requestEnv.TELEGRAM_BOT_TOKEN && context?.waitUntil) {
        context.waitUntil(flushTelegramOutbox(requestEnv).catch(() => null));
      }
      if (url.pathname.startsWith('/api/')) return handleApi(request, requestEnv, context);
      return serveSpa(request, requestEnv);
    } catch {
      if (url.pathname.startsWith('/api/')) return json({ ok: false, error: 'battle_initialization_failed' }, 503);
      return new Response('ИКИОМА ОС временно завершает подготовку рабочего пространства. Обновите страницу через минуту.', {
        status: 503,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      });
    }
  },
  async scheduled(_controller, env, context) {
    const scheduledEnv = context?.waitUntil
      ? { ...env, WAIT_UNTIL: (promise) => context.waitUntil(promise) }
      : env;
    await ensureBattleReady(scheduledEnv);
    context.waitUntil(flushTelegramOutbox(scheduledEnv));
  },
};
