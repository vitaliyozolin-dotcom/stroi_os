import { useState, type FormEvent } from 'react';
import type { AppState, BudgetMeta, UserRole } from '../entities/index';
import type { StateChangeSink } from '../application';
import { Field, Modal } from './Ui';
import { money } from '../presentation/formatting';

const labels = { internal_cost: 'Внутренняя себестоимость', commercial: 'Смета заказчику', unknown: 'Вид сметы не подтверждён' };

export function FinanceEstimateIdentity({ state, role, onChange }: { state: AppState; role: UserRole; onChange: StateChangeSink }) {
  const [editor, setEditor] = useState<{ expected: string; kind: NonNullable<BudgetMeta['estimateKind']>; source: string; commercialAmount: string; commercialVersion: string; commercialSource: string; documentId: string } | null>(null);
  const [error, setError] = useState('');
  const kind = state.budgetMeta.estimateKind ?? 'unknown';
  const open = () => { setError(''); setEditor({ expected: JSON.stringify(state.budgetMeta), kind, source: state.budgetMeta.classificationSource ?? '', commercialAmount: state.budgetMeta.commercialEstimate ? String(state.budgetMeta.commercialEstimate.amountCents / 100) : '', commercialVersion: state.budgetMeta.commercialEstimate?.version ?? '', commercialSource: state.budgetMeta.commercialEstimate?.source ?? '', documentId: state.budgetMeta.commercialEstimate?.documentId ?? '' }); };
  const save = (event: FormEvent) => {
    event.preventDefault(); if (!editor || role !== 'management') return;
    if (JSON.stringify(state.budgetMeta) !== editor.expected) { setError('Смета обновилась. Закройте окно и откройте заново.'); return; }
    if (editor.kind !== 'unknown' && !editor.source.trim()) { setError('Укажите документ или основание, по которому определён вид сметы.'); return; }
    let commercialEstimate: BudgetMeta['commercialEstimate'];
    if (editor.commercialAmount.trim()) {
      const amount = Number(editor.commercialAmount), amountCents = Math.round(amount * 100);
      if (!Number.isFinite(amount) || amount < 0 || !Number.isSafeInteger(amountCents) || Math.abs(amount - amountCents / 100) > .000001 || !editor.commercialVersion.trim() || !editor.commercialSource.trim()) { setError('Для сметы заказчику нужны точная сумма, версия и источник.'); return; }
      commercialEstimate = { amountCents, version: editor.commercialVersion.trim(), source: editor.commercialSource.trim(), ...(editor.documentId ? { documentId: editor.documentId } : {}) };
    }
    onChange({ ...state, budgetMeta: { ...state.budgetMeta, estimateKind: editor.kind, classificationSource: editor.source.trim(), commercialEstimate } }, { action: 'estimate_classification', summary: `Вид сметы: ${labels[editor.kind]}. Основание: ${editor.source.trim() || 'требует уточнения'}` });
    setEditor(null);
  };
  return <section className="finance-estimate-identity" aria-label="Назначение сметы">
    <div><span className="finance-eyebrow">Загруженная смета</span><h3>{labels[kind]}</h3><p>{kind === 'unknown' ? 'Сначала определите, чьи это цены: компании или заказчика.' : kind === 'commercial' ? 'Эти цены не используются как внутренняя себестоимость.' : state.budgetMeta.approvedAt ? 'Тип подтверждён. Утверждённая версия сохранена.' : 'Тип подтверждён. Утверждение бюджета — отдельный шаг.'}</p>{state.budgetMeta.commercialEstimate && <small>Отдельная смета заказчику: {money(state.budgetMeta.commercialEstimate.amountCents / 100)} · {state.budgetMeta.commercialEstimate.version}</small>}</div>
    {role === 'management' && <button type="button" className="button button--secondary" onClick={open}>{kind === 'unknown' ? 'Определить вид сметы' : 'Вид и коммерческая сумма'}</button>}
    {editor && <Modal title="Какая смета загружена?" subtitle="Классификация не меняет суммы, оплаты и цену договора." onClose={() => setEditor(null)}><form className="modal-form" onSubmit={save}>
      {error && <p className="form-warning" role="alert">{error}</p>}
      <Field label="Вид текущих строк сметы"><select value={editor.kind} onChange={event => setEditor({ ...editor, kind: event.target.value as typeof editor.kind })}><option value="unknown">Пока не подтверждён</option><option value="internal_cost">Внутренняя себестоимость компании</option><option value="commercial">Коммерческая смета заказчику</option></select></Field>
      <Field label="Основание" hint="Название документа или подтверждение ответственного"><input required={editor.kind !== 'unknown'} value={editor.source} onChange={event => setEditor({ ...editor, source: event.target.value })} /></Field>
      <details className="finance-disclosure" open={Boolean(editor.commercialAmount)}><summary>Отдельная коммерческая смета</summary><p className="finance-muted">Сохраняется отдельно от внутренних строк и цены договора. Заполняйте по источнику.</p><div className="form-grid"><Field label="Сумма заказчику, ₽"><input type="number" min="0" step="0.01" value={editor.commercialAmount} onChange={event => setEditor({ ...editor, commercialAmount: event.target.value })} /></Field><Field label="Версия"><input value={editor.commercialVersion} onChange={event => setEditor({ ...editor, commercialVersion: event.target.value })} /></Field></div><Field label="Источник"><input value={editor.commercialSource} onChange={event => setEditor({ ...editor, commercialSource: event.target.value })} /></Field><Field label="Документ"><select value={editor.documentId} onChange={event => setEditor({ ...editor, documentId: event.target.value })}><option value="">Без файла · текстовое основание</option>{state.documents.map(document => <option value={document.id} key={document.id}>{document.name}</option>)}</select></Field></details>
      <div className="modal__actions"><button type="button" className="button button--ghost" onClick={() => setEditor(null)}>Отмена</button><button type="submit" className="button button--primary">Сохранить</button></div>
    </form></Modal>}
  </section>;
}
