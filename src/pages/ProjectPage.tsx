import { useModuleRepository } from '../useModuleRepository';
import { createDocumentsRepository } from '../infrastructure/module-project';
import { updateProjectDocumentStatus } from '../application/project-records.js';
import { ProjectFilePreview } from '../components/ProjectFilePreview';
import { PreparationWizard } from '../components/PreparationWizard';
import '../components/project-lifecycle-dashboard.css';
import { FieldReportUpload } from '../components/FieldReportUpload';
import { automaticSchedule } from '../domain/construction/index.js';
import { useScheduleToday } from '../components/ProjectScheduleDates';
import { uploadProjectDocument } from '../application/project-documents';
import { documentUploader } from '../infrastructure/document-upload';
import { projectDocumentCategories as categoryLabels } from '../domain/project-documents';
import { runtimeIdGenerator, systemClock } from '../infrastructure/runtime';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  Building2,
  CalendarRange,
  ExternalLink,
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
import { formatDate, formatDateTime } from '../presentation/formatting';
import type { AppState, AuthenticatedUser, ProjectDocument } from '../entities/index';
import type { PageId } from '../presentation/navigation';
import { Field, Modal, SectionHeader, StatusBadge } from '../components/Ui';

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
  const documentsRepository = useModuleRepository(createDocumentsRepository, state, onChange);
  const uploadAbort = useRef<AbortController | null>(null);
  useEffect(() => () => { uploadAbort.current?.abort(); }, [state.project.id]);
  const [search, setSearch] = useState('');
  const [documentStatus, setDocumentStatus] = useState<ProjectDocument['status']>('draft');
  const [signedOriginal, setSignedOriginal] = useState(false);
  const [documentError, setDocumentError] = useState('');
  const [showPhotoUpload, setShowPhotoUpload] = useState(false);
  const today = useScheduleToday();
  const schedule = automaticSchedule(state, today);
  const [category, setCategory] = useState<'all' | NonNullable<ProjectDocument['category']>>('all');
  const [showUpload, setShowUpload] = useState(false);
  const [selectedPhoto, setSelectedPhoto] = useState<{ key: string; name: string } | null>(null);
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
  useEffect(() => { setDocumentStatus(selected?.status ?? 'draft'); setSignedOriginal(false); setDocumentError(''); }, [selected?.id, selected?.status]);
  const signedCount = state.documents.filter((item) => item.status === 'signed').length;
  const awaitingCount = state.documents.filter((item) => item.status === 'draft').length;
  const activeStages = state.stages.filter((item) => ['in_progress', 'blocked', 'awaiting_inspection', 'rework'].includes(item.status));
  const team = state.settings.users.filter((item) => item.status !== 'disabled');
  const fieldReports = useMemo(() => [...state.fieldReports].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [state.fieldReports]);

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
      const controller = new AbortController(); uploadAbort.current = controller;
      const result = await uploadProjectDocument(documentsRepository, { projectId: state.project.id, draft: { ...form }, file }, session, systemClock, runtimeIdGenerator, documentUploader, controller.signal);
      if (!result.ok) throw new Error(result.error);
      setShowUpload(false);
      setForm(emptyDocumentForm());
      setFile(null);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      setUploadError(code === 'storage_unavailable'
        ? 'Файловое хранилище ещё не подключено к публикации.'
        : code === 'unsupported_file'
          ? 'Этот формат не поддерживается. Используйте PDF, изображение, Word или Excel.'
          : code || 'Не удалось загрузить файл. Проверьте связь и повторите.');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="page-stack project-passport-page">
      <section className="page-title-row">
        <div>
          <span className="eyebrow">Единая карточка объекта</span>
          <h1>{state.project.name}</h1>
          <p>{[state.project.code, state.project.model, state.project.unknownFields?.includes('area') ? 'Площадь уточняется' : `${state.project.area} м²`].filter(Boolean).join(' · ')}</p>
        </div>
        {session.role !== 'client' && <button type="button" className="button button--primary" onClick={() => setShowUpload(true)}><UploadCloud size={17} /> Загрузить документ</button>}
      </section>

      <nav className="project-passport-nav" aria-label="Карточка проекта"><a href="#project-identity">Паспорт</a><a href="#project-preparation">Этап 0 и завершение</a><a href="#project-documents">Документы</a><a href="#project-photos">Фото объекта</a></nav>
      {session.role === 'management' && <button type="button" className="button button--secondary" onClick={() => onNavigate('customers')}><UsersRound size={18} /> Заказчик, объекты и условия заказа</button>}

      <section className="project-hero-grid" id="project-identity">
        <article className="panel project-identity-card">
          <span className="project-identity-card__icon"><House size={27} /></span>
          <div>
            <span className="eyebrow">Объект</span>
            <h2>{state.project.name}</h2>
            <p><MapPin size={15} /> {state.project.address || 'Адрес ещё не заполнен'}</p>
          </div>
          <div className="project-identity-card__facts">
            <span><small>Начало</small><strong>{formatDate(state.project.startDate, true)}</strong></span>
            <span><small>Сдача по договору</small><strong>{formatDate(state.project.targetDate, true)}</strong></span>
            <span><small>{schedule.kind === 'actual' ? 'Факт готовности по ППР' : schedule.kind === 'observed' ? 'Готовность подтверждена' : 'Готовность по ППР · расчёт'}</small><strong>{schedule.end ? formatDate(schedule.end, true) : 'Нужны сроки'}</strong>{schedule.unmappedWork.length > 0 && <small>Без сроков: {schedule.unmappedWork.join(', ')}</small>}</span>
            <span><small>Прораб</small><strong>{state.project.foreman || 'Не назначен'}</strong></span>
            <span><small>Заказчик</small><strong>{state.project.clientNames || 'Не указан'}</strong></span>
            <span><small>Проект дома</small><strong>{state.project.model || 'Не выбран'}</strong></span>
          </div>
        </article>

        <button type="button" className="project-quick-card" onClick={() => onNavigate('schedule', activeStages[0]?.id)}>
          <span><CalendarRange size={21} /></span><div><small>Работы сейчас</small><strong>{activeStages.length || 'Нет'}</strong><p>{activeStages[0]?.name ?? 'Нет активного этапа'}</p></div>
        </button>
        <article className="project-quick-card">
          <span><UsersRound size={21} /></span><div><small>Команда проекта</small><strong>{team.length}</strong><p>{team.filter((item) => item.status === 'active').length} с активным доступом</p></div>
        </article>
        <button type="button" className="project-quick-card" onClick={() => document.getElementById('project-documents')?.scrollIntoView({ behavior: 'smooth' })}>
          <span><FileCheck2 size={21} /></span><div><small>Документы</small><strong>{state.documents.length}</strong><p>{signedCount} подписано · {awaitingCount} черновика</p></div>
        </button>
      </section>

      <div id="project-preparation"><PreparationWizard state={state} actor={session.name} role={session.role} onChange={onChange} /></div>
      {showPhotoUpload && <FieldReportUpload state={state} actor={session.name} role={session.role} onChange={onChange} onClose={() => setShowPhotoUpload(false)} />}
      <section className="panel project-documents-panel" id="project-documents">
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
          {session.role !== 'client' && <button type="button" className="button button--secondary button--compact" onClick={() => setShowUpload(true)}><Plus size={16} /> Добавить</button>}
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
                <span className="project-document-row__links">{stage?.name ?? counterpart?.name ?? state.project.code}</span>
                <span className="project-document-row__file">{document.fileName ? <><strong>{document.fileName}</strong><small>{readableSize(document.sizeBytes)}</small></> : <small>{document.storageLocation ?? 'Файл не загружен'}</small>}</span>
                <span className="project-document-row__open"><StatusBadge label={statusLabels[document.status]} tone={statusTone(document.status)} /><span><ExternalLink size={16} /> {document.fileKey ? 'Открыть' : 'Нет оригинала'}</span></span>
              </button>
            );
          })}
          {!documents.length && <div className="task-empty"><FolderOpen size={28} /><strong>Документов пока нет</strong><p>Загрузите договор, акт, счёт, УПД, накладную или рабочую спецификацию.</p></div>}
        </div>
      </section>

      <section className="panel field-reports-panel" id="project-photos">
        <SectionHeader
          eyebrow="С объекта"
          title="Фото объекта"
          action={session.role !== 'client' ? <button type="button" className="button button--secondary" onClick={() => setShowPhotoUpload(true)}>Добавить фото</button> : <span>{fieldReports.length} отчётов</span>}
        />
        <p className="field-reports-panel__intro">Фотографии и отчёты команды с датой и привязкой к этапу.</p>
        {fieldReports.length ? (
          <div className="field-report-grid">
            {fieldReports.map((report) => {
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
                      <button type="button" key={attachment.id} onClick={() => setSelectedPhoto({ key: attachment.key, name: attachment.name })}>
                        {attachment.mimeType.startsWith('image/') ? <img className="field-report-thumbnail" src={`/api/field-reports/file?projectId=${encodeURIComponent(state.project.id)}&key=${encodeURIComponent(attachment.key)}&preview=1`} alt={report.note || attachment.name} loading="lazy" /> : <Mic size={14} />}
                        <span>{attachment.name}</span>
                        <small>{readableSize(attachment.sizeBytes)}</small>
                      </button>
                    ))}
                  </div>
                </article>
              );
            })}
          </div>
        ) : <div className="task-empty"><Image size={28} /><strong>Полевой дневник пока пуст</strong><p>Добавьте фотографии с объекта или ответьте на запрос Ская в рабочем чате.</p></div>}
      </section>

      {showUpload && (
        <Modal wide title="Загрузить документ" subtitle="Файл сохранится в защищённом хранилище проекта. Метаданные помогут потом найти его по этапу, контрагенту и статусу." onClose={() => { uploadAbort.current?.abort(); setShowUpload(false); }}>
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
            {uploadError && <div role="alert" className="entity-alert"><FileText size={18} /><span><strong>Файл не загружен</strong>{uploadError}</span></div>}
            <div className="modal__actions"><button type="button" className="button button--ghost" onClick={() => { uploadAbort.current?.abort(); setShowUpload(false); }}>Отмена</button><button type="submit" className="button button--primary" disabled={!file || uploading}>{uploading ? 'Загружаем…' : 'Загрузить и сохранить'}</button></div>
          </form>
        </Modal>
      )}

      {selected && (
        <Modal wide title={selected.name} subtitle={`${categoryLabels[selected.category ?? 'other']} · ${formatDate(selected.documentDate ?? selected.updatedAt, true)}`} onClose={() => setSelectedId(null)}>
          <ProjectFilePreview key={selected.id} url={selected.fileKey ? `/api/documents/file?projectId=${encodeURIComponent(state.project.id)}&key=${encodeURIComponent(selected.fileKey)}` : undefined} name={selected.fileName || selected.name} />
          <div className="document-detail-card">
            <span><FileText size={26} /></span>
            <div><small>Статус</small><StatusBadge label={statusLabels[selected.status]} tone={statusTone(selected.status)} /></div>
            <div><small>Файл</small><strong>{selected.fileName ?? 'Не загружен'}</strong><p>{selected.fileName ? `${readableSize(selected.sizeBytes)} · ${selected.uploadedBy ?? 'ИКИОМА ОС'}` : selected.storageLocation ?? 'Место хранения не указано'}</p></div>
          </div>
          {session.role === 'management' && <form className="document-status-editor" onSubmit={event => {
            event.preventDefault();
            const result = updateProjectDocumentStatus(documentsRepository, { id: selected.id, status: documentStatus, confirmSignedOriginal: signedOriginal }, { identity: session, clock: systemClock, ids: runtimeIdGenerator });
            setDocumentError(result.ok ? '' : result.error);
          }}><Field label="Уточнить статус документа"><select value={documentStatus} onChange={event => { setDocumentStatus(event.target.value as ProjectDocument['status']); setSignedOriginal(false); }}>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
            {documentStatus === 'signed' && selected.status !== 'signed' && <label className="document-status-confirm"><input type="checkbox" checked={signedOriginal} onChange={event => setSignedOriginal(event.target.checked)} />Проверил оригинал: документ подписан</label>}
            {documentError && <p role="alert" className="form-warning">{documentError}</p>}
            <button type="submit" className="button button--secondary" disabled={documentStatus === selected.status || documentStatus === 'signed' && (!selected.fileKey || !signedOriginal)}>Сохранить статус</button>
          </form>}
          <div className="entity-detail-grid">
            <section className="entity-detail-card"><small>Контрагент</small><strong>{state.counterparties.find((item) => item.id === selected.counterpartyId)?.name ?? 'Не указан'}</strong><span>{selected.direction === 'incoming' ? 'Получен' : selected.direction === 'outgoing' ? 'Отправлен' : 'Внутренний'}</span></section>
            <section className="entity-detail-card"><small>Этап</small><strong>{state.stages.find((item) => item.id === selected.stageId)?.name ?? 'Без этапа'}</strong><span>{selected.clientVisible ? 'Виден клиенту' : 'Только внутри команды'}</span></section>
          </div>
          <div className="modal__actions">
            {selected.stageId && <button type="button" className="button button--secondary" onClick={() => { setSelectedId(null); onNavigate('schedule', selected.stageId); }}><Link2 size={16} /> Открыть этап</button>}
            {!selected.fileKey && session.role !== 'client' && <button type="button" className="button button--primary" onClick={() => { setSelectedId(null); setShowUpload(true); }}><UploadCloud size={16} /> Добавить документ с оригиналом</button>}
          </div>
        </Modal>
      )}

      {selectedPhoto && <Modal wide title={selectedPhoto.name} subtitle={`${state.project.code} · Фото объекта`} onClose={() => setSelectedPhoto(null)}><ProjectFilePreview url={`/api/field-reports/file?projectId=${encodeURIComponent(state.project.id)}&key=${encodeURIComponent(selectedPhoto.key)}`} name={selectedPhoto.name} /></Modal>}
      <section className="project-card-note">
        <Building2 size={19} />
        <div><strong>Одна карточка — один объект</strong><p>График, задачи, снабжение, финансы и документы связаны через код проекта {state.project.code}; дублировать файлы по разделам не нужно.</p></div>
        <HardHat size={20} />
      </section>
    </div>
  );
}
