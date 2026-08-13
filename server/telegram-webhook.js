const clean = (value, limit = 1000) => String(value ?? '').trim().slice(0, limit);

export const telegramWebhookConfig = (env = process.env) => ({
  token: clean(env.TELEGRAM_BOT_TOKEN, 512),
  url: clean(env.TELEGRAM_WEBHOOK_URL, 1000),
  secret: clean(env.TELEGRAM_WEBHOOK_SECRET, 512),
  apiBase: clean(env.TELEGRAM_API_BASE, 1000).replace(/\/+$/u, '') || 'https://api.telegram.org',
  relaySecret: clean(env.TELEGRAM_RELAY_SECRET, 512),
});

export const isTelegramWebhookConfigured = (config) => Boolean(config.token && config.url && config.secret);

const requestHeaders = (config) => ({
  'Content-Type': 'application/json',
  ...(config.relaySecret ? { 'X-Telegram-Relay-Secret': config.relaySecret } : {}),
});

const telegramApi = async (config, method, payload, timeoutMs, fetchImpl) => {
  const response = await fetchImpl(`${config.apiBase}/bot${config.token}/${method}`, {
    method: 'POST',
    headers: requestHeaders(config),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) {
    const description = clean(body?.description || `HTTP ${response.status}`, 300);
    throw new Error(`Telegram ${method}: ${description}`);
  }
  return body.result;
};

export const ensureTelegramWebhook = async (env = process.env, options = {}) => {
  const config = telegramWebhookConfig(env);
  if (!isTelegramWebhookConfigured(config)) return { ready: false, skipped: true, reason: 'webhook_not_configured' };
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = Number(options.timeoutMs) || 25_000;
  const current = await telegramApi(config, 'getWebhookInfo', {}, timeoutMs, fetchImpl);
  if (clean(current?.url, 1000) === config.url) {
    return { ready: true, changed: false, pendingUpdateCount: Number(current?.pending_update_count) || 0 };
  }

  await telegramApi(config, 'setWebhook', {
    url: config.url,
    secret_token: config.secret,
    allowed_updates: ['message', 'callback_query', 'my_chat_member'],
    drop_pending_updates: false,
  }, timeoutMs, fetchImpl);
  const verified = await telegramApi(config, 'getWebhookInfo', {}, timeoutMs, fetchImpl);
  if (clean(verified?.url, 1000) !== config.url) throw new Error('Telegram сохранил неверный адрес webhook');
  return {
    ready: true,
    changed: true,
    pendingUpdateCount: Number(verified?.pending_update_count) || 0,
    previousError: clean(current?.last_error_message, 300),
  };
};
