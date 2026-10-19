import { dateKey } from '../lib/date.js';
import { clean } from '../lib/validation.js';
import { commandFromText, telegramCommandTargetsBot } from './commands.js';
import { renderFileDraft } from './rendering.js';
import { telegramSend } from './transport.js';

const categoryFromDocument = (name, caption) => {
  const source = `${clean(name, 240)} ${clean(caption, 500)}`.toLocaleLowerCase('ru');
  if (source.includes('договор')) return ['contract', 'Договор'];
  if (source.includes('акт')) return ['act', 'Акт'];
  if (source.includes('упд')) return ['upd', 'УПД'];
  if (source.includes('наклад') || /\bтн\b/.test(source)) return ['waybill', 'ТН'];
  if (source.includes('счёт') || source.includes('счет')) return ['invoice', 'Счёт'];
  if (source.includes('специф')) return ['specification', 'Спецификация'];
  return ['other', 'Прочее'];
};

export const createTelegramAttachmentDrafts = ({ createDraft, projectForBinding, telegramBotUsername }) => {
  const prepare = async (message, binding, env) => {
    const { snapshot } = await projectForBinding(env, binding);
    const caption = clean(message.caption, 1200);
    const captionCommand = commandFromText(caption);
    const isPrivate = message.chat?.type === 'private';
    if (!isPrivate && !telegramCommandTargetsBot(captionCommand, await telegramBotUsername(env))) return;
    if (!isPrivate && !['doc', 'report'].includes(captionCommand?.name)) return;
    const document = message.document;
    const photo = Array.isArray(message.photo) ? message.photo.at(-1) : null;
    const voice = message.voice;
    const source = document ?? photo ?? voice;
    if (!source?.file_id) return;
    const kind = captionCommand?.name === 'doc' || (document && captionCommand?.name !== 'report') ? 'document' : 'field_report';
    const fallbackName = document?.file_name
      || (voice ? `Голосовой отчёт ${dateKey()}.ogg` : `Фотоотчёт ${dateKey()}.jpg`);
    const [category, typeLabel] = categoryFromDocument(fallbackName, caption);
    const note = clean(captionCommand?.body || caption, 1000);
    const draft = await createDraft(env.DB, String(message.from.id), String(message.chat.id), binding.project_id, kind, {
      projectName: snapshot.state.project?.name ?? snapshot.state.project?.code ?? binding.project_id,
      telegramFileId: source.file_id,
      fileName: fallbackName,
      mimeType: clean(document?.mime_type || voice?.mime_type || (photo ? 'image/jpeg' : ''), 120),
      fileSize: Number(document?.file_size || voice?.file_size || photo?.file_size) || 0,
      note,
      category,
      typeLabel,
      telegramMessageId: String(message.message_id ?? ''),
    }, String(message.message_id ?? ''));
    const card = renderFileDraft(draft);
    await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, card.text, { reply_markup: card.replyMarkup });
  };

  const payload = (message) => ({
    message_id: message.message_id,
    caption: clean(message.caption, 1200),
    chat: { id: message.chat.id, type: message.chat.type },
    document: message.document ?? null,
    photo: message.photo ?? null,
    voice: message.voice ?? null,
  });

  return { prepare, payload };
};
