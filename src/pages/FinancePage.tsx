import { budgetLineSnapshot } from '../domain/finance/index.js';
import { CashflowPanel } from '../components/CashflowPanel';
import { SchedulePage } from './SchedulePage';
import { TreasuryPanel } from '../components/TreasuryPanel';
import { useTreasury } from '../useTreasury';
import { treasuryProjection, treasuryCostSummary } from '../domain/treasury.js';
import { automaticSchedule } from '../domain/construction/index.js';
import { documentUploader } from '../infrastructure/document-upload';
import { FinanceAttachmentModal } from '../components/FinanceAttachmentModal';
import type { StateChangeSink } from '../application';
import { useFinance } from '../useFinance';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowUpRight,
  CircleDollarSign,
  LockKeyhole,
  Plus,
  ReceiptText,
} from 'lucide-react';
import { acceptedAmountFor, financeTotals, lineTotals, lineForecast, unallocatedExpenses, unallocatedExpenseTotals, paidAmountFor, financeMoney, needsExpenseApproval, expenseAcceptanceSources } from '../domain/index';
import { formatDate, money, shortMoney } from '../presentation/formatting';
import type { AppState, FinanceEntry, UserRole } from '../entities/index';
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

export function FinancePage({ state, actor, role, userId, focusId, onChange, onNavigate, onOpenQuestions }: { state: AppState; actor: string; role: UserRole; userId?: string; focusId?: string | null; onChange: StateChangeSink; onNavigate: (page: PageId, entityId?: string) => void; onOpenQuestions: () => void }) {
  const finance = useFinance(state, { name: actor, role }, onChange);
  const treasury = useTreasury(state, { name: actor, role, id: userId }, onChange);
  const cash = treasuryProjection(state, { today: financeToday(), horizonDays: 91 });
  const cost = treasuryCostSummary(state);
  const schedule = automaticSchedule(state, financeToday());
  const [approvalError, setApprovalError] = useState('');
  const totals = financeTotals(state);
  const margin = state.project.contractValue - totals.forecast;
  const unallocated = unallocatedExpenseTotals(state);
  const unallocatedEntries = unallocatedExpenses(state);
  const [showUnallocated, setShowUnallocated] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [showHistoryImport, setShowHistoryImport] = useState(false);
  const [formKind, setFormKind] = useState<'expense' | 'income'>('expense');
  const [view, setView] = useState<'payments' | 'schedule' | 'budget' | 'forecast'>(() => {
    try { const saved = localStorage.getItem(`ikioma-finance-view:${state.project.id}`); return saved === 'schedule' || saved === 'budget' || saved === 'forecast' ? saved : 'payments'; } catch { return 'payments'; }
  });
  const [paymentView, setPaymentView] = useState<'calendar' | 'operations'>('calendar');
  useEffect(() => { try { localStorage.setItem(`ikioma-finance-view:${state.project.id}`, view); } catch { /* Display preference is optional. */ } }, [state.project.id, view]);
  const [formError, setFormError] = useState('');
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [attachmentEntryId, setAttachmentEntryId] = useState<string | null>(null);
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null);
  const [counterpartyId, setCounterpartyId] = useState<string | null>(null);
  const [summaryOpen, setSummaryOpen] = useState<'paid' | 'received' | 'balance' | null>(null);
  const [actionEntryId, setActionEntryId] = useState<string | null>(null);
  const [actionKind, setActionKind] = useState<'accept' | 'pay' | 'receive'>('accept');
  const [actionForm, setActionForm] = useState({ amount: '', date: financeToday(), document: '', source: '' });
  const [actionError, setActionError] = useState('');
  const [actionFile, setActionFile] = useState<File | null>(null);
  const [actionDocumentId, setActionDocumentId] = useState('');
  const [actionUploadedFile, setActionUploadedFile] = useState<Awaited<ReturnType<typeof documentUploader.upload>> | undefined>();
  const [actionSaving, setActionSaving] = useState(false);
  const actionUploadController = useRef<AbortController | null>(null);
  const actionBusy = useRef(false);
  useEffect(() => () => actionUploadController.current?.abort(), [state.project.id]);
  const [editingLineId, setEditingLineId] = useState<string | null>(null);
  const [lineError, setLineError] = useState('');
  const [lineForm, setLineForm] = useState({ plan: '', forecast: '', version: state.budgetMeta.version, source: state.budgetMeta.source, expected: '' });
  const firstLine = state.budgetLines[0];
  const [form, setForm] = useState({
    budgetLineId: firstLine?.id ?? '',
    stageId: firstLine?.stageIds[0] ?? '',
    amount: '',
    counterpartyId: '',
    description: '',
    date: financeToday(),
  });
  useEffect(() => { setApprovalError(''); }, [selectedEntryId]);
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
    const result = finance.createCommitment({
      kind: formKind, amount: Number(form.amount), date: form.date,
      counterpartyId: form.counterpartyId, description: form.description,
      budgetLineId: formKind === 'expense' ? form.budgetLineId : undefined,
      stageId: formKind === 'expense' ? form.stageId : undefined,
    });
    if (!result.ok) { setFormError(result.error); return; }
    setShowForm(false);
    setSelectedEntryId(result.entryId);
    setForm({ ...form, amount: '', counterpartyId: '', description: '' });
  };

  const selectedEntry = state.financeEntries.find((entry) => entry.id === selectedEntryId) ?? null;
  const selectedCounterparty = state.counterparties.find(item => item.id === selectedEntry?.counterpartyId);
  const selectedLine = state.budgetLines.find((line) => line.id === selectedLineId) ?? null;
  const balance = totals.received - totals.paid;

  const canAcceptEntry = (entry: FinanceEntry) => !needsExpenseApproval(entry) && expenseAcceptanceSources(state, entry).length > 0;
  const approveExpense = (entry: FinanceEntry) => {
    const result = finance.approveExpense(entry.id);
    setApprovalError(result.ok ? '' : result.error);
  };

  const openAction = (entry: FinanceEntry, kind: 'accept' | 'pay' | 'receive') => {
    const remaining = financeMoney(kind === 'accept' ? entry.amount - acceptedAmountFor(entry) : entry.amount - paidAmountFor(entry));
    setActionEntryId(entry.id);
    setSelectedEntryId(null);
    setActionError('');
    setActionKind(kind);
    setActionFile(null); setActionUploadedFile(undefined); setActionDocumentId('');
    setActionForm({ amount: String(Math.max(0, remaining)), date: financeToday(), document: '', source: expenseAcceptanceSources(state, entry)[0]?.id ?? '' });
  };

  const saveAction = async (event: FormEvent) => {
    event.preventDefault();
    if (!actionEntryId || actionBusy.current) return;
    actionBusy.current = true;
    setActionSaving(true); setActionError('');
    try {
      let uploadedFile = actionUploadedFile;
      if (actionFile && actionFile.size > 20 * 1024 * 1024) throw new Error('Файл больше 20 МБ.');
      if (actionFile && !uploadedFile) {
        const controller = new AbortController(); actionUploadController.current = controller;
        uploadedFile = await documentUploader.upload(state.project.id, actionFile, controller.signal);
        if (controller.signal.aborted) return;
        setActionUploadedFile(uploadedFile);
      }
      const input = { entryId: actionEntryId, amount: Number(actionForm.amount), date: actionForm.date, document: actionForm.document, source: actionForm.source, uploadedFile, documentId: actionDocumentId || undefined };
      const result = actionKind === 'accept' ? finance.acceptExpense(input)
        : actionKind === 'pay' ? finance.recordPayment(input) : finance.recordReceipt(input);
      if (!result.ok) { setActionError(result.error); return; }
      setActionEntryId(null);
    } catch (error) { setActionError(error instanceof Error ? error.message : 'Не удалось загрузить документ. Попробуйте ещё раз.'); }
    finally { actionBusy.current = false; setActionSaving(false); actionUploadController.current = null; }
  };

  const openLineEdit = (line: AppState['budgetLines'][number]) => {
    setSelectedLineId(null);
    setEditingLineId(line.id);
    setLineError('');
    setLineForm({ plan: String(line.plan), forecast: String(line.forecast), version: state.budgetMeta.version, source: state.budgetMeta.source, expected: budgetLineSnapshot(state, line.id) });
  };

  const saveLine = (event: FormEvent) => {
    event.preventDefault();
    if (!editingLineId) return;
    const result = finance.updateBudgetLine({ ...lineForm, lineId: editingLineId, plan: Number(lineForm.plan), forecast: Number(lineForm.forecast) });
    if (!result.ok) { setLineError(result.error); return; }
    setEditingLineId(null);
  };

  const tabs = [
    { id: 'payments', label: 'Платежи' },
    { id: 'schedule', label: 'План работ' },
    { id: 'budget', label: 'Бюджет' },
    { id: 'forecast', label: 'Прогноз' },
  ] as const;
  const openNew = (kind: 'expense' | 'income') => {
    setFormKind(kind);
    setFormError('');
    setForm(current => {
      const line = state.budgetLines.find(item => item.id === current.budgetLineId) ?? firstLine;
      return { ...current, date: financeToday(), budgetLineId: line?.id ?? '', stageId: line?.stageIds.includes(current.stageId) ? current.stageId : line?.stageIds[0] ?? '' };
    });
    setShowForm(true);
  };

  return (
    <div className="finance-page">
      <header className="finance-page__heading">
        <div><span className="finance-eyebrow">{state.project.name} · {state.project.code}</span><h1>Финансы</h1></div>
        <div className="finance-page__actions"><button type="button" className="button button--secondary" onClick={() => openNew('income')}><Plus size={17} /> Поступление</button><button type="button" data-tour="finance-add" className="button button--primary" onClick={() => openNew('expense')}><Plus size={17} /> Расход</button></div>
      </header>
      <section className="finance-money finance-money--workspace" aria-label="Деньги и сроки проекта">
        <button type="button" className="finance-money__available" onClick={() => setSummaryOpen('balance')}><span>Доступно проекту</span><strong>{cash.openingCents === null ? 'Нет данных' : shortMoney(cash.openingCents / 100)}</strong><small>{cash.openingKnown ? 'На дату среза · доля проекта' : 'Нужны остатки и сверка'} <ArrowUpRight size={14} /></small></button>
        <button type="button" onClick={() => setView('forecast')}><span>Ближайший дефицит</span><strong>{cash.firstDeficitDate ? formatDate(cash.firstDeficitDate) : cash.completeness && cash.openingKnown ? 'Не ожидается' : 'Не определён'}</strong><small>{cash.peakFundingCents ? `Пик потребности ${money(cash.peakFundingCents / 100)}` : 'Прогноз на 13 недель'}</small></button>
        <button type="button" onClick={() => setView('budget')}><span>Стоимость завершённого объекта</span><strong>{cost.eacCents === null ? 'Нет оценки' : shortMoney(cost.eacCents / 100)}</strong><small>{cost.complete ? `К бюджету ${money((cost.varianceCents ?? 0) / 100)}` : 'Оценка достройки неполная'}</small></button>
        <button type="button" onClick={() => setView('schedule')}><span>Прогноз завершения ППР</span><strong>{schedule.kind === 'observed' ? 'Нужны сроки' : schedule.end ? formatDate(schedule.end) : 'Нет прогноза'}</strong><small>{schedule.kind === 'observed' || schedule.baselineShift === null ? 'Отклонение пока не определено' : `${schedule.baselineShift > 0 ? '+' : ''}${schedule.baselineShift} дн. к исходному ППР`}</small></button>
      </section>
      {unallocatedEntries.length > 0 && <button type="button" className="finance-attention" onClick={() => setShowUnallocated(true)}><span><strong>{unallocatedEntries.length} расходов без статьи</strong><span> · {money(unallocated.paid)} оплачено</span></span><span>Посмотреть <ArrowUpRight size={16} /></span></button>}
      <nav className="finance-tabs" role="tablist" aria-label="Разделы финансов" onKeyDown={event => {
        const current = tabs.findIndex(tab => tab.id === view);
        const next = event.key === 'ArrowRight' ? (current + 1) % tabs.length : event.key === 'ArrowLeft' ? (current + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
        if (next < 0) return;
        event.preventDefault(); setView(tabs[next].id);
        event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
      }}>{tabs.map(tab => <button key={tab.id} type="button" id={`finance-tab-${tab.id}`} role="tab" aria-selected={view === tab.id} tabIndex={view === tab.id ? 0 : -1} aria-controls={`finance-view-${tab.id}`} onClick={() => setView(tab.id)}>{tab.label}</button>)}</nav>
      <div id="finance-view-payments" role="tabpanel" aria-labelledby="finance-tab-payments" hidden={view !== 'payments'}>
        <div className="finance-workspace-toolbar"><div><h2>Платежи проекта</h2><p>Планируемые суммы и записанные оплаты</p></div><div className="finance-segments" aria-label="Вид платежей"><button type="button" aria-pressed={paymentView === 'calendar'} onClick={() => setPaymentView('calendar')}>Календарь</button><button type="button" aria-pressed={paymentView === 'operations'} onClick={() => setPaymentView('operations')}>Реестр</button></div></div>
        <div hidden={paymentView !== 'calendar'}>{state.treasury?.enabled ? <><TreasuryPanel mode="payments" state={state} role={role} snapshot={treasury.snapshot} onSave={treasury.save} onOpenEntry={setSelectedEntryId} /><details className="finance-disclosure"><summary>Сроки обязательств</summary><FinancePaymentCalendar state={state} onSetDueDate={finance.setDueDate} onOpenEntry={setSelectedEntryId} onAddEntry={openNew} /></details></> : <FinancePaymentCalendar state={state} onSetDueDate={finance.setDueDate} onOpenEntry={setSelectedEntryId} onAddEntry={openNew} />}</div>
        <div hidden={paymentView !== 'operations'}><div className="finance-ledger-totals"><button type="button" onClick={() => setSummaryOpen('received')}>Поступило <strong>{money(totals.received)}</strong></button><button type="button" onClick={() => setSummaryOpen('paid')}>Оплачено <strong>{money(totals.paid)}</strong></button></div><FinanceOperations state={state} onOpenEntry={setSelectedEntryId} /><CashflowPanel state={state} /></div>
      </div>
      <div id="finance-view-schedule" role="tabpanel" aria-labelledby="finance-tab-schedule" hidden={view !== 'schedule'}>{view === 'schedule' && <SchedulePage state={state} role={role} actor={actor} userId={userId} onChange={onChange} embedded onOpenFinance={setSelectedEntryId} onOpenTask={id => onNavigate('tasks', id)} />}</div>
      <div id="finance-view-budget" role="tabpanel" aria-labelledby="finance-tab-budget" hidden={view !== 'budget'}><FinanceBudgetPanel state={state} onClassify={finance.classifyCosts} onOpenLine={setSelectedLineId} onOpenUnallocated={() => setShowUnallocated(true)} onImport={() => setShowHistoryImport(true)} /></div>
      <div id="finance-view-forecast" role="tabpanel" aria-labelledby="finance-tab-forecast" hidden={view !== 'forecast'}><TreasuryPanel state={state} role={role} snapshot={treasury.snapshot} onSave={treasury.save} onOpenEntry={setSelectedEntryId} /></div>
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
            <Field label="За что" hint="Короткое название покупки или поступления"><textarea required maxLength={500} rows={3} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} placeholder="За что платим или какое поступление ожидаем" /></Field>
            <div className="form-grid"><Field label={formKind === 'expense' ? 'Контрагент' : 'Плательщик'} hint="Выбор из единого справочника"><select required value={form.counterpartyId} onChange={(event) => setForm({ ...form, counterpartyId: event.target.value })}><option value="">Выберите контрагента</option>{state.counterparties.filter((item) => item.status !== 'blocked').map((item) => <option value={item.id} key={item.id}>{item.name}{item.specialty ? ` · ${item.specialty}` : ''}</option>)}</select></Field><Field label="Дата"><input type="date" value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value })} /></Field></div>
            {formKind === 'expense' && <div className="form-warning"><ReceiptText size={18} /><span>После сохранения откройте расход: там доступны утверждение, приёмка и запись оплаты.</span></div>}
            <div className="modal__actions"><button className="button button--ghost" type="button" onClick={() => setShowForm(false)}>Отмена</button><button className="button button--primary" type="submit" disabled={!state.counterparties.length}><CircleDollarSign size={18} /> Сохранить договорённость</button></div>
          </form>
        </Modal>
      )}
      {showHistoryImport && <HistoryImport state={state} onImport={finance.importHistory} onClose={() => setShowHistoryImport(false)} />}

      {summaryOpen && <FinanceDrawer title={summaryOpen === 'paid' ? 'Оплачено по проекту' : summaryOpen === 'received' ? 'Поступило в проект' : 'Доступные деньги'} subtitle="По записанным операциям" onClose={() => setSummaryOpen(null)}>
        {summaryOpen === 'balance' ? <><div className="finance-drawer__total"><span>Остаток на счетах</span><strong>{cash.openingCents === null ? 'Пока не установлен' : money(cash.openingCents / 100)}</strong></div><p className="finance-muted">{cash.openingKnown ? 'Средства, отнесённые к проекту, с учётом заданных счетов и ограничений.' : 'Для доступного остатка нужно сверить счета, кассу и оплаты участников из своих средств.'}</p><button type="button" className="button button--secondary" onClick={() => { setSummaryOpen(null); setView('forecast'); }}>Открыть остатки и прогноз</button><dl className="finance-definition-list"><div><dt>Записано поступлений</dt><dd>{money(totals.received)}</dd></div><div><dt>Записано выплат</dt><dd>{money(totals.paid)}</dd></div><div><dt>Разность по учёту</dt><dd>{money(balance)}</dd></div></dl><p className="finance-inline-note">Эта разность не является подтверждённым остатком банка или долгом участнику.</p><details className="finance-disclosure"><summary>Прогноз экономики</summary><dl className="finance-definition-list"><div><dt>План затрат</dt><dd>{money(totals.plan)}</dd></div><div><dt>Расчётный прогноз</dt><dd>{money(totals.forecast)}</dd></div><div><dt>Цена договора − прогноз затрат</dt><dd>{money(margin)}</dd></div></dl><p className="finance-muted">Прогноз предварительный. Полнота стоимости достройки ещё не подтверждена.</p></details></> : <><div className="finance-drawer__total"><span>{summaryOpen === 'paid' ? 'Оплачено' : 'Получено'}</span><strong>{money(summaryOpen === 'paid' ? totals.paid : totals.received)}</strong></div><div className="finance-linked-list">{state.financeEntries.filter(entry => entry.kind === (summaryOpen === 'paid' ? 'expense' : 'income') && paidAmountFor(entry) > 0).map(entry => <button type="button" key={entry.id} onClick={() => { setSummaryOpen(null); setSelectedEntryId(entry.id); }}><span><strong>{financeEntryTitle(entry)}</strong><small>{entry.counterparty}</small></span><strong>{money(paidAmountFor(entry))}</strong></button>)}</div>{!(summaryOpen === 'paid' ? totals.paid : totals.received) && <p className="finance-muted">Записей пока нет.</p>}</>}
      </FinanceDrawer>}

      {selectedEntry && !attachmentEntryId && <FinanceDrawer title={financeEntryTitle(selectedEntry)} subtitle={selectedEntry.kind === 'expense' ? 'Расход' : 'Поступление'} onClose={() => setSelectedEntryId(null)}>
        {approvalError && <p role="alert" className="form-warning">{approvalError}</p>}
        <div className="finance-drawer__total"><span>{selectedEntry.kind === 'expense' ? 'Оплачено' : 'Получено'}</span><strong>{money(paidAmountFor(selectedEntry))}</strong><small>{selectedEntry.kind === 'expense' && paidAmountFor(selectedEntry) > 0 ? paymentEvidence(selectedEntry, state.documents).sourceLabel : ''}</small></div>
        <dl className="finance-definition-list"><div><dt>{selectedEntry.kind === 'expense' ? 'Получатель' : 'Плательщик'}</dt><dd>{selectedCounterparty ? <button type="button" onClick={() => { setSelectedEntryId(null); setCounterpartyId(selectedCounterparty.id); }}>{selectedEntry.counterparty} <ArrowUpRight size={14} /></button> : selectedEntry.counterparty}</dd></div><div><dt>Сумма договорённости</dt><dd>{money(selectedEntry.amount)}</dd></div>{paidAmountFor(selectedEntry) < selectedEntry.amount && <div><dt>{selectedEntry.kind === 'expense' ? 'Осталось оплатить' : 'Ожидается'}</dt><dd>{money(selectedEntry.amount - paidAmountFor(selectedEntry))}</dd></div>}<div><dt>Дата документа / записи</dt><dd>{formatDate(selectedEntry.date, true)}</dd></div>{!selectedEntry.payments?.length && <div><dt>Дата оплаты</dt><dd>{selectedEntry.paidAt ? formatDate(selectedEntry.paidAt, true) : 'Не установлена'}</dd></div>}</dl>
        {(needsExpenseApproval(selectedEntry) || selectedEntry.kind === 'expense' && !selectedEntry.historicalPayment && acceptedAmountFor(selectedEntry) < selectedEntry.amount || selectedEntry.kind === 'expense' && paidAmountFor(selectedEntry) < selectedEntry.amount || selectedEntry.kind === 'income' && paidAmountFor(selectedEntry) < selectedEntry.amount) && <section className="finance-next-action">
          {needsExpenseApproval(selectedEntry) ? <button type="button" className="button button--primary" onClick={() => approveExpense(selectedEntry)}>Утвердить расход</button> : selectedEntry.kind === 'income' ? <button type="button" className="button button--primary" onClick={() => openAction(selectedEntry, 'receive')}>Записать поступление</button> : paidAmountFor(selectedEntry) < selectedEntry.amount ? <button type="button" className="button button--primary" onClick={() => openAction(selectedEntry, 'pay')}>Записать оплату</button> : canAcceptEntry(selectedEntry) ? <button type="button" className="button button--primary" onClick={() => openAction(selectedEntry, 'accept')}>Зафиксировать приёмку</button> : <><p>Для записи приёмки сначала подтвердите работу или поставку.</p><button type="button" className="button button--secondary" onClick={() => { setSelectedEntryId(null); onNavigate(selectedEntry.procurementItemId ? 'procurement' : 'schedule', selectedEntry.procurementItemId ?? selectedEntry.stageId); }}>Открыть {selectedEntry.procurementItemId ? 'поставку' : 'этап'}</button></>}
          {selectedEntry.kind === 'expense' && !selectedEntry.historicalPayment
            && paidAmountFor(selectedEntry) < selectedEntry.amount
            && acceptedAmountFor(selectedEntry) < selectedEntry.amount && canAcceptEntry(selectedEntry)
            && <button type="button" className="button button--secondary" onClick={() => openAction(selectedEntry, 'accept')}>Принять ещё</button>}
        </section>}
        <button type="button" className="button button--secondary" onClick={() => setAttachmentEntryId(selectedEntry.id)}><ReceiptText size={16} /> Прикрепить счёт</button><details className="finance-disclosure"><summary>Документы и источник</summary><p className="finance-original-description">{selectedEntry.description}</p>{selectedEntry.document && <p className="finance-muted">{selectedEntry.document}</p>}{selectedEntry.kind === 'expense' && <PaymentEvidence entry={selectedEntry} documents={state.documents} />}{selectedEntry.historicalPayment && <><p className="finance-muted">{selectedEntry.historicalPayment.confirmation}</p><button type="button" className="button button--secondary" onClick={() => { setSelectedEntryId(null); onNavigate('project', selectedEntry.historicalPayment!.sourceDocumentId); }}>Открыть исходный документ</button></>}{!selectedEntry.historicalPayment && selectedEntry.paymentDocument && <p>{selectedEntry.paymentDocument}</p>}<div className="finance-linked-list">{state.documents.filter(document => document.fileKey && (document.financeEntryId === selectedEntry.id || document.id === selectedEntry.paymentDocumentId || document.id === selectedEntry.acceptanceDocumentId || selectedEntry.payments?.some(payment => payment.documentId === document.id))).map(document => <button type="button" key={document.id} onClick={() => { setSelectedEntryId(null); onNavigate('project', document.id); }}><span><strong>{document.name}</strong><small>Оригинал документа · {document.fileName}</small></span><ArrowUpRight size={16} /></button>)}</div></details>
        <details className="finance-disclosure"><summary>История платежей</summary><PaymentHistory entry={selectedEntry} />{!paidAmountFor(selectedEntry) && <p className="finance-muted">Платежей пока нет.</p>}</details>
        <details className="finance-disclosure"><summary>Смета, этап и приёмка</summary><dl className="finance-definition-list"><div><dt>Статья</dt><dd>{state.budgetLines.find(line => line.id === selectedEntry.budgetLineId)?.name ?? 'Не распределено'}</dd></div><div><dt>Этап</dt><dd>{state.stages.find(stage => stage.id === selectedEntry.stageId)?.shortName ?? 'Не указан'}</dd></div>{selectedEntry.kind === 'expense' && <div><dt>Финансовая приёмка</dt><dd>{acceptedAmountFor(selectedEntry) ? money(acceptedAmountFor(selectedEntry)) : 'Не записана'}</dd></div>}</dl>{selectedEntry.createdBy && <p className="finance-muted">Добавил: {selectedEntry.createdBy}</p>}{selectedEntry.approvedBy && <p className="finance-muted">Утвердил: {selectedEntry.approvedBy}</p>}</details>
      </FinanceDrawer>}

      {selectedLine && <Modal wide title={selectedLine.name} subtitle="Статья сметы и все связанные обязательства." onClose={() => setSelectedLineId(null)}>{selectedLine.sourceRow && <section className="entity-detail-card"><small>Исходная смета · строка {selectedLine.sourceRow}</small>{selectedLine.outsideSourceTotal && <p>В файле: {money(selectedLine.sourcePlan ?? 0)}. Строка не включена в итог исходной формулы; её включение в бюджет требует решения.</p>}<p>Колонка «Факт»: {selectedLine.sourceFact === undefined ? "не заполнена" : money(selectedLine.sourceFact)}. Это значение для сверки, отдельно от реестра оплат.</p>{Object.entries(selectedLine.sourceParticipantAmounts ?? {}).filter(([, amount]) => amount !== null).map(([name, amount]) => <span key={name}>{name}: {money(amount!)} · из исходной таблицы</span>)}</section>}<div className="finance-drilldown"><div><small>План</small><strong>{money(selectedLine.plan)}</strong></div><div><small>Прогноз</small><strong>{money(lineForecast(state, selectedLine))}</strong></div><div><small>Обязательства</small><strong>{money(lineTotals(state, selectedLine).committed)}</strong></div><div><small>Принято</small><strong>{money(lineTotals(state, selectedLine).accepted)}</strong></div><div><small>Оплачено</small><strong>{money(lineTotals(state, selectedLine).paid)}</strong></div></div><div className="entity-related-list">{state.financeEntries.filter((entry) => entry.budgetLineId === selectedLine.id).map((entry) => <button type="button" key={entry.id} onClick={() => { setSelectedLineId(null); setSelectedEntryId(entry.id); }}><span><strong>{entry.description}</strong><small>{entry.counterparty} · {formatDate(entry.date, true)}</small></span><strong>{money(entry.amount)}</strong></button>)}{!state.financeEntries.some((entry) => entry.budgetLineId === selectedLine.id) && <div className="table-empty">По статье ещё нет обязательств и оплат.</div>}</div><div className="modal__actions"><button type="button" className="button button--secondary" onClick={() => openLineEdit(selectedLine)}>Изменить план и прогноз</button><button type="button" className="button button--primary" onClick={() => { setSelectedLineId(null); setFormKind('expense'); setFormError(''); setForm({ ...form, budgetLineId: selectedLine.id, stageId: selectedLine.stageIds[0], date: financeToday() }); setShowForm(true); }}>Добавить обязательство</button></div></Modal>}

      {counterpartyId && <CounterpartyModal state={state} counterpartyId={counterpartyId} onClose={() => setCounterpartyId(null)} onOpenFinanceEntry={(id) => { setCounterpartyId(null); setSelectedEntryId(id); }} />}

      {attachmentEntryId && state.financeEntries.find(entry => entry.id === attachmentEntryId) && <FinanceAttachmentModal state={state} entry={state.financeEntries.find(entry => entry.id === attachmentEntryId)!} onAttach={finance.attachDocument} onClose={() => setAttachmentEntryId(null)} />}

      {actionEntryId && (() => {
        const entry = state.financeEntries.find(item => item.id === actionEntryId);
        if (!entry) return null;
        const title = actionKind === 'accept' ? 'Фактическая приёмка' : actionKind === 'pay' ? 'Записать оплату' : 'Записать поступление';
        const documents = state.documents.filter(document => document.fileKey && !document.clientVisible && (document.financeEntryId === entry.id || document.counterpartyId === entry.counterpartyId));
        const close = () => { actionUploadController.current?.abort(); setActionEntryId(null); };
        return <Modal title={title} subtitle={`${financeEntryTitle(entry)} · ${entry.counterparty}`} onClose={close}><form className="modal-form" onSubmit={saveAction}>
          {actionError && <p role="alert" className="form-warning">{actionError}</p>}
          <fieldset className="finance-action-fields" disabled={actionSaving}>
            {actionKind === 'accept' && <Field label="Принятая работа или поставка" hint="Выберите конкретное основание, к которому относится эта сумма"><select required value={actionForm.source} onChange={event => setActionForm({ ...actionForm, source: event.target.value })}><option value="">Выберите основание</option>{expenseAcceptanceSources(state, entry).map(source => <option key={source.id} value={source.id}>{source.label}</option>)}</select></Field>}
            <div className="finance-action-context"><div><small>Обязательство</small><strong>{money(entry.amount)}</strong></div><div><small>{actionKind === 'accept' ? 'Уже принято' : actionKind === 'receive' ? 'Уже получено' : 'Уже оплачено'}</small><strong>{money(actionKind === 'accept' ? acceptedAmountFor(entry) : paidAmountFor(entry))}</strong></div></div>
            <div className="form-grid"><Field label="Фактическая сумма, ₽"><input required min="0.01" step="0.01" max={financeMoney(actionKind === 'accept' ? entry.amount - acceptedAmountFor(entry) : entry.amount - paidAmountFor(entry))} type="number" inputMode="decimal" value={actionForm.amount} onChange={event => setActionForm({ ...actionForm, amount: event.target.value })} /></Field><Field label="Фактическая дата"><input required type="date" max={financeToday()} value={actionForm.date} onChange={event => setActionForm({ ...actionForm, date: event.target.value })} /></Field></div>
            {actionKind === 'pay' && acceptedAmountFor(entry) < paidAmountFor(entry) + Number(actionForm.amount || 0) && <p className="finance-inline-note">Оплата включает аванс. Выполнение и приёмка работ от этого не изменятся.</p>}
            <Field label={actionKind === 'accept' ? 'Акт / УПД / ТН или основание' : 'ПП / чек или основание оплаты'} hint="Если файла пока нет, запись сохранится как текстовое основание."><input required value={actionForm.document} onChange={event => setActionForm({ ...actionForm, document: event.target.value })} placeholder={actionKind === 'accept' ? 'Акт №…' : 'Платёжное поручение №… / подтверждение ответственного'} /></Field>
            <Field label="Приложить оригинал" hint="PDF, изображения или офисный документ · до 20 МБ"><input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.heic,.doc,.docx,.xls,.xlsx,.csv,.txt" onChange={event => { const file = event.target.files?.[0] ?? null; setActionFile(file); setActionUploadedFile(undefined); setActionDocumentId(''); if (file && !actionForm.document.trim()) setActionForm({ ...actionForm, document: file.name }); }} /></Field>
            {documents.length > 0 && <Field label="Или выбрать загруженный документ"><select value={actionDocumentId} onChange={event => { setActionDocumentId(event.target.value); setActionFile(null); setActionUploadedFile(undefined); const document = documents.find(item => item.id === event.target.value); if (document) setActionForm({ ...actionForm, document: document.name }); }}><option value="">Не выбран</option>{documents.map(document => <option key={document.id} value={document.id}>{document.name}</option>)}</select></Field>}
          </fieldset>
          {actionSaving && <p role="status" className="finance-muted">{actionFile && !actionUploadedFile ? 'Загружаем оригинал документа…' : 'Сохраняем запись…'}</p>}
          {actionUploadedFile && !actionSaving && <p className="finance-muted">Файл загружен. При повторном сохранении новая копия не создаётся.</p>}
          <div className="modal__actions"><button type="button" className="button button--ghost" onClick={close}>{actionSaving ? 'Отменить' : 'Закрыть'}</button><button type="submit" className="button button--primary" disabled={actionSaving}>{actionSaving ? 'Сохраняем…' : 'Сохранить факт'}</button></div>
        </form></Modal>;
      })()}


      {editingLineId && <Modal title="Изменить статью сметы" subtitle={state.budgetLines.find((item) => item.id === editingLineId)?.name} onClose={() => setEditingLineId(null)}><form className="modal-form" onSubmit={saveLine}>{lineError && <p role="alert" className="form-warning">{lineError}</p>}<div className="form-grid"><Field label="План, ₽" hint="Утверждённая базовая сумма"><input required min="0" step="0.01" type="number" inputMode="decimal" value={lineForm.plan} onChange={(event) => setLineForm({ ...lineForm, plan: event.target.value })} /></Field><Field label="Прогноз, ₽" hint="Ожидаемый итог с учётом изменений"><input required min="0" step="0.01" type="number" inputMode="decimal" value={lineForm.forecast} onChange={(event) => setLineForm({ ...lineForm, forecast: event.target.value })} /></Field><Field label="Версия сметы"><input value={lineForm.version} onChange={(event) => setLineForm({ ...lineForm, version: event.target.value })} /></Field></div><Field label="Источник плана"><input required value={lineForm.source} onChange={(event) => setLineForm({ ...lineForm, source: event.target.value })} /></Field><div className="modal__actions"><button type="button" className="button button--ghost" onClick={() => setEditingLineId(null)}>Отмена</button><button type="submit" className="button button--primary">Сохранить статью</button></div></form></Modal>}
    </div>
  );
}
