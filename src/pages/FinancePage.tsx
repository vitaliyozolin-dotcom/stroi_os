import { CashflowPanel } from '../components/CashflowPanel';
import { createFinanceCommands } from '../application';
import { runtimeIdGenerator, systemClock, uid } from '../infrastructure/runtime';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowUpRight,
  CircleDollarSign,
  LockKeyhole,
  Plus,
  ReceiptText,
} from 'lucide-react';
import { acceptedAmountFor, financeTotals, lineTotals, lineForecast, unallocatedExpenses, unallocatedExpenseTotals, paidAmountFor, financeMoney, needsExpenseApproval, expenseAcceptanceSources, financeActionError } from '../domain/index';
import { formatDate, money, shortMoney } from '../presentation/formatting';
import type { AppState, ExpenseStatus, FinanceEntry, ProjectDocument } from '../entities/index';
import type { PageId } from '../presentation/navigation';
import { Field, Modal } from '../components/Ui';
import { CounterpartyModal } from '../components/CounterpartyModal';
import { HistoryImport } from '../components/HistoryImport';
import { PaymentEvidence } from '../components/PaymentEvidence';
import { PaymentHistory } from '../components/PaymentHistory';
import { paymentEvidence } from '../domain/payment-evidence';
import { FinanceOperations } from '../components/FinanceOperations';
import { FinanceBudgetPanel } from '../components/FinanceBudgetPanel';
import { FinancePaymentCalendar } from '../components/FinancePaymentCalendar';
import { FinanceDrawer } from '../components/FinanceDrawer';
import { financeEntryTitle, financeToday } from '../presentation/finance-view';
import './finance-page.css';

export function FinancePage({ state, actor, focusId, onChange, onNavigate, onOpenQuestions }: { state: AppState; actor: string; focusId?: string | null; onChange: (next: AppState) => void; onNavigate: (page: PageId, entityId?: string) => void; onOpenQuestions: () => void }) {
  const saveChange = createFinanceCommands(state, actor, systemClock, runtimeIdGenerator, onChange);
  const totals = financeTotals(state);
  const margin = state.project.contractValue - totals.forecast;
  const unallocated = unallocatedExpenseTotals(state);
  const unallocatedEntries = unallocatedExpenses(state);
  const [showUnallocated, setShowUnallocated] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [showHistoryImport, setShowHistoryImport] = useState(false);
  const [formKind, setFormKind] = useState<'expense' | 'income'>('expense');
  const [view, setView] = useState<'operations' | 'budget' | 'calendar'>('operations');
  const [formError, setFormError] = useState('');
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null);
  const [counterpartyId, setCounterpartyId] = useState<string | null>(null);
  const [summaryOpen, setSummaryOpen] = useState<'paid' | 'received' | 'balance' | null>(null);
  const [actionEntryId, setActionEntryId] = useState<string | null>(null);
  const [actionKind, setActionKind] = useState<'accept' | 'pay' | 'receive'>('accept');
  const [actionForm, setActionForm] = useState({ amount: '', date: financeToday(), document: '', source: '' });
  const [actionError, setActionError] = useState('');
  const [editingLineId, setEditingLineId] = useState<string | null>(null);
  const [lineForm, setLineForm] = useState({ plan: '', forecast: '', version: state.budgetMeta.version, source: state.budgetMeta.source });
  const firstLine = state.budgetLines[0];
  const [form, setForm] = useState({
    budgetLineId: firstLine?.id ?? '',
    stageId: firstLine?.stageIds[0] ?? '',
    amount: '',
    counterpartyId: '',
    description: '',
    date: financeToday(),
  });
  const handledFocus = useRef<string | null>(null);
  useEffect(() => {
    if (!focusId) { handledFocus.current = null; return; }
    if (handledFocus.current !== focusId && state.financeEntries.some(entry => entry.id === focusId)) {
      handledFocus.current = focusId;
      setSelectedEntryId(focusId);
    }
  }, [focusId, state.financeEntries]);

  const addOperation = (event: FormEvent) => {
    event.preventDefault();
    const amount = Number(form.amount);
    const counterparty = state.counterparties.find((item) => item.id === form.counterpartyId);
    if (!Number.isFinite(amount) || amount <= 0 || !counterparty || !form.description.trim()) { setFormError('Укажите сумму, контрагента и назначение.'); return; }
    const selectedLine = state.budgetLines.find((line) => line.id === form.budgetLineId) ?? firstLine;
    if (formKind === 'expense' && (!selectedLine || !selectedLine.stageIds.includes(form.stageId))) { setFormError('Для этой статьи пока не выбран этап. Уточните связь статьи в смете.'); return; }
    const currentCommitted = selectedLine ? lineTotals(state, selectedLine).committed : 0;
    const entryId = uid('finance');
    const next: AppState = {
      ...state,
      budgetLines: formKind === 'expense' ? state.budgetLines.map((line) => line.id === selectedLine.id
        ? { ...line, forecast: Math.max(line.forecast, currentCommitted + amount) }
        : line) : state.budgetLines,
      financeEntries: [{
        id: entryId,
        kind: formKind,
        status: 'committed',
        createdBy: actor,
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
    saveChange(next);
    setShowForm(false);
    setSelectedEntryId(entryId);
    setForm({ ...form, amount: '', counterpartyId: '', description: '' });
  };

  const selectedEntry = state.financeEntries.find((entry) => entry.id === selectedEntryId) ?? null;
  const selectedCounterparty = state.counterparties.find(item => item.id === selectedEntry?.counterpartyId);
  const selectedLine = state.budgetLines.find((line) => line.id === selectedLineId) ?? null;
  const balance = totals.received - totals.paid;

  const canAcceptEntry = (entry: FinanceEntry) => !needsExpenseApproval(entry) && expenseAcceptanceSources(state, entry).length > 0;
  const approveExpense = (entry: FinanceEntry) => {
    if (!needsExpenseApproval(entry)) return;
    const now = new Date().toISOString();
    saveChange({ ...state, financeEntries: state.financeEntries.map((item) => item.id === entry.id ? { ...item, approvedBy: actor, approvedAt: now } : item), activity: [{ id: uid('activity'), timestamp: now, actor, text: `Утверждён расход ${money(entry.amount)} · ${entry.description}`, tone: 'positive' }, ...state.activity] });
  };

  const openAction = (entry: FinanceEntry, kind: 'accept' | 'pay' | 'receive') => {
    const remaining = financeMoney(kind === 'accept' ? entry.amount - acceptedAmountFor(entry) : kind === 'pay' ? acceptedAmountFor(entry) - paidAmountFor(entry) : entry.amount - paidAmountFor(entry));
    setActionEntryId(entry.id);
    setSelectedEntryId(null);
    setActionError('');
    setActionKind(kind);
    setActionForm({ amount: String(Math.max(0, remaining)), date: financeToday(), document: '', source: expenseAcceptanceSources(state, entry)[0]?.id ?? '' });
  };

  const saveAction = (event: FormEvent) => {
    event.preventDefault();
    const entry = state.financeEntries.find((item) => item.id === actionEntryId);
    const amount = Number(actionForm.amount);
    if (!entry) return;
    const error = financeActionError(state, entry, actionKind, amount, actionForm.date, actionForm.document, actionForm.source);
    if (error) { setActionError(error); return; }
    const now = new Date().toISOString();
    let text = '';
    const financeEntries = state.financeEntries.map((item) => {
      if (item.id !== entry.id) return item;
      if (actionKind === 'accept') {
        const acceptedAmount = financeMoney(acceptedAmountFor(item) + amount);
        text = `${item.description}: принято ${money(amount)}`;
        return { ...item, status: 'accepted' as ExpenseStatus, acceptedAmount, acceptedAt: actionForm.date, acceptedBy: actor, acceptanceSource: actionForm.source, acceptanceDocument: actionForm.document.trim(), document: actionForm.document.trim() };
      }
      const paidAmount = financeMoney(paidAmountFor(item) + amount);
      text = `${item.description}: ${actionKind === 'receive' ? 'получено' : 'оплачено'} ${money(amount)}`;
      return { ...item, status: paidAmount >= item.amount ? 'paid' as ExpenseStatus : item.status, paidAmount, paidAt: actionForm.date, paidBy: actor, paymentDocument: actionForm.document.trim() };
    });
    const document: ProjectDocument | null = actionForm.document.trim() ? { id: uid('document'), name: actionForm.document.trim(), type: actionKind === 'accept' ? 'Акт / приёмка' : 'Платёжный документ', category: actionKind === 'accept' ? 'act' : 'other', documentDate: actionForm.date, updatedAt: now, clientVisible: false, status: 'current', direction: actionKind === 'accept' ? 'incoming' : 'outgoing', counterpartyId: entry.counterpartyId, stageId: entry.stageId, financeEntryId: entry.id, receivedAt: actionKind === 'accept' ? now : undefined, sentAt: actionKind === 'accept' ? undefined : now, storageLocation: `ИКИОМА ОС / ${state.project.code} / Финансы` } : null;
    saveChange({ ...state, financeEntries, documents: document ? [document, ...state.documents] : state.documents, activity: [{ id: uid('activity'), timestamp: now, actor, text, tone: actionKind === 'accept' ? 'neutral' : 'positive' }, ...state.activity] });
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
    saveChange({ ...state, budgetLines: state.budgetLines.map((item) => item.id === editingLineId ? { ...item, plan, forecast } : item), budgetMeta: { ...state.budgetMeta, version: lineForm.version.trim() || state.budgetMeta.version, source: lineForm.source.trim(), importedAt: new Date().toISOString() }, activity: [{ id: uid('activity'), timestamp: new Date().toISOString(), actor, text: `Обновлена статья сметы ${line?.name ?? ''}: план ${money(plan)}`, tone: 'neutral' }, ...state.activity] });
    setEditingLineId(null);
  };

  const tabs = [
    { id: 'operations', label: 'Операции' },
    { id: 'budget', label: 'Смета' },
    { id: 'calendar', label: 'Платёжный календарь' },
  ] as const;
  const openNew = (kind: 'expense' | 'income') => { setFormKind(kind); setFormError(''); setForm(current => ({ ...current, date: financeToday() })); setShowForm(true); };

  return (
    <div className="finance-page">
      <header className="finance-page__heading">
        <div><span className="finance-eyebrow">{state.project.name} · {state.project.code}</span><h1>Деньги</h1></div>
        <div className="finance-page__actions"><button type="button" className="button button--secondary" onClick={() => openNew('income')}><Plus size={17} /> Поступление</button><button type="button" data-tour="finance-add" className="button button--primary" onClick={() => openNew('expense')}><Plus size={17} /> Расход</button></div>
      </header>
      <section className="finance-money" aria-label="Денежная сводка проекта">
        <button type="button" onClick={() => setSummaryOpen('received')}><span>Поступило</span><strong>{shortMoney(totals.received)}</strong><small>Записанные поступления</small></button>
        <button type="button" onClick={() => setSummaryOpen('paid')}><span>Оплачено</span><strong>{shortMoney(totals.paid)}</strong><small>По учёту проекта</small></button>
        <button type="button" className="finance-money__available" onClick={() => setSummaryOpen('balance')}><span>Доступно на счетах</span><strong>—</strong><small>Нужна сверка остатков <ArrowUpRight size={15} /></small></button>
      </section>
      {unallocatedEntries.length > 0 && <button type="button" className="finance-attention" onClick={() => setShowUnallocated(true)}><span><strong>{unallocatedEntries.length} расходов без статьи</strong><span> · {money(unallocated.paid)} оплачено</span></span><span>Посмотреть <ArrowUpRight size={16} /></span></button>}
      <nav className="finance-tabs" role="tablist" aria-label="Разделы финансов" onKeyDown={event => {
        const current = tabs.findIndex(tab => tab.id === view);
        const next = event.key === 'ArrowRight' ? (current + 1) % tabs.length : event.key === 'ArrowLeft' ? (current + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
        if (next < 0) return;
        event.preventDefault(); setView(tabs[next].id);
        event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
      }}>{tabs.map(tab => <button key={tab.id} type="button" id={`finance-tab-${tab.id}`} role="tab" aria-selected={view === tab.id} tabIndex={view === tab.id ? 0 : -1} aria-controls={`finance-view-${tab.id}`} onClick={() => setView(tab.id)}>{tab.label}</button>)}</nav>
      <div id="finance-view-operations" role="tabpanel" aria-labelledby="finance-tab-operations" hidden={view !== 'operations'}><FinanceOperations state={state} onOpenEntry={setSelectedEntryId} /><CashflowPanel state={state} /></div>
      <div id="finance-view-budget" role="tabpanel" aria-labelledby="finance-tab-budget" hidden={view !== 'budget'}><FinanceBudgetPanel state={state} onChange={saveChange} onOpenLine={setSelectedLineId} onOpenUnallocated={() => setShowUnallocated(true)} onImport={() => setShowHistoryImport(true)} /></div>
      <div id="finance-view-calendar" role="tabpanel" aria-labelledby="finance-tab-calendar" hidden={view !== 'calendar'}><FinancePaymentCalendar state={state} actor={actor} onChange={saveChange} onOpenEntry={setSelectedEntryId} onAddEntry={openNew} /></div>
      <footer className="finance-page__footer"><button type="button" onClick={onOpenQuestions}>Как вести учёт</button><button type="button" onClick={() => setShowHistoryImport(true)}>Импорт прошлых оплат</button></footer>
      {showUnallocated && <FinanceDrawer title="Расходы без статьи" subtitle="Уже включены в общие суммы" onClose={() => setShowUnallocated(false)}><p className="finance-muted">Откройте расход, чтобы посмотреть его источник и связи со сметой.</p><div className="finance-linked-list">{unallocatedEntries.map(entry => <button type="button" key={entry.id} onClick={() => { setShowUnallocated(false); setSelectedEntryId(entry.id); }}><span><strong>{financeEntryTitle(entry)}</strong><small>{entry.counterparty}</small></span><strong>{money(paidAmountFor(entry))}<small>оплачено</small></strong></button>)}</div></FinanceDrawer>}

      {showForm && (
        <Modal title="Новая операция" subtitle="Сначала запишите договорённость. Фактическую оплату можно внести в её карточке." onClose={() => setShowForm(false)}>
          <form className="modal-form" onSubmit={addOperation}>{formError && <p role="alert" className="form-warning">{formError}</p>}
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
              <Field label="Сумма, ₽"><input required min="0.01" step="0.01" inputMode="decimal" type="number" value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} placeholder="350000" /></Field>
              <Field label="Статус"><div className="locked-field"><LockKeyhole size={15} /> Обязательство</div></Field>
            </div>
            </>}
            {formKind === 'income' && <div className="form-grid"><Field label="Сумма, ₽"><input required min="0.01" step="0.01" inputMode="decimal" type="number" value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} placeholder="1400000" /></Field><Field label="Статус"><div className="locked-field"><LockKeyhole size={15} /> Запланировано</div></Field></div>}
            <Field label="За что" hint="Короткое название покупки или поступления"><textarea required rows={3} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} placeholder="За что платим или какое поступление ожидаем" /></Field>
            <div className="form-grid"><Field label={formKind === 'expense' ? 'Контрагент' : 'Плательщик'} hint="Выбор из единого справочника"><select required value={form.counterpartyId} onChange={(event) => setForm({ ...form, counterpartyId: event.target.value })}><option value="">Выберите контрагента</option>{state.counterparties.filter((item) => item.status !== 'blocked').map((item) => <option value={item.id} key={item.id}>{item.name}{item.specialty ? ` · ${item.specialty}` : ''}</option>)}</select></Field><Field label="Дата"><input type="date" value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value })} /></Field></div>
            {formKind === 'expense' && <div className="form-warning"><ReceiptText size={18} /><span>После сохранения откройте расход: там доступны утверждение, приёмка и запись оплаты.</span></div>}
            <div className="modal__actions"><button className="button button--ghost" type="button" onClick={() => setShowForm(false)}>Отмена</button><button className="button button--primary" type="submit" disabled={!state.counterparties.length}><CircleDollarSign size={18} /> Сохранить договорённость</button></div>
          </form>
        </Modal>
      )}
      {showHistoryImport && <HistoryImport state={state} actor={actor} onSave={saveChange} onClose={() => setShowHistoryImport(false)} />}

      {summaryOpen && <FinanceDrawer title={summaryOpen === 'paid' ? 'Оплачено по проекту' : summaryOpen === 'received' ? 'Поступило в проект' : 'Доступные деньги'} subtitle="По записанным операциям" onClose={() => setSummaryOpen(null)}>
        {summaryOpen === 'balance' ? <><div className="finance-drawer__total"><span>Остаток на счетах</span><strong>Пока не установлен</strong></div><p className="finance-muted">Для доступного остатка нужно сверить счета, кассу и оплаты участников из своих средств.</p><dl className="finance-definition-list"><div><dt>Записано поступлений</dt><dd>{money(totals.received)}</dd></div><div><dt>Записано выплат</dt><dd>{money(totals.paid)}</dd></div><div><dt>Разность по учёту</dt><dd>{money(balance)}</dd></div></dl><p className="finance-inline-note">Эта разность не является подтверждённым остатком банка или долгом участнику.</p><details className="finance-disclosure"><summary>Прогноз экономики</summary><dl className="finance-definition-list"><div><dt>План затрат</dt><dd>{money(totals.plan)}</dd></div><div><dt>Расчётный прогноз</dt><dd>{money(totals.forecast)}</dd></div><div><dt>Цена договора − прогноз затрат</dt><dd>{money(margin)}</dd></div></dl><p className="finance-muted">Прогноз предварительный. Полнота стоимости достройки ещё не подтверждена.</p></details></> : <><div className="finance-drawer__total"><span>{summaryOpen === 'paid' ? 'Оплачено' : 'Получено'}</span><strong>{money(summaryOpen === 'paid' ? totals.paid : totals.received)}</strong></div><div className="finance-linked-list">{state.financeEntries.filter(entry => entry.kind === (summaryOpen === 'paid' ? 'expense' : 'income') && paidAmountFor(entry) > 0).map(entry => <button type="button" key={entry.id} onClick={() => { setSummaryOpen(null); setSelectedEntryId(entry.id); }}><span><strong>{financeEntryTitle(entry)}</strong><small>{entry.counterparty}</small></span><strong>{money(paidAmountFor(entry))}</strong></button>)}</div>{!(summaryOpen === 'paid' ? totals.paid : totals.received) && <p className="finance-muted">Записей пока нет.</p>}</>}
      </FinanceDrawer>}

      {selectedEntry && <FinanceDrawer title={financeEntryTitle(selectedEntry)} subtitle={selectedEntry.kind === 'expense' ? 'Расход' : 'Поступление'} onClose={() => setSelectedEntryId(null)}>
        <div className="finance-drawer__total"><span>{selectedEntry.kind === 'expense' ? 'Оплачено' : 'Получено'}</span><strong>{money(paidAmountFor(selectedEntry))}</strong><small>{selectedEntry.kind === 'expense' && paidAmountFor(selectedEntry) > 0 ? paymentEvidence(selectedEntry, state.documents).sourceLabel : ''}</small></div>
        <dl className="finance-definition-list"><div><dt>{selectedEntry.kind === 'expense' ? 'Получатель' : 'Плательщик'}</dt><dd>{selectedCounterparty ? <button type="button" onClick={() => { setSelectedEntryId(null); setCounterpartyId(selectedCounterparty.id); }}>{selectedEntry.counterparty} <ArrowUpRight size={14} /></button> : selectedEntry.counterparty}</dd></div><div><dt>Сумма договорённости</dt><dd>{money(selectedEntry.amount)}</dd></div>{paidAmountFor(selectedEntry) < selectedEntry.amount && <div><dt>{selectedEntry.kind === 'expense' ? 'Осталось оплатить' : 'Ожидается'}</dt><dd>{money(selectedEntry.amount - paidAmountFor(selectedEntry))}</dd></div>}<div><dt>Дата документа / записи</dt><dd>{formatDate(selectedEntry.date, true)}</dd></div>{!selectedEntry.payments?.length && <div><dt>Дата оплаты</dt><dd>{selectedEntry.paidAt ? formatDate(selectedEntry.paidAt, true) : 'Не установлена'}</dd></div>}</dl>
        {(needsExpenseApproval(selectedEntry) || selectedEntry.kind === 'expense' && !selectedEntry.historicalPayment && acceptedAmountFor(selectedEntry) < selectedEntry.amount || selectedEntry.kind === 'expense' && paidAmountFor(selectedEntry) < acceptedAmountFor(selectedEntry) || selectedEntry.kind === 'income' && paidAmountFor(selectedEntry) < selectedEntry.amount) && <section className="finance-next-action">
          {needsExpenseApproval(selectedEntry) ? <button type="button" className="button button--primary" onClick={() => approveExpense(selectedEntry)}>Утвердить расход</button> : selectedEntry.kind === 'income' ? <button type="button" className="button button--primary" onClick={() => openAction(selectedEntry, 'receive')}>Записать поступление</button> : paidAmountFor(selectedEntry) < acceptedAmountFor(selectedEntry) ? <button type="button" className="button button--primary" onClick={() => openAction(selectedEntry, 'pay')}>Записать оплату</button> : canAcceptEntry(selectedEntry) ? <button type="button" className="button button--primary" onClick={() => openAction(selectedEntry, 'accept')}>Зафиксировать приёмку</button> : <><p>Для записи приёмки сначала подтвердите работу или поставку.</p><button type="button" className="button button--secondary" onClick={() => { setSelectedEntryId(null); onNavigate(selectedEntry.procurementItemId ? 'procurement' : 'schedule', selectedEntry.procurementItemId ?? selectedEntry.stageId); }}>Открыть {selectedEntry.procurementItemId ? 'поставку' : 'этап'}</button></>}
          {selectedEntry.kind === 'expense' && !selectedEntry.historicalPayment
            && paidAmountFor(selectedEntry) < acceptedAmountFor(selectedEntry)
            && acceptedAmountFor(selectedEntry) < selectedEntry.amount && canAcceptEntry(selectedEntry)
            && <button type="button" className="button button--secondary" onClick={() => openAction(selectedEntry, 'accept')}>Принять ещё</button>}
        </section>}
        <details className="finance-disclosure"><summary>Документы и источник</summary><p className="finance-original-description">{selectedEntry.description}</p>{selectedEntry.document && <p className="finance-muted">{selectedEntry.document}</p>}{selectedEntry.kind === 'expense' && <PaymentEvidence entry={selectedEntry} documents={state.documents} />}{selectedEntry.historicalPayment && <><p className="finance-muted">{selectedEntry.historicalPayment.confirmation}</p><button type="button" className="button button--secondary" onClick={() => { setSelectedEntryId(null); onNavigate('project', selectedEntry.historicalPayment!.sourceDocumentId); }}>Открыть исходный документ</button></>}{!selectedEntry.historicalPayment && selectedEntry.paymentDocument && <p>{selectedEntry.paymentDocument}</p>}</details>
        <details className="finance-disclosure"><summary>История платежей</summary><PaymentHistory entry={selectedEntry} />{!paidAmountFor(selectedEntry) && <p className="finance-muted">Платежей пока нет.</p>}</details>
        <details className="finance-disclosure"><summary>Смета, этап и приёмка</summary><dl className="finance-definition-list"><div><dt>Статья</dt><dd>{state.budgetLines.find(line => line.id === selectedEntry.budgetLineId)?.name ?? 'Не распределено'}</dd></div><div><dt>Этап</dt><dd>{state.stages.find(stage => stage.id === selectedEntry.stageId)?.shortName ?? 'Не указан'}</dd></div>{selectedEntry.kind === 'expense' && <div><dt>Финансовая приёмка</dt><dd>{acceptedAmountFor(selectedEntry) ? money(acceptedAmountFor(selectedEntry)) : 'Не записана'}</dd></div>}</dl>{selectedEntry.createdBy && <p className="finance-muted">Добавил: {selectedEntry.createdBy}</p>}{selectedEntry.approvedBy && <p className="finance-muted">Утвердил: {selectedEntry.approvedBy}</p>}</details>
      </FinanceDrawer>}

      {selectedLine && <Modal wide title={selectedLine.name} subtitle="Статья сметы и все связанные обязательства." onClose={() => setSelectedLineId(null)}>{selectedLine.sourceRow && <section className="entity-detail-card"><small>Исходная смета · строка {selectedLine.sourceRow}</small>{selectedLine.outsideSourceTotal && <p>В файле: {money(selectedLine.sourcePlan ?? 0)}. Строка не включена в итог исходной формулы; её включение в бюджет требует решения.</p>}<p>Колонка «Факт»: {selectedLine.sourceFact === undefined ? "не заполнена" : money(selectedLine.sourceFact)}. Это значение для сверки, отдельно от реестра оплат.</p>{Object.entries(selectedLine.sourceParticipantAmounts ?? {}).filter(([, amount]) => amount !== null).map(([name, amount]) => <span key={name}>{name}: {money(amount!)} · из исходной таблицы</span>)}</section>}<div className="finance-drilldown"><div><small>План</small><strong>{money(selectedLine.plan)}</strong></div><div><small>Прогноз</small><strong>{money(lineForecast(state, selectedLine))}</strong></div><div><small>Обязательства</small><strong>{money(lineTotals(state, selectedLine).committed)}</strong></div><div><small>Принято</small><strong>{money(lineTotals(state, selectedLine).accepted)}</strong></div><div><small>Оплачено</small><strong>{money(lineTotals(state, selectedLine).paid)}</strong></div></div><div className="entity-related-list">{state.financeEntries.filter((entry) => entry.budgetLineId === selectedLine.id).map((entry) => <button type="button" key={entry.id} onClick={() => { setSelectedLineId(null); setSelectedEntryId(entry.id); }}><span><strong>{entry.description}</strong><small>{entry.counterparty} · {formatDate(entry.date, true)}</small></span><strong>{money(entry.amount)}</strong></button>)}{!state.financeEntries.some((entry) => entry.budgetLineId === selectedLine.id) && <div className="table-empty">По статье ещё нет обязательств и оплат.</div>}</div><div className="modal__actions"><button type="button" className="button button--secondary" onClick={() => openLineEdit(selectedLine)}>Изменить план и прогноз</button><button type="button" className="button button--primary" onClick={() => { setSelectedLineId(null); setFormKind('expense'); setFormError(''); setForm({ ...form, budgetLineId: selectedLine.id, stageId: selectedLine.stageIds[0], date: financeToday() }); setShowForm(true); }}>Добавить обязательство</button></div></Modal>}

      {counterpartyId && <CounterpartyModal state={state} counterpartyId={counterpartyId} onClose={() => setCounterpartyId(null)} onOpenFinanceEntry={(id) => { setCounterpartyId(null); setSelectedEntryId(id); }} />}

      {actionEntryId && (() => { const entry = state.financeEntries.find((item) => item.id === actionEntryId); if (!entry) return null; const title = actionKind === 'accept' ? 'Фактическая приёмка' : actionKind === 'pay' ? 'Фактическая оплата' : 'Фактическое поступление'; return <Modal title={title} subtitle={`${entry.description} · ${entry.counterparty}`} onClose={() => setActionEntryId(null)}><form className="modal-form" onSubmit={saveAction}>{actionError && <p role="alert" className="form-warning">{actionError}</p>}{actionKind === 'accept' && <Field label="Принятая работа или поставка" hint="Выберите конкретное основание, к которому относится эта сумма"><select required value={actionForm.source} onChange={(event) => setActionForm({ ...actionForm, source: event.target.value })}><option value="">Выберите основание</option>{expenseAcceptanceSources(state, entry).map((source) => <option key={source.id} value={source.id}>{source.label}</option>)}</select></Field>}<div className="finance-action-context"><div><small>Обязательство</small><strong>{money(entry.amount)}</strong></div><div><small>{actionKind === 'accept' ? 'Уже принято' : actionKind === 'receive' ? 'Уже получено' : 'Уже оплачено'}</small><strong>{money(actionKind === 'accept' ? acceptedAmountFor(entry) : paidAmountFor(entry))}</strong></div></div><div className="form-grid"><Field label="Фактическая сумма, ₽"><input required min="0.01" step="0.01" max={financeMoney(actionKind === 'accept' ? entry.amount - acceptedAmountFor(entry) : actionKind === 'pay' ? acceptedAmountFor(entry) - paidAmountFor(entry) : entry.amount - paidAmountFor(entry))} type="number" inputMode="numeric" value={actionForm.amount} onChange={(event) => setActionForm({ ...actionForm, amount: event.target.value })} /></Field><Field label="Фактическая дата"><input required type="date" value={actionForm.date} onChange={(event) => setActionForm({ ...actionForm, date: event.target.value })} /></Field></div><Field label={actionKind === 'accept' ? 'Акт / УПД / ТН' : 'Платёжное поручение / чек'} hint="Документ автоматически попадёт в историю контрагента"><input required value={actionForm.document} onChange={(event) => setActionForm({ ...actionForm, document: event.target.value })} placeholder={actionKind === 'accept' ? 'Акт №…' : 'Платёжное поручение №…'} /></Field><div className="modal__actions"><button type="button" className="button button--ghost" onClick={() => setActionEntryId(null)}>Отмена</button><button type="submit" className="button button--primary">Сохранить факт</button></div></form></Modal>; })()}

      {editingLineId && <Modal title="Изменить статью сметы" subtitle={state.budgetLines.find((item) => item.id === editingLineId)?.name} onClose={() => setEditingLineId(null)}><form className="modal-form" onSubmit={saveLine}><div className="form-grid"><Field label="План, ₽" hint="Утверждённая базовая сумма"><input required min="0" type="number" inputMode="numeric" value={lineForm.plan} onChange={(event) => setLineForm({ ...lineForm, plan: event.target.value })} /></Field><Field label="Прогноз, ₽" hint="Ожидаемый итог с учётом изменений"><input required min="0" type="number" inputMode="numeric" value={lineForm.forecast} onChange={(event) => setLineForm({ ...lineForm, forecast: event.target.value })} /></Field><Field label="Версия сметы"><input value={lineForm.version} onChange={(event) => setLineForm({ ...lineForm, version: event.target.value })} /></Field></div><Field label="Источник плана"><input required value={lineForm.source} onChange={(event) => setLineForm({ ...lineForm, source: event.target.value })} /></Field><div className="modal__actions"><button type="button" className="button button--ghost" onClick={() => setEditingLineId(null)}>Отмена</button><button type="submit" className="button button--primary">Сохранить статью</button></div></form></Modal>}
    </div>
  );
}
