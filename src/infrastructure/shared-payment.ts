import { requestApi } from './api-http';
import type { SharedPaymentInput, SharedPaymentRecord, SharedPaymentWorkspace } from '../entities/index';
import type { RemoteProjectSnapshot } from '../application/ports';
export interface SharedPaymentSaved { payment: SharedPaymentRecord; snapshot: RemoteProjectSnapshot; replayed: boolean }
export class SharedPaymentApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.name = 'SharedPaymentApiError'; this.status = status; }
}
async function read<T>(response: Response): Promise<T> {
  let body: { ok?: boolean; message?: string };
  try { body = await response.json(); }
  catch { throw new SharedPaymentApiError('Ответ сервера не получен полностью. Проверьте запись повтором с тем же ID платежа.', 500); }
  if (!response.ok || !body.ok) throw new SharedPaymentApiError(body.message || (response.status === 403
    ? 'Для общего платежа нужны финансовые права во всех затронутых заказах.'
    : response.status === 409 ? 'Данные заказов или исходная запись изменились. Обновите форму.' : 'Не удалось подтвердить результат записи.'), response.status);
  return body as T;
}
export const fetchSharedPayments = async (projectId: string, signal: AbortSignal): Promise<SharedPaymentWorkspace> => read(await requestApi(`/api/finance/shared-payments?projectId=${encodeURIComponent(projectId)}`, { signal, cache: 'no-store' }));
export const recordSharedPayment = async (projectId: string, input: SharedPaymentInput, signal: AbortSignal): Promise<SharedPaymentSaved> => read(await requestApi(`/api/finance/shared-payments?projectId=${encodeURIComponent(projectId)}`, {
  method: 'POST', signal, headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(input),
}));
