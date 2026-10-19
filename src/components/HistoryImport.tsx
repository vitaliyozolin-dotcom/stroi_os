import { useEffect, useRef, useState } from 'react';
import type { AppState } from '../entities/index';
import { parseHistoryRegister, type HistoryRegister } from '../domain/finance/history-import';
import { historyImportSnapshot, type HistoryImportCommand, type HistoryImportCommandResult } from '../application';
import { Modal } from './Ui';
import { money } from '../presentation/formatting';

export function HistoryImport({ state, onImport, onClose }: { state: AppState; onImport: (input: HistoryImportCommand) => HistoryImportCommandResult; onClose: () => void }) {
  const [input, setInput] = useState<HistoryRegister | null>(null);
  const [error, setError] = useState('');
  const [includeBudget, setIncludeBudget] = useState(true);
  const [confirmed, setConfirmed] = useState(false);
  const [expected, setExpected] = useState('');
  const [reading, setReading] = useState(false);
  const [fileName, setFileName] = useState('');
  const readVersion = useRef(0);
  useEffect(() => () => { readVersion.current += 1; }, []);
  const records = input ? [...input.paidInvoices, ...input.paidLemanaPurchases, ...(input.existingPaidExpenses ?? [])] : [];
  return <Modal wide title="Внести смету и прошлые оплаты" subtitle="Исходные документы предварительно загружаются в карточку проекта." onClose={onClose}>
    <form className="modal-form" onSubmit={(event) => {
      event.preventDefault();
      if (!input || reading) return;
      const result = onImport({ register: input, confirmed, includeBudget, expected });
      if (!result.ok) { setError(result.error); return; }
      onClose();
    }}>
      <label>Реестр импорта<input aria-label="Реестр импорта" type="file" accept=".json,application/json" onChange={async (event) => {
        const file = event.target.files?.[0];
        event.currentTarget.value = '';
        const version = ++readVersion.current;
        setError(''); setInput(null); setConfirmed(false); setExpected(''); setFileName('');
        if (!file) { setReading(false); return; }
        const snapshot = historyImportSnapshot(state);
        setReading(true);
        try {
          if (file.size > 2_000_000) throw new Error('Реестр слишком большой');
          const parsed = parseHistoryRegister(JSON.parse(await file.text()));
          if (version !== readVersion.current) return;
          setInput(parsed); setExpected(snapshot); setFileName(file.name);
        } catch (failure) {
          if (version === readVersion.current) setError(failure instanceof Error ? failure.message : 'Не удалось прочитать реестр');
        } finally { if (version === readVersion.current) setReading(false); }
      }} /></label>
      {reading && <p role="status">Читаем реестр…</p>}
      {input && <>
        <p>Загружен реестр: {fileName}</p>
        <label><input type="checkbox" checked={includeBudget} onChange={(event) => { setIncludeBudget(event.target.checked); setConfirmed(false); }} /> Внести статьи исходной сметы ({money(input.budgetReconciliation.sumOfPlanItems)})</label>
        <p>Итог исходного файла: {money(input.budgetReconciliation.sourceDisplayedPlan)}. Прежняя смета сохраняется в истории импорта.</p>
        {input.budgetApproval && includeBudget && <p>Смета принимается за план: {input.budgetApproval}</p>}
        <div className="entity-related-list">{records.map((item) => <div className="entity-detail-card" key={item.dedupKey}><strong>{item.vendor} · {money(item.amount)}</strong><span>{item.description}</span><small>{item.existingOperation ? 'Существующая операция, без создания дубля. Дата записи: ' : 'Дата документа: '}{item.documentDate ?? item.purchaseDate}. {item.paymentDate ? `Дата оплаты: ${item.paymentDate}` : 'Дата оплаты не указана.'}</small></div>)}</div>
        <strong>Оплачено по этому набору: {money(records.reduce((sum, item) => sum + item.amount, 0))}</strong>
        <label><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> Подтверждаю, что перечисленные расходы уже оплачены. Приёмка работ и материалов этим не подтверждается.</label>
      </>}
      {error && <p role="alert" className="form-warning">{error}</p>}
      <div className="modal__actions"><button type="button" className="button button--ghost" onClick={onClose}>Отмена</button><button type="submit" className="button button--primary" disabled={reading || !input || !confirmed}>Внести в проект</button></div>
    </form>
  </Modal>;
}
