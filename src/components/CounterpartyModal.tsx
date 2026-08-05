import {
  Banknote,
  BriefcaseBusiness,
  Building2,
  CalendarCheck2,
  CircleAlert,
  Clock3,
  Mail,
  PackageCheck,
  FileText,
  Pencil,
  Plus,
  Phone,
  ShieldCheck,
  Truck,
} from 'lucide-react';
import { acceptedAmountFor, formatDate, money, paidAmountFor } from '../domain';
import type { AppState, ExpenseStatus, ProcurementStatus, StageStatus } from '../types';
import { Modal, StatusBadge } from './Ui';

const stageLabels: Record<StageStatus, string> = {
  not_ready: 'Не готов', ready: 'Готов к старту', in_progress: 'В работе', blocked: 'Заблокирован', awaiting_inspection: 'На проверке', accepted: 'Принят', rework: 'Доработка',
};
const supplyLabels: Record<ProcurementStatus, string> = {
  need: 'Потребность', rfq: 'Сбор цен', ordered: 'Заказано', in_transit: 'В пути', delivered: 'Доставлено', accepted: 'Принято', issued: 'Выдано',
};
const financeLabels: Record<ExpenseStatus, string> = { committed: 'Обязательство', accepted: 'Принято', paid: 'Оплачено' };
const typeLabels = { contractor: 'Подрядчик', supplier: 'Поставщик', service: 'Сервисная компания', client: 'Заказчик' } as const;
const documentLabels = { contract: 'Договор', act: 'Акт', invoice: 'Счёт', upd: 'УПД', waybill: 'ТН', specification: 'Спецификация', other: 'Документ' } as const;

const sameName = (left?: string, right?: string) => Boolean(left && right && left.trim().toLocaleLowerCase('ru') === right.trim().toLocaleLowerCase('ru'));

export function CounterpartyModal({ state, counterpartyId, name, onClose, onOpenFinanceEntry, onEdit, onAddDocument }: { state: AppState; counterpartyId?: string; name?: string; onClose: () => void; onOpenFinanceEntry?: (id: string) => void; onEdit?: () => void; onAddDocument?: () => void }) {
  const profile = state.counterparties.find((item) => item.id === counterpartyId)
    ?? state.counterparties.find((item) => sameName(item.name, name));
  const displayName = profile?.name ?? name ?? 'Контрагент';
  const linked = (id: string | undefined, legacyName: string | undefined) => (
    profile ? id === profile.id || (!id && sameName(legacyName, profile.name)) : sameName(legacyName, displayName)
  );
  const financeEntries = state.financeEntries.filter((entry) => linked(entry.counterpartyId, entry.counterparty));
  const procurement = state.procurement.filter((item) => linked(item.supplierId, item.supplier));
  const quotes = state.supplierQuotes.filter((item) => linked(item.supplierId, item.supplier));
  const stages = state.stages.filter((stage) => linked(stage.responsibleId, stage.responsible));
  const stageIds = new Set(stages.map((stage) => stage.id));
  const reworkCount = state.checkpoints.filter((item) => stageIds.has(item.stageId) && item.status === 'rework').length;
  const paid = financeEntries.filter((item) => item.kind === 'expense').reduce((sum, item) => sum + paidAmountFor(item), 0);
  const accepted = financeEntries.filter((item) => item.kind === 'expense').reduce((sum, item) => sum + acceptedAmountFor(item), 0);
  const obligations = financeEntries.filter((item) => item.kind === 'expense').reduce((sum, item) => sum + Math.max(0, item.amount - paidAmountFor(item)), 0);
  const ordered = procurement.reduce((sum, item) => sum + item.budget, 0);
  const completedStages = stages.filter((stage) => stage.status === 'accepted' && stage.actualEnd);
  const measurableDeliveries = procurement.filter((item) => item.deliveredAt && ['delivered', 'accepted', 'issued'].includes(item.status));
  const measuredEvents = completedStages.length + measurableDeliveries.length;
  const onTimeEvents = completedStages.filter((stage) => String(stage.actualEnd) <= stage.planEnd).length
    + measurableDeliveries.filter((item) => String(item.deliveredAt) <= item.neededBy).length;
  const onTimePercent = measuredEvents ? Math.round(onTimeEvents / measuredEvents * 100) : null;
  const activeItems = stages.filter((stage) => !['accepted', 'not_ready'].includes(stage.status)).length
    + procurement.filter((item) => !['accepted', 'issued'].includes(item.status)).length;
  const status = profile?.status ?? 'probation';
  const documents = profile ? state.documents.filter((item) => item.counterpartyId === profile.id) : [];

  return (
    <Modal wide title={displayName} subtitle={`${profile ? typeLabels[profile.type] : 'Контрагент'} · единая история по проекту`} onClose={onClose}>
      <div className="counterparty-head">
        <span className="counterparty-head__logo"><Building2 size={25} /></span>
        <div><strong>{profile?.specialty ?? 'Специализация пока не заполнена'}</strong><p>{profile?.notes ?? 'Карточка собирается автоматически из этапов, закупок и финансовых операций.'}</p><div className="counterparty-tags">{profile?.tags?.map((tag) => <span key={tag}>{tag}</span>)}</div></div>
        <StatusBadge label={status === 'active' ? 'Работаем' : status === 'probation' ? 'На проверке' : 'Заблокирован'} tone={status === 'active' ? 'positive' : status === 'probation' ? 'warning' : 'danger'} />
      </div>

      {(onEdit || onAddDocument) && <div className="counterparty-actions">{onEdit && <button type="button" className="button button--secondary button--compact" onClick={onEdit}><Pencil size={15} /> Редактировать</button>}{onAddDocument && <button type="button" className="button button--primary button--compact" onClick={onAddDocument}><Plus size={15} /> Добавить документ</button>}</div>}

      <div className="counterparty-metrics">
        <article><span><CalendarCheck2 size={18} /></span><div><small>Соблюдение сроков</small><strong>{onTimePercent === null ? 'Нет факта' : `${onTimePercent}%`}</strong><p>{measuredEvents ? `${onTimeEvents} из ${measuredEvents} завершено вовремя` : 'Появится после первой завершённой работы или поставки'}</p></div></article>
        <article><span><Banknote size={18} /></span><div><small>Принято / оплачено</small><strong>{money(accepted)}</strong><p>{money(paid)} фактически оплачено</p></div></article>
        <article><span><BriefcaseBusiness size={18} /></span><div><small>Активно сейчас</small><strong>{activeItems}</strong><p>обязательств на {money(obligations)}</p></div></article>
        <article className={reworkCount ? 'counterparty-metric--warning' : ''}><span><ShieldCheck size={18} /></span><div><small>Качество</small><strong>{reworkCount ? `${reworkCount} доработка` : 'Без замечаний'}</strong><p>по связанным принятым этапам</p></div></article>
      </div>

      <div className="counterparty-contact-strip">
        <span><BriefcaseBusiness size={15} /> {profile?.contactName ?? 'Контактное лицо не заполнено'}</span>
        <span><Phone size={15} /> {profile?.phone ?? 'Телефон не заполнен'}</span>
        <span><Mail size={15} /> {profile?.email ?? 'Email не заполнен'}</span>
        <span><Building2 size={15} /> {profile?.inn ? `ИНН ${profile.inn}` : 'Реквизиты не заполнены'}</span>
      </div>

      <div className="counterparty-requisites"><div><small>Юридическое лицо</small><strong>{profile?.legalName ?? 'Не заполнено'}</strong></div><div><small>ИНН / КПП</small><strong>{profile?.inn ? `${profile.inn}${profile.kpp ? ` / ${profile.kpp}` : ''}` : 'Не заполнено'}</strong></div><div><small>Расчётный счёт</small><strong>{profile?.settlementAccount ?? 'Не заполнено'}</strong></div><div><small>Банк / БИК</small><strong>{profile?.bankName || profile?.bik ? `${profile.bankName ?? ''}${profile.bankName && profile.bik ? ' · ' : ''}${profile.bik ?? ''}` : 'Не заполнено'}</strong></div></div>
      <div className="counterparty-terms"><span><small>Условия оплаты</small><strong>{profile?.paymentTerms ?? 'Не заполнены'}</strong></span><span><small>Гарантия</small><strong>{profile?.warrantyTerms ?? 'Не заполнена'}</strong></span><span><small>Регион</small><strong>{profile?.serviceRegion ?? 'Не заполнен'}</strong></span><span><small>Ответственный внутри</small><strong>{profile?.internalOwner ?? 'Не назначен'}</strong></span></div>

      <section className="counterparty-section">
        <div className="counterparty-section__title"><span><BriefcaseBusiness size={18} /></span><div><small>Производство</small><h3>Работы и этапы</h3></div><strong>{stages.length}</strong></div>
        <div className="counterparty-history">
          {stages.map((stage) => <article key={stage.id}><span className="counterparty-history__icon"><Clock3 size={17} /></span><div><strong>{stage.name}</strong><small>План: {formatDate(stage.planStart)} — {formatDate(stage.planEnd)} · {stage.actualEnd ? `завершено ${formatDate(stage.actualEnd)}` : `прогноз ${formatDate(stage.forecastEnd)}`}</small></div><div className="counterparty-history__right"><StatusBadge label={stageLabels[stage.status]} tone={stage.status === 'accepted' ? 'positive' : stage.status === 'rework' || stage.status === 'blocked' ? 'danger' : 'blue'} /><small>{stage.progress}%</small></div></article>)}
          {!stages.length && <p className="counterparty-empty">Связанных этапов пока нет.</p>}
        </div>
      </section>

      <section className="counterparty-section">
        <div className="counterparty-section__title"><span><FileText size={18} /></span><div><small>Документооборот</small><h3>Договоры, акты, счета, ТН и УПД</h3></div><strong>{documents.length}</strong></div>
        <div className="counterparty-history">
          {documents.map((document) => <article key={document.id}><span className="counterparty-history__icon"><FileText size={17} /></span><div><strong>{document.name}</strong><small>{document.category ? documentLabels[document.category] : document.type}{document.number ? ` · ${document.number}` : ''}{document.direction === 'incoming' ? ' · получен' : document.direction === 'outgoing' ? ' · отправлен' : ''}</small><small>{document.storageLocation ? `Хранится: ${document.storageLocation}` : 'Место хранения не указано'}</small></div><div className="counterparty-history__right"><StatusBadge label={document.status === 'signed' ? 'Подписан' : document.status === 'current' ? 'Актуален' : 'Черновик'} tone={document.status === 'signed' ? 'positive' : document.status === 'current' ? 'blue' : 'neutral'} /><small>{document.signedAt ? `подписан ${formatDate(document.signedAt)}` : document.receivedAt ? `получен ${formatDate(document.receivedAt)}` : document.sentAt ? `отправлен ${formatDate(document.sentAt)}` : formatDate(document.updatedAt)}</small></div></article>)}
          {!documents.length && <p className="counterparty-empty">Связанных документов пока нет. Добавьте договор, акт, счёт, ТН или УПД.</p>}
        </div>
      </section>

      <section className="counterparty-section">
        <div className="counterparty-section__title"><span><Truck size={18} /></span><div><small>Снабжение</small><h3>Заказы и поставки</h3></div><strong>{procurement.length}</strong></div>
        <div className="counterparty-history">
          {procurement.map((item) => <article key={item.id}><span className="counterparty-history__icon"><PackageCheck size={17} /></span><div><strong>{item.item}</strong><small>{item.quantity} {item.unit} · нужно {formatDate(item.neededBy)}{item.deliveredAt ? ` · доставлено ${formatDate(item.deliveredAt)}` : ''}</small>{item.risk && <em><CircleAlert size={13} /> {item.risk}</em>}</div><div className="counterparty-history__right"><strong>{money(item.budget)}</strong><StatusBadge label={supplyLabels[item.status]} tone={item.risk ? 'warning' : ['accepted', 'issued'].includes(item.status) ? 'positive' : 'neutral'} /></div></article>)}
          {!procurement.length && quotes.map((quote) => <article key={quote.id}><span className="counterparty-history__icon"><PackageCheck size={17} /></span><div><strong>Предложение: {state.procurement.find((item) => item.id === quote.procurementItemId)?.item ?? 'Закупка'}</strong><small>{quote.paymentTerms} · срок {quote.deliveryDays} дн.</small></div><div className="counterparty-history__right"><strong>{money(quote.amount)}</strong><StatusBadge label={quote.status === 'selected' ? 'Выбрано' : quote.status === 'rejected' ? 'Отклонено' : 'Получено'} tone={quote.status === 'selected' ? 'positive' : 'neutral'} /></div></article>)}
          {!procurement.length && !quotes.length && <p className="counterparty-empty">Заказов и предложений пока нет.</p>}
        </div>
      </section>

      <section className="counterparty-section">
        <div className="counterparty-section__title"><span><Banknote size={18} /></span><div><small>Финансы</small><h3>Обязательства и оплаты</h3></div><strong>{financeEntries.length}</strong></div>
        <div className="counterparty-history">
          {financeEntries.map((entry) => {
            const row = <><span className="counterparty-history__icon"><Banknote size={17} /></span><div><strong>{entry.description}</strong><small>{formatDate(entry.date, true)} · {entry.document ?? 'без документа'}</small></div><div className="counterparty-history__right"><strong>{entry.kind === 'income' ? '+' : '−'}{money(entry.amount)}</strong><StatusBadge label={financeLabels[entry.status]} tone={entry.status === 'paid' ? 'positive' : entry.status === 'accepted' ? 'blue' : 'neutral'} /></div></>;
            return onOpenFinanceEntry ? <button type="button" key={entry.id} onClick={() => onOpenFinanceEntry(entry.id)}>{row}</button> : <article key={entry.id}>{row}</article>;
          })}
          {!financeEntries.length && <p className="counterparty-empty">Финансовых операций пока нет.</p>}
        </div>
      </section>

      <div className="counterparty-footnote"><CircleAlert size={16} /><span>Надёжность считается только по зафиксированным фактам: завершённым этапам и поставкам с датой доставки. Чем больше данных пройдёт через СтройОС, тем точнее будет история.</span>{ordered > 0 && <strong>Объём заказов: {money(ordered)}</strong>}</div>
    </Modal>
  );
}
