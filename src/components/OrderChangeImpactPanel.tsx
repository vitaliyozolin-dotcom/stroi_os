import { useMemo, useState } from 'react';
import type { AppState, AuthenticatedUser } from '../entities/index';
import type { PageId } from '../presentation/navigation';
import { orderChangeImpact } from '../application/order-change-impact';
import { formatDate, money } from '../presentation/formatting';
import { Field } from './Ui';
import { SchedulePaymentImpact } from './SchedulePaymentImpact';

const amount = (cents: number | null) => cents === null ? 'Не определено' : money(cents / 100);
export function OrderChangeImpactPanel({ state, session, onNavigate }: { state: AppState; session: AuthenticatedUser; onNavigate: (page: PageId, id?: string) => void }) {
  const [changeId, setChangeId] = useState(''), [stageId, setStageId] = useState(''), [remaining, setRemaining] = useState(''), [forecastEnd, setForecastEnd] = useState('');
  const change = state.orderRelations?.changeRequests.find(row => row.id === changeId);
  const impact = useMemo(() => change ? orderChangeImpact(state, change, session, stageId ? { stageId, remainingDays: remaining ? Number(remaining) : undefined, forecastEnd } : undefined) : null, [state, change, session, stageId, remaining, forecastEnd]);
  if (session.role !== 'management' || !state.orderRelations?.changeRequests.length) return null;
  const stage = state.stages.find(row => row.id === stageId);
  return <section className="panel" aria-label="Предпросмотр последствий изменения">
    <h3>Предпросмотр последствий изменения</h3>
    <p>Выберите предложение и связанные работы. Расчёт показывает будущие последствия; действующие договоры, смета и факты сохраняются до отдельного оформления изменений.</p>
    <Field label="Проверяемое изменение"><select value={changeId} onChange={event => { setChangeId(event.target.value); setStageId(''); setRemaining(''); setForecastEnd(''); }}><option value="">Выберите изменение</option>{state.orderRelations.changeRequests.map(row => <option key={row.id} value={row.id}>{row.title}</option>)}</select></Field>
    {impact?.ok && change && <>
      <div className="customer-orders__stats">
        <div className="customer-orders__stat"><small>Цена заказа по предложению</small><strong>{amount(impact.currentPriceCents)} → {amount(impact.proposedPriceCents)}</strong><small>Изменение: {change.priceDeltaCents === undefined ? 'не оценено' : amount(change.priceDeltaCents)}. Вступает в силу по оформленному договору.</small></div>
        <div className="customer-orders__stat"><small>План связанных статей бюджета</small><strong>{amount(impact.currentBudgetCents)} → {amount(impact.proposedBudgetCents)}</strong><small>Оценка изменения: {change.costDeltaCents === undefined ? 'не задана' : amount(change.costDeltaCents)}. Распределение по статьям требует проверки.</small></div>
      </div>
      {impact.specifications.map(object => <div key={object.objectId}><h4>{object.title}</h4><p>Действующая комплектация: {object.current?.title ?? 'не утверждена'}{object.current?.terraceAreaSqm !== undefined ? ` · терраса ${object.current.terraceAreaSqm} м²` : ''}.</p>{object.proposals.length ? object.proposals.map(spec => <p key={spec.id}>Предложение v{spec.version}: {spec.title}{spec.terraceAreaSqm !== undefined ? ` · терраса ${spec.terraceAreaSqm} м²` : ''}{spec.houseAreaSqm !== undefined ? ` · площадь ${spec.houseAreaSqm} м²` : ''}. {spec.scope}</p>) : <p>Новая версия комплектации ещё не привязана к изменению.</p>}</div>)}
      <p>Оценка срока: {change.scheduleDeltaDays === undefined ? 'не задана' : `${change.scheduleDeltaDays > 0 ? '+' : ''}${change.scheduleDeltaDays} дн.`}. Для расчёта зависимых оплат задайте конкретный сценарий этапа.</p>
      {impact.stages.length ? <div className="form-grid"><Field label="Связанный этап"><select value={stageId} onChange={event => { setStageId(event.target.value); setRemaining(''); setForecastEnd(''); }}><option value="">Выберите этап</option>{impact.stages.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></Field>{stage && (stage.schedule ? <Field label="Новый остаток рабочих дней в сценарии"><input type="number" min="1" max="730" value={remaining} onChange={event => setRemaining(event.target.value)} /></Field> : <Field label="Прогноз окончания этапа в сценарии"><input type="date" value={forecastEnd} onChange={event => setForecastEnd(event.target.value)} /></Field>)}</div> : <p>Для расчёта сроков добавьте связь с этапом в разделе «Связи». Отсутствие связи означает неизвестное влияние.</p>}
      {stageId && <SchedulePaymentImpact before={state} preview={impact.preview} role={session.role} scenario />}
      {stageId && !state.treasury?.entryPlans.some(plan => plan.tranches.some(tranche => tranche.dateRule)) && <p>Зависимые даты оплат пока не настроены. Укажите правила траншей в разделе «Финансы»; изменение срока само по себе не задаёт дату оплаты.</p>}
      {impact.preview && !impact.preview.ok && <p role="status">{impact.preview.error}</p>}
      <h4>Связанные поставки</h4>
      {impact.supplies.length ? <ul>{impact.supplies.map(row => <li key={row.id}><button type="button" className="text-button" onClick={() => onNavigate('procurement', row.id)}>{row.item}</button> · текущий срок {row.neededBy ? formatDate(row.neededBy, true) : 'не задан'} · {row.risk || 'Проверьте объём и срок по новому решению'}</li>)}</ul> : <p>Связанные поставки не указаны. Влияние на закупки требует оценки.</p>}
      <div className="customer-orders__actions"><button type="button" className="button button--secondary" onClick={() => onNavigate('finance')}>Проверить бюджет и обязательства</button>{stageId && <button type="button" className="button button--secondary" onClick={() => onNavigate('schedule', stageId)}>Оформить изменение графика</button>}</div>
    </>}
    {impact && !impact.ok && <p role="alert">{impact.error}</p>}
  </section>;
}
