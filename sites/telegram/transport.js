import { clean } from '../lib/validation.js';

const runtimeEnv = () => globalThis.process?.env ?? {};

export const telegramApiBase = () => clean(runtimeEnv().TELEGRAM_API_BASE, 500).replace(/\/+$/u, '')
  || 'https://api.telegram.org';

export const telegramTransportHeaders = (headers = {}) => {
  const relaySecret = clean(runtimeEnv().TELEGRAM_RELAY_SECRET, 512);
  return relaySecret
    ? { ...headers, 'X-Telegram-Relay-Secret': relaySecret }
    : headers;
};

export const telegramApiUrl = (path) => `${telegramApiBase()}${path}`;

export const telegramMessageText = (value, limit = 4000) => {
  const source = typeof value === 'string' ? value.trim() : String(value ?? '').trim();
  return source.length <= limit
    ? source
    : `${source.slice(0, Math.max(1, limit - 34)).trimEnd()}\n\n… сообщение сокращено ИКИОМА ОС`;
};

export const telegramRequest = (token, method, payload = {}, timeoutMs = 15_000) => fetch(
  telegramApiUrl(`/bot${token}/${method}`),
  {
    method: 'POST',
    headers: telegramTransportHeaders({ 'Content-Type': 'application/json' }),
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify(payload),
  },
);

export const parseTelegramBody = async (response) => {
  try {
    return await response.json();
  } catch {
    return null;
  }
};

export const telegramSend = async (token, chatId, text, options = {}) => {
  const { timeoutMs = 10_000, ...telegramOptions } = options;
  const response = await telegramRequest(token, 'sendMessage', {
    chat_id: chatId,
    text: telegramMessageText(text),
    disable_web_page_preview: true,
    ...telegramOptions,
  }, timeoutMs);
  if (!response.ok) {
    const body = await response.clone().json().catch(() => null);
    throw new Error(`telegram_send_failed:${response.status}:${clean(body?.description || response.status, 200)}`);
  }
  return response;
};

export const telegramCheckedRequest = async (token, method, payload = {}, timeoutMs = 15_000) => {
  const response = await telegramRequest(token, method, payload, timeoutMs);
  const body = await parseTelegramBody(response);
  if (!response.ok || body?.ok === false) {
    const description = clean(body?.description || response.status, 200);
    throw new Error(`telegram_${method}_failed:${response.status}:${description}`);
  }
  return body?.result ?? body;
};
