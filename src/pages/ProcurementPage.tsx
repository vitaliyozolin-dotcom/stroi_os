import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Boxes,
  Check,
  ChevronRight,
  ClipboardList,
  PackageCheck,
  Plus,
  Search,
  ShoppingCart,
  Truck,
  Warehouse,
} from 'lucide-react';
import { formatDate, money, uid } from '../domain';
import type { AppState, ProcurementStatus, UserRole } from '../types';
import { Field, Modal, SectionHeader, StatusBadge } from '../components/Ui';
import { CounterpartyModal } from '../components/CounterpartyModal';

const statusOrder: ProcurementStatus[] = ['need', 'rfq', 'ordered', 'in_transit', 'delivered', 'accepted', 'issued'];
const statusLabels: Record<ProcurementStatus, string> = {
  need: 'Потребность',
  rfq: 'Сбор цен',
  ordered: 'Заказано',
  in_transit: 'В пути',
  delivered: 'Доставлено',
  accepted: 'Принято',
  issued: 'Выдано в работу',
};

const toneForStatus = (status: ProcurementStatus): 'neutral' | 'positive' | 'warning' | 'blue' => {
  if (status === 'accepted' || status === 'issued') return 'positive';
  if (status === 'in_transit' || status === 'delivered') return 'blue';
  if (status === 'need' || status === 'rfq') return 'warning';
  return 'neutral';
};

const dateAfterDays = (days: number) => {
  const value = new Date();
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

export function ProcurementPage({ state, role, actor, focusId, onChange }: { state: AppState; role: UserRole; actor: string; focusId?: string | null; onChange: (next: AppState) => void }) {
  const [showForm, setShowForm] = useState(false);
  const [filter, setFilter] = useState<'active' | 'all' | 'risk'>('active');
  const [statusFilter, setStatusFilter] = useState<ProcurementStatus | null>(null);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [counterpartyId, setCounterpartyId] = useState<string | null>(null);
  const [quoteForId, setQuoteForId] = useState<string | null>(null);
  const [quoteForm, setQuoteForm] = useState({ supplierId: '', amount: '', deliveryDays: '', paymentTerms: '', source: 'Коммерческое предложение', comment: '' });
  const [form, setForm] = useState({ stageId: state.stages[0]?.id ?? '', item: '', quantity: '', unit: 'шт', neededBy: dateAfterDays(14), budget: '', supplierId: '', owner: state.project.foreman || actor });
  useEffect(() => {
    if (focusId && state.procurement.some((item) => item.id === focusId)) setSelectedId(focusId);
  }, [focusId, state.procurement]);

  const visibleItems = useMemo(() => state.procurement.filter((item) => {
    if (statusFilter && item.status !== statusFilter) return false;
    if (filter === 'active' && ['accepted', 'issued'].includes(item.status)) return false;
    if (filter === 'risk' && !item.risk) return false;
    return `${item.item} ${item.supplier}`.toLocaleLowerCase('ru').includes(search.toLocaleLowerCase('ru'));
  }), [filter, search, state.procurement, statusFilter]);

  const metrics = {
    active: state.procurement.filter((item) => !['accepted', 'issued'].includes(item.status)).length,
    transit: state.procurement.filter((item) => item.status === 'in_transit').length,
    risks: state.procurement.filter((item) => item.risk).length,
    accepted: state.procurement.filter((item) => ['accepted', 'issued'].includes(item.status)).reduce((sum, item) => sum + item.budget, 0),
  };

  const addRequirement = (event: FormEvent) => {
    event.preventDefault();
    const quantity = Number(form.quantity);
    const budget = Number(form.budget);
    if (!form.item.trim() || quantity <= 0) return;
    const supplier = state.counterparties.find((item) => item.id === form.supplierId);
    const budgetLine = state.budgetLines.find((item) => item.stageIds.includes(form.stageId));
    onChange({
      ...state,
      procurement: [{ id: uid('supply'), stageId: form.stageId, budgetLineId: budgetLine?.id, item: form.item.trim(), quantity, unit: form.unit, neededBy: form.neededBy, status: 'need', budget: budget || 0, supplier: supplier?.name ?? 'Не выбран', supplierId: supplier?.id, owner: form.owner.trim() || actor }, ...state.procurement],
      activity: [{ id: uid('activity'), timestamp: new Date().toISOString(), actor, text: `Создана потребность: ${form.item.trim()}`, tone: 'neutral' }, ...state.activity],
    });
    setShowForm(false);
    setForm({ ...form, item: '', quantity: '', budget: '', supplierId: '' });
  };

  const moveNext = (id: string) => {
    const current = state.procurement.find((item) => item.id === id);
    if (!current) return;
    const nextStatus = statusOrder[Math.min(statusOrder.indexOf(current.status) + 1, statusOrder.length - 1)];
    const today = new Date().toISOString().slice(0, 10);
    onChange({
      ...state,
      procurement: state.procurement.map((item) => item.id === id ? {
        ...item,
        status: nextStatus,
        orderedAt: nextStatus === 'ordered' ? item.orderedAt ?? today : item.orderedAt,
        deliveredAt: ['delivered', 'accepted', 'issued'].includes(nextStatus) ? item.deliveredAt ?? today : item.deliveredAt,
        risk: nextStatus === 'accepted' || nextStatus === 'issued' ? undefined : item.risk,
      } : item),
      activity: [{ id: uid('activity'), timestamp: new Date().toISOString(), actor, text: `${current.item}: ${statusLabels[nextStatus].toLocaleLowerCase('ru')}`, tone: nextStatus === 'accepted' || nextStatus === 'issued' ? 'positive' : 'neutral' }, ...state.activity],
    });
  };

  const selected = state.procurement.find((item) => item.id === selectedId) ?? null;

  const selectQuote = (quoteId: string) => {
    const quote = state.supplierQuotes.find((item) => item.id === quoteId);
    if (!quote || !selected) return;
    onChange({
      ...state,
      supplierQuotes: state.supplierQuotes.map((item) => item.procurementItemId === selected.id ? { ...item, status: item.id === quoteId ? 'selected' : 'rejected' } : item),
      procurement: state.procurement.map((item) => item.id === selected.id ? { ...item, supplier: quote.supplier, supplierId: quote.supplierId ?? state.counterparties.find((profile) => profile.name === quote.supplier)?.id, budget: quote.amount, status: item.status === 'need' ? 'rfq' : item.status } : item),
      activity: [{ id: uid('activity'), timestamp: new Date().toISOString(), actor, text: `${selected.item}: выбран поставщик ${quote.supplier} за ${money(quote.amount)}`, tone: 'positive' }, ...state.activity],
    });
  };

  const addQuote = (event: FormEvent) => {
    event.preventDefault();
    const procurementItem = state.procurement.find((item) => item.id === quoteForId);
    const supplier = state.counterparties.find((item) => item.id === quoteForm.supplierId);
    const amount = Number(quoteForm.amount);
    const deliveryDays = Number(quoteForm.deliveryDays);
    if (!procurementItem || !supplier || amount <= 0 || deliveryDays < 0 || !quoteForm.paymentTerms.trim()) return;
    onChange({
      ...state,
      supplierQuotes: [{
        id: uid('quote'),
        procurementItemId: procurementItem.id,
        supplier: supplier.name,
        supplierId: supplier.id,
        amount,
        deliveryDays,
        paymentTerms: quoteForm.paymentTerms.trim(),
        source: quoteForm.source.trim() || 'Коммерческое предложение',
        status: 'received',
        comment: quoteForm.comment.trim() || undefined,
      }, ...state.supplierQuotes],
      procurement: state.procurement.map((item) => item.id === procurementItem.id && item.status === 'need' ? { ...item, status: 'rfq' } : item),
      activity: [{ id: uid('activity'), timestamp: new Date().toISOString(), actor, text: `Получено предложение ${supplier.name}: ${procurementItem.item} за ${money(amount)}`, tone: 'neutral' }, ...state.activity],
    });
    setQuoteForId(null);
    setSelectedId(procurementItem.id);
    setQuoteForm({ supplierId: '', amount: '', deliveryDays: '', paymentTerms: '', source: 'Коммерческое предложение', comment: '' });
  };

  return (
    <div className="page-stack">
      <section className="page-title-row">
        <div>
          <span className="eyebrow">От потребности до списания</span>
          <h1>Снабжение и материалы</h1>
          <p>Материал появляется в закупке из графика работ и проходит приёмку до выдачи бригаде.</p>
        </div>
        {role !== 'client' && <button type="button" data-tour="procurement-add" className="button button--primary" onClick={() => setShowForm(true)}><Plus size={18} /> Создать потребность</button>}
      </section>

      <section className="supply-metrics">
        <button type="button" onClick={() => { setFilter('active'); setStatusFilter(null); }}><span><ClipboardList size={19} /></span><div><small>Активные позиции</small><strong>{metrics.active}</strong></div></button>
        <button type="button" onClick={() => { setFilter('all'); setStatusFilter('in_transit'); }}><span><Truck size={19} /></span><div><small>Сейчас в пути</small><strong>{metrics.transit}</strong></div></button>
        <button type="button" className={metrics.risks ? 'supply-metric--risk' : ''} onClick={() => { setFilter('risk'); setStatusFilter(null); }}><span><AlertTriangle size={19} /></span><div><small>Риски поставки</small><strong>{metrics.risks}</strong></div></button>
        <button type="button" onClick={() => { setFilter('all'); setStatusFilter('accepted'); }}><span><PackageCheck size={19} /></span><div><small>Принято материалов</small><strong>{money(metrics.accepted)}</strong></div></button>
      </section>

      <section className="panel supply-pipeline-panel">
        <SectionHeader eyebrow="Единый маршрут" title="Воронка снабжения" />
        <div className="supply-pipeline">
          {statusOrder.map((status, index) => (
            <button type="button" className={statusFilter === status ? 'supply-pipeline__step supply-pipeline__step--active' : 'supply-pipeline__step'} key={status} onClick={() => { setFilter('all'); setStatusFilter(statusFilter === status ? null : status); }}>
              <span>{index + 1}</span>
              <div><strong>{statusLabels[status]}</strong><small>{state.procurement.filter((item) => item.status === status).length} поз.</small></div>
              {index < statusOrder.length - 1 && <ChevronRight size={15} />}
            </button>
          ))}
        </div>
      </section>

      <section className="panel supply-register">
        <div className="supply-register__header">
          <div><span className="eyebrow">Реестр</span><h2>Позиции проекта</h2></div>
          <div className="supply-register__tools">
            <label className="search-field"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Материал или поставщик" /></label>
            <div className="segmented-control"><button className={filter === 'active' ? 'active' : ''} onClick={() => setFilter('active')}>Активные</button><button className={filter === 'risk' ? 'active' : ''} onClick={() => setFilter('risk')}>Риски</button><button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>Все</button></div>
          </div>
        </div>
        <div className="supply-table">
          <div className="supply-table__head"><span>Позиция</span><span>Этап</span><span>Нужно к</span><span>Поставщик</span><span>Бюджет</span><span>Статус</span><span /></div>
          {visibleItems.map((item) => {
            const stage = state.stages.find((stageItem) => stageItem.id === item.stageId);
            const isFinal = item.status === 'issued';
            return (
              <div className={`supply-table__row supply-table__row--clickable ${item.risk ? 'supply-table__row--risk' : ''}`} role="button" tabIndex={0} key={item.id} onClick={() => setSelectedId(item.id)} onKeyDown={(event) => { if (event.key === 'Enter') setSelectedId(item.id); }}>
                <div className="supply-item-name"><span className="supply-item-name__icon">{item.status === 'in_transit' ? <Truck size={18} /> : item.status === 'issued' ? <Warehouse size={18} /> : <Boxes size={18} />}</span><span><strong>{item.item}</strong><small>{item.quantity} {item.unit} · {item.owner}</small>{item.risk && <em><AlertTriangle size={13} /> {item.risk}</em>}</span></div>
                <span data-label="Этап">{stage?.shortName ?? '—'}</span>
                <span data-label="Нужно к">{formatDate(item.neededBy)}</span>
                <span data-label="Поставщик">{item.supplier}</span>
                <strong data-label="Бюджет">{money(item.budget)}</strong>
                <span data-label="Статус"><StatusBadge label={statusLabels[item.status]} tone={toneForStatus(item.status)} /></span>
                <span>{role !== 'client' && !isFinal && <button type="button" className="advance-button" onClick={(event) => { event.stopPropagation(); moveNext(item.id); }} title={`Перевести в статус «${statusLabels[statusOrder[statusOrder.indexOf(item.status) + 1]]}»`}>{item.status === 'delivered' ? <Check size={16} /> : <ArrowRight size={16} />}</button>}</span>
              </div>
            );
          })}
          {!visibleItems.length && <div className="table-empty">По выбранному фильтру позиций нет.</div>}
        </div>
      </section>

      <section className="supply-rule-grid">
        <article><span><ShoppingCart size={20} /></span><div><strong>Закупка начинается из потребности</strong><p>Прораб не пишет список в мессенджере: материал привязан к этапу и сроку.</p></div></article>
        <article><span><PackageCheck size={20} /></span><div><strong>Приёмка до оплаты</strong><p>Количество, состояние и документы фиксируются при доставке на объект.</p></div></article>
        <article><span><Warehouse size={20} /></span><div><strong>Выдача и остаток</strong><p>Следующий слой добавит склад, списание на дом и возврат неиспользованного.</p></div></article>
      </section>

      {showForm && (
        <Modal title="Новая потребность" subtitle="Создаётся до запроса цен — с привязкой к этапу и дате потребности." onClose={() => setShowForm(false)}>
          <form className="modal-form" onSubmit={addRequirement}>
            <Field label="Материал или комплект"><input required value={form.item} onChange={(event) => setForm({ ...form, item: event.target.value })} placeholder="Например: пароизоляционная мембрана" /></Field>
            <div className="form-grid form-grid--three">
              <Field label="Количество"><input required min="0.01" step="0.01" type="number" value={form.quantity} onChange={(event) => setForm({ ...form, quantity: event.target.value })} /></Field>
              <Field label="Единица"><select value={form.unit} onChange={(event) => setForm({ ...form, unit: event.target.value })}><option>шт</option><option>м²</option><option>м³</option><option>м.п.</option><option>компл</option><option>кор</option></select></Field>
              <Field label="Нужно на объекте"><input type="date" value={form.neededBy} onChange={(event) => setForm({ ...form, neededBy: event.target.value })} /></Field>
            </div>
            <Field label="Этап работ"><select value={form.stageId} onChange={(event) => setForm({ ...form, stageId: event.target.value })}>{state.stages.map((stage) => <option key={stage.id} value={stage.id}>{stage.order}. {stage.name}</option>)}</select></Field>
            <div className="form-grid">
              <Field label="Ориентир бюджета, ₽"><input min="0" type="number" value={form.budget} onChange={(event) => setForm({ ...form, budget: event.target.value })} placeholder="0" /></Field>
              <Field label="Предпочтительный поставщик"><select value={form.supplierId} onChange={(event) => setForm({ ...form, supplierId: event.target.value })}><option value="">Будет выбран после сравнения</option>{state.counterparties.filter((item) => (item.type === 'supplier' || item.type === 'contractor') && item.status !== 'blocked').map((item) => <option value={item.id} key={item.id}>{item.name}{item.specialty ? ` · ${item.specialty}` : ''}</option>)}</select></Field>
            </div>
            <Field label="Ответственный"><input value={form.owner} onChange={(event) => setForm({ ...form, owner: event.target.value })} /></Field>
            <div className="modal__actions"><button className="button button--ghost" type="button" onClick={() => setShowForm(false)}>Отмена</button><button className="button button--primary" type="submit"><Plus size={17} /> Создать потребность</button></div>
          </form>
        </Modal>
      )}

      {selected && (
        <Modal wide title={selected.item} subtitle={`${statusLabels[selected.status]} · нужно к ${formatDate(selected.neededBy, true)}`} onClose={() => setSelectedId(null)}>
          <div className="entity-detail-grid">
            <section className="entity-detail-card"><small>Потребность</small><strong>{selected.quantity} {selected.unit}</strong><span>{selected.reason ?? 'Основание не заполнено'}</span></section>
            <section className="entity-detail-card"><small>Проект и этап</small><strong>{state.stages.find((item) => item.id === selected.stageId)?.name ?? 'Этап не найден'}</strong><span>{state.budgetLines.find((item) => item.id === selected.budgetLineId)?.name ?? 'Без статьи бюджета'}</span></section>
            <section className="entity-detail-card"><small>Поставщик</small><button type="button" className="entity-link" disabled={!selected.supplierId} onClick={() => { setSelectedId(null); setCounterpartyId(selected.supplierId ?? null); }}>{selected.supplier}</button><span>{money(selected.budget)}</span></section>
            <section className="entity-detail-card"><small>Ответственный</small><strong>{selected.owner}</strong><span>{selected.deliveryAddress ?? `Объект ${state.project.code}`}</span></section>
          </div>
          {selected.risk && <div className="entity-alert"><AlertTriangle size={18} /><span><strong>Риск поставки</strong>{selected.risk}</span></div>}
          <div className="entity-detail-section"><SectionHeader eyebrow="Сравнение" title="Предложения поставщиков" action={<div className="section-action-row"><span className="count-badge">{state.supplierQuotes.filter((item) => item.procurementItemId === selected.id).length}</span>{role !== 'client' && <button type="button" className="button button--secondary button--compact" onClick={() => { setQuoteForId(selected.id); setSelectedId(null); }}><Plus size={15} /> Добавить КП</button>}</div>} />
            <div className="quote-list">{state.supplierQuotes.filter((item) => item.procurementItemId === selected.id).map((quote) => <article key={quote.id} className={quote.status === 'selected' ? 'quote-card quote-card--selected' : 'quote-card'}><div><button type="button" className="entity-link entity-link--compact" disabled={!quote.supplierId} onClick={() => { setSelectedId(null); setCounterpartyId(quote.supplierId ?? null); }}>{quote.supplier}</button><small>{quote.source} · {quote.deliveryDays} дн.</small></div><strong>{money(quote.amount)}</strong><p>{quote.paymentTerms}{quote.comment ? ` · ${quote.comment}` : ''}</p>{quote.status === 'selected' ? <StatusBadge label="Выбрано" tone="positive" /> : role !== 'client' ? <button type="button" className="button button--secondary button--compact" onClick={() => selectQuote(quote.id)}>Выбрать</button> : <StatusBadge label="Предложение" />}</article>)}</div>
            {!state.supplierQuotes.some((item) => item.procurementItemId === selected.id) && <div className="table-empty">Предложения ещё не заведены. Они появятся на этапе сбора цен.</div>}
          </div>
          <div className="entity-detail-section"><SectionHeader eyebrow="Связи" title="Финансы и документы" /><div className="entity-related-list">{state.financeEntries.filter((entry) => entry.procurementItemId === selected.id || (selected.supplierId && entry.stageId === selected.stageId && entry.counterpartyId === selected.supplierId)).map((entry) => <div key={entry.id}><span><strong>{entry.description}</strong><small>{entry.document ?? 'Без документа'} · {entry.counterparty}</small></span><strong>{money(entry.amount)}</strong></div>)}{!state.financeEntries.some((entry) => entry.procurementItemId === selected.id || (selected.supplierId && entry.stageId === selected.stageId && entry.counterpartyId === selected.supplierId)) && <div className="table-empty">Связанных финансовых операций пока нет.</div>}</div></div>
          <div className="modal__actions"><button type="button" className="button button--ghost" onClick={() => setSelectedId(null)}>Закрыть</button>{role !== 'client' && selected.status !== 'issued' && <button type="button" className="button button--primary" onClick={() => moveNext(selected.id)}>Перевести: {statusLabels[statusOrder[Math.min(statusOrder.indexOf(selected.status) + 1, statusOrder.length - 1)]]} <ArrowRight size={17} /></button>}</div>
        </Modal>
      )}
      {quoteForId && <Modal title="Добавить коммерческое предложение" subtitle={state.procurement.find((item) => item.id === quoteForId)?.item} onClose={() => setQuoteForId(null)}><form className="modal-form" onSubmit={addQuote}>{!state.counterparties.some((item) => (item.type === 'supplier' || item.type === 'contractor') && item.status !== 'blocked') && <div className="form-warning"><AlertTriangle size={18} /><span>Сначала добавьте поставщика в единый справочник.</span></div>}<Field label="Поставщик"><select required value={quoteForm.supplierId} onChange={(event) => setQuoteForm({ ...quoteForm, supplierId: event.target.value })}><option value="">Выберите поставщика</option>{state.counterparties.filter((item) => (item.type === 'supplier' || item.type === 'contractor') && item.status !== 'blocked').map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></Field><div className="form-grid"><Field label="Цена, ₽"><input required min="1" type="number" inputMode="numeric" value={quoteForm.amount} onChange={(event) => setQuoteForm({ ...quoteForm, amount: event.target.value })} /></Field><Field label="Срок поставки, дней"><input required min="0" type="number" inputMode="numeric" value={quoteForm.deliveryDays} onChange={(event) => setQuoteForm({ ...quoteForm, deliveryDays: event.target.value })} /></Field></div><Field label="Условия оплаты"><input required value={quoteForm.paymentTerms} onChange={(event) => setQuoteForm({ ...quoteForm, paymentTerms: event.target.value })} placeholder="Аванс / постоплата / отсрочка" /></Field><div className="form-grid"><Field label="Источник"><input value={quoteForm.source} onChange={(event) => setQuoteForm({ ...quoteForm, source: event.target.value })} /></Field><Field label="Комментарий"><input value={quoteForm.comment} onChange={(event) => setQuoteForm({ ...quoteForm, comment: event.target.value })} /></Field></div><div className="modal__actions"><button type="button" className="button button--ghost" onClick={() => setQuoteForId(null)}>Отмена</button><button type="submit" className="button button--primary" disabled={!quoteForm.supplierId}>Сохранить предложение</button></div></form></Modal>}
      {counterpartyId && <CounterpartyModal state={state} counterpartyId={counterpartyId} onClose={() => setCounterpartyId(null)} />}
    </div>
  );
}
