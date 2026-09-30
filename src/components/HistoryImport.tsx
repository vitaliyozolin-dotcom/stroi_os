import { useState } from 'react';
import type { AppState } from '../entities/index';
import { parseHistoryRegister, prepareHistoryImport, type HistoryRegister } from '../domain/history-import';
import { Modal } from './Ui';
import { money } from '../presentation/formatting';

export function HistoryImport({ state, actor, onSave, onClose }: { state: AppState; actor: string; onSave: (next: AppState) => void; onClose: () => void }) {
  const [input, setInput] = useState<HistoryRegister | null>(null);
  const [error, setError] = useState('');
  const [includeBudget, setIncludeBudget] = useState(true);
  const [confirmed, setConfirmed] = useState(false);
  const records = input ? [...input.paidInvoices, ...input.paidLemanaPurchases, ...(input.existingPaidExpenses ?? [])] : [];
  return <Modal wide title="Внести смету и прошлые оплаты" subtitle="Исходные документы предварительно загружаются в карточку проекта." onClose={onClose}>
    <form className="modal-form" onSubmit={(event) => {
      event.preventDefault();
      if (!input || !confirmed) return;
      try { const result = prepareHistoryImport(state, input, actor, new Date().toISOString(), includeBudget); onSave(result.state); onClose(); } catch (failure) { setError(failure instanceof Error ? failure.message : 'Импорт не выполнен'); }
    }}>
      <label>Реестр импорта<input aria-label="Реестр импорта" type="file" accept=".json,application/json" onChange={async (event) => {
        const file = event.target.files?.[0]; if (!file) return;
        setError(''); setInput(null); setConfirmed(false);
        try { if (file.size > 2_000_000) throw new Error('Реестр слишком большой'); setInput(parseHistoryRegister(JSON.parse(await file.text()))); } catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось прочитать реестр'); }
      }} /></label>
      {input && <>
        <label><input type="checkbox" checked={includeBudget} onChange={(event) => setIncludeBudget(event.target.checked)} /> Внести статьи исходной сметы ({money(input.budgetReconciliation.sumOfPlanItems)})</label>
        <p>Итог исходного файла: {money(input.budgetReconciliation.sourceDisplayedPlan)}. Прежняя смета сохраняется в истории импорта.</p>
        {input.budgetApproval && includeBudget && <p>Смета принимается за план: {input.budgetApproval}</p>}
        <div className="entity-related-list">{records.map((item) => <div className="entity-detail-card" key={item.dedupKey}><strong>{item.vendor} · {money(item.amount)}</strong><span>{item.description}</span><small>{item.existingOperation ? 'Существующая операция, без создания дубля. Дата записи: ' : 'Дата документа: '}{item.documentDate ?? item.purchaseDate}. {item.paymentDate ? `Дата оплаты: ${item.paymentDate}` : 'Дата оплаты не указана.'}</small></div>)}</div>
        <strong>Оплачено по этому набору: {money(records.reduce((sum, item) => sum + item.amount, 0))}</strong>
        <label><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> Подтверждаю, что перечисленные расходы уже оплачены. Приёмка работ и материалов этим не подтверждается.</label>
      </>}
      {error && <p role="alert" className="form-warning">{error}</p>}
      <div className="modal__actions"><button type="button" className="button button--ghost" onClick={onClose}>Отмена</button><button type="submit" className="button button--primary" disabled={!input || !confirmed}>Внести в проект</button></div>
    </form>
  </Modal>;
}
