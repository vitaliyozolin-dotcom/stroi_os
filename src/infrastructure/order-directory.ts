import type { OrderDirectoryDataMap, OrderDirectoryKind, OrderDirectoryResponse } from '../entities/index';
import { requestApi } from './api-http';

export type OrderDirectoryWrite = { [K in OrderDirectoryKind]: {
  record: { id: string; kind: K; data: OrderDirectoryDataMap[K] };
  expectedRevision: number;
  reason: string;
} }[OrderDirectoryKind];

export class OrderDirectoryError extends Error {
  constructor(message: string, public readonly code: string, public readonly status: number) { super(message); }
}

const messages: Record<string, string> = {
  project_access_denied: 'Карточки доступны только сотрудникам с правом управления соответствующим заказом.',
  owner_required: 'Для этого изменения нужны права владельца.',
  shared_record_access_denied: 'Контакт или объект используется в других заказах. Изменить общую карточку может сотрудник, который управляет всеми связанными заказами.',
  revision_conflict: 'Карточка уже изменена другим сотрудником. Обновите данные и внесите изменение заново.',
  storage_unavailable: 'Хранилище временно недоступно. Изменение не подтверждено.',
  financial_transaction_unavailable: 'Сохранение сейчас недоступно. Обновите страницу позже.',
  portfolio_scope_too_large: 'Не удалось получить полный список заказов. Обратитесь к владельцу системы.',
  record_not_found: 'Карточка не найдена или у вас нет доступа к ней.',
};

async function readResponse(response: Response): Promise<OrderDirectoryResponse> {
  const body = await response.json().catch(() => null) as (Partial<OrderDirectoryResponse> & { error?: string; message?: string }) | null;
  if (!response.ok || !body?.ok || !Array.isArray(body.records) || !Array.isArray(body.orders)) {
    const code = body?.error ?? 'invalid_response';
    throw new OrderDirectoryError(body?.message || messages[code] || (response.status === 403 ? messages.project_access_denied : 'Не удалось загрузить или сохранить карточку. Проверьте связь и повторите.'), code, response.status);
  }
  return body as OrderDirectoryResponse;
}

export async function fetchOrderDirectory(projectId: string, signal: AbortSignal): Promise<OrderDirectoryResponse> {
  const response = await requestApi(`/api/order-directory?projectId=${encodeURIComponent(projectId)}`, {
    signal, cache: 'no-store', headers: { Accept: 'application/json' },
  });
  return readResponse(response);
}

export async function saveOrderDirectoryRecord(projectId: string, input: OrderDirectoryWrite, signal: AbortSignal): Promise<OrderDirectoryResponse> {
  const response = await requestApi(`/api/order-directory?projectId=${encodeURIComponent(projectId)}`, {
    method: 'POST', signal, headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(input),
  });
  return readResponse(response);
}
