import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Field, Modal } from './Ui';
import { fetchSharedFinanceAccount, updateSharedFinanceAccount, type SharedFinanceAccount } from '../infrastructure/shared-finance-account';
import { parseBankMoney } from '../domain/banking/statement';
import { financeToday } from '../presentation/finance-view';
import { money } from '../presentation/formatting';

export function SharedFinanceAccountEditor({ accountKey, onClose, onSaved }: { accountKey: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const [data, setData] = useState<SharedFinanceAccount | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [saved, setSaved] = useState(false);
  const [form, setForm] = useState({ legalEntityId: '', asOf: '', balance: '', restricted: '', source: '', reason: '' });
  const [allocations, setAllocations] = useState<Record<string, string>>({});
  const controller = useRef<AbortController | null>(null), saving = useRef(false);
  const rowKey = (row: { projectId: string; accountId: string }) => JSON.stringify([row.projectId, row.accountId]);
  useEffect(() => {
    const current = new AbortController(); controller.current = current;
    fetchSharedFinanceAccount(accountKey, current.signal).then(result => {
      if (current.signal.aborted) return; setData(result);
      setForm({ legalEntityId: result.legalEntityId, asOf: result.opening?.asOf ?? financeToday(), balance: result.opening ? String(result.opening.amountCents / 100) : '', restricted: String((result.restrictedCents ?? 0) / 100), source: result.opening?.source ?? '', reason: '' });
      setAllocations(Object.fromEntries(result.projects.map(row => [rowKey(row), String(row.allocationCents / 100)])));
    }).catch(cause => { if (!current.signal.aborted) setError(cause instanceof Error ? cause.message : 'Не удалось открыть общий счёт.'); });
    return () => current.abort();
  }, [accountKey]);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!data || saving.current || !controller.current) return;
    saving.current = true; setBusy(true); setError('');
    try {
      const amountCents = parseBankMoney(form.balance), restrictedCents = parseBankMoney(form.restricted);
      if (amountCents === null || restrictedCents === null || restrictedCents < 0) throw new Error('Проверьте остаток и ограничения: допустимы суммы до копеек.');
      const nextAllocations = data.projects.map(row => { const amount = parseBankMoney(allocations[rowKey(row)]); if (amount === null || amount < 0) throw new Error('У каждого объекта должна быть неотрицательная выделенная сумма.'); return { projectId: row.projectId, accountId: row.accountId, amountCents: amount }; });
      await updateSharedFinanceAccount({ sharedAccountKey: accountKey, currency: 'RUB', legalEntityId: form.legalEntityId.trim(), opening: { asOf: form.asOf, amountCents, confirmed: true, source: form.source.trim() }, restrictedCents,
        expected: data.projects.map(({ projectId, accountId, revision }) => ({ projectId, accountId, revision })), allocations: nextAllocations, reason: form.reason.trim() }, controller.current.signal);
      if (controller.current.signal.aborted) return;
      setSaved(true);
      await onSaved();
    } catch (cause) { if (!controller.current.signal.aborted) setError(cause instanceof Error ? cause.message : 'Не удалось выполнить сверку.'); }
    finally { saving.current = false; if (!controller.current.signal.aborted) setBusy(false); }
  };
  const amounts = Object.values(allocations).map(parseBankMoney), total = amounts.some(value => value === null) ? null : amounts.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  return <Modal wide title="Сверка общего счёта" subtitle={accountKey} onClose={() => { if (!saving.current) onClose(); }}>
    {!data && !error && <p role="status">Загружаются связанные объекты…</p>}
    {saved ? <><p role="status">Остаток и выделенные суммы сохранены одновременно во всех связанных объектах.</p>{error && <p className="form-warning" role="alert">{error} Общая сверка уже сохранена; повторять запись не требуется.</p>}<button type="button" className="button button--primary" onClick={onClose}>Закрыть</button></> : <>
      {error && <p className="form-warning" role="alert">{error}</p>}
      {data && <form className="modal-form" onSubmit={submit}>
        <p className="finance-muted">Введите подтверждённый остаток на конец дня и распределите доступные средства между объектами. Изменение применяется ко всем строкам ниже одной записью с проверкой версий.</p>
        <div className="form-grid"><Field label="Компания / юрлицо"><input required value={form.legalEntityId} onChange={e => setForm({ ...form, legalEntityId: e.target.value })} /></Field><Field label="Остаток на конец дня"><input required type="date" max={financeToday()} value={form.asOf} onChange={e => setForm({ ...form, asOf: e.target.value })} /></Field><Field label="Подтверждённый остаток, ₽"><input required inputMode="decimal" value={form.balance} onChange={e => setForm({ ...form, balance: e.target.value })} /></Field><Field label="Заблокировано / ограничения, ₽"><input required inputMode="decimal" value={form.restricted} onChange={e => setForm({ ...form, restricted: e.target.value })} /></Field></div>
        <Field label="Источник остатка"><input required value={form.source} onChange={e => setForm({ ...form, source: e.target.value })} placeholder="Выписка на дату среза" /></Field>
        <h3>Выделено объектам</h3>{data.projects.map(row => <Field key={rowKey(row)} label={`${row.projectName} · ${row.accountName}, ₽`}><input required inputMode="decimal" value={allocations[rowKey(row)] ?? ''} onChange={e => setAllocations({ ...allocations, [rowKey(row)]: e.target.value })} /></Field>)}
        <p>Распределено: <strong>{total === null || !Number.isSafeInteger(total) ? 'Проверьте суммы' : money(total / 100)}</strong></p>
        <Field label="Что изменилось и почему"><textarea required value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} /></Field>
        <div className="modal__actions"><button type="button" className="button button--ghost" disabled={busy} onClick={onClose}>Отмена</button><button type="submit" className="button button--primary" disabled={busy}>{busy ? 'Сохраняется общая сверка…' : 'Сохранить для всех объектов'}</button></div>
      </form>}
    </>}
  </Modal>;
}
