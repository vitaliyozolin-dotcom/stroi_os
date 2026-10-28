import { requestApi } from './api-http';
import type { TreasuryAccount } from '../entities/index';

export interface SharedFinanceAccount {
  sharedAccountKey: string; legalEntityId: string; currency: 'RUB';
  opening: TreasuryAccount['opening'] | null; restrictedCents: number;
  projects: { projectId: string; projectName: string; accountId: string; accountName: string; revision: number; allocationCents: number }[];
}
export interface SharedFinanceAccountUpdate {
  sharedAccountKey: string; legalEntityId: string; currency: 'RUB';
  opening: NonNullable<TreasuryAccount['opening']>; restrictedCents: number;
  expected: { projectId: string; accountId: string; revision: number }[];
  allocations: { projectId: string; accountId: string; amountCents: number }[]; reason: string;
}
const read = async (response: Response): Promise<SharedFinanceAccount> => {
  const body = await response.json() as { ok?: boolean; sharedAccount?: SharedFinanceAccount; error?: string; message?: string };
  if (!response.ok || !body.ok || !body.sharedAccount) throw new Error(body.message || (response.status === 403
    ? 'Для общей сверки нужны финансовые права во всех связанных объектах. Обратитесь к владельцу.'
    : response.status === 409 ? 'Данные одного из объектов изменились. Закройте форму и откройте сверку заново.'
      : 'Не удалось сверить общий счёт. Проверьте соединение и повторно откройте данные.'));
  return body.sharedAccount;
};
export const fetchSharedFinanceAccount = async (key: string, signal: AbortSignal) => read(await requestApi(`/api/finance/shared-account?key=${encodeURIComponent(key)}`, { signal, cache: 'no-store' }));
export const updateSharedFinanceAccount = async (input: SharedFinanceAccountUpdate, signal: AbortSignal) => read(await requestApi('/api/finance/shared-account', {
  method: 'POST', signal, headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(input),
}));
