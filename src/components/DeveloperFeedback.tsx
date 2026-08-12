import { useMemo, useState, type FormEvent } from 'react';
import { CheckCircle2, CircleDot, Code2, MessageSquarePlus, RotateCcw } from 'lucide-react';
import { uid } from '../domain';
import type { AppState, DeveloperRequest, PageId } from '../types';
import { Field, Modal, StatusBadge } from './Ui';

const priorityLabels = { normal: 'Обычная', important: 'Важная', critical: 'Критичная' } as const;
const statusLabels = { new: 'Новая', in_progress: 'В работе', done: 'Готово' } as const;

export function DeveloperFeedback({ state, actor, page, onChange, onOpenTraining }: {
  state: AppState;
  actor: string;
  page: PageId;
  onChange: (next: AppState) => void;
  onOpenTraining: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState({ title: '', description: '', priority: 'normal' as DeveloperRequest['priority'] });
  const requests = useMemo(() => [...state.developerRequests].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [state.developerRequests]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!form.title.trim() || !form.description.trim()) return;
    const request: DeveloperRequest = {
      id: uid('developer-request'),
      createdAt: new Date().toISOString(),
      createdBy: actor,
      title: form.title.trim(),
      description: form.description.trim(),
      page,
      priority: form.priority,
      status: 'new',
    };
    onChange({
      ...state,
      developerRequests: [request, ...state.developerRequests],
      activity: [{ id: uid('activity'), timestamp: request.createdAt, actor, text: `Правка разработчику: ${request.title}`, tone: request.priority === 'critical' ? 'warning' : 'neutral' }, ...state.activity],
    });
    setForm({ title: '', description: '', priority: 'normal' });
    setFormOpen(false);
  };

  const cycleStatus = (request: DeveloperRequest) => {
    const status = request.status === 'new' ? 'in_progress' : request.status === 'in_progress' ? 'done' : 'new';
    onChange({ ...state, developerRequests: state.developerRequests.map((item) => item.id === request.id ? { ...item, status } : item) });
  };

  return <>
    <button type="button" className="help-fab developer-fab" aria-label="Правки разработчику" title="Правки разработчику" onClick={() => setOpen(true)}><Code2 size={23} /></button>
    {open && <Modal wide title="Правки разработчику" subtitle="Замечания сохраняются в проекте, не теряются в чатах и видны со статусом выполнения." onClose={() => setOpen(false)}>
      <div className="developer-feedback__toolbar">
        <button type="button" className="button button--primary" onClick={() => setFormOpen(true)}><MessageSquarePlus size={17} /> Добавить правку</button>
        <button type="button" className="button button--ghost" onClick={() => { setOpen(false); onOpenTraining(); }}><RotateCcw size={16} /> Открыть обучение</button>
      </div>
      <div className="developer-request-list">
        {requests.map((request) => <button type="button" className="developer-request" key={request.id} onClick={() => cycleStatus(request)} title="Нажмите, чтобы изменить статус">
          <span>{request.status === 'done' ? <CheckCircle2 size={20} /> : <CircleDot size={20} />}</span>
          <div><strong>{request.title}</strong><p>{request.description}</p><small>{request.createdBy} · экран «{request.page}» · {new Intl.DateTimeFormat('ru-RU').format(new Date(request.createdAt))}</small></div>
          <span><StatusBadge label={priorityLabels[request.priority]} tone={request.priority === 'critical' ? 'danger' : request.priority === 'important' ? 'warning' : 'neutral'} /><StatusBadge label={statusLabels[request.status]} tone={request.status === 'done' ? 'positive' : request.status === 'in_progress' ? 'blue' : 'neutral'} /></span>
        </button>)}
        {!requests.length && <div className="task-empty"><Code2 size={28} /><strong>Правок пока нет</strong><p>Добавьте конкретное замечание — экран, автор и дата зафиксируются автоматически.</p></div>}
      </div>
    </Modal>}
    {formOpen && <Modal title="Новая правка" subtitle={`Будет привязана к текущему экрану: ${page}.`} onClose={() => setFormOpen(false)}><form className="modal-form" onSubmit={submit}>
      <Field label="Что исправить"><input required value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="Короткое название проблемы" /></Field>
      <Field label="Как должно работать"><textarea required rows={5} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} placeholder="Что происходит сейчас и какой результат ожидается" /></Field>
      <Field label="Приоритет"><select value={form.priority} onChange={(event) => setForm({ ...form, priority: event.target.value as DeveloperRequest['priority'] })}>{Object.entries(priorityLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></Field>
      <div className="modal__actions"><button type="button" className="button button--ghost" onClick={() => setFormOpen(false)}>Отмена</button><button type="submit" className="button button--primary">Сохранить правку</button></div>
    </form></Modal>}
  </>;
}
