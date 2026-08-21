import { ProjectCacheError } from '../projectCache.ts';

export type SyncPhase = 'loading' | 'saved' | 'saving' | 'offline' | 'conflict';

export interface SyncView {
  phase: SyncPhase;
  revision: number;
  updatedAt?: string;
  message?: string;
}

export interface LocalCacheView {
  phase: 'idle' | 'saving' | 'saved' | 'failed';
  message?: string;
}

export const syncErrorMessage = (error: unknown, cachePhase: LocalCacheView['phase']) => {
  if (error instanceof Error && error.message === 'payload_too_large') return 'Данные слишком велики для сохранения. Проверьте вложения.';
  if (cachePhase === 'failed') return 'Сервер недоступен, локальная копия тоже не сохранена. Не закрывайте вкладку.';
  if (cachePhase === 'saving') return 'Нет связи с сервером. Локальная копия ещё сохраняется на этом устройстве.';
  return 'Нет связи с сервером. Изменения сохранены на этом устройстве и ждут синхронизации.';
};

export const cacheErrorMessage = (error?: ProjectCacheError) => error?.code === 'quota_exceeded'
  ? 'Локальная копия не сохранена: в хранилище браузера закончилось место.'
  : error?.code === 'corrupt'
    ? 'Локальная копия повреждена и не была загружена.'
    : 'Локальная копия недоступна в этом браузере.';
