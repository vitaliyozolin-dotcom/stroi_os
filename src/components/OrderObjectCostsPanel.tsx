import { useRef, useState } from 'react';
import type { AppState, AuthenticatedUser, OrderObjectCostAllocation } from '../entities/index';
import type { StateChangeSink } from '../application/state-change';
import type { PageId } from '../presentation/navigation';
import { orderObjectCostSources, orderObjectCostSummary, orderObjectCostSourceKey, type OrderObjectCostSource } from '../domain/order-object-costs.js';
import { commitOrderRelationsProject, orderRelationsFingerprint } from '../infrastructure/order-relations-project';
import { orderMoneyInput } from '../presentation/customer-order-forms';
import { money } from '../presentation/formatting';
import { OrderEditorModal, type OrderEditorField, type OrderEditorValues } from './customer-orders/OrderEditorModal';
import './order-object-costs.css';

interface Props {
  state: AppState; session: AuthenticatedUser; onChange: StateChangeSink;
  onNavigate?: (page: PageId, entityId?: string) => void; syncPhase?: string;
}
interface AllocationEditor { source: OrderObjectCostSource; expected: string; allocationIds: Record<string, string> }
const labels = { budget: 'Плановый бюджет', commitment: 'Обязательства перед поставщиками', payment: 'Оплаты поставщикам с учётом возвратов' };
const display = (value: number | null | undefined) => value === null || value === undefined ? '—' : money(value / 100);
const signed = (amount: number, source?: OrderObjectCostSource) => amount * (source?.sign ?? 1);
const reasonField: OrderEditorField = { name: 'reason', label: 'Основание распределения', type: 'textarea', required: true, maxLength: 2000, hint: 'Объясните, почему эта сумма относится к выбранным объектам. Основание останется в истории заказа.' };
const blocked = (phase?: string) => ['loading', 'saving', 'offline', 'conflict'].includes(phase ?? '');

export function OrderObjectCostsPanel({ state, session, onChange, onNavigate, syncPhase }: Props) {
  const [type, setType] = useState<OrderObjectCostAllocation['sourceType']>('budget');
  const [editor, setEditor] = useState<AllocationEditor | null>(null);
  const [cancel, setCancel] = useState<{ row: OrderObjectCostAllocation; expected: string } | null>(null);
  const [notice, setNotice] = useState('');
  const stateRef = useRef(state), phaseRef = useRef(syncPhase); stateRef.current = state; phaseRef.current = syncPhase;
  if (session.role !== 'management') return null;
  const summary = orderObjectCostSummary(state), sources = summary.sources.filter(source => source.sourceType === type);
  const allAllocations = state.orderRelations?.costAllocations ?? [];
  const ready = Boolean(state.orderRelations) && !blocked(syncPhase);
  const objectName = (id: string) => state.orderRelations?.objects.find(object => object.id === id)?.title || id;
  const sourceFor = (row: OrderObjectCostAllocation) => summary.sources.find(source => orderObjectCostSourceKey(source) === orderObjectCostSourceKey(row));
  const save = (rows: OrderObjectCostAllocation[], expected: string, reason: string) => {
    const current = stateRef.current;
    if (!current.orderRelations || current.project.id !== state.project.id || blocked(phaseRef.current)) throw new Error('Дождитесь сохранения заказа на сервере и проверьте актуальные данные.');
    if (!reason.trim()) throw new Error('Укажите основание распределения.');
    commitOrderRelationsProject(current, { ...current.orderRelations, costAllocations: rows }, session, reason.trim(), expected, onChange);
    setNotice('Изменение передано на сохранение. Итоговый статус записи показан в строке синхронизации системы.');
  };
  const start = (source: OrderObjectCostSource) => {
    setNotice('');
    const canonical = orderObjectCostSources(state).find(item => orderObjectCostSourceKey(item) === orderObjectCostSourceKey(source));
    if (!canonical) return;
    setEditor({ source: canonical, expected: orderRelationsFingerprint(state), allocationIds: Object.fromEntries((state.orderRelations?.objects ?? []).map(object => [object.id, crypto.randomUUID()])) });
  };
  const allocationFields: OrderEditorField[] = editor ? [
    ...(state.orderRelations?.objects ?? []).map(object => ({ name: `object:${object.id}`, label: `${object.title}, ₽`, type: 'money' as const, hint: 'Пусто — эта строка не распределяется на объект' })), reasonField,
  ] : [];
  const amountFrom = (values: OrderEditorValues, objectId: string) => orderMoneyInput(values[`object:${objectId}`] ?? '') ?? 0;
  return <section className="order-object-costs" aria-label="Распределение затрат по объектам">
    <header><h3>Бюджет и расчёты по объектам</h3><p>Для каждой суммы выберите исходную запись и укажите доли объектов. Бюджет, обязательства и оплаты показывают разные этапы учёта и сохраняются отдельными показателями.</p></header>
    {!state.orderRelations && <p className="finance-muted">Сначала настройте карточку заказа и добавьте объекты.</p>}
    {summary.objects.length === 0 ? <p className="finance-muted">Добавьте объекты — например, дом и баню, — чтобы распределить общие суммы.</p> : <>
      <div className="order-object-costs__scroll"><table><thead><tr><th scope="col">Объект</th><th scope="col">Бюджет</th><th scope="col">Обязательства</th><th scope="col">Оплачено, нетто</th></tr></thead><tbody>
        {summary.objects.map(object => <tr key={object.objectId}><th scope="row">{object.title}</th><td>{display(object.budget)}</td><td>{display(object.commitment)}</td><td>{display(object.payment)}</td></tr>)}
        <tr className="order-object-costs__remainder"><th scope="row">Не распределено по объектам</th><td>{display(summary.unallocated.budget)}</td><td>{display(summary.unallocated.commitment)}</td><td>{display(summary.unallocated.payment)}</td></tr>
        <tr><th scope="row">Зарегистрировано в заказе</th><td>{display(summary.totals.budget)}</td><td>{display(summary.totals.commitment)}</td><td>{display(summary.totals.payment)}</td></tr>
      </tbody></table></div>
      <p className="finance-muted">«—» означает, что доли ещё не указаны. Источников с нераспределённым остатком: {summary.sources.filter(source => (source.remainingCents ?? 0) > 0).length}. Возвраты уменьшают оплату того объекта, которому отнесён исходный платёж.</p>
    </>}
    {summary.warnings.map(warning => <p className="form-warning" role="alert" key={warning}>{warning}</p>)}
    {notice && <p role="status" className="finance-muted">{notice}</p>}
    <label className="field"><span className="field__label">Какие суммы распределяем</span><select value={type} onChange={event => setType(event.target.value as OrderObjectCostAllocation['sourceType'])}>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    {!sources.length ? <p className="finance-muted">Для этого показателя пока нет исходных записей. Добавьте бюджет, расходное обязательство или подтверждённую оплату в финансовом разделе.</p> : <div className="order-object-costs__sources">{sources.map(source => <article key={orderObjectCostSourceKey(source)}>
      <div><strong>{source.label}</strong><small>{[source.counterparty, source.date, source.participantDirect ? 'Прямой расчёт участника' : '', source.sharedPaymentId ? 'Доля общего платежа этого заказа' : ''].filter(Boolean).join(' · ')}</small>
        <p>Исходная сумма: {display(signed(source.amountCents, source))} · распределено: {display(source.allocatedCents === null ? null : signed(source.allocatedCents, source))} · остаток: <strong>{display(source.remainingCents === null ? null : signed(source.remainingCents, source))}</strong></p>
        {source.sign === -1 && <small>Укажите положительные доли возврата; система вычтет их из оплат соответствующих объектов.</small>}</div>
      <div className="order-object-costs__actions">{onNavigate && <button type="button" className="button button--ghost" onClick={() => onNavigate('finance', source.entityId)}>Исходная запись</button>}<button type="button" className="button button--primary" disabled={!ready || !summary.objects.length || (source.remainingCents ?? 0) <= 0} onClick={() => start(source)}>Распределить</button></div>
    </article>)}</div>}
    {allAllocations.length > 0 && <details className="order-object-costs__history"><summary>Записанные доли и исправления ({allAllocations.length})</summary>{allAllocations.map(row => {
      const source = sourceFor(row);
      return <div key={row.id}><p><strong>{objectName(row.objectId)}</strong> · {labels[row.sourceType]} · {display(signed(row.amountCents, source))}</p><p>{source?.label ?? row.sourceId} · {row.status === 'canceled' ? 'Отменено' : 'Действует'}</p><small>Основание: {row.source}{row.canceledReason ? ` · Отмена: ${row.canceledReason}` : ''}</small>
        {row.status === 'active' && <button type="button" className="button button--ghost" disabled={!ready} onClick={() => setCancel({ row, expected: orderRelationsFingerprint(state) })}>Отменить распределение</button>}</div>;
    })}</details>}
    {!ready && state.orderRelations && <p className="finance-muted">Распределение доступно после завершения синхронизации заказа.</p>}
    {editor && <OrderEditorModal key={editor.expected + orderObjectCostSourceKey(editor.source)} title={`Распределить: ${editor.source.label}`} subtitle={labels[editor.source.sourceType]} fields={allocationFields} initialValues={{}} submitLabel="Сохранить доли" onClose={() => setEditor(null)}
      summary={<p>Доступный остаток: <strong>{display(summary.sources.find(source => orderObjectCostSourceKey(source) === orderObjectCostSourceKey(editor.source))?.remainingCents)}</strong>. Укажите только подтверждённые доли объектов. Нераспределённая сумма останется отдельным остатком.</p>}
      renderHint={values => { try { const total = (state.orderRelations?.objects ?? []).reduce((sum, object) => sum + amountFrom(values, object.id), 0); return <p aria-live="polite">Будет распределено: <strong>{Number.isSafeInteger(total) ? display(total) : 'Проверьте суммы'}</strong></p>; } catch { return <p className="form-warning">Проверьте суммы: допустимы рубли и копейки.</p>; } }}
      onSubmit={values => {
        const current = stateRef.current;
        const source = orderObjectCostSources(current).find(row => orderObjectCostSourceKey(row) === orderObjectCostSourceKey(editor.source));
        if (!source || JSON.stringify(source) !== JSON.stringify(editor.source)) throw new Error('Исходная запись изменилась. Закройте форму и проверьте источник.');
        const additions = (current.orderRelations?.objects ?? []).flatMap(object => {
          const amountCents = amountFrom(values, object.id); if (!amountCents) return [];
          if (amountCents < 0) throw new Error('Укажите положительные доли. Для возврата знак определяется исходной записью.');
          const id = editor.allocationIds[object.id]; if (!id) throw new Error('Состав объектов изменился. Откройте форму заново.');
          return [{ id, objectId: object.id, sourceType: source.sourceType, sourceId: source.sourceId, amountCents, source: values.reason?.trim() ?? '', status: 'active' as const }];
        });
        if (!additions.length) throw new Error('Укажите хотя бы одну положительную долю.');
        save([...(current.orderRelations?.costAllocations ?? []), ...additions], editor.expected, values.reason ?? ''); setEditor(null);
      }} />}
    {cancel && <OrderEditorModal title="Отменить распределение" subtitle={`${objectName(cancel.row.objectId)} · ${display(cancel.row.amountCents)}`} fields={[{ ...reasonField, label: 'Причина отмены' }]} initialValues={{}} submitLabel="Отменить долю с сохранением истории" onClose={() => setCancel(null)}
      summary={<p>Финансовый источник сохранится. Его сумма снова станет доступна для распределения по объектам. Записанная доля и основание её отмены останутся в истории.</p>}
      onSubmit={values => { const current = stateRef.current; save((current.orderRelations?.costAllocations ?? []).map(row => row.id === cancel.row.id ? { ...row, status: 'canceled', canceledReason: values.reason?.trim() ?? '' } : row), cancel.expected, values.reason ?? ''); setCancel(null); }} />}
  </section>;
}
