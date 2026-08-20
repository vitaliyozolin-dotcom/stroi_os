import { createMutationContext, createPageStateSink } from '../application';
import { runtimeIdGenerator, systemClock } from '../infrastructure/runtime';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  Building2,
  CalendarRange,
  Download,
  FileCheck2,
  FileClock,
  FileText,
  FolderOpen,
  HardHat,
  House,
  Image,
  Link2,
  MapPin,
  Mic,
  Plus,
  Search,
  UploadCloud,
  UsersRound,
} from 'lucide-react';
import { formatDate, formatDateTime, uid } from '../domain';
import type { AppState, AuthenticatedUser, ProjectDocument } from '../entities/index';
import type { PageId } from '../presentation/navigation';
import { Field, Modal, SectionHeader, StatusBadge } from '../components/Ui';

const categoryLabels: Record<NonNullable<ProjectDocument['category']>, string> = {
  contract: 'Договор',
  act: 'Акт',
  invoice: 'Счёт',
  upd: 'УПД',
  waybill: 'ТН',
  specification: 'Спецификация',
  other: 'Прочее',
};

const statusLabels: Record<ProjectDocument['status'], string> = {
  draft: 'Черновик',
  current: 'Актуальный',
  signed: 'Подписан',
};

const statusTone = (status: ProjectDocument['status']) => status === 'signed' ? 'positive' as const : status === 'current' ? 'blue' as const : 'neutral' as const;

const readableSize = (bytes?: number) => {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(bytes > 10 * 1024 * 1024 ? 0 : 1)} МБ`;
};

const emptyDocumentForm = () => ({
  name: '',
  category: 'contract' as NonNullable<ProjectDocument['category']>,
  number: '',
  documentDate: new Date().toISOString().slice(0, 10),
  status: 'draft' as ProjectDocument['status'],
  direction: 'incoming' as NonNullable<ProjectDocument['direction']>,
  counterpartyId: '',
  stageId: '',
  clientVisible: false,
});

export function ProjectPage({
  state,
  session,
  focusId,
  onChange,
  onNavigate,
}: {
  state: AppState;
  session: AuthenticatedUser;
  focusId?: string | null;
  onChange: (next: AppState) => void;
  onNavigate: (page: PageId, entityId?: string) => void;
}) {
  const saveChange = createPageStateSink(state, { action: 'document_updated', summary: 'Обновлены документы проекта' }, createMutationContext(session.name, systemClock, runtimeIdGenerator), onChange);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<'all' | NonNullable<ProjectDocument['category']>>('all');
  const [showUpload, setShowUpload] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyDocumentForm);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (focusId && state.documents.some((item) => item.id === focusId)) setSelectedId(focusId);
  }, [focusId, state.documents]);

  const documents = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('ru');
    return [...state.documents]
      .filter((item) => category === 'all' || (item.category ?? 'other') === category)
      .filter((item) => !query || [item.name, item.number, item.type].some((value) => value?.toLocaleLowerCase('ru').includes(query)))
      .sort((a, b) => (b.documentDate ?? b.updatedAt).localeCompare(a.documentDate ?? a.updatedAt));
  }, [category, search, state.documents]);

  const selected = state.documents.find((item) => item.id === selectedId) ?? null;
  const signedCount = state.documents.filter((item) => item.status === 'signed').length;
  const awaitingCount = state.documents.filter((item) => item.status === 'draft').length;
  const activeStages = state.stages.filter((item) => ['in_progress', 'blocked', 'awaiting_inspection', 'rework'].includes(item.status));
  const team = state.settings.users.filter((item) => item.status !== 'disabled');
  const fieldReports = useMemo(() => [...state.fieldReports].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [state.fieldReports]);

  const openFile = (document: ProjectDocument) => {
    if (!document.fileKey) return;
    const url = `/api/documents/file?projectId=${encodeURIComponent(state.project.id)}&key=${encodeURIComponent(document.fileKey)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const openFieldReportFile = (key: string) => {
    const url = `/api/field-reports/file?projectId=${encodeURIComponent(state.project.id)}&key=${encodeURIComponent(key)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const submitUpload = async (event: FormEvent) => {
    event.preventDefault();
    if (!file || uploading) return;
    if (file.size > 20 * 1024 * 1024) {
      setUploadError('Файл больше 20 МБ. Уменьшите его или разделите на несколько документов.');
      return;
    }
    setUploading(true);
    setUploadError('');
    try {
      const payload = new FormData();
      payload.append('file', file);
      const response = await fetch(`/api/documents/upload?projectId=${encodeURIComponent(state.project.id)}`, {
        method: 'POST',
        body: payload,
      });
      const body = await response.json() as {
        file?: { key: string; name: string; type: string; size: number; uploadedAt: string };
        error?: string;
      };
      if (!response.ok || !body.file) throw new Error(body.error ?? 'upload_failed');
      const timestamp = new Date().toISOString();
      const document: ProjectDocument = {
        id: uid('document'),
        name: form.name.trim() || file.name.replace(/\.[^.]+$/, ''),
        type: categoryLabels[form.category],
        category: form.category,
        number: form.number.trim() || undefined,
        documentDate: form.documentDate,
        status: form.status,
        direction: form.direction,
        counterpartyId: form.counterpartyId || undefined,
        stageId: form.stageId || undefined,
        clientVisible: form.clientVisible,
        signedAt: form.status === 'signed' ? timestamp : undefined,
        updatedAt: timestamp,
        storageLocation: `ИКИОМА ОС / ${state.project.code} / Документы`,
        fileKey: body.file.key,
        fileName: body.file.name,
        mimeType: body.file.type,
        sizeBytes: body.file.size,
        uploadedAt: body.file.uploadedAt,
        uploadedBy: session.name,
      };
      saveChange({
        ...state,
        documents: [document, ...state.documents],
        activity: [{
          id: uid('activity'),
          timestamp,
          actor: session.name,
          text: `Загружен документ «${document.name}»`,
          tone: 'neutral',
        }, ...state.activity],
      });
      setShowUpload(false);
      setForm(emptyDocumentForm());
      setFile(null);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      setUploadError(code === 'storage_unavailable'
        ? 'Файловое хранилище ещё не подключено к публикации.'
        : code === 'unsupported_file'
          ? 'Этот формат не поддерживается. Используйте PDF, изображение, Word или Excel.'
          : 'Не удалось загрузить файл. Проверьте связь и повторите.');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="page-stack">
      <section className="page-title-row">
        <div>
          <span className="eyebrow">Единая карточка объекта</span>
          <h1>{state.project.name}</h1>
          <p>{state.project.code} · {state.project.model} · {state.project.area} м²</p>
        </div>
        <button type="button" className="button button--primary" onClick={() => setShowUpload(true)}><UploadCloud size={17} /> Загрузить документ</button>
      </section>

      <section className="project-hero-grid">
        <article className="panel project-identity-card">
          <span className="project-identity-card__icon"><House size={27} /></span>
          <div>
            <span className="eyebrow">Объект</span>
            <h2>{state.project.name}</h2>
            <p><MapPin size={15} /> {state.project.address || 'Адрес ещё не заполнен'}</p>
          </div>
          <div className="project-identity-card__facts">
            <span><small>Начало</small><strong>{formatDate(state.project.startDate, true)}</strong></span>
            <span><small>Плановая сдача</small><strong>{formatDate(state.project.targetDate, true)}</strong></span>
            <span><small>Прогноз</small><strong>{formatDate(state.project.forecastDate, true)}</strong></span>
            <span><small>Прораб</small><strong>{state.project.foreman || 'Не назначен'}</strong></span>
          </div>
        </article>

        <button type="button" className="project-quick-card" onClick={() => onNavigate('schedule', activeStages[0]?.id)}>
          <span><CalendarRange size={21} /></span><div><small>Работы сейчас</small><strong>{activeStages.length || 'Нет'}</strong><p>{activeStages[0]?.name ?? 'Нет активного этапа'}</p></div>
        </button>
        <article className="project-quick-card">
          <span><UsersRound size={21} /></span><div><small>Команда проекта</small><strong>{team.length}</strong><p>{team.filter((item) => item.status === 'active').length} с активным доступом</p></div>
        </article>
        <article className="project-quick-card">
          <span><FileCheck2 size={21} /></span><div><small>Документы</small><strong>{state.documents.length}</strong><p>{signedCount} подписано · {awaitingCount} черновика</p></div>
        </article>
      </section>

      <section className="panel field-reports-panel">
        <SectionHeader
          eyebrow="С объекта"
          title="Полевой дневник"
          action={<span className="count-badge">{fieldReports.length}</span>}
        />
        <p className="field-reports-panel__intro">Фото, голосовые заметки и короткие отчёты, подтверждённые командой через Telegram.</p>
        {fieldReports.length ? (
          <div className="field-report-grid">
            {fieldReports.slice(0, 8).map((report) => {
              const stage = state.stages.find((item) => item.id === report.stageId);
              return (
                <article className="field-report-card" key={report.id}>
                  <div className="field-report-card__head">
                    <span>{report.attachments.some((item) => item.mimeType.startsWith('audio/')) ? <Mic size={18} /> : <Image size={18} />}</span>
                    <div><strong>{report.author}</strong><small>{formatDateTime(report.createdAt)}{stage ? ` · ${stage.name}` : ''}</small></div>
                    <StatusBadge label={report.source === 'telegram' ? 'Telegram' : 'ИКИОМА ОС'} tone="neutral" />
                  </div>
                  <p>{report.note}</p>
                  <div className="field-report-card__files">
                    {report.attachments.map((attachment) => (
                      <button type="button" key={attachment.id} onClick={() => openFieldReportFile(attachment.key)}>
                        {attachment.mimeType.startsWith('audio/') ? <Mic size={14} /> : <Image size={14} />}
                        <span>{attachment.name}</span>
                        <small>{readableSize(attachment.sizeBytes)}</small>
                      </button>
                    ))}
                  </div>
                </article>
              );
            })}
          </div>
        ) : <div className="task-empty"><Image size={28} /><strong>Полевой дневник пока пуст</strong><p>После подключения Telegram пришлите боту фото с подписью /report — запись появится здесь после подтверждения.</p></div>}
      </section>

      <section className="panel project-documents-panel">
        <SectionHeader
          eyebrow="Документооборот"
          title="Документы проекта"
          action={<span className="count-badge">{documents.length}</span>}
        />
        <div className="project-documents-toolbar">
          <div className="task-search"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Название, номер или тип документа" /></div>
          <select aria-label="Категория документа" value={category} onChange={(event) => setCategory(event.target.value as typeof category)}>
            <option value="all">Все категории</option>
            {Object.entries(categoryLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
          </select>
          <button type="button" className="button button--secondary button--compact" onClick={() => setShowUpload(true)}><Plus size={16} /> Добавить</button>
        </div>

        <div className="project-document-list">
          {documents.map((document) => {
            const counterpart = state.counterparties.find((item) => item.id === document.counterpartyId);
            const stage = state.stages.find((item) => item.id === document.stageId);
            return (
              <button type="button" className="project-document-row" key={document.id} onClick={() => setSelectedId(document.id)}>
                <span className="project-document-row__icon">{document.fileKey ? <FileText size={20} /> : <FileClock size={20} />}</span>
                <span className="project-document-row__main">
                  <strong>{document.name}</strong>
                  <small>{categoryLabels[document.category ?? 'other']}{document.number ? ` № ${document.number}` : ''} · {formatDate(document.documentDate ?? document.updatedAt, true)}</small>
                </span>
                <span className="project-document-row__links">{counterpart?.name ?? stage?.name ?? 'Без привязки'}</span>
                <span className="project-document-row__file">{document.fileName ? <><strong>{document.fileName}</strong><small>{readableSize(document.sizeBytes)}</small></> : <small>{document.storageLocation ?? 'Файл не загружен'}</small>}</span>
                <StatusBadge label={statusLabels[document.status]} tone={statusTone(document.status)} />
              </button>
            );
          })}
          {!documents.length && <div className="task-empty"><FolderOpen size={28} /><strong>Документов пока нет</strong><p>Загрузите договор, акт, счёт, УПД, накладную или рабочую спецификацию.</p></div>}
        </div>
      </section>

      {showUpload && (
        <Modal wide title="Загрузить документ" subtitle="Файл сохранится в защищённом хранилище проекта. Метаданные помогут потом найти его по этапу, контрагенту и статусу." onClose={() => setShowUpload(false)}>
          <form className="modal-form" onSubmit={submitUpload}>
            <button type="button" className={file ? 'document-dropzone document-dropzone--selected' : 'document-dropzone'} onClick={() => fileInputRef.current?.click()}>
              <UploadCloud size={25} />
              <strong>{file ? file.name : 'Выберите файл'}</strong>
              <span>{file ? `${readableSize(file.size)} · нажмите, чтобы заменить` : 'PDF, JPG, PNG, Word или Excel · до 20 МБ'}</span>
              <input ref={fileInputRef} type="file" hidden accept=".pdf,.jpg,.jpeg,.png,.webp,.doc,.docx,.xls,.xlsx" onChange={(event) => { const nextFile = event.target.files?.[0] ?? null; setFile(nextFile); setForm((current) => ({ ...current, name: current.name || nextFile?.name.replace(/\.[^.]+$/, '') || '' })); setUploadError(''); }} />
            </button>
            <div className="form-grid">
              <Field label="Название"><input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Договор подряда на фундамент" /></Field>
              <Field label="Категория"><select value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value as typeof form.category })}>{Object.entries(categoryLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></Field>
              <Field label="Номер"><input value={form.number} onChange={(event) => setForm({ ...form, number: event.target.value })} placeholder="№ 14/26" /></Field>
              <Field label="Дата документа"><input type="date" value={form.documentDate} onChange={(event) => setForm({ ...form, documentDate: event.target.value })} /></Field>
            </div>
            <div className="form-grid">
              <Field label="Статус"><select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value as ProjectDocument['status'] })}><option value="draft">Черновик</option><option value="current">Актуальный</option><option value="signed">Подписан</option></select></Field>
              <Field label="Направление"><select value={form.direction} onChange={(event) => setForm({ ...form, direction: event.target.value as NonNullable<ProjectDocument['direction']> })}><option value="incoming">Получен</option><option value="outgoing">Отправлен</option><option value="internal">Внутренний</option></select></Field>
              <Field label="Контрагент"><select value={form.counterpartyId} onChange={(event) => setForm({ ...form, counterpartyId: event.target.value })}><option value="">Без контрагента</option>{state.counterparties.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></Field>
              <Field label="Этап"><select value={form.stageId} onChange={(event) => setForm({ ...form, stageId: event.target.value })}><option value="">Без этапа</option>{state.stages.map((item) => <option value={item.id} key={item.id}>{item.order}. {item.name}</option>)}</select></Field>
            </div>
            <label className="document-visibility"><input type="checkbox" checked={form.clientVisible} onChange={(event) => setForm({ ...form, clientVisible: event.target.checked })} /><span><strong>Показывать клиенту</strong><small>Документ появится в кабинете клиента после сохранения.</small></span></label>
            {uploadError && <div className="entity-alert"><FileText size={18} /><span><strong>Файл не загружен</strong>{uploadError}</span></div>}
            <div className="modal__actions"><button type="button" className="button button--ghost" onClick={() => setShowUpload(false)}>Отмена</button><button type="submit" className="button button--primary" disabled={!file || uploading}>{uploading ? 'Загружаем…' : 'Загрузить и сохранить'}</button></div>
          </form>
        </Modal>
      )}

      {selected && (
        <Modal title={selected.name} subtitle={`${categoryLabels[selected.category ?? 'other']} · ${formatDate(selected.documentDate ?? selected.updatedAt, true)}`} onClose={() => setSelectedId(null)}>
          <div className="document-detail-card">
            <span><FileText size={26} /></span>
            <div><small>Статус</small><StatusBadge label={statusLabels[selected.status]} tone={statusTone(selected.status)} /></div>
            <div><small>Файл</small><strong>{selected.fileName ?? 'Не загружен'}</strong><p>{selected.fileName ? `${readableSize(selected.sizeBytes)} · ${selected.uploadedBy ?? 'ИКИОМА ОС'}` : selected.storageLocation ?? 'Место хранения не указано'}</p></div>
          </div>
          <div className="entity-detail-grid">
            <section className="entity-detail-card"><small>Контрагент</small><strong>{state.counterparties.find((item) => item.id === selected.counterpartyId)?.name ?? 'Не указан'}</strong><span>{selected.direction === 'incoming' ? 'Получен' : selected.direction === 'outgoing' ? 'Отправлен' : 'Внутренний'}</span></section>
            <section className="entity-detail-card"><small>Этап</small><strong>{state.stages.find((item) => item.id === selected.stageId)?.name ?? 'Без этапа'}</strong><span>{selected.clientVisible ? 'Виден клиенту' : 'Только внутри команды'}</span></section>
          </div>
          <div className="modal__actions">
            {selected.stageId && <button type="button" className="button button--secondary" onClick={() => { setSelectedId(null); onNavigate('schedule', selected.stageId); }}><Link2 size={16} /> Открыть этап</button>}
            <button type="button" className="button button--primary" disabled={!selected.fileKey} onClick={() => openFile(selected)}><Download size={16} /> Скачать файл</button>
          </div>
        </Modal>
      )}

      <section className="project-card-note">
        <Building2 size={19} />
        <div><strong>Одна карточка — один объект</strong><p>График, задачи, снабжение, финансы и документы связаны через код проекта {state.project.code}; дублировать файлы по разделам не нужно.</p></div>
        <HardHat size={20} />
      </section>
    </div>
  );
}
