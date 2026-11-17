import { clean, validProjectId } from '../lib/validation.js';
import { qualityRequestStillNeeded } from '../automations/project-coordinator.js';
import { telegramFileToR2 } from './files.js';

// The project reference must come from a real message authored by this bot, never from a user's caption.
export const qualityReplyTarget = (message, botUsername, origin) => {
  const reply = message.reply_to_message;
  if (!reply?.from?.is_bot || clean(reply.from.username, 120).toLowerCase() !== clean(botUsername, 120).replace(/^@/, '').toLowerCase()) return null;
  const matches = String(reply.text || '').match(/https?:\/\/[^\s]+/g) || [];
  const targets = matches.flatMap(value => {
    try {
      const url = new URL(value);
      const projectId = url.searchParams.get('projectId'), checkpointId = url.searchParams.get('entity');
      return url.origin === new URL(origin).origin && url.searchParams.get('page') === 'quality' && validProjectId(projectId) && validProjectId(checkpointId) ? [{ projectId, checkpointId }] : [];
    } catch { return []; }
  });
  return targets.length === 1 ? targets[0] : null;
};

export const receiveQualityReply = async ({ message, bindings, env, botUsername, readSnapshot, mutateProjectFromTelegram, mutationNoop }) => {
  if (!message.photo?.length || !env.BUCKET || !mutateProjectFromTelegram) return false;
  const origin = clean(env.APP_PUBLIC_URL, 500);
  if (!origin) return false;
  let target = qualityReplyTarget(message, botUsername, origin);
  const albumKey = message.media_group_id ? `quality-album:${message.chat.id}:${message.from.id}:${message.media_group_id}` : '';
  if (!target && albumKey) {
    const saved = await env.DB.prepare('SELECT value FROM system_meta WHERE key = ?').bind(albumKey).first();
    try { const value = JSON.parse(saved?.value || 'null'); if (value && Date.now() - Date.parse(value.createdAt) < 60 * 60 * 1000) target = value.target; } catch { /* unrelated album */ }
  }
  if (!target) return false;
  const binding = bindings.find(row => row.project_id === target.projectId);
  if (!binding) return false;
  const snapshot = await readSnapshot(env.DB, target.projectId);
  const user = snapshot?.state?.settings?.users?.find(row => row.id === binding.system_user_id && row.status === 'active' && ['foreman', 'management'].includes(row.role));
  if (!user) return false;
  if (albumKey) await env.DB.prepare('INSERT INTO system_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING').bind(albumKey, JSON.stringify({ target, createdAt: new Date().toISOString() }), new Date().toISOString()).run();
  const source = message.photo.at(-1);
  const sourceId = `tg-quality-${String(message.chat.id).replace(/[^0-9-]/g, '')}-${message.message_id}`;
  const checkpoint = snapshot.state.checkpoints?.find(row => row.id === target.checkpointId);
  if (!checkpoint || checkpoint.photos?.some(photo => photo.id === sourceId || source.file_unique_id && photo.telegramFileUniqueId === source.file_unique_id)) return true;
  if (!qualityRequestStillNeeded(snapshot.state, checkpoint.id)) return true;
  const attachment = await telegramFileToR2(env, target.projectId, source.file_id, `${sourceId}.jpg`, 'image/jpeg', user.name, sourceId, target.checkpointId);
  const now = new Date().toISOString();
  await mutateProjectFromTelegram(env, target.projectId, user.name, user.role, 'telegram.quality.photo', `Получено фото: ${checkpoint.title}`, state => {
    const currentUser = state.settings?.users?.find(row => row.id === binding.system_user_id && row.status === 'active' && ['foreman', 'management'].includes(row.role));
    const point = state.checkpoints?.find(row => row.id === target.checkpointId);
    if (!currentUser || !point) throw new Error('action_denied');
    if (point.photos?.some(photo => photo.id === sourceId || source.file_unique_id && photo.telegramFileUniqueId === source.file_unique_id) || !qualityRequestStillNeeded(state, point.id)) return mutationNoop;
    point.photos = [...(point.photos || []), { id: sourceId, telegramFileUniqueId: source.file_unique_id, name: attachment.name, fileName: attachment.name, fileKey: attachment.key, mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes, capturedAt: new Date(Number(message.date) * 1000 || Date.now()).toISOString(), uploadedAt: now, uploadedBy: currentUser.name, source: 'telegram' }];
    const task = (state.tasks || []).find(row => row.id === `auto-photo-${point.id}`);
    if (task && point.photos.length >= point.requiredShots.length && !['done', 'canceled'].includes(task.status)) {
      task.status = task.reviewerId ? 'review' : 'done'; task.completedAt = task.reviewerId ? undefined : now; task.updatedAt = now;
      task.completionNote = 'Обязательные фотографии получены. Приёмка результата выполняется отдельно.';
      task.history = [...(task.history || []), { id: crypto.randomUUID(), timestamp: now, actor: 'ИКИОМА ОС', kind: task.reviewerId ? 'status' : 'completed', text: task.completionNote }];
    }
    state.activity = [{ id: sourceId, timestamp: now, actor: currentUser.name, tone: 'neutral', text: `Фото для проверки «${point.title}» получено из Telegram` }, ...(state.activity || [])];
    // Photo receipt never changes checkpoint acceptance or the physical completion of the work.
  });
  return true;
};
