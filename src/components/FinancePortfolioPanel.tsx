import { useEffect, useRef, useState } from 'react';
import { SharedFinanceAccountEditor } from './SharedFinanceAccountEditor';
import { fetchRemoteProject } from '../infrastructure/project-http';
import type { RemoteProjectSnapshot } from '../application';
import type { FinancePortfolio } from '../domain/finance-portfolio.js';
import type { TreasuryScenario, UserRole } from '../entities/index';
import { fetchFinancePortfolio } from '../infrastructure/finance-portfolio';
import { formatDate, money } from '../presentation/formatting';
import { Field } from './Ui';
import './finance-portfolio.css';

const amount = (value: number | null) => value === null ? 'Нет данных' : money(value / 100);
export function FinancePortfolioPanel({ role, projectId, onServerSnapshot }: { role: UserRole; projectId: string; onServerSnapshot?: (snapshot: RemoteProjectSnapshot) => void }) {
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, [projectId]);
  const [accountKey, setAccountKey] = useState<string | null>(null);
  const [opened, setOpened] = useState(false), [horizon, setHorizon] = useState(91), [scenario, setScenario] = useState<TreasuryScenario>('base');
  const [data, setData] = useState<FinancePortfolio | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(false), [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!opened || role !== 'management') { setData(null); return; }
    const controller = new AbortController(); setLoading(true); setError(''); setData(null);
    fetchFinancePortfolio({ horizonDays: horizon, scenario }, controller.signal).then(result => { if (!controller.signal.aborted) setData(result); })
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Не удалось загрузить прогноз.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [opened, role, projectId, horizon, scenario, revision]);
  if (role !== 'management') return null;
  return <section className="finance-portfolio" aria-label="Деньги нескольких объектов"><div className="finance-portfolio__heading"><div><h3>Деньги нескольких объектов</h3><p>Сводка доступных вам проектов с разделением компаний и счетов.</p></div><button type="button" className="button button--secondary" onClick={() => setOpened(value => !value)} aria-expanded={opened}>{opened ? 'Свернуть' : 'Открыть сводный прогноз'}</button></div>
    {opened && <><div className="form-grid"><Field label="Горизонт сводки"><select value={horizon} onChange={event => setHorizon(Number(event.target.value))}><option value={14}>2 недели</option><option value={91}>13 недель</option><option value={183}>6 месяцев</option><option value={365}>12 месяцев</option></select></Field><Field label="Сценарий"><select value={scenario} onChange={event => setScenario(event.target.value as TreasuryScenario)}><option value="base">Базовый</option><option value="cautious">Осторожный</option><option value="stress">Стрессовый</option></select></Field></div>
      <p className="muted">Общие банковские остатки учитываются по выделенным суммам объектов. Сводный плюс не покрывает дефицит другой компании автоматически. Показаны сохранённые серверные данные.</p>
      <button type="button" className="text-button" disabled={loading} onClick={() => setRevision(value => value + 1)}>Обновить данные</button>
      {loading && <p role="status">Загружается сводный прогноз…</p>}{error && <p role="alert" className="danger-text">{error}</p>}
      {data && <><div className="finance-portfolio__totals"><div><small>Доступно проектам на конец {formatDate(data.today)}</small><strong>{amount(data.summary.openingCents)}</strong></div><div><small>Минимальный совокупный остаток</small><strong>{amount(data.summary.minBalanceCents)}</strong></div><div><small>Компаний с дефицитом</small><strong>{data.companiesWithDeficit}</strong></div></div>
        {!data.summary.complete && <p className="finance-portfolio__warning">Прогноз неполон. Нулевой рассчитанный дефицит не подтверждает достаточность средств на все работы.</p>}
        {data.warnings.map(text => <p className="finance-portfolio__warning" key={text}>{text}</p>)}
        <div className="finance-portfolio__table"><table><thead><tr><th>Объект</th><th>Доступно</th><th>Минимум</th><th>Нужно финансирование</th><th>Первый дефицит</th><th>Полнота</th></tr></thead><tbody>{data.projects.map(row => <tr key={row.projectId}><td>{row.code} · {row.name}</td><td>{amount(row.openingCents)}</td><td>{amount(row.minBalanceCents)}</td><td>{amount(row.peakFundingCents)}</td><td>{row.firstDeficitDate ? formatDate(row.firstDeficitDate, true) : row.complete ? 'Не выявлен' : 'Не определён'}</td><td>{row.complete ? 'Подтверждена' : row.enabled ? 'Нужна сверка' : 'Не настроено'}</td></tr>)}</tbody></table></div>
        {data.accounts.some(row => row.sharedAccountKey) && <div><h4>Сверка общих счетов</h4>{[...new Set(data.accounts.map(row => row.sharedAccountKey).filter((key): key is string => Boolean(key)))].map(key => <button key={key} type="button" className="button button--secondary" onClick={() => setAccountKey(key)}>Сверить общий счёт · {key}</button>)}</div>}
        <h4>Компании</h4><div className="finance-portfolio__companies">{data.companies.map(row => <article key={row.legalEntityId}><strong>{row.legalEntityId}</strong><p>Доступно: {amount(row.openingCents)}</p><p className={(row.peakFundingCents ?? 0) > 0 ? 'danger-text' : ''}>Потребность: {amount(row.peakFundingCents)}{row.firstDeficitDate && ` · с ${formatDate(row.firstDeficitDate)}`}</p></article>)}</div>
        <details><summary>Счета и ежедневные остатки</summary>{data.accounts.map(row => <div key={`${row.projectId}:${row.accountId}`}><strong>{row.name} · {row.legalEntityId}</strong><p>{row.scope === 'project_allocation' ? 'Выделенная доля объекта' : 'Отдельный счёт объекта'}: {amount(row.openingCents)} · минимум: {amount(row.minBalanceCents)}</p></div>)}<div className="finance-portfolio__table"><table><thead><tr><th>Дата</th><th>Поступления</th><th>Выплаты</th><th>Остаток</th></tr></thead><tbody>{data.summary.days.map(day => <tr key={day.date}><td>{formatDate(day.date)}</td><td>{amount(day.inflowCents)}</td><td>{amount(day.outflowCents)}</td><td className={(day.balanceCents ?? 0) < 0 ? 'danger-text' : ''}>{amount(day.balanceCents)}</td></tr>)}</tbody></table></div></details>
      </>}
    </>}
    {accountKey && <SharedFinanceAccountEditor key={accountKey} accountKey={accountKey} onClose={() => setAccountKey(null)} onSaved={async () => {
      setRevision(value => value + 1);
      if (onServerSnapshot) { const snapshot = await fetchRemoteProject(projectId); if (active.current && snapshot?.projectId === projectId) onServerSnapshot(snapshot); }
    }} />}
  </section>;
}
