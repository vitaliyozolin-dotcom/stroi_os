import { useEffect, useRef, useState } from 'react';
import type { AppState, OrderDirectoryRecord } from '../entities/index';
import { buildStages, createDraftOrderState, createProjectState } from '../seed';
import { emptyOrderRelations } from '../domain/order-relations.js';
import { uid } from '../infrastructure/runtime';
import { fetchOrderDirectory, saveOrderDirectoryRecord } from '../infrastructure/order-directory';
import { OrderEditorModal, type OrderEditorField } from '../components/customer-orders/OrderEditorModal';
import { orderMoneyInput, orderNumberInput } from './customer-order-forms';
import '../pages/customer-orders.css';

export function CreateProjectDialog({ state, actor, nextCode, initialCustomerId, onClose, onCreate }: {
  state: AppState; actor: string; nextCode: string; initialCustomerId?: string;
  onClose: () => void; onCreate: (next: AppState) => Promise<void>;
}) {
  const [template, setTemplate] = useState(false);
  const [records, setRecords] = useState<OrderDirectoryRecord[]>([]);
  const [directoryError, setDirectoryError] = useState('');
  const [started, setStarted] = useState(false);
  const attempt = useRef<AppState | null>(null);
  const partyId = useRef(uid('party'));
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetchOrderDirectory(state.project.id, controller.signal).then(result => setRecords(result.records)).catch(error => {
      if (!controller.signal.aborted) setDirectoryError(error instanceof Error ? error.message : 'Не удалось загрузить заказчиков.');
    });
    return () => { controller.abort(); request.current?.abort(); };
  }, [state.project.id]);

  const fields: OrderEditorField[] = ([
    { name: 'code', label: 'Номер заказа', required: true },
    { name: 'name', label: 'Название заказа', required: true, placeholder: 'Дом и баня для семьи Ивановых' },
    { name: 'customerId', label: 'Заказчик из справочника', type: 'select', options: records.filter(record => record.kind === 'party').map(record => ({ value: record.id, label: record.data.name })), hint: 'Можно выбрать позже. Повторный заказ связывайте с той же карточкой.' },
    { name: 'newCustomerName', label: 'Имя нового заказчика', hint: 'Заполните, если заказчика ещё нет в справочнике.' },
    { name: 'address', label: 'Адрес', hint: 'Можно уточнить позже' },
    { name: 'source', label: 'Основание', placeholder: 'Заявка, договор или внутреннее решение' },
    ...(template ? [
      { name: 'model', label: 'Модель / технология' },
      { name: 'area', label: 'Площадь, м²', type: 'number', required: true, min: 0.01 },
      { name: 'contractValue', label: 'Стоимость договора, ₽', type: 'money', hint: 'Пусто — ещё не определена' },
      { name: 'targetCost', label: 'Плановая себестоимость, ₽', type: 'money', hint: 'Пусто — сметы пока нет' },
      { name: 'startDate', label: 'Начало', type: 'date', required: true },
      { name: 'targetDate', label: 'Плановая сдача', type: 'date', required: true },
      { name: 'foreman', label: 'Прораб' },
    ] satisfies OrderEditorField[] : []),
  ] satisfies OrderEditorField[]).map(field => ({ ...field, disabled: started }));

  return <OrderEditorModal title="Новый заказ" subtitle="Черновик можно создать до выбора участка, согласования стоимости и сроков."
    fields={fields} initialValues={{ code: nextCode, customerId: initialCustomerId ?? '' }}
    submitLabel={started ? 'Повторить сохранение заказа' : 'Создать заказ'} onClose={onClose}
    summary={<>
      <label className="field"><span><input type="checkbox" disabled={started} checked={template} onChange={event => setTemplate(event.target.checked)} /> Добавить шаблон строительства с 13 этапами</span><small>{template ? 'Сроки и площадь обязательны для шаблона. Плановая смета останется черновиком.' : 'Создастся пустой заказ. Участников, объекты и условия можно добавить в его карточке.'}</small></label>
      {directoryError && <p role="alert">{directoryError} Можно создать заказ без привязки и выбрать заказчика позже.</p>}
      {started && <p role="status">Повторная отправка использует ту же запись. Если ответ сервера потерялся, второй заказ создан не будет.</p>}
    </>}
    onSubmit={async values => {
      if (attempt.current) { await onCreate(attempt.current); return; }
      if (!values.code?.trim() || !values.name?.trim()) throw new Error('Укажите номер и название заказа.');
      if (values.customerId && values.newCustomerName?.trim()) throw new Error('Выберите существующего заказчика либо укажите имя нового.');
      const area = template ? orderNumberInput(values.area ?? '', 'Площадь') : undefined;
      const contractCents = template ? orderMoneyInput(values.contractValue ?? '') : undefined;
      const costCents = template ? orderMoneyInput(values.targetCost ?? '') : undefined;
      if (template && (!area || area <= 0 || !values.startDate || !values.targetDate || values.targetDate < values.startDate)) throw new Error('Для шаблона укажите положительную площадь и дату сдачи не раньше начала.');
      if (template && (Date.parse(values.targetDate) - Date.parse(values.startDate)) / 86400000 < 13) throw new Error('Шаблону 13 этапов нужен плановый период не менее 13 календарных дней.');
      let customerId = values.customerId || undefined;
      let customerName = records.find(record => record.id === customerId && record.kind === 'party')?.data.name ?? '';
      if (values.newCustomerName?.trim()) {
        const controller = new AbortController(); request.current = controller;
        const name = values.newCustomerName.trim();
        try {
          await saveOrderDirectoryRecord(state.project.id, { record: { id: partyId.current, kind: 'party', data: { name, partyType: 'person' } }, expectedRevision: 0, reason: 'Заказчик для нового заказа' }, controller.signal);
        } catch (error) {
          const current = await fetchOrderDirectory(state.project.id, controller.signal).catch(() => null);
          if (!current?.records.some(record => record.id === partyId.current && record.kind === 'party' && record.data.name === name)) throw error;
        }
        customerId = partyId.current; customerName = name;
      }
      const next = template
        ? createProjectState(state, { code: values.code, name: values.name, address: values.address ?? '', source: values.source ?? '', model: values.model ?? '', area: area!, clientNames: customerName, contractValue: (contractCents ?? 0) / 100, targetCost: (costCents ?? 0) / 100, startDate: values.startDate, targetDate: values.targetDate, foreman: values.foreman ?? '', actor })
        : createDraftOrderState(state, { code: values.code, name: values.name, address: values.address, source: values.source, customerId, customerName, actor });
      if (template) {
        next.project.status = 'draft';
        next.stages = buildStages(values.startDate, values.targetDate, values.foreman ?? '', false);
        next.project.creationRequestId = uid('create');
        next.project.unknownFields = [...(contractCents === undefined ? ['contractValue' as const] : []), ...(costCents === undefined ? ['targetCost' as const] : [])];
        next.counterparties = [];
        if (costCents === undefined) next.budgetLines = [];
        next.orderRelations = { ...emptyOrderRelations(), ...(customerId ? { customerId } : {}) };
      }
      attempt.current = next; setStarted(true);
      await onCreate(next);
    }} />;
}
