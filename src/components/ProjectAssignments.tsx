import { useId, useState } from 'react';
import type { AppState, UserRole } from '../entities/index';
import { projectLead } from '../domain/project-lifecycle.js';
import { Field } from './Ui';

export function PersonField({ label, value, people, onChange }: { label: string; value: string; people: string[]; onChange: (value: string) => void }) {
  const listId = useId();
  return <Field label={label}><input list={listId} maxLength={160} value={value} placeholder="Имя и фамилия" onChange={event => onChange(event.target.value)} />
    <datalist id={listId}>{[...new Set(people.filter(Boolean))].map(name => <option key={name} value={name} />)}</datalist></Field>;
}

export function ProjectAssignments({ state, role, onChange }: { state: AppState; role: UserRole; onChange: (next: AppState) => void }) {
  const lead = projectLead(state);
  const owner = state.project.leadOwner ?? lead?.owner ?? '';
  const manager = state.project.projectManager ?? lead?.projectManager ?? '';
  const [draft, setDraft] = useState<null | { owner: string; manager: string }>(null);
  const people = state.settings.users.filter(user => user.status === 'active' && user.role !== 'client').map(user => user.name);
  const save = () => {
    if (!draft) return;
    const leadOwner = draft.owner.trim(), projectManager = draft.manager.trim();
    onChange({ ...state, project: { ...state.project, leadOwner, projectManager },
      leads: state.leads.map(row => row.id === lead?.id ? { ...row, owner: leadOwner, projectManager } : row) });
    setDraft(null);
  };
  return <section className="project-assignments" aria-label="Ответственные по проекту">
    {draft && role === 'management' ? <form className="modal-form" onSubmit={event => { event.preventDefault(); save(); }}>
      <div className="form-grid"><PersonField label="Чей лид" value={draft.owner} people={people} onChange={owner => setDraft({ ...draft, owner })} />
        <PersonField label="Менеджер проекта" value={draft.manager} people={people} onChange={manager => setDraft({ ...draft, manager })} /></div>
      <div className="stage-quick__actions"><button type="submit" className="button button--secondary">Сохранить</button><button type="button" className="text-button" onClick={() => setDraft(null)}>Отмена</button></div>
    </form> : <><dl>{role === 'management' && <div><dt>Чей лид</dt><dd>{owner || 'Не указан'}</dd></div>}
      <div><dt>Менеджер проекта</dt><dd>{manager || 'Не назначен'}</dd></div></dl>
      {role === 'management' && <button type="button" className="text-button" onClick={() => setDraft({ owner, manager })}>Изменить</button>}</>}
  </section>;
}
