import { useModuleRepository } from '../useModuleRepository';
import { createDocumentsRepository } from '../infrastructure/module-project';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AppState, UserRole } from '../entities/index';
import { uploadFieldReport } from '../application/field-reports';
import { documentUploader } from '../infrastructure/document-upload';
import { systemClock, runtimeIdGenerator } from '../infrastructure/runtime';
import { planToday } from '../domain/construction/index.js';
import { Field, Modal } from './Ui';

export function FieldReportUpload({ state, actor, role, onChange, onClose }: { state: AppState; actor: string; role: UserRole; onChange: (state: AppState) => void; onClose: () => void }) {
  const documentsRepository = useModuleRepository(createDocumentsRepository, state, onChange);
  const uploadAbort = useRef<AbortController | null>(null);
  useEffect(() => () => { uploadAbort.current?.abort(); }, [state.project.id]);
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
    setBusy(true);
    try {
      const controller = new AbortController(); uploadAbort.current = controller;
      const result = await uploadFieldReport(documentsRepository, { projectId: state.project.id, files, date, note, stageId, sourceLink }, { name: actor, role }, systemClock, runtimeIdGenerator, documentUploader, controller.signal);
      if (!result.ok) throw new Error(result.error);
      onClose();
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
