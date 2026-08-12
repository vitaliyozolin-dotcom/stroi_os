import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Banknote,
  CheckCircle2,
  CircleDollarSign,
  FileCheck2,
  LockKeyhole,
  Plus,
  ReceiptText,
  ShieldCheck,
  WalletCards,
} from 'lucide-react';
import { acceptedAmountFor, financeTotals, formatDate, lineTotals, money, paidAmountFor, shortMoney, uid } from '../domain';
import type { AppState, ExpenseStatus, FinanceEntry, PageId, ProjectDocument } from '../types';
import { Field, MetricCard, Modal, ProgressBar, SectionHeader, StatusBadge } from '../components/Ui';
import { CounterpartyModal } from '../components/CounterpartyModal';

const statusLabels: Record<ExpenseStatus, string> = {
  committed: 'Обязательство',
  accepted: 'Принято',
  paid: 'Оплачено',
};

export function FinancePage({ state, actor, focusId, onChange, onNavigate }: { state: AppState; actor: string; focusId?: string | null; onChange: (next: AppState) => void; onNavigate: (page: PageId) => void }) {
  const totals = financeTotals(state);
  const [showForm, setShowForm] = useState(false);
  const [formKind, setFormKind] = useState<'expense' | 'income'>('expense');
  const [kindFilter, setKindFilter] = useState<'all' | 'expense' | 'income'>('all');
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null);
  const [counterpartyId, setCounterpartyId] = useState<string | null>(null);
  const [summaryOpen, setSummaryOpen] = useState<'plan' | 'committed' | 'accepted' | 'balance' | null>(null);
  const [actionEntryId, setActionEntryId] = useState<string | null>(null);
  const [actionKind, setActionKind] = useState<'accept' | 'pay' | 'receive'>('accept');
  const [actionForm, setActionForm] = useState({ amount: '', date: new Date().toISOString().slice(0, 10), document: '' });
  const [editingLineId, setEditingLineId] = useState<string | null>(null);
  const [lineForm, setLineForm] = useState({ plan: '', forecast: '', version: state.budgetMeta.version, source: state.budgetMeta.source });
  const firstLine = state.budgetLines[0];
  const [form, setForm] = useState({
    budgetLineId: firstLine.id,
    stageId: firstLine.stageIds[0],
    amount: '',
    counterpartyId: '',
    description: '',
    date: new Date().toISOString().slice(0, 10),
  });
  useEffect(() => {
    if (focusId && state.financeEntries.some((entry) => entry.id === focusId)) setSelectedEntryId(focusId);
  }, [focusId, state.financeEntries]);

  const entries = useMemo(() => state.financeEntries
    .filter((entry) => kindFilter === 'all' || entry.kind === kindFilter)
    .sort((a, b) => b.date.localeCompare(a.date)), [kindFilter, state.financeEntries]);

  const addOperation = (event: FormEvent) => {
    event.preventDefault();
    const amount = Number(form.amount);
    const counterparty = state.counterparties.find((item) => item.id === form.counterpartyId);
    if (!amount || amount <= 0 || !counterparty || !form.description.trim()) return;
    const selectedLine = state.budgetLines.find((line) => line.id === form.budgetLineId) ?? firstLine;
    const currentCommitted = lineTotals(state, selectedLine).committed;
    const next: AppState = {
      ...state,
      budgetLines: formKind === 'expense' ? state.budgetLines.map((line) => line.id === selectedLine.id
        ? { ...line, forecast: Math.max(line.forecast, currentCommitted + amount) }
        : line) : state.budgetLines,
      financeEntries: [{
        id: uid('finance'),
        kind: formKind,
        status: 'committed',
        amount,
        date: form.date,
        stageId: formKind === 'expense' ? form.stageId : undefined,
        budgetLineId: formKind === 'expense' ? form.budgetLineId : undefined,
        counterparty: counterparty.name,
        counterpartyId: counterparty.id,
        description: form.description.trim(),
      }, ...state.financeEntries],
      activity: [{
        id: uid('activity'),
        timestamp: new Date().toISOString(),
        actor,
        text: `${formKind === 'expense' ? 'Добавлен расход' : 'Добавлено поступление'} ${money(amount)} · ${form.description.trim()}`,
        tone: 'neutral',
      }, ...state.activity],
    };
    onChange(next);
    setShowForm(false);
    setForm({ ...form, amount: '', counterpartyId: '', description: '' });
  };

  const selectedEntry = state.financeEntries.find((entry) => entry.id === selectedEntryId) ?? null;
  const selectedLine = state.budgetLines.find((line) => line.id === selectedLineId) ?? null;
  const balance = totals.received - totals.paid;

  const canAcceptEntry = (entry: FinanceEntry) => {
    if (!entry.stageId) return false;
    const acceptedWork = state.checkpoints.some((checkpoint) => checkpoint.stageId === entry.stageId && checkpoint.status === 'accepted');
    const acceptedMaterial = state.procurement.some((item) => item.stageId === entry.stageId && ['accepted', 'issued'].includes(item.status));
    return acceptedWork || acceptedMaterial;
  };

  const openAction = (entry: FinanceEntry, kind: 'accept' | 'pay' | 'receive') => {
    const remaining = kind === 'accept' ? entry.amount - acceptedAmountFor(entry) : kind === 'pay' ? acceptedAmountFor(entry) - paidAmountFor(entry) : entry.amount - paidAmountFor(entry);
    setActionEntryId(entry.id);
    setActionKind(kind);
    setActionForm({ amount: String(Math.max(0, remaining)), date: new Date().toISOString().slice(0, 10), document: kind === 'accept' ? entry.acceptanceDocument ?? '' : entry.paymentDocument ?? '' });
  };

  const saveAction = (event: FormEvent) => {
    event.preventDefault();
    const entry = state.financeEntries.find((item) => item.id === actionEntryId);
    const amount = Number(actionForm.amount);
    if (!entry || amount <= 0) return;
    const now = new Date().toISOString();
    let text = '';
    const financeEntries = state.financeEntries.map((item) => {
      if (item.id !== entry.id) return item;
      if (actionKind === 'accept') {
        const acceptedAmount = Math.min(item.amount, acceptedAmountFor(item) + amount);
        text = `${item.description}: принято ${money(amount)}`;
        return { ...item, status: 'accepted' as ExpenseStatus, acceptedAmount, acceptedAt: actionForm.date, acceptanceDocument: actionForm.document.trim() || undefined, document: actionForm.document.trim() || item.document };
      }
      const paidAmount = Math.min(actionKind === 'pay' ? acceptedAmountFor(item) : item.amount, paidAmountFor(item) + amount);
      text = `${item.description}: ${actionKind === 'receive' ? 'получено' : 'оплачено'} ${money(amount)}`;
      return { ...item, status: paidAmount >= item.amount ? 'paid' as ExpenseStatus : item.status, paidAmount, paidAt: actionForm.date, paymentDocument: actionForm.document.trim() || undefined };
    });
    const document: ProjectDocument | null = actionForm.document.trim() ? { id: uid('document'), name: actionForm.document.trim(), type: actionKind === 'accept' ? 'Акт / приёмка' : 'Платёжный документ', category: actionKind === 'accept' ? 'act' : 'other', documentDate: actionForm.date, updatedAt: now, clientVisible: false, status: 'current', direction: actionKind === 'accept' ? 'incoming' : 'outgoing', counterpartyId: entry.counterpartyId, stageId: entry.stageId, financeEntryId: entry.id, receivedAt: actionKind === 'accept' ? now : undefined, sentAt: actionKind === 'accept' ? undefined : now, storageLocation: `ИКИОМА ОС / ${state.project.code} / Финансы` } : null;
    onChange({ ...state, financeEntries, documents: document ? [document, ...state.documents] : state.documents, activity: [{ id: uid('activity'), timestamp: now, actor, text, tone: actionKind === 'accept' ? 'neutral' : 'positive' }, ...state.activity] });
    setActionEntryId(null);
  };

  const openLineEdit = (line: AppState['budgetLines'][number]) => {
    setSelectedLineId(null);
    setEditingLineId(line.id);
    setLineForm({ plan: String(line.plan), forecast: String(line.forecast), version: state.budgetMeta.version, source: state.budgetMeta.source });
  };

  const saveLine = (event: FormEvent) => {
    event.preventDefault();
    const plan = Number(lineForm.plan);
    const forecast = Number(lineForm.forecast);
    if (!editingLineId || plan < 0 || forecast < 0 || !lineForm.source.trim()) return;
    const line = state.budgetLines.find((item) => item.id === editingLineId);
    onChange({ ...state, budgetLines: state.budgetLines.map((item) => item.id === editingLineId ? { ...item, plan, forecast } : item), budgetMeta: { ...state.budgetMeta, version: lineForm.version.trim() || state.budgetMeta.version, source: lineForm.source.trim(), importedAt: new Date().toISOString() }, activity: [{ id: uid('activity'), timestamp: new Date().toISOString(), actor, text: `Обновлена статья сметы ${line?.name ?? ''}: план ${money(plan)}`, tone: 'neutral' }, ...state.activity] });
    setEditingLineId(null);
  };

  return (
    <div className="page-stack">
      <section className="page-title-row">
        <div>
          <span className="eyebrow">Экономика дома · {state.project.code}</span>
          <h1>Деньги и обязательства</h1>
          <p>Один поток от бюджета до фактической оплаты. Никаких выплат без привязки к этапу и основанию.</p>
        </div>
        <button type="button" data-tour="finance-add" className="button button--primary" onClick={() => setShowForm(true)}><Plus size={18} /> Добавить операцию</button>
      </section>

      <section className="rule-banner">
        <span><ShieldCheck size={21} /></span>
        <div><strong>Правило оплаты включено</strong><p>Расход можно оплатить только после приёмки материала или выполненной работы.</p></div>
        <StatusBadge label="Контроль активен" tone="positive" />
      </section>

      <section className="metric-grid">
        <MetricCard label="План себестоимости" value={shortMoney(totals.plan)} detail={<span>утверждённая базовая смета</span>} icon={WalletCards} onClick={() => setSummaryOpen('plan')} />
        <MetricCard label="Законтрактовано" value={shortMoney(totals.committed)} detail={<span>{totals.plan ? Math.round(totals.committed / totals.plan * 100) : 0}% бюджета имеет обязательства</span>} icon={FileCheck2} onClick={() => setSummaryOpen('committed')} />
        <MetricCard label="Принято работ" value={shortMoney(totals.accepted)} detail={<span>{shortMoney(totals.paid)} уже оплачено</span>} icon={CheckCircle2} tone="positive" onClick={() => setSummaryOpen('accepted')} />
        <MetricCard label="Доступный баланс" value={shortMoney(balance)} detail={<span>получено {shortMoney(totals.received)} · маржа {shortMoney(state.project.contractValue - totals.forecast)}</span>} icon={Banknote} tone="dark" onClick={() => setSummaryOpen('balance')} />
      </section>

      <section className="panel finance-summary" data-tour="budget-plan">
        <SectionHeader eyebrow={`Смета ${state.budgetMeta.version}`} title="Бюджет по пакетам работ" action={<div className="finance-summary__legend"><span>План</span><span>Прогноз</span><span>Оплачено</span></div>} />
        <div className="budget-source"><div><small>Откуда берётся план</small><strong>{state.budgetMeta.source}</strong><p>{state.budgetMeta.approvedBy ? `Утвердил: ${state.budgetMeta.approvedBy}` : 'Ещё не утверждена'}{state.budgetMeta.approvedAt ? ` · ${formatDate(state.budgetMeta.approvedAt, true)}` : ''}</p></div><div><small>Откуда берётся проект</small><strong>{state.project.source ?? 'Создан в ИКИОМА ОС'}</strong><p>{state.project.contractNumber ? `Договор ${state.project.contractNumber}` : state.project.model}</p></div><p>{state.budgetMeta.note}</p></div>
        <div className="budget-table" role="table" aria-label="Бюджет проекта">
          <div className="budget-table__head" role="row">
            <span>Пакет работ</span><span>План</span><span>Обязательства</span><span>Принято</span><span>Оплачено</span><span>Прогноз</span><span>Отклонение</span>
          </div>
          {state.budgetLines.map((line) => {
            const values = lineTotals(state, line);
            const deviation = line.forecast - line.plan;
            return (
              <button type="button" className="budget-table__row budget-table__row--clickable" role="row" key={line.id} onClick={() => setSelectedLineId(line.id)}>
                <div className="budget-name">
                  <strong>{line.name}</strong>
                  <ProgressBar value={line.plan ? values.committed / line.plan * 100 : 0} tone={deviation > 0 ? 'orange' : 'green'} />
                </div>
                <span data-label="План">{money(line.plan)}</span>
                <span data-label="Обязательства">{money(values.committed)}</span>
                <span data-label="Принято">{money(values.accepted)}</span>
                <span data-label="Оплачено">{money(values.paid)}</span>
                <strong data-label="Прогноз">{money(line.forecast)}</strong>
                <span data-label="Отклонение" className={deviation > 0 ? 'budget-deviation budget-deviation--negative' : 'budget-deviation budget-deviation--positive'}>{deviation === 0 ? '—' : `${deviation > 0 ? '+' : '−'}${money(Math.abs(deviation))}`}</span>
              </button>
            );
          })}
          <div className="budget-table__total">
            <strong>Итого по дому</strong><span>{money(totals.plan)}</span><span>{money(totals.committed)}</span><span>{money(totals.accepted)}</span><span>{money(totals.paid)}</span><strong>{money(totals.forecast)}</strong><span className={totals.forecast > totals.plan ? 'negative-text' : 'positive-text'}>{totals.forecast > totals.plan ? '+' : ''}{money(totals.forecast - totals.plan)}</span>
          </div>
        </div>
      </section>

      <section className="panel transaction-panel" data-tour="finance-flow">
        <SectionHeader
          eyebrow="Реестр"
          title="Операции проекта"
          action={<div className="segmented-control"><button className={kindFilter === 'all' ? 'active' : ''} onClick={() => setKindFilter('all')}>Все</button><button className={kindFilter === 'expense' ? 'active' : ''} onClick={() => setKindFilter('expense')}>Расходы</button><button className={kindFilter === 'income' ? 'active' : ''} onClick={() => setKindFilter('income')}>Поступления</button></div>}
        />
        <div className="transaction-list">
          {entries.map((entry) => {
            const stage = state.stages.find((item) => item.id === entry.stageId);
            return (
              <div className="transaction-row transaction-row--clickable" role="button" tabIndex={0} key={entry.id} onClick={() => setSelectedEntryId(entry.id)} onKeyDown={(event) => { if (event.key === 'Enter') setSelectedEntryId(entry.id); }}>
                <span className={`transaction-row__icon transaction-row__icon--${entry.kind}`}>{entry.kind === 'income' ? <ArrowDownLeft size={18} /> : <ArrowUpRight size={18} />}</span>
                <div className="transaction-row__main"><strong>{entry.description}</strong><span><button type="button" className="entity-link entity-link--inline" onClick={(event) => { event.stopPropagation(); setCounterpartyId(entry.counterpartyId ?? null); }}>{entry.counterparty}</button>{stage ? ` · ${stage.shortName}` : ''}{entry.document ? ` · ${entry.document}` : ''}</span></div>
                <span className="transaction-row__date">{formatDate(entry.date, true)}</span>
                <div className="transaction-status-cell">
                  <StatusBadge label={entry.kind === 'income' && entry.status === 'paid' ? 'Получено' : statusLabels[entry.status]} tone={entry.status === 'paid' ? 'positive' : entry.status === 'accepted' ? 'blue' : 'neutral'} />
                  {entry.kind === 'expense' && acceptedAmountFor(entry) < entry.amount && <button type="button" disabled={!canAcceptEntry(entry)} onClick={(event) => { event.stopPropagation(); openAction(entry, 'accept'); }} title={!canAcceptEntry(entry) ? 'Сначала примите связанную работу или поставку' : 'Зафиксировать фактически принятый объём'}>Принять</button>}
                  {entry.kind === 'expense' && paidAmountFor(entry) < acceptedAmountFor(entry) && <button type="button" onClick={(event) => { event.stopPropagation(); openAction(entry, 'pay'); }}>Оплатить</button>}
                  {entry.kind === 'income' && paidAmountFor(entry) < entry.amount && <button type="button" onClick={(event) => { event.stopPropagation(); openAction(entry, 'receive'); }}>Получить</button>}
                </div>
                <strong className={entry.kind === 'income' ? 'positive-text' : ''}>{entry.kind === 'income' ? '+' : '−'}{money(entry.amount)}</strong>
              </div>
            );
          })}
          {!entries.length && <div className="task-empty"><WalletCards size={28} /><strong>Операций пока нет</strong><p>Сначала добавьте контрагента, затем создайте обязательство или ожидаемое поступление.</p></div>}
        </div>
      </section>

      {showForm && (
        <Modal title="Новая операция" subtitle="Расход привязывается к смете и этапу, поступление — к плательщику и основанию." onClose={() => setShowForm(false)}>
          <form className="modal-form" onSubmit={addOperation}>
            {!state.counterparties.length && <div className="form-warning"><ReceiptText size={18} /><span>Сначала добавьте подрядчика, поставщика или заказчика в справочник.</span><button type="button" className="text-button" onClick={() => { setShowForm(false); onNavigate('counterparties'); }}>Открыть справочник</button></div>}
            <div className="segmented-control segmented-control--wide"><button type="button" className={formKind === 'expense' ? 'active' : ''} onClick={() => setFormKind('expense')}>Расход</button><button type="button" className={formKind === 'income' ? 'active' : ''} onClick={() => setFormKind('income')}>Поступление</button></div>
            {formKind === 'expense' && <>
            <div className="form-grid">
              <Field label="Статья бюджета">
                <select value={form.budgetLineId} onChange={(event) => {
                  const line = state.budgetLines.find((item) => item.id === event.target.value) ?? firstLine;
                  setForm({ ...form, budgetLineId: line.id, stageId: line.stageIds[0] });
                }}>
                  {state.budgetLines.map((line) => <option value={line.id} key={line.id}>{line.name}</option>)}
                </select>
              </Field>
              <Field label="Этап">
                <select value={form.stageId} onChange={(event) => setForm({ ...form, stageId: event.target.value })}>
                  {state.stages.filter((stage) => (state.budgetLines.find((line) => line.id === form.budgetLineId)?.stageIds ?? []).includes(stage.id)).map((stage) => <option key={stage.id} value={stage.id}>{stage.name}</option>)}
                </select>
              </Field>
              <Field label="Сумма, ₽"><input required min="1" inputMode="numeric" type="number" value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} placeholder="350000" /></Field>
              <Field label="Статус"><div className="locked-field"><LockKeyhole size={15} /> Обязательство</div></Field>
            </div>
            </>}
            {formKind === 'income' && <div className="form-grid"><Field label="Сумма, ₽"><input required min="1" inputMode="numeric" type="number" value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} placeholder="1400000" /></Field><Field label="Статус"><div className="locked-field"><LockKeyhole size={15} /> Запланировано</div></Field></div>}
            <Field label="Основание операции" hint="Счёт, договор, акт, платёж или конкретная поставка"><textarea required rows={3} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} placeholder="За что платим или какое поступление ожидаем" /></Field>
            <div className="form-grid"><Field label={formKind === 'expense' ? 'Контрагент' : 'Плательщик'} hint="Выбор из единого справочника"><select required value={form.counterpartyId} onChange={(event) => setForm({ ...form, counterpartyId: event.target.value })}><option value="">Выберите контрагента</option>{state.counterparties.filter((item) => item.status !== 'blocked').map((item) => <option value={item.id} key={item.id}>{item.name}{item.specialty ? ` · ${item.specialty}` : ''}</option>)}</select></Field><Field label="Дата"><input type="date" value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value })} /></Field></div>
            {formKind === 'expense' && <div className="form-warning"><ReceiptText size={18} /><span>Сначала создаётся обязательство. Перевести его в «принято» можно только после приёмки связанной работы или поставки, а затем — оплатить.</span></div>}
            <div className="modal__actions"><button className="button button--ghost" type="button" onClick={() => setShowForm(false)}>Отмена</button><button className="button button--primary" type="submit" disabled={!state.counterparties.length}><CircleDollarSign size={18} /> Добавить в поток</button></div>
          </form>
        </Modal>
      )}

      {summaryOpen && <Modal wide title={summaryOpen === 'plan' ? 'План себестоимости' : summaryOpen === 'committed' ? 'Законтрактованные расходы' : summaryOpen === 'accepted' ? 'Принятые работы и материалы' : 'Баланс проекта'} subtitle={summaryOpen === 'plan' ? `${state.budgetMeta.source} · ${state.budgetMeta.version}` : 'Каждая цифра раскрывается до операции, контрагента и документа.'} onClose={() => setSummaryOpen(null)}><div className="finance-drilldown"><div><small>План</small><strong>{money(totals.plan)}</strong></div><div><small>Прогноз</small><strong>{money(totals.forecast)}</strong></div><div><small>Обязательства</small><strong>{money(totals.committed)}</strong></div><div><small>Принято</small><strong>{money(totals.accepted)}</strong></div><div><small>Оплачено</small><strong>{money(totals.paid)}</strong></div><div><small>Получено</small><strong>{money(totals.received)}</strong></div><div className="finance-drilldown__accent"><small>Доступный баланс</small><strong>{money(balance)}</strong></div><div className="finance-drilldown__accent"><small>Прогноз маржи</small><strong>{money(state.project.contractValue - totals.forecast)}</strong></div></div><div className="entity-related-list">{summaryOpen === 'plan' ? state.budgetLines.map((line) => <button type="button" key={line.id} onClick={() => { setSummaryOpen(null); setSelectedLineId(line.id); }}><span><strong>{line.name}</strong><small>{line.stageIds.length} этапа · прогноз {money(line.forecast)}</small></span><strong>{money(line.plan)}</strong></button>) : state.financeEntries.filter((entry) => summaryOpen === 'committed' ? entry.kind === 'expense' : summaryOpen === 'accepted' ? entry.kind === 'expense' && acceptedAmountFor(entry) > 0 : entry.kind === 'income' || paidAmountFor(entry) > 0).map((entry) => <button type="button" key={entry.id} onClick={() => { setSummaryOpen(null); setSelectedEntryId(entry.id); }}><span><strong>{entry.description}</strong><small>{entry.counterparty} · {entry.kind === 'income' ? 'поступление' : `принято ${money(acceptedAmountFor(entry))} · оплачено ${money(paidAmountFor(entry))}`}</small></span><strong>{money(entry.amount)}</strong></button>)}</div></Modal>}

      {selectedEntry && <Modal title={selectedEntry.description} subtitle={`${selectedEntry.kind === 'expense' ? 'Расход' : 'Поступление'} · ${formatDate(selectedEntry.date, true)}`} onClose={() => setSelectedEntryId(null)}><div className="entity-detail-grid"><section className="entity-detail-card"><small>Обязательство</small><strong>{money(selectedEntry.amount)}</strong><span>{selectedEntry.kind === 'income' ? 'ожидаемое поступление' : statusLabels[selectedEntry.status]}</span></section><section className="entity-detail-card"><small>{selectedEntry.kind === 'income' ? 'Получено' : 'Принято'}</small><strong>{money(selectedEntry.kind === 'income' ? paidAmountFor(selectedEntry) : acceptedAmountFor(selectedEntry))}</strong><span>{selectedEntry.kind === 'income' ? selectedEntry.paymentDocument ?? 'Без платёжного документа' : selectedEntry.acceptanceDocument ?? 'Акт не указан'}</span></section>{selectedEntry.kind === 'expense' && <section className="entity-detail-card"><small>Оплачено</small><strong>{money(paidAmountFor(selectedEntry))}</strong><span>{selectedEntry.paymentDocument ?? 'Платёжный документ не указан'}</span></section>}<section className="entity-detail-card"><small>Контрагент</small><button type="button" className="entity-link" onClick={() => { setSelectedEntryId(null); setCounterpartyId(selectedEntry.counterpartyId ?? null); }}>{selectedEntry.counterparty} <ArrowUpRight size={15} /></button><span>{selectedEntry.document ?? 'Основание не приложено'}</span></section><section className="entity-detail-card"><small>Связь</small><strong>{state.stages.find((item) => item.id === selectedEntry.stageId)?.name ?? 'Без этапа'}</strong><span>{state.budgetLines.find((item) => item.id === selectedEntry.budgetLineId)?.name ?? 'Без статьи бюджета'}</span></section></div><div className="modal__actions">{selectedEntry.kind === 'expense' && acceptedAmountFor(selectedEntry) < selectedEntry.amount && <button type="button" className="button button--secondary" disabled={!canAcceptEntry(selectedEntry)} onClick={() => { setSelectedEntryId(null); openAction(selectedEntry, 'accept'); }}>Зафиксировать приёмку</button>}{selectedEntry.kind === 'expense' && paidAmountFor(selectedEntry) < acceptedAmountFor(selectedEntry) && <button type="button" className="button button--primary" onClick={() => { setSelectedEntryId(null); openAction(selectedEntry, 'pay'); }}>Зафиксировать оплату</button>}{selectedEntry.kind === 'income' && paidAmountFor(selectedEntry) < selectedEntry.amount && <button type="button" className="button button--primary" onClick={() => { setSelectedEntryId(null); openAction(selectedEntry, 'receive'); }}>Зафиксировать поступление</button>}</div></Modal>}

      {selectedLine && <Modal wide title={selectedLine.name} subtitle="Статья сметы и все связанные обязательства." onClose={() => setSelectedLineId(null)}><div className="finance-drilldown"><div><small>План</small><strong>{money(selectedLine.plan)}</strong></div><div><small>Прогноз</small><strong>{money(selectedLine.forecast)}</strong></div><div><small>Обязательства</small><strong>{money(lineTotals(state, selectedLine).committed)}</strong></div><div><small>Принято</small><strong>{money(lineTotals(state, selectedLine).accepted)}</strong></div><div><small>Оплачено</small><strong>{money(lineTotals(state, selectedLine).paid)}</strong></div></div><div className="entity-related-list">{state.financeEntries.filter((entry) => entry.budgetLineId === selectedLine.id).map((entry) => <button type="button" key={entry.id} onClick={() => { setSelectedLineId(null); setSelectedEntryId(entry.id); }}><span><strong>{entry.description}</strong><small>{entry.counterparty} · {formatDate(entry.date, true)}</small></span><strong>{money(entry.amount)}</strong></button>)}{!state.financeEntries.some((entry) => entry.budgetLineId === selectedLine.id) && <div className="table-empty">По статье ещё нет обязательств и оплат.</div>}</div><div className="modal__actions"><button type="button" className="button button--secondary" onClick={() => openLineEdit(selectedLine)}>Изменить план и прогноз</button><button type="button" className="button button--primary" onClick={() => { setSelectedLineId(null); setForm({ ...form, budgetLineId: selectedLine.id, stageId: selectedLine.stageIds[0] }); setShowForm(true); }}>Добавить обязательство</button></div></Modal>}

      {counterpartyId && <CounterpartyModal state={state} counterpartyId={counterpartyId} onClose={() => setCounterpartyId(null)} onOpenFinanceEntry={(id) => { setCounterpartyId(null); setSelectedEntryId(id); }} />}

      {actionEntryId && (() => { const entry = state.financeEntries.find((item) => item.id === actionEntryId); if (!entry) return null; const title = actionKind === 'accept' ? 'Фактическая приёмка' : actionKind === 'pay' ? 'Фактическая оплата' : 'Фактическое поступление'; return <Modal title={title} subtitle={`${entry.description} · ${entry.counterparty}`} onClose={() => setActionEntryId(null)}><form className="modal-form" onSubmit={saveAction}><div className="finance-action-context"><div><small>Обязательство</small><strong>{money(entry.amount)}</strong></div><div><small>{actionKind === 'accept' ? 'Уже принято' : actionKind === 'receive' ? 'Уже получено' : 'Уже оплачено'}</small><strong>{money(actionKind === 'accept' ? acceptedAmountFor(entry) : paidAmountFor(entry))}</strong></div></div><div className="form-grid"><Field label="Фактическая сумма, ₽"><input required min="1" max={actionKind === 'accept' ? entry.amount - acceptedAmountFor(entry) : actionKind === 'pay' ? acceptedAmountFor(entry) - paidAmountFor(entry) : entry.amount - paidAmountFor(entry)} type="number" inputMode="numeric" value={actionForm.amount} onChange={(event) => setActionForm({ ...actionForm, amount: event.target.value })} /></Field><Field label="Фактическая дата"><input required type="date" value={actionForm.date} onChange={(event) => setActionForm({ ...actionForm, date: event.target.value })} /></Field></div><Field label={actionKind === 'accept' ? 'Акт / УПД / ТН' : 'Платёжное поручение / чек'} hint="Документ автоматически попадёт в историю контрагента"><input value={actionForm.document} onChange={(event) => setActionForm({ ...actionForm, document: event.target.value })} placeholder={actionKind === 'accept' ? 'Акт №…' : 'Платёжное поручение №…'} /></Field><div className="modal__actions"><button type="button" className="button button--ghost" onClick={() => setActionEntryId(null)}>Отмена</button><button type="submit" className="button button--primary">Сохранить факт</button></div></form></Modal>; })()}

      {editingLineId && <Modal title="Изменить статью сметы" subtitle={state.budgetLines.find((item) => item.id === editingLineId)?.name} onClose={() => setEditingLineId(null)}><form className="modal-form" onSubmit={saveLine}><div className="form-grid"><Field label="План, ₽" hint="Утверждённая базовая сумма"><input required min="0" type="number" inputMode="numeric" value={lineForm.plan} onChange={(event) => setLineForm({ ...lineForm, plan: event.target.value })} /></Field><Field label="Прогноз, ₽" hint="Ожидаемый итог с учётом изменений"><input required min="0" type="number" inputMode="numeric" value={lineForm.forecast} onChange={(event) => setLineForm({ ...lineForm, forecast: event.target.value })} /></Field><Field label="Версия сметы"><input value={lineForm.version} onChange={(event) => setLineForm({ ...lineForm, version: event.target.value })} /></Field></div><Field label="Источник плана"><input required value={lineForm.source} onChange={(event) => setLineForm({ ...lineForm, source: event.target.value })} /></Field><div className="modal__actions"><button type="button" className="button button--ghost" onClick={() => setEditingLineId(null)}>Отмена</button><button type="submit" className="button button--primary">Сохранить статью</button></div></form></Modal>}
    </div>
  );
}

