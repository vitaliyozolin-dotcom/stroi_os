import { useEffect, useState, type FormEvent } from 'react';
import { requestApi } from '../infrastructure/api-http';
import { financeQuestions } from '../presentation/finance-questions';
import { Field, Modal } from './Ui';

type Question = { id: string; title: string; details: string; page: string; status: string; createdAt: string; createdBy: string };

export function QuestionRegistry({ projectId, currentPage, onClose }: { projectId: string; currentPage: string; onClose: () => void }) {
  const [items, setItems] = useState<Question[]>([]);
  const [form, setForm] = useState({ title: '', details: '' });
  const [filter, setFilter] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);

  const readQuestions = async (start: number, signal?: AbortSignal) => {
    setLoading(true);
    setStatus('');
    try {
      const response = await requestApi(`/api/developer-feedback?projectId=${encodeURIComponent(projectId)}&category=${encodeURIComponent('Вопрос')}&offset=${start}`, { signal });
      const body = await response.json() as { items?: Question[]; hasMore?: boolean };
      if (!response.ok || !body.items) throw new Error();
      if (signal?.aborted) return;
      setItems((previous) => start ? [...previous, ...body.items!].filter((item, index, all) => all.findIndex((other) => other.id === item.id) === index) : body.items!);
      setOffset(start + body.items.length);
      setHasMore(Boolean(body.hasMore));
    } catch { if (!signal?.aborted) setStatus('Не удалось загрузить вопросы. Повторите загрузку.'); }
    finally { if (!signal?.aborted) setLoading(false); }
  };
  useEffect(() => {
    const controller = new AbortController();
    setItems([]);
    setOffset(0);
    void readQuestions(0, controller.signal);
    return () => controller.abort();
  }, [projectId]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving || !form.title.trim() || !form.details.trim()) return;
    setSaving(true);
    setStatus('');
    try {
      const response = await requestApi('/api/developer-feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId, page: currentPage, category: 'Вопрос', ...form }) });
      const body = await response.json() as { item?: Question };
      if (!response.ok || !body.item) throw new Error();
      setItems((previous) => [body.item!, ...previous]);
      setOffset((previous) => previous + 1);
      setForm({ title: '', details: '' });
      setStatus('Вопрос сохранён в реестре для подготовки подсказки.');
    } catch { setStatus('Не удалось сохранить вопрос. Текст остался в форме — повторите отправку.'); }
    finally { setSaving(false); }
  };
  const matches = (value: string) => value.toLocaleLowerCase('ru').includes(filter.trim().toLocaleLowerCase('ru'));
  return <Modal wide title="Вопросы и подсказки" subtitle="Общие ответы по системе и отдельная очередь вопросов этого проекта для будущих подсказок." onClose={onClose}>
    <div className="question-registry">
      <Field label="Поиск по загруженным вопросам"><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Например: кто утверждает расходы" /></Field>
      <section aria-label="Ответы по системе">{financeQuestions.filter((item) => matches(`${item.title} ${item.answer}`)).map((item) => <article className="question-card" key={item.id}><small>{item.pending ? 'Требует решения' : 'Ответ готов'} · {item.category || 'Финансы'}</small><h3>{item.title}</h3><p>{item.answer}</p><small>Место подсказки: {item.target}</small></article>)}</section>
      <section aria-label="Вопросы проекта"><h3>Вопросы проекта</h3>{items.filter((item) => matches(`${item.title} ${item.details}`)).map((item) => <article className="question-card" key={item.id}><small>{item.status === 'new' ? 'Ожидает ответа и подсказки' : item.status} · {item.page}</small><h3>{item.title}</h3><p>{item.details}</p><small>{item.createdBy} · {new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short' }).format(new Date(item.createdAt))}</small></article>)}{!loading && !items.length && !status && <p>Новых вопросов по этому проекту пока нет. Добавьте первый ниже.</p>}{loading && <p role="status">Загружаем вопросы…</p>}{hasMore && <button type="button" className="button button--secondary" disabled={loading} onClick={() => void readQuestions(offset)}>Показать ещё</button>}</section>
      <form className="modal-form" onSubmit={submit}><h3>Добавить вопрос для подсказки</h3><Field label="Вопрос"><input required maxLength={160} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></Field><Field label="Где возник вопрос и что непонятно"><textarea required maxLength={3000} rows={3} value={form.details} onChange={(event) => setForm({ ...form, details: event.target.value })} /></Field><button type="submit" className="button button--primary" disabled={saving}>{saving ? 'Сохраняем…' : 'Сохранить вопрос'}</button></form>
      {status && <p role="status">{status}{status.startsWith('Не удалось загрузить') && <button type="button" className="text-button" onClick={() => void readQuestions(0)}>Повторить</button>}</p>}
    </div>
  </Modal>;
}
