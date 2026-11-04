import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AppState, UserRole } from '../entities/index';
import type { RemoteProjectSnapshot } from '../application/ports';
import type { SharedPaymentInput, SharedPaymentProjectOption, SharedPaymentRecord, SharedPaymentWorkspace } from '../entities/index';
import { fetchSharedPayments, recordSharedPayment, SharedPaymentApiError, type SharedPaymentSaved } from '../infrastructure/shared-payment';
import { sharedPaymentBankKey, sharedPaymentDocumentKey, sharedPaymentInputError } from '../domain/shared-payment.js';
import { parseBankMoney } from '../domain/banking/statement';
import { financeToday } from '../presentation/finance-view';
import { money } from '../presentation/formatting';
import { Field, Modal } from './Ui';
import './shared-payment.css';

interface Props { state: AppState; role: UserRole; onServerSnapshot?: (snapshot: RemoteProjectSnapshot) => void }
interface SplitRow { id: string; projectId: string; entryId: string; trancheId: string; retentionId: string; amount: string }
const rowFor = (projectId: string): SplitRow => ({ id: crypto.randomUUID(), projectId, entryId: '', trancheId: '', retentionId: '', amount: '' });
const display = (cents: number | null) => cents === null ? 'Проверьте сумму' : money(cents / 100);
const groupKey = (legalEntityId: string, sharedAccountKey: string) => JSON.stringify([legalEntityId, sharedAccountKey]);

export function SharedPaymentPanel({ state, role, onServerSnapshot }: Props) {
  const [open, setOpen] = useState(false);
  useEffect(() => { setOpen(false); }, [state.project.id]);
  if (role !== 'management') return null;
  const shares = state.financeLedger?.operations.filter(operation => operation.sharedPaymentId) ?? [];
  return <section className="shared-payment-panel" aria-label="Общие платежи по заказам">
    <div><h3>Один платёж по нескольким заказам</h3><p>Запишите реальный платёж один раз и укажите долю каждого заказа. В расчётах каждого заказа учитывается только его доля.</p>
      {shares.length > 0 && <small>В этом заказе зарегистрировано долей: {shares.length}. Они также видны в журнале расчётов.</small>}</div>
    <button type="button" className="button button--primary" onClick={() => setOpen(true)}>Распределить платёж</button>
    {open && <SharedPaymentForm key={state.project.id} state={state} onClose={() => setOpen(false)} onServerSnapshot={onServerSnapshot} />}
  </section>;
}

function SharedPaymentForm({ state, onClose, onServerSnapshot }: Omit<Props, 'role'> & { onClose: () => void }) {
  const [workspace, setWorkspace] = useState<SharedPaymentWorkspace | null>(null), [loadError, setLoadError] = useState('');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [saved, setSaved] = useState<SharedPaymentSaved | null>(null);
  const [unknownOutcome, setUnknownOutcome] = useState(false), [refreshNotice, setRefreshNotice] = useState('');
  const [loadVersion, setLoadVersion] = useState(0);
  const [form, setForm] = useState({ kind: 'payment' as 'payment' | 'receipt', date: financeToday(), amount: '', payer: '', payee: '', description: '', source: '', reference: '',
    cashTreatment: 'account' as 'account' | 'participant_direct', accountGroup: '', legalEntityId: '', identityKind: 'document' as 'document' | 'bank', confirmation: 'confirmed' as 'confirmed' | 'reconciled', documentProjectId: state.project.id, documentId: '' });
  const [splits, setSplits] = useState<SplitRow[]>(() => [rowFor(state.project.id), rowFor('')]);
  const [paymentId] = useState(() => crypto.randomUUID());
  const controller = useRef<AbortController | null>(null), saving = useRef(false), intent = useRef<SharedPaymentInput | null>(null);
  useEffect(() => {
    const current = new AbortController(); controller.current = current; setLoadError('');
    fetchSharedPayments(state.project.id, current.signal).then(data => { if (!current.signal.aborted) setWorkspace(data); })
      .catch(cause => { if (!current.signal.aborted) setLoadError(cause instanceof Error ? cause.message : 'Не удалось загрузить заказы.'); });
    return () => current.abort();
  }, [state.project.id, loadVersion]);
  const current = workspace?.projects.find(project => project.projectId === state.project.id);
  const accountGroups = [...new Map((current?.accounts ?? []).map(account => [groupKey(account.legalEntityId, account.sharedAccountKey), account])).values()];
  const selectedAccount = accountGroups.find(account => groupKey(account.legalEntityId, account.sharedAccountKey) === form.accountGroup);
  const entity = form.cashTreatment === 'account' ? selectedAccount?.legalEntityId ?? '' : form.legalEntityId;
  const accountFor = (project: SharedPaymentProjectOption) => project.accounts.find(account => account.legalEntityId === entity && account.sharedAccountKey === selectedAccount?.sharedAccountKey);
  const eligible = (workspace?.projects ?? []).filter(project => form.cashTreatment === 'account' ? Boolean(accountFor(project)) : project.legalEntityIds.includes(entity));
  const selectedProjectIds = new Set(splits.map(row => row.projectId).filter(Boolean));
  const evidenceProjects = (workspace?.projects ?? []).filter(project => selectedProjectIds.has(project.projectId));
  const evidenceProject = evidenceProjects.find(project => project.projectId === form.documentProjectId);
  const values = splits.map(row => parseBankMoney(row.amount));
  const sum = values.some(value => value === null || value <= 0) ? null : values.reduce<number>((total, value) => total + (value ?? 0), 0);
  const exactTotal = sum !== null && Number.isSafeInteger(sum) ? sum : null, amountCents = parseBankMoney(form.amount);
  const remainder = exactTotal !== null && amountCents !== null && Number.isSafeInteger(amountCents - exactTotal) ? amountCents - exactTotal : null;
  const updateSplit = (id: string, update: Partial<SplitRow>) => setSplits(rows => rows.map(row => row.id === id ? { ...row, ...update } : row));
  const disabled = busy || unknownOutcome;
  const save = async (event: FormEvent) => {
    event.preventDefault(); if (saving.current || !controller.current || !workspace || saved) return;
    setError(''); setRefreshNotice('');
    let submission: SharedPaymentInput;
    try {
      if (unknownOutcome && intent.current) submission = intent.current;
      else {
        if (amountCents === null || amountCents <= 0) throw new Error('Введите положительную сумму до копеек.');
        if (!entity || form.cashTreatment === 'account' && !selectedAccount) throw new Error('Выберите общий счёт и юрлицо.');
        if (!selectedProjectIds.has(state.project.id)) throw new Error('В распределении должен участвовать текущий заказ.');
        const allocations = splits.map(row => {
          const project = eligible.find(item => item.projectId === row.projectId), amount = parseBankMoney(row.amount);
          if (!project || amount === null || amount <= 0) throw new Error('У каждой строки нужны доступный заказ и положительная сумма.');
          if (row.entryId && !project.entries.some(entry => entry.id === row.entryId && entry.kind === (form.kind === 'payment' ? 'expense' : 'income'))) throw new Error('Проверьте обязательства: направление должно совпадать с платежом.');
          return { projectId: row.projectId, ...(form.cashTreatment === 'account' ? { accountId: accountFor(project)!.id } : {}), amountCents: amount,
            ...(row.entryId ? { entryId: row.entryId } : {}), ...(row.trancheId ? { trancheId: row.trancheId } : {}), ...(row.retentionId ? { retentionId: row.retentionId } : {}) };
        });
        const bank = form.cashTreatment === 'account' && form.identityKind === 'bank';
        if (!form.reference.trim()) throw new Error('Укажите уникальный ID исходного платежа.');
        if (form.confirmation === 'reconciled' && !bank) throw new Error('Для банковской сверки выберите ID банковской операции и оригинал выписки.');
        submission = { id: paymentId, sourceKey: bank ? sharedPaymentBankKey(selectedAccount!.sharedAccountKey, form.reference) : sharedPaymentDocumentKey(form.cashTreatment === 'account' ? `account:${selectedAccount!.sharedAccountKey}` : `participant:${entity}`, form.reference),
          sourceReference: form.reference.trim(), kind: form.kind, date: form.date, amountCents, currency: 'RUB', legalEntityId: entity,
          ...(selectedAccount && form.cashTreatment === 'account' ? { sharedAccountKey: selectedAccount.sharedAccountKey } : {}),
          payer: form.payer, payee: form.payee, description: form.description, source: form.source, confirmation: form.confirmation, cashTreatment: form.cashTreatment,
          allocations, expected: [...selectedProjectIds].map(projectId => ({ projectId, revision: workspace.projects.find(project => project.projectId === projectId)!.revision })),
          ...(bank ? { bankEvidence: { projectId: form.documentProjectId, documentId: form.documentId, externalId: form.reference.trim(), source: form.source.trim() } } : {}) };
        const problem = sharedPaymentInputError(submission); if (problem) throw new Error(problem);
        intent.current = submission;
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Проверьте платёж.'); return; }
    saving.current = true; setBusy(true);
    try {
      const result = await recordSharedPayment(state.project.id, submission, controller.current.signal);
      if (controller.current.signal.aborted) return;
      setSaved(result); setUnknownOutcome(false);
      try { if (onServerSnapshot) onServerSnapshot(result.snapshot); else setRefreshNotice('Платёж сохранён. Обновите страницу, чтобы увидеть актуальные суммы в остальных разделах.'); }
      catch { setRefreshNotice('Платёж сохранён. Обновите страницу для загрузки актуального состояния заказа. Повторять платёж не нужно.'); }
    } catch (cause) {
      if (controller.current.signal.aborted) return;
      const unknown = !(cause instanceof SharedPaymentApiError) || cause.status >= 500;
      setUnknownOutcome(unknown); setError(cause instanceof Error ? cause.message : 'Результат записи неизвестен. Проверьте его повтором с тем же ID.');
    } finally { saving.current = false; if (!controller.current.signal.aborted) setBusy(false); }
  };
  return <Modal wide title="Один платёж — несколько заказов" subtitle={state.project.name} onClose={() => { if (!saving.current) onClose(); }}>
    {saved ? <div className="shared-payment-success"><h3>Платёж {display(saved.payment.principal.amountCents)} сохранён</h3>
      <p role="status">Исходное движение записано один раз. Доли и обязательства всех затронутых заказов обновлены одновременно{saved.replayed ? '; повторная проверка подтвердила уже сохранённую запись' : ''}.</p>
      <PaymentSummary record={saved.payment} projects={workspace?.projects ?? []} />
      <p>Записанные доли между заказами не переносятся. Нераспределённый остаток внутри заказа можно связать с обязательством в журнале расчётов. Фактический возврат оформляется отдельной операцией со ссылкой на исходную долю.</p>
      {refreshNotice && <p className="form-warning" role="status">{refreshNotice}</p>}
      <button type="button" className="button button--primary" onClick={onClose}>Готово</button></div> : <>
      {!workspace && !loadError && <p role="status">Загружаются доступные заказы и обязательства…</p>}
      {loadError && <p className="form-warning" role="alert">{loadError} <button type="button" className="button button--ghost" onClick={() => setLoadVersion(value => value + 1)}>Повторить загрузку</button></p>}
      {workspace && <form className="modal-form shared-payment-form" onSubmit={save}>
        <p className="finance-muted">Здесь регистрируется уже состоявшийся расчёт. Укажите фактических плательщика и получателя и уникальный источник: один банковский ID или одно однозначное основание конкретного платежа.</p>
        {error && <p className="form-warning" role="alert">{error}</p>}
        {unknownOutcome && <p className="form-warning" role="status">Ответ о сохранении не получен. Данные зафиксированы для безопасного повтора: кнопка «Проверить результат» проверит тот же ID и не создаст дубликат.</p>}
        <fieldset disabled={disabled} className="shared-payment-fieldset">
          <div className="form-grid"><Field label="Направление"><select value={form.kind} onChange={e => { setForm({ ...form, kind: e.target.value as 'payment' | 'receipt' }); setSplits(rows => rows.map(row => ({ ...row, entryId: '', trancheId: '', retentionId: '' }))); }}><option value="payment">Оплата поставщику / подрядчику</option><option value="receipt">Поступление от заказчика</option></select></Field>
            <Field label="Дата фактического расчёта"><input required type="date" max={financeToday()} value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} /></Field>
            <Field label="Полная сумма платежа, ₽"><input required inputMode="decimal" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} /></Field>
            <Field label="Как прошли деньги"><select value={form.cashTreatment} onChange={e => setForm({ ...form, cashTreatment: e.target.value as 'account' | 'participant_direct', confirmation: 'confirmed', identityKind: 'document' })}><option value="account">По общему счёту компании</option><option value="participant_direct">Прямой расчёт участника</option></select></Field></div>
          {form.cashTreatment === 'account' ? <Field label="Общий счёт и юрлицо"><select required value={form.accountGroup} onChange={e => setForm({ ...form, accountGroup: e.target.value })}><option value="">Выберите общий счёт</option>{accountGroups.map(account => <option key={groupKey(account.legalEntityId, account.sharedAccountKey)} value={groupKey(account.legalEntityId, account.sharedAccountKey)}>{account.name} · {account.legalEntityId} · {account.sharedAccountKey}</option>)}</select></Field>
            : <><Field label="Юрлицо обязательств"><select required value={form.legalEntityId} onChange={e => setForm({ ...form, legalEntityId: e.target.value })}><option value="">Выберите юрлицо</option>{(current?.legalEntityIds ?? []).map(id => <option key={id} value={id}>{id}</option>)}</select></Field><p className="finance-muted">Прямой расчёт погашает обязательства, но не создаёт движение на счетах компании.</p></>}
          {entity && eligible.length < 2 && <p className="form-warning" role="status">Для распределения нужны минимум два доступных вам заказа с тем же юрлицом{form.cashTreatment === 'account' ? ' и подтверждёнными проекциями общего счёта' : ''}. Настройте счёт в разделе финансового планирования.</p>}
          <div className="form-grid"><Field label="Фактический плательщик"><input required maxLength={500} value={form.payer} onChange={e => setForm({ ...form, payer: e.target.value })} /></Field><Field label="Фактический получатель"><input required maxLength={500} value={form.payee} onChange={e => setForm({ ...form, payee: e.target.value })} /></Field></div>
          <Field label="Назначение платежа"><textarea required maxLength={2000} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} /></Field>
          <div className="form-grid"><Field label="Уникальный источник"><select value={form.identityKind} onChange={e => setForm({ ...form, identityKind: e.target.value as 'document' | 'bank', confirmation: 'confirmed' })}><option value="document">Реквизиты конкретного платежа</option>{form.cashTreatment === 'account' && <option value="bank">ID банковской операции</option>}</select></Field>
            <Field label={form.identityKind === 'bank' ? 'Уникальный ID из банка' : 'Уникальные реквизиты платежа'}><input required maxLength={500} value={form.reference} onChange={e => setForm({ ...form, reference: e.target.value })} placeholder={form.identityKind === 'bank' ? 'ID строки из выписки' : 'Поручение № 123 от 04.11.2026, платёж 1'} /></Field></div>
          <Field label="Основание подтверждения"><textarea required maxLength={4000} value={form.source} onChange={e => setForm({ ...form, source: e.target.value })} placeholder="Документ и сведения, подтверждающие состоявшийся расчёт" /></Field>
          <Field label="Уровень подтверждения"><select value={form.confirmation} onChange={e => setForm({ ...form, confirmation: e.target.value as 'confirmed' | 'reconciled' })}><option value="confirmed">Подтверждён основанием</option>{form.identityKind === 'bank' && form.cashTreatment === 'account' && <option value="reconciled">Сверен по оригиналу банковской выписки</option>}</select></Field>
          <h3>Доли заказов</h3><p className="finance-muted">Можно добавить несколько обязательств одного заказа. Строка без обязательства сохранит долю с остатком для последующего распределения внутри заказа.</p>
          {splits.map((row, index) => {
            const project = eligible.find(item => item.projectId === row.projectId), entry = project?.entries.find(item => item.id === row.entryId);
            return <div className="shared-payment-row" key={row.id}><div className="shared-payment-row__heading"><strong>Доля {index + 1}</strong><button type="button" className="button button--ghost" disabled={splits.length <= 2} onClick={() => setSplits(rows => rows.filter(item => item.id !== row.id))}>Убрать</button></div>
              <div className="form-grid"><Field label="Заказ"><select required value={row.projectId} onChange={e => updateSplit(row.id, { projectId: e.target.value, entryId: '', trancheId: '', retentionId: '' })}><option value="">Выберите заказ</option>{!project && row.projectId && <option value={row.projectId} disabled>Выберите подходящий заказ</option>}{eligible.map(item => <option key={item.projectId} value={item.projectId}>{item.projectName}</option>)}</select></Field><Field label="Сумма доли, ₽"><input required inputMode="decimal" value={row.amount} onChange={e => updateSplit(row.id, { amount: e.target.value })} /></Field></div>
              <Field label="Обязательство"><select value={row.entryId} onChange={e => updateSplit(row.id, { entryId: e.target.value, trancheId: '', retentionId: '' })}><option value="">Распределить по обязательствам позже</option>{project?.entries.filter(item => item.kind === (form.kind === 'payment' ? 'expense' : 'income')).map(item => <option key={item.id} value={item.id}>{item.description} · {item.counterparty} · остаток {display(item.remainingCents)}</option>)}</select></Field>
              {entry && <><p className="finance-muted">Доступно к расчёту с учётом удержаний: {display(entry.payableCents)}</p>{entry.tranches.length > 0 && <Field label="Транш"><select value={row.trancheId} onChange={e => updateSplit(row.id, { trancheId: e.target.value, retentionId: '' })}><option value="">Без указания транша</option>{entry.tranches.map(tranche => <option key={tranche.id} value={tranche.id}>{tranche.source || tranche.id} · {display(tranche.amountCents)}</option>)}</select></Field>}{entry.retentions.some(retention => retention.status === 'released') && <Field label="Разрешённое к выплате удержание"><select value={row.retentionId} onChange={e => updateSplit(row.id, { retentionId: e.target.value })}><option value="">Обычный расчёт</option>{entry.retentions.filter(retention => retention.status === 'released' && (!retention.trancheId || retention.trancheId === row.trancheId)).map(retention => <option key={retention.id} value={retention.id}>{display(retention.amountCents)} · {retention.id}</option>)}</select></Field>}</>}
            </div>;
          })}
          <button type="button" className="button button--ghost" disabled={splits.length >= 100} onClick={() => setSplits(rows => [...rows, rowFor('')])}>Добавить долю</button>
          <div className="shared-payment-totals" aria-live="polite"><span>Исходный платёж: <strong>{display(amountCents)}</strong></span><span>Распределено: <strong>{display(exactTotal)}</strong></span><span>Осталось: <strong>{display(remainder)}</strong></span></div>
          {form.identityKind === 'bank' && <div className="form-grid"><Field label="Заказ с оригиналом выписки"><select required value={form.documentProjectId} onChange={e => setForm({ ...form, documentProjectId: e.target.value, documentId: '' })}><option value="">Выберите заказ</option>{evidenceProjects.map(project => <option key={project.projectId} value={project.projectId}>{project.projectName}</option>)}</select></Field><Field label="Закрытый оригинал выписки"><select required value={form.documentId} onChange={e => setForm({ ...form, documentId: e.target.value })}><option value="">Выберите загруженный документ</option>{evidenceProject?.documents.map(document => <option key={document.id} value={document.id}>{document.name}</option>)}</select></Field></div>}
          <p className="finance-muted">После записи суммы долей между заказами зафиксированы. Проверьте распределение до сохранения.</p>
        </fieldset>
        <div className="modal__actions"><button type="button" className="button button--ghost" disabled={busy} onClick={onClose}>Закрыть</button>{!unknownOutcome && <button type="button" className="button button--ghost" disabled={busy} onClick={() => setLoadVersion(value => value + 1)}>Обновить версии заказов</button>}<button type="submit" className="button button--primary" disabled={busy || (!unknownOutcome && (remainder !== 0 || eligible.length < 2))}>{busy ? 'Сохраняется общий платёж…' : unknownOutcome ? 'Проверить результат' : 'Записать платёж и все доли'}</button></div>
        {workspace.payments.length > 0 && <details className="shared-payment-history"><summary>Ранее записанные общие платежи этого заказа ({workspace.payments.length})</summary>{workspace.payments.map(payment => <PaymentSummary key={payment.principal.id} record={payment} projects={workspace.projects} />)}</details>}
      </form>}
    </>}
  </Modal>;
}

function PaymentSummary({ record, projects }: { record: SharedPaymentRecord; projects: SharedPaymentProjectOption[] }) {
  return <div className="shared-payment-summary"><p><strong>{record.principal.sourceReference || record.principal.id}</strong> · {record.principal.date} · {display(record.principal.amountCents)} · {record.principal.confirmation === 'reconciled' ? 'Сверено по выписке' : 'Подтверждено'}</p><p>{record.principal.payer} → {record.principal.payee}</p><p>{record.principal.description}</p>
    <ul>{record.shares.map(share => <li key={share.projectId}>{projects.find(project => project.projectId === share.projectId)?.projectName || share.projectId}: <strong>{display(share.amountCents)}</strong></li>)}</ul><small>Источник: {record.principal.source}</small></div>;
}
export default SharedPaymentPanel;
