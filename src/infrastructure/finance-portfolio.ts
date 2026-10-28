import { requestApi } from './api-http';
import type { FinancePortfolio } from '../domain/finance-portfolio.js';
import type { TreasuryScenario } from '../entities/index';

export async function fetchFinancePortfolio(input: { horizonDays: number; scenario: TreasuryScenario; projectIds?: string[] }, signal: AbortSignal): Promise<FinancePortfolio> {
  const params = new URLSearchParams({ horizon: String(input.horizonDays), scenario: input.scenario });
  if (input.projectIds) params.set('projects', input.projectIds.join(','));
  const response = await requestApi(`/api/finance/portfolio?${params}`, { signal, headers: { Accept: 'application/json' }, cache: 'no-store' });
  const body = await response.json() as { ok?: boolean; portfolio?: FinancePortfolio; error?: string };
  if (!response.ok || !body.ok || !body.portfolio) throw new Error(response.status === 403 ? 'Нет доступных проектов с финансовыми правами.' : 'Не удалось загрузить сводный прогноз. Повторите запрос.');
  return body.portfolio;
}
