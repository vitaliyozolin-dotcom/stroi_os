import type { EvidencePhoto, QualityCheckpoint } from '../entities/index';
import type { ConstructionSnapshot, ConstructionPatch } from '../domain/contexts.ts';
import { changeCheckpoint } from '../domain/mutations.ts';
import { validateStageControl } from '../domain/construction/index.js';
import { executeModule, moduleChange, type ModuleContext, type ModuleRepository } from './module-repository.ts';
export const checkpointSnapshot = (state: Pick<ConstructionSnapshot, 'project' | 'checkpoints'>, id: string) => JSON.stringify([state.project.id, state.checkpoints.find(point => point.id === id)]);
export interface QualityUploadPort { upload(projectId: string, checkpointId: string, file: File, signal: AbortSignal): Promise<EvidencePhoto> }
type CheckpointPatch = Partial<Pick<QualityCheckpoint, 'status' | 'note' | 'measurement' | 'submittedAt' | 'acceptedAt' | 'clientVisible'>>;
export const createQualityUseCases = (repository: ModuleRepository<ConstructionSnapshot, ConstructionPatch>, context: ModuleContext) => {
 const current = (state: ConstructionSnapshot, checkpointId: string, expected: string) => {
  if (context.identity.role === 'client') throw new Error('Контроль качества доступен команде проекта.');
  const point = state.checkpoints.find(point => point.id === checkpointId);
  if (!point || checkpointSnapshot(state, checkpointId) !== expected) throw new Error('Контрольная точка обновилась. Откройте её заново.');
  if (!state.stages.some(stage => stage.id === point.stageId)) throw new Error('Этап контрольной точки больше недоступен.');
  return point;
 };
 const prepare = (state: ConstructionSnapshot, id: string, patch: Partial<QualityCheckpoint>, summary: string, tone: 'neutral' | 'positive' | 'warning', recordActivity: boolean) => {
  const mutation = changeCheckpoint(state, { checkpointId: id, patch, summary, tone, recordActivity }, { actor: context.identity.name, timestamp: context.clock.now(), nextId: prefix => context.ids.next(prefix) });
  const candidate = { ...state, checkpoints: mutation.patch.checkpoints ?? state.checkpoints };
  const error = validateStageControl(state, structuredClone(candidate), context.identity, context.clock.now());
  if (error) throw new Error(error);
  const change = moduleChange(state, mutation.patch, mutation.action, mutation.summary, context, tone, false);
  return { ...change, event: mutation.event };
 };
 return {
  update: (input: { checkpointId: string; expected: string; patch: CheckpointPatch; summary?: string; tone?: 'neutral' | 'positive' | 'warning' }) => executeModule(repository, state => {
   try {
    const point = current(state, input.checkpointId, input.expected);
    const allowed: CheckpointPatch = {};
    for (const key of ['status', 'note', 'measurement', 'submittedAt', 'acceptedAt', 'clientVisible'] as const) if (Object.hasOwn(input.patch, key)) Object.assign(allowed, { [key]: input.patch[key] });
    if (['accepted', 'rework'].includes(allowed.status ?? '') && context.identity.role !== 'management') throw new Error('Приёмку и доработку назначает управление.');
    if (allowed.status === 'in_review' && point.photos.length < point.requiredShots.length) throw new Error('Сначала добавьте обязательные кадры.');
    return { ok: true as const, change: prepare(state, point.id, allowed, input.summary ?? `Обновлена контрольная точка «${point.title}»`, input.tone ?? 'neutral', Boolean(input.summary)) };
   } catch (failure) { return { ok: false as const, error: failure instanceof Error ? failure.message : 'Не удалось сохранить контрольную точку.' }; }
  }),
  upload: async (input: { checkpointId: string; expected: string; files: File[] }, uploader: QualityUploadPort, signal: AbortSignal) => {
   try {
    const check = () => { if (signal.aborted) throw new Error('Загрузка отменена.'); const read = repository.read(); if (!read.ok) throw new Error(read.error); return { state: read.snapshot, point: current(read.snapshot, input.checkpointId, input.expected) }; };
    const initial = check(), point = initial.point;
    if (point.status === 'accepted') throw new Error('Принятые доказательства сохраняются.');
    const remaining = Math.max(0, point.requiredShots.length - point.photos.length), replacing = remaining === 0 && point.status === 'rework';
    const slots = replacing ? point.requiredShots.length : remaining;
    if (!input.files.length || input.files.length > slots || input.files.some(file => file.size <= 0 || file.size > 12*1024*1024 || !/^image\/(jpeg|png|webp)$/.test(file.type))) throw new Error('Выберите обязательные фото JPG, PNG или WebP до 12 МБ.');
    const photos: EvidencePhoto[] = [];
    for (const file of input.files) {
     const photo = await uploader.upload(initial.state.project.id, point.id, file, signal); check();
     if (typeof photo.id !== 'string' || !photo.id.trim() || typeof photo.name !== 'string' || !photo.name.trim() || typeof photo.capturedAt !== 'string' || typeof photo.fileKey !== 'string' || !photo.fileKey.startsWith(`${initial.state.project.id}/quality/${point.id}/`) || photo.fileKey.split('/').some(part => part === '.' || part === '..') || !Number.isFinite(Date.parse(photo.capturedAt)) || !/^image\/(jpeg|png|webp)$/.test(photo.mimeType ?? '') || typeof photo.sizeBytes !== 'number' || !Number.isSafeInteger(photo.sizeBytes) || photo.sizeBytes <= 0 || photo.sizeBytes > 12*1024*1024) throw new Error('Сервер вернул некорректные сведения фото.');
     photos.push(photo);
    }
    const latest = check();
    const summary = `${replacing ? 'Начата повторная фиксация' : `Добавлено ${photos.length} фото`}: ${point.title}`;
    const change = prepare(latest.state, point.id, { photos: replacing ? photos : [...latest.point.photos, ...photos] }, summary, 'neutral', true);
    const committed = repository.commit(change);
    return committed.ok ? { ok: true as const, change, photos, replacing } : committed;
   } catch (failure) { return { ok: false as const, error: failure instanceof Error ? failure.message : 'Не удалось загрузить фото.' }; }
  },
 };
};
