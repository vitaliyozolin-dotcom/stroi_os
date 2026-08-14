import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Camera,
  Check,
  CheckCircle2,
  Clock3,
  Eye,
  FileImage,
  FlaskConical,
  ImagePlus,
  Images,
  Maximize2,
  RotateCcw,
  Ruler,
  ScanLine,
  Send,
  ShieldCheck,
  Tag,
  UserRound,
  ZoomIn,
} from 'lucide-react';
import { formatDateTime, uid } from '../domain';
import { photoStandard } from '../seed';
import type { AppState, CheckpointStatus, EvidencePhoto, UserRole } from '../types';
import { ProgressBar, StatusBadge } from '../components/Ui';

const checkpointLabels: Record<CheckpointStatus, string> = {
  pending: 'Не начат',
  in_review: 'На проверке',
  accepted: 'Принят',
  rework: 'Доработка',
};

const checkpointTone = (status: CheckpointStatus): 'neutral' | 'positive' | 'danger' | 'blue' => {
  if (status === 'accepted') return 'positive';
  if (status === 'rework') return 'danger';
  if (status === 'in_review') return 'blue';
  return 'neutral';
};

const standardIcons = [Camera, ScanLine, ZoomIn, Ruler, Tag, FlaskConical, RotateCcw];

export function QualityPage({ state, role, actor, focusId, onChange }: { state: AppState; role: UserRole; actor: string; focusId?: string | null; onChange: (next: AppState) => void }) {
  const defaultCheckpoint = state.checkpoints.find((item) => item.status === 'in_review') ?? state.checkpoints[0];
  const [selectedId, setSelectedId] = useState(defaultCheckpoint?.id ?? '');
  const [filter, setFilter] = useState<'all' | CheckpointStatus>('all');
  const [uploading, setUploading] = useState(false);
  const [uploadMessage, setUploadMessage] = useState('');
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  const previewUrlsRef = useRef(previewUrls);
  previewUrlsRef.current = previewUrls;
  useEffect(() => {
    if (focusId && state.checkpoints.some((item) => item.id === focusId)) setSelectedId(focusId);
  }, [focusId, state.checkpoints]);
  useEffect(() => {
    if (!state.checkpoints.some((item) => item.id === selectedId) && defaultCheckpoint) setSelectedId(defaultCheckpoint.id);
  }, [defaultCheckpoint, selectedId, state.checkpoints]);
  useEffect(() => () => {
    Object.values(previewUrlsRef.current).forEach((url) => URL.revokeObjectURL(url));
  }, []);
  const selected = state.checkpoints.find((item) => item.id === selectedId) ?? defaultCheckpoint;
  const visible = useMemo(() => state.checkpoints.filter((item) => filter === 'all' || item.status === filter), [filter, state.checkpoints]);

  if (!selected) {
    return (
      <div className="page-stack">
        <section className="page-title-row">
          <div>
            <span className="eyebrow">Доказательства вместо обещаний</span>
            <h1>Контроль качества</h1>
            <p>Здесь появятся фотофиксация, замеры, замечания и результаты независимой приёмки.</p>
          </div>
        </section>
        <section className="panel">
          <div className="task-empty">
            <ShieldCheck size={30} />
            <strong>Контрольных точек пока нет</strong>
            <p>Они создаются автоматически при переводе этапа в работу. Сначала откройте график и запустите первый этап.</p>
          </div>
        </section>
      </div>
    );
  }

  const selectedStage = state.stages.find((stage) => stage.id === selected.stageId);

  const updateCheckpoint = (patch: Partial<typeof selected>, activityText?: string, tone: 'neutral' | 'positive' | 'warning' = 'neutral') => {
    onChange({
      ...state,
      checkpoints: state.checkpoints.map((item) => item.id === selected.id ? { ...item, ...patch } : item),
      activity: activityText ? [{ id: uid('activity'), timestamp: new Date().toISOString(), actor, text: activityText, tone }, ...state.activity] : state.activity,
    });
  };

  const uploadFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    setUploadMessage('');
    const remaining = Math.max(0, selected.requiredShots.length - selected.photos.length);
    const replacingRework = remaining === 0 && selected.status === 'rework';
    const slots = replacingRework ? selected.requiredShots.length : remaining;
    const selectedFiles = Array.from(files).filter((file) => ['image/jpeg', 'image/png', 'image/webp'].includes(file.type)).slice(0, slots);
    try {
      const photos: EvidencePhoto[] = [];
      const nextPreviews: Record<string, string> = {};
      for (const file of selectedFiles) {
        const body = new FormData();
        body.append('file', file);
        const response = await fetch(`/api/quality/upload?projectId=${encodeURIComponent(state.project.id)}&checkpointId=${encodeURIComponent(selected.id)}`, {
          method: 'POST',
          body,
        });
        const payload = await response.json().catch(() => null) as { ok?: boolean; photo?: EvidencePhoto; error?: string } | null;
        if (!response.ok || !payload?.ok || !payload.photo) throw new Error(payload?.error || 'upload_failed');
        photos.push(payload.photo);
        nextPreviews[payload.photo.id] = URL.createObjectURL(file);
      }
      setPreviewUrls((current) => ({ ...current, ...nextPreviews }));
      updateCheckpoint({ photos: replacingRework ? photos : [...selected.photos, ...photos] }, photos.length ? `${replacingRework ? 'Начата повторная фиксация' : `Добавлено ${photos.length} фото`}: ${selected.title}` : undefined);
      setUploadMessage(photos.length ? (replacingRework ? 'Предыдущий комплект заменён повторной фиксацией' : `Добавлено фото: ${photos.length}`) : 'Все обязательные кадры уже загружены');
    } catch {
      setUploadMessage('Не удалось загрузить фото. Допустимы JPG, PNG или WebP до 12 МБ.');
    } finally {
      setUploading(false);
    }
  };

  const submitForReview = () => {
    updateCheckpoint({ status: 'in_review', submittedAt: new Date().toISOString() }, `Отчёт «${selected.title}» отправлен на проверку`);
  };

  const accept = () => {
    updateCheckpoint({ status: 'accepted', acceptedAt: new Date().toISOString(), clientVisible: true }, `Контрольная точка «${selected.title}» принята`, 'positive');
  };

  const returnForRework = () => {
    updateCheckpoint({ status: 'rework', note: selected.note || 'Требуется устранить замечание и повторить фотофиксацию' }, `Контрольная точка «${selected.title}» возвращена на доработку`, 'warning');
  };

  const completedShots = Math.min(selected.photos.length, selected.requiredShots.length);
  const canSubmit = completedShots >= selected.requiredShots.length;
  const completionPercent = selected.requiredShots.length ? completedShots / selected.requiredShots.length * 100 : 0;
  const photoUrl = (photo: EvidencePhoto) => previewUrls[photo.id]
    || (photo.fileKey ? `/api/quality/file?projectId=${encodeURIComponent(state.project.id)}&key=${encodeURIComponent(photo.fileKey)}` : '')
    || (/^data:image\/(?:jpeg|png|webp);base64,/i.test(photo.dataUrl ?? '') ? photo.dataUrl ?? '' : '');

  return (
    <div className="page-stack">
      <section className="page-title-row">
        <div>
          <span className="eyebrow">Доказательства вместо обещаний</span>
          <h1>Контроль качества</h1>
          <p>Скрытая работа не закрывается без обязательных кадров, замера и независимой приёмки.</p>
        </div>
        <div className="quality-head-stat"><ShieldCheck size={21} /><span><small>Принято без замечаний</small><strong>{state.checkpoints.filter((item) => item.status === 'accepted').length} из {state.checkpoints.length}</strong></span></div>
      </section>

      <section className="photo-standard-panel">
        <div className="photo-standard-panel__intro"><span className="eyebrow">Стандарт фотофиксации v1.0</span><h2>7 обязательных кадров</h2><p>До того, как конструкция будет закрыта следующим слоем.</p></div>
        <div className="photo-standard-list">
          {photoStandard.map((item, index) => {
            const Icon = standardIcons[index];
            return <div key={item}><span><Icon size={17} /></span><small>0{index + 1}</small><strong>{item}</strong></div>;
          })}
        </div>
      </section>

      <section className="quality-layout">
        <article className="panel checkpoint-register">
          <div className="checkpoint-register__head">
            <div><span className="eyebrow">Реестр</span><h2>Контрольные точки</h2></div>
            <div className="segmented-control segmented-control--wrap">
              {(['all', 'in_review', 'rework', 'accepted'] as const).map((value) => <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{value === 'all' ? 'Все' : checkpointLabels[value]}</button>)}
            </div>
          </div>
          <div className="checkpoint-list">
            {visible.map((checkpoint) => {
              const stage = state.stages.find((item) => item.id === checkpoint.stageId);
              const completeness = checkpoint.requiredShots.length ? checkpoint.photos.length / checkpoint.requiredShots.length * 100 : 0;
              return (
                <button type="button" className={`checkpoint-row ${checkpoint.id === selected.id ? 'checkpoint-row--selected' : ''}`} key={checkpoint.id} onClick={() => { setSelectedId(checkpoint.id); setUploadMessage(''); }}>
                  <span className={`checkpoint-row__icon checkpoint-row__icon--${checkpoint.status}`}>{checkpoint.status === 'accepted' ? <CheckCircle2 size={19} /> : checkpoint.status === 'rework' ? <AlertTriangle size={19} /> : checkpoint.status === 'in_review' ? <Eye size={19} /> : <Camera size={19} />}</span>
                  <span className="checkpoint-row__body">
                    <span className="checkpoint-row__title"><strong>{checkpoint.title}</strong><StatusBadge label={checkpointLabels[checkpoint.status]} tone={checkpointTone(checkpoint.status)} /></span>
                    <small>{stage?.shortName} · {checkpoint.zone}</small>
                    <span className="checkpoint-row__progress"><ProgressBar value={completeness} tone={checkpoint.status === 'rework' ? 'red' : 'green'} /><em>{checkpoint.photos.length}/{checkpoint.requiredShots.length}</em></span>
                  </span>
                </button>
              );
            })}
          </div>
        </article>

        <article className="panel checkpoint-detail">
          <div className="checkpoint-detail__head">
            <div><span className="eyebrow">{selectedStage?.name} · {selected.zone}</span><h2>{selected.title}</h2></div>
            <StatusBadge label={checkpointLabels[selected.status]} tone={checkpointTone(selected.status)} />
          </div>
          <div className="checkpoint-detail__people">
            <span><UserRound size={16} /><small>Исполнитель</small><strong>{selected.assignee}</strong></span>
            <span><ShieldCheck size={16} /><small>Проверяет</small><strong>{selected.reviewer}</strong></span>
          </div>

          {selected.status === 'rework' && <div className="quality-warning"><AlertTriangle size={19} /><div><strong>Возвращено на доработку</strong><p>{selected.note}</p></div></div>}
          {selected.measurement && <div className="measurement-card"><Ruler size={19} /><div><small>Контрольный замер</small><strong>{selected.measurement}</strong>{selected.status === 'accepted' && <span><Check size={14} /> подтверждено</span>}</div></div>}

          <div className="evidence-head">
            <div><strong>Фотофиксация</strong><span>{completedShots} из {selected.requiredShots.length} обязательных кадров</span></div>
            <strong>{Math.round(completionPercent)}%</strong>
          </div>
          <ProgressBar value={completionPercent} tone={selected.status === 'rework' ? 'red' : 'green'} />

          <div className="evidence-grid">
            {selected.requiredShots.map((shot, index) => {
              const photo = selected.photos[index];
              const source = photo ? photoUrl(photo) : '';
              return (
                <div className={`evidence-tile ${photo ? 'evidence-tile--filled' : ''}`} key={`${selected.id}-${shot}`}>
                  {source ? <img src={source} alt={shot} /> : photo ? <div className={`evidence-placeholder evidence-placeholder--${(index % 4) + 1}`}><FileImage size={23} /><span>{String(index + 1).padStart(2, '0')}</span></div> : <div className="evidence-empty"><ImagePlus size={21} /><span>{String(index + 1).padStart(2, '0')}</span></div>}
                  <div><strong>{shot}</strong>{photo && <small>{formatDateTime(photo.capturedAt)}</small>}</div>
                  {source && <button type="button" aria-label="Открыть фото" onClick={() => window.open(source, '_blank', 'noopener,noreferrer')}><Maximize2 size={15} /></button>}
                </div>
              );
            })}
          </div>

          {selected.submittedAt && <div className="submission-meta"><Clock3 size={15} /> Отправлено {formatDateTime(selected.submittedAt)}{selected.acceptedAt ? ` · принято ${formatDateTime(selected.acceptedAt)}` : ''}</div>}

          {role !== 'client' && selected.status !== 'accepted' && (
            <div className="quality-actions">
              <label className={`button button--secondary ${uploading ? 'button--disabled' : ''}`}><Images size={17} /> {uploading ? 'Загружаем…' : 'Добавить фото'}<input hidden disabled={uploading} type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={(event) => { void uploadFiles(event.target.files); event.target.value = ''; }} /></label>
              {uploadMessage && <span className="upload-message">{uploadMessage}</span>}
              {role === 'foreman' && <button className="button button--primary" type="button" disabled={!canSubmit || selected.status === 'in_review'} onClick={submitForReview}><Send size={17} /> {selected.status === 'in_review' ? 'Отчёт на проверке' : 'Отправить на проверку'}</button>}
              {role === 'management' && selected.status === 'in_review' && <div className="action-pair"><button className="button button--danger-soft" type="button" onClick={returnForRework}><RotateCcw size={17} /> Вернуть</button><button className="button button--primary" type="button" disabled={!canSubmit} onClick={accept}><Check size={17} /> Принять</button></div>}
              {role === 'management' && selected.status !== 'in_review' && <button className="button button--primary" type="button" disabled={!canSubmit} onClick={submitForReview}><Send size={17} /> Отправить на проверку</button>}
            </div>
          )}

          <div className="client-visibility"><Eye size={17} /><div><strong>{selected.clientVisible ? 'Будет в кабинете клиента' : 'Пока скрыто от клиента'}</strong><p>Клиент увидит только принятый отчёт, без внутренних замечаний.</p></div></div>
        </article>
      </section>

      <section className="quality-principles">
        <article><span>01</span><div><strong>Оригинал сохраняется на сервере</strong><p>Дата, автор, дом, этап и зона становятся частью доказательства и не раздувают общий снимок проекта.</p></div></article>
        <article><span>02</span><div><strong>Фото не заменяет акт</strong><p>Замеры, испытания и исполнительная документация остаются обязательными.</p></div></article>
        <article><span>03</span><div><strong>Оплата после приёмки</strong><p>Принятая контрольная точка открывает оплату выполненного объёма.</p></div></article>
      </section>
    </div>
  );
}
