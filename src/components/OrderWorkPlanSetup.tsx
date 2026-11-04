import { useRef, useState } from 'react';
import type { AppState, UserRole } from '../entities/index';
import { buildStages } from '../seed';
import { uid } from '../infrastructure/runtime';
import { commitStateChange, type StateChangeSink } from '../application/state-change';
import { prepareOrderRelationsUpdate } from '../domain/order-relations.js';
import { validPlanDate } from '../domain/construction/index.js';
import { OrderEditorModal, type OrderEditorField } from './customer-orders/OrderEditorModal';

const fingerprint = (state: AppState) => JSON.stringify([state.project.id, state.project.startDate, state.stages, state.orderRelations]);
export function OrderWorkPlanSetup({ state, role, actor, onChange }: { state: AppState; role: UserRole; actor: string; onChange: StateChangeSink }) {
  const latest = useRef(state); latest.current = state;
  const [expected, setExpected] = useState<string | null>(null);
  if (role !== 'management' || !state.orderRelations || ['canceled', 'completed', 'on_hold'].includes(state.orderRelations.status)) return null;
  const fields: OrderEditorField[] = [
    { name: 'template', label: 'Состав плана', type: 'select', required: true, options: [{ value: 'single', label: 'Один свой этап' }, ...(!state.stages.length ? [{ value: 'house', label: 'Шаблон строительства — 13 этапов' }] : [])] },
    { name: 'title', label: 'Название своего этапа', hint: 'Для шаблона используются названия его 13 этапов.' },
    { name: 'startDate', label: 'Плановое начало работ', type: 'date', required: true },
    { name: 'endDate', label: 'Плановое окончание работ', type: 'date', required: true, hint: 'Это план работ. Срок сдачи по договору задаётся отдельно.' },
    { name: 'objectId', label: 'Объект этого заказа', type: 'select', options: state.orderRelations.objects.map(object => ({ value: object.id, label: object.title })) },
    { name: 'dependencyId', label: 'Предшествующий этап', type: 'select', options: state.stages.map(stage => ({ value: stage.id, label: stage.name })) },
    { name: 'source', label: 'Источник и основание плана', type: 'textarea', required: true },
  ];
  return <section className="panel">
    <h3>{state.stages.length ? 'Дополнить план работ' : 'Составить план нового заказа'}</h3>
    <p>Добавьте свой этап или стартовый шаблон. Даты выполнения, приёмка и платежи заполняются по фактам отдельно.</p>
    <button type="button" className="button button--secondary" onClick={() => setExpected(fingerprint(state))}>{state.stages.length ? 'Добавить этап' : 'Добавить план работ'}</button>
    {expected !== null && <OrderEditorModal title="Добавить работы в заказ" fields={fields} initialValues={{ template: 'single', title: '', startDate: '', endDate: '', objectId: '', dependencyId: '', source: '' }} submitLabel="Добавить работы" onClose={() => setExpected(null)} onSubmit={values => {
      const current = latest.current;
      if (fingerprint(current) !== expected || !current.orderRelations) throw new Error('План или связи изменились. Откройте форму заново.');
      if (!validPlanDate(values.startDate) || !validPlanDate(values.endDate) || values.endDate < values.startDate) throw new Error('Укажите корректные сроки работ.');
      if (!values.source.trim()) throw new Error('Укажите источник плана.');
      const template = values.template === 'house';
      if (template && (current.stages.length || (Date.parse(values.endDate) - Date.parse(values.startDate)) / 86400000 < 13)) throw new Error('Шаблон доступен для пустого плана с периодом не менее 13 календарных дней.');
      if (!template && !values.title.trim()) throw new Error('Укажите название этапа.');
      const additions = template ? buildStages(values.startDate, values.endDate, '', false) : [{
        id: uid('stage'), order: Math.max(0, ...current.stages.map(stage => stage.order)) + 1, name: values.title.trim(), shortName: values.title.trim(), status: 'not_ready' as const,
        weight: 1, progress: 0, planStart: values.startDate, planEnd: values.endDate, forecastEnd: values.endDate, responsible: 'Не назначен',
        dependencyId: values.dependencyId || undefined, dependency: current.stages.find(stage => stage.id === values.dependencyId)?.shortName,
      }];
      const candidate: AppState = { ...current, stages: [...current.stages, ...additions], project: { ...current.project,
        ...(!current.project.startDate ? { startDate: values.startDate, planChangeReason: values.source.trim() } : {}),
      } };
      if (values.objectId) {
        const nextRelations = structuredClone(current.orderRelations);
        nextRelations.links.push(...additions.map(stage => ({ id: uid('link'), kind: 'stage' as const, entityId: stage.id, objectId: values.objectId })));
        const prepared = prepareOrderRelationsUpdate(candidate, nextRelations, { role, name: actor }, values.source.trim());
        if (!prepared.ok) throw new Error(prepared.error);
        candidate.orderRelations = prepared.orderRelations;
      }
      const timestamp = new Date().toISOString();
      candidate.activity = [{ id: uid('activity'), timestamp, actor, text: `Добавлены работы: ${additions.length}. ${values.source.trim()}`, tone: 'neutral' }, ...current.activity];
      commitStateChange({ state: candidate, action: 'order_work_plan_added', summary: `Добавлены работы: ${additions.length}. ${values.source.trim()}` }, onChange);
      setExpected(null);
    }} />}
  </section>;
}
