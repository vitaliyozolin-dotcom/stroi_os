import { useState } from 'react';
import type { AppState, Stage } from '../entities/index';
import { PersonField } from './ProjectAssignments';

const steps = [
  ['power', 'Подключить электричество или установить генератор', 'Площадка обеспечена электричеством'],
  ['housing', 'Установить бытовку', 'Бытовка готова к работе'],
  ['crew', 'Назначить бригаду и согласовать дату выхода', 'Бригада и дата выхода согласованы'],
  ['access', 'Обеспечить подъезд и подготовить место разгрузки', 'Транспорт может подъехать и разгрузиться'],
  ['storage', 'Подготовить место хранения материалов', 'Место хранения готово'],
] as const;

export function SitePreparationSteps({ stage, state, canEdit, canAssign, onChange }: { stage: Stage; state: AppState; canEdit: boolean; canAssign: boolean; onChange: (state: AppState) => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [owner, setOwner] = useState('');
  const people = state.settings.users.filter(user => user.status === 'active' && user.role !== 'client').map(user => user.name);
  const save = (key: string, patch: { owner?: string; done?: boolean }) => {
    const siteChecks = { ...stage.siteChecks, [key]: { ...stage.siteChecks?.[key], ...patch } };
    onChange({ ...state, stages: state.stages.map(row => row.id === stage.id ? { ...row, siteChecks } : row) });
  };
  return <details open><summary>Готовность площадки</summary><ul className="preparation-steps">
    {steps.map(([key, title, result]) => {
      const item = stage.siteChecks?.[key];
      const name = item?.owner || stage.responsible || 'Не назначен';
      return <li key={key} className="preparation-step">
        <div className="preparation-step__row"><div className="site-preparation-task">
          <strong>{item?.done ? result : title}</strong>
          {canAssign ? <button className="text-button" type="button" aria-label={`Ответственный · ${title}`} onClick={() => { setEditing(key); setOwner(item?.owner || ''); }}>{name}</button> : <small>{name}</small>}
        </div>{canEdit ? <button type="button" className="button button--secondary" aria-pressed={Boolean(item?.done)} onClick={() => save(key, { done: !item?.done })}>{item?.done ? 'Выполнено' : 'Готово'}</button> : <small>{item?.done ? 'Выполнено' : 'В работе'}</small>}</div>
        {canAssign && editing === key && <form className="preparation-step__details modal-form" onSubmit={event => { event.preventDefault(); save(key, { owner: owner.trim() }); setEditing(null); }}>
          <PersonField label="Ответственный за подэтап" people={people} value={owner} onChange={setOwner} /><button className="text-button" type="submit">Сохранить</button>
        </form>}
      </li>;
    })}
  </ul></details>;
}
