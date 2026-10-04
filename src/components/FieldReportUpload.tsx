import { useRef, useState, type FormEvent } from 'react';
import type { AppState, FieldReport } from '../entities/index';
import { requestApi } from '../infrastructure/api-http';
import { planToday } from '../../sites/lib/plan-baseline.js';
import { Field, Modal } from './Ui';

export function FieldReportUpload({ state, actor, onChange, onClose }: { state: AppState; actor: string; onChange: (state: AppState) => void; onClose: () => void }) {
  const latest = useRef(state); latest.current = state;
  const [files, setFiles] = useState<File[]>([]);
  const [date, setDate] = useState(planToday());
  const [note, setNote] = useState('');
  const [stageId, setStageId] = useState('');
  const [sourceLink, setSourceLink] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !files.length) return;
    setError('');
    if (files.length > 10 || files.some(file => file.size > 12 * 1024 * 1024 || !/^image\/(jpeg|png|webp)$/.test(file.type))) { setError('До 10 фото JPG, PNG или WebP, каждое до 12 МБ.'); return; }
    if (sourceLink && !/^https:\/\/t\.me\//.test(sourceLink)) { setError('Укажите ссылку на сообщение t.me или оставьте поле пустым.'); return; }
    if (sourceLink && state.fieldReports.some(report => report.note.includes(sourceLink))) { setError('Отчёт из этого сообщения уже добавлен.'); return; }
    setBusy(true);
    try {
      const attachments: FieldReport['attachments'] = [];
      for (const file of files) {
        const payload = new FormData(); payload.append('file', file);
        const response = await requestApi('/api/documents/upload?projectId=' + encodeURIComponent(state.project.id), { method: 'POST', body: payload });
        const body = await response.json();
        if (!response.ok || !body.file) throw new Error('Не удалось загрузить ' + file.name);
        attachments.push({ id: crypto.randomUUID(), key: body.file.key, name: body.file.name, mimeType: body.file.type, sizeBytes: body.file.size, uploadedAt: body.file.uploadedAt, uploadedBy: actor, source: 'web' });
      }
      if (latest.current.project.id !== state.project.id) throw new Error('Проект изменился. Откройте нужный объект и повторите.');
      const next = structuredClone(latest.current);
      if (sourceLink && next.fieldReports.some(report => report.note.includes(sourceLink))) throw new Error('Отчёт из этого сообщения уже добавлен.');
      const now = new Date().toISOString();
      next.fieldReports.unshift({ id: crypto.randomUUID(), createdAt: date + 'T12:00:00+03:00', author: actor, note: note.trim() + (sourceLink ? '\nИсточник: ' + sourceLink : ''), source: 'web', stageId: stageId || undefined, clientVisible: false, attachments });
      next.activity.unshift({ id: crypto.randomUUID(), timestamp: now, actor, text: 'Добавлен фотоотчёт за ' + date + ': ' + files.length + ' фото', tone: 'neutral' });
      onChange(next); onClose();
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось сохранить отчёт'); } finally { setBusy(false); }
  };
  return <Modal title="Фото со стройки" subtitle="Снимки сохраняются в проекте и появляются на главной." onClose={() => { if (!busy) onClose(); }}>
    <form className="modal-form" onSubmit={submit}>
      <Field label="Фотографии"><input aria-label="Фотографии" type="file" accept="image/jpeg,image/png,image/webp" multiple required disabled={busy} onChange={event => setFiles(Array.from(event.target.files || []))} /></Field>
      <Field label="Дата съёмки"><input aria-label="Дата съёмки" type="date" value={date} max={planToday()} required disabled={busy} onChange={event => setDate(event.target.value)} /></Field>
      <Field label="Что на фото"><textarea aria-label="Что на фото" value={note} required maxLength={2000} disabled={busy} onChange={event => setNote(event.target.value)} /></Field>
      <Field label="Этап"><select aria-label="Этап фото" value={stageId} disabled={busy} onChange={event => setStageId(event.target.value)}><option value="">Общий вид объекта</option>{state.stages.map(stage => <option key={stage.id} value={stage.id}>{stage.name}</option>)}</select></Field>
      <Field label="Ссылка на сообщение в Telegram, если фото из чата"><input aria-label="Источник фото" value={sourceLink} disabled={busy} onChange={event => setSourceLink(event.target.value)} placeholder="https://t.me/…" /></Field>
      <p className="muted">Фото доступно команде проекта. Статусы этапов и приёмка не меняются.</p>
      {error && <p role="alert" className="danger-text">{error}</p>}
      <button className="button button--primary" disabled={busy || !files.length}>{busy ? 'Загружаем…' : 'Добавить фотоотчёт'}</button>
    </form>
  </Modal>;
}