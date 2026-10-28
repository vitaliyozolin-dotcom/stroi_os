import { useMemo, useRef, useState, useEffect, type FormEvent } from 'react';
import type { AppState } from '../entities/index';
import { formatDate } from '../presentation/formatting';
import { bankStatementIdentity, parseBankStatement, type BankColumnMapping, type BankStatementPreview } from '../domain/banking/statement';
import { bankIdentityNamespace, bankOperationMatches, bankRowMatches, buildBankReconciliation, recordedStatementOperation, type BankRowSelection } from '../domain/banking/reconciliation';
import { LedgerField as Field, LedgerModal, ledgerAmount, type LedgerSave } from './finance-ledger-ui';

const columns: { key: keyof BankColumnMapping; label: string }[] = [
  { key: 'date', label: 'Дата движения' }, { key: 'amount', label: 'Сумма со знаком' }, { key: 'debit', label: 'Списание' }, { key: 'credit', label: 'Зачисление' },
  { key: 'direction', label: 'Направление' }, { key: 'externalId', label: 'Банковский ID' }, { key: 'documentNumber', label: 'Номер документа' },
  { key: 'purpose', label: 'Назначение' }, { key: 'counterparty', label: 'Контрагент' }, { key: 'payerAccount', label: 'Счёт плательщика' }, { key: 'recipientAccount', label: 'Счёт получателя' }, { key: 'currency', label: 'Валюта' },
];
export function BankStatementImport({ state, snapshot, onSave, onClose }: { state: AppState; snapshot: string; onSave: LedgerSave; onClose: () => void }) {
  const [expected] = useState(snapshot), [projectId] = useState(state.project.id);
  const [file, setFile] = useState<{ name: string; sha: string; text: string } | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const [accountId, setAccountId] = useState(state.treasury?.accounts.length === 1 ? state.treasury.accounts[0].id : ''), [statementAccount, setStatementAccount] = useState('');
  const [mapping, setMapping] = useState<BankColumnMapping | undefined>(), [selections, setSelections] = useState<Record<number, BankRowSelection>>({}), [identifiers, setIdentifiers] = useState<Record<number, string>>({});
  const [reason, setReason] = useState(''), [rubConfirmed, setRubConfirmed] = useState(false), [page, setPage] = useState(0);
  const reading = useRef(0); useEffect(() => () => { reading.current++; }, []);
  const parse = useMemo((): { preview: BankStatementPreview | null; error: string } => {
    if (!file) return { preview: null, error: '' };
    try { const preview = parseBankStatement(file.text, { mapping, accountNumber: statementAccount || undefined }); return { preview: { ...preview, rows: preview.rows.map(row => identifiers[row.rowNumber]?.trim() ? { ...row, externalId: identifiers[row.rowNumber].trim() } : row) }, error: '' }; }
    catch (failure) { return { preview: null, error: failure instanceof Error ? failure.message : 'Файл не распознан.' }; }
  }, [file, mapping, statementAccount, identifiers]);
  const preview = parse.preview, account = state.treasury?.accounts.find(item => item.id === accountId);
  const namespace = account ? bankIdentityNamespace(state, accountId) : 'unselected';
  const identityCounts = useMemo(() => { const counts = new Map<string, number>(); for (const row of preview?.rows ?? []) { const key = bankStatementIdentity(row, namespace).key; counts.set(key, (counts.get(key) ?? 0) + 1); } return counts; }, [preview, namespace]);
  const readFile = async (selected?: File) => {
    if (!selected) return; const token = ++reading.current; setLoading(false); setError(''); setFile(null); setSelections({}); setIdentifiers({}); setMapping(undefined); setPage(0); setStatementAccount(''); setRubConfirmed(false);
    if (selected.size > 5_000_000) { setError('Размер выписки превышает 5 МБ. Разделите период.'); return; }
    setLoading(true);
    try { const buffer = await selected.arrayBuffer(); let text: string; try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { text = new TextDecoder('windows-1251').decode(buffer); }
      const digest = await crypto.subtle.digest('SHA-256', buffer); const sha = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
      if (reading.current === token) setFile({ name: selected.name, sha, text });
    } catch (failure) { if (reading.current === token) setError(failure instanceof Error ? failure.message : 'Не удалось прочитать файл.'); }
    finally { if (reading.current === token) setLoading(false); }
  };
  const setAction = (rowNumber: number, value: string) => {
    let selection: BankRowSelection | undefined;
    if (value === 'skip' || value === 'new') selection = { action: value };
    else if (value.startsWith('operation:')) selection = { action: 'operation', operationId: value.slice(10) };
    else if (value.startsWith('legacy:')) { const [entryId, paymentId] = JSON.parse(value.slice(7)) as string[]; selection = { action: 'legacy', entryId, paymentId }; }
    setSelections(current => { const next = { ...current }; if (selection) next[rowNumber] = selection; else delete next[rowNumber]; return next; });
  };
  const selectionValue = (selection?: BankRowSelection) => !selection ? '' : selection.action === 'operation' ? `operation:${selection.operationId}` : selection.action === 'legacy' ? `legacy:${JSON.stringify([selection.entryId, selection.paymentId])}` : selection.action;
  const effectiveSelections = { ...selections };
  for (const row of preview?.rows ?? []) {
    const identity = bankStatementIdentity(row, namespace), recorded = recordedStatementOperation(state.financeLedger, identity.key);
    if (identity.strength === 'bank_id' && !effectiveSelections[row.rowNumber] && recorded && bankOperationMatches(state, recorded, row, accountId)) effectiveSelections[row.rowNumber] = { action: 'skip' };
  }
  const submit = (event: FormEvent) => { event.preventDefault(); setError('');
    try { if (state.project.id !== projectId) throw new Error('Проект изменился. Откройте импорт заново.'); if (!preview || !file || !rubConfirmed) throw new Error('Загрузите выписку и подтвердите валюту.');
      const next = buildBankReconciliation(state, preview, effectiveSelections, { accountId, fileName: file.name, fileSha256: file.sha, reason });
      const result = onSave(next, expected); if (!result.ok) throw new Error(result.error || 'Не удалось сохранить сверку.'); onClose();
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось импортировать выписку.'); }
  };
  const exportErrors = () => { if (!preview) return; const body = '\uFEFFСтрока;Ошибка\n' + preview.errors.map(item => `${item.rowNumber};"${item.message.replaceAll('"', '""')}"`).join('\n'); const url = URL.createObjectURL(new Blob([body], { type: 'text/csv;charset=utf-8' })); const link = document.createElement('a'); link.href = url; link.download = 'statement-errors.csv'; link.click(); URL.revokeObjectURL(url); };
  const pageRows = preview?.rows.slice(page * 50, page * 50 + 50) ?? [], totalPages = Math.max(1, Math.ceil((preview?.rows.length ?? 0) / 50));
  return <LedgerModal title="Импорт и сверка выписки" subtitle="Файл обрабатывается в браузере. До сохранения денежные записи не меняются." onClose={onClose}><form className="modal-form ledger-form" onSubmit={submit}>
    <div className="form-grid"><Field label="Выписка CSV или 1С Клиент-Банк" hint="UTF-8 или Windows-1251, до 5 МБ, до 5000 операций"><input type="file" accept=".csv,.txt,.tsv" onChange={event => void readFile(event.target.files?.[0])} /></Field><Field label="Счёт в системе"><select required value={accountId} onChange={event => { setAccountId(event.target.value); setSelections({}); }}><option value="">Выберите счёт</option>{state.treasury?.accounts.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></Field></div>
    {!state.treasury?.accounts.length && <p className="ledger-warning">Сначала добавьте счёт и исходный остаток во вкладке «Прогноз».</p>}{loading && <p role="status">Читаем файл и проверяем его контрольную сумму…</p>}
    {file && <p className="ledger-note">{file.name} · SHA-256 {file.sha.slice(0, 16)}…</p>}
    {preview?.format === '1c' && preview.accounts.length > 1 && <Field label="Расчётный счёт из выписки"><select required value={statementAccount} onChange={event => { setStatementAccount(event.target.value); setSelections({}); }}><option value="">Выберите</option>{preview.accounts.map(value => <option key={value} value={value}>{value}</option>)}</select></Field>}
    {preview?.format === 'csv' && <details open={!preview.rows.length}><summary>Сопоставление столбцов CSV</summary><div className="form-grid">{columns.map(column => <Field label={column.label} key={column.key}><select value={(mapping ?? preview.mapping)?.[column.key] ?? -1} onChange={event => { const next = { ...(mapping ?? preview.mapping ?? { date: -1 }) }; const index = Number(event.target.value); if (index < 0) delete next[column.key]; else next[column.key] = index; setMapping(next as BankColumnMapping); setSelections({}); }}><option value={-1}>Не используется</option>{preview.headers.map((header, index) => <option key={index} value={index}>{index + 1}. {header || 'Без заголовка'}</option>)}</select></Field>)}</div></details>}
    {preview?.warnings.map(message => <p className="ledger-warning" key={message}>{message}</p>)}{parse.error && <p className="ledger-warning" role="alert">{parse.error}</p>}
    {preview && preview.errors.length > 0 && <details className="ledger-errors" open><summary>Ошибки: {preview.errors.length}. Сохранение заблокировано.</summary><ul>{preview.errors.slice(0, 30).map(item => <li key={`${item.rowNumber}:${item.message}`}>Строка {item.rowNumber}: {item.message}</li>)}</ul><button type="button" className="text-button" onClick={exportErrors}>Скачать отчёт ошибок</button></details>}
    {preview && preview.rows.length > 0 && <><div className="ledger-section-heading"><strong>Операций: {preview.rows.length}</strong><button type="button" className="text-button" onClick={() => setSelections(Object.fromEntries(preview.rows.map(row => [row.rowNumber, { action: 'skip' }])))}>Пропустить все</button></div>
      <p className="ledger-note">Совпадение суммы само по себе не подтверждает оплату. Для каждого нового движения выберите действие. Займы, возвраты и переводы сначала внесите с правильным типом в журнал, затем сопоставьте с выпиской.</p>
      <div className="ledger-bank-rows">{pageRows.map(row => { const identity = bankStatementIdentity(row, namespace), recorded = recordedStatementOperation(state.financeLedger, identity.key), matches = accountId ? bankRowMatches(state, row, accountId) : [], conflict = recorded && !bankOperationMatches(state, recorded, row, accountId);
        const count = identityCounts.get(identity.key) ?? 0;
        return <article className="ledger-bank-row" key={row.rowNumber}><div className="ledger-section-heading"><strong>{row.direction === 'in' ? '+' : '−'}{ledgerAmount(row.amountCents)}</strong><span>{formatDate(row.date, true)} · строка {row.rowNumber}</span></div><p>{row.counterparty || 'Контрагент не указан'} · {row.purpose || 'Назначение отсутствует'}</p>
          {recorded && <p className={conflict ? 'ledger-warning' : 'ledger-note'}>{conflict ? 'Конфликт банковского ID: данные отличаются от сохранённого движения.' : 'Найдено движение с таким идентификатором. Проверьте совпадение перед пропуском строки.'}</p>}
          {identity.strength === 'composite' && <small className="ledger-note">Банковского ID нет: совпадение определяется по реквизитам и требует проверки.</small>}
          {count > 1 && <p className="ledger-warning">В файле повторяется идентификатор ({count} строк). Для разных платежей укажите разные банковские ID по документу.</p>}
          <Field label={`Действие для строки ${row.rowNumber}`}><select value={selectionValue(effectiveSelections[row.rowNumber])} onChange={event => setAction(row.rowNumber, event.target.value)} disabled={!accountId}><option value="">Выберите действие</option><option value="skip">Пропустить строку</option>{!recorded && <><option value="new">Новый обычный {row.direction === 'in' ? 'приход' : 'платёж'} · распределить позже</option>{matches.map(match => <option value={match.value} key={match.value}>Сверить: {match.label}</option>)}</>}</select></Field>
          {!row.externalId || identifiers[row.rowNumber] !== undefined ? <details><summary>Уточнить банковский ID</summary><Field label="ID по банковскому документу" hint="Нужен реальный идентификатор, если две разные операции имеют одинаковые реквизиты"><input value={identifiers[row.rowNumber] ?? ''} onChange={event => { setIdentifiers(current => ({ ...current, [row.rowNumber]: event.target.value })); setSelections(current => { const next = { ...current }; delete next[row.rowNumber]; return next; }); }} /></Field></details> : <small className="ledger-note">Банковский ID: {row.externalId}</small>}
        </article>;
      })}</div>{totalPages > 1 && <div className="ledger-pagination"><button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>Назад</button><span>{page + 1} / {totalPages}</span><button type="button" disabled={page + 1 === totalPages} onClick={() => setPage(page + 1)}>Далее</button></div>}
      <label className="ledger-check"><input type="checkbox" checked={rubConfirmed} onChange={event => setRubConfirmed(event.target.checked)} />Проверено: выписка в рублях и относится к счёту «{account?.name || 'не выбран'}».</label>
      <Field label="Основание сверки"><textarea required value={reason} onChange={event => setReason(event.target.value)} placeholder="Период выписки, источник и результат проверки" /></Field>
    </>}
    {error && <p role="alert" className="ledger-warning">{error}</p>}<div className="ledger-form-actions"><button type="button" className="button button--ghost" onClick={onClose}>Отмена</button><button type="submit" className="button button--primary" disabled={loading || !preview?.rows.length || Boolean(preview.errors.length) || !accountId || !rubConfirmed}>Сохранить сверку</button></div>
  </form></LedgerModal>;
}
