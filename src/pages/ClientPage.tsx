import { requestApi } from '../infrastructure/api-http';
import { createClientDecisionCommands } from '../application';
import { runtimeIdGenerator, systemClock } from '../infrastructure/runtime';
import { useEffect, useState, type CSSProperties } from 'react';
import {
  ArrowRight,
  CalendarCheck2,
  Camera,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Download,
  Eye,
  FileCheck2,
  FileText,
  House,
  Images,
  MessageCircle,
  Play,
  Radio,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { financeTotals, formatDate, formatDateTime, money, progressTotals, uid } from '../domain';
import type { AppState } from '../entities/index';
import { Modal, ProgressBar, SectionHeader, StatusBadge } from '../components/Ui';

export function ClientPage({ state, onChange }: { state: AppState; onChange: (next: AppState) => void }) {
  const saveChange = createClientDecisionCommands(state, state.project.clientNames, systemClock, runtimeIdGenerator, onChange);
  const progress = progressTotals(state);
  const finance = financeTotals(state);
  const current = state.stages.find((stage) => ['in_progress', 'awaiting_inspection', 'rework', 'blocked'].includes(stage.status)) ?? state.stages[0];
  const acceptedReports = state.checkpoints.filter((item) => item.status === 'accepted' && item.clientVisible);
  const documents = state.documents.filter((item) => item.clientVisible);
  const waitingDecisions = state.decisions.filter((item) => item.status === 'waiting');
  const [decisionId, setDecisionId] = useState<string | null>(null);
  const [infoModal, setInfoModal] = useState<'camera' | 'reports' | 'warranty' | null>(null);
  const [reportId, setReportId] = useState<string | null>(null);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [camera, setCamera] = useState<{ configured: boolean; online: boolean; label: string } | null>(null);
  const activeDecision = state.decisions.find((item) => item.id === decisionId);
  const [choice, setChoice] = useState('Графит');
  const selectedReport = acceptedReports.find((item) => item.id === reportId);
  const selectedDocument = documents.find((item) => item.id === documentId);

  useEffect(() => {
    let active = true;
    void requestApi(`/api/camera/status?projectId=${encodeURIComponent(state.project.id)}`, { cache: 'no-store' })
      .then((response) => response.json())
      .then((body: { camera?: { configured: boolean; online: boolean; label: string } }) => {
        if (active) setCamera(body.camera ?? null);
      })
      .catch(() => { if (active) setCamera(null); });
    return () => { active = false; };
  }, [state.project.id, state.project.cameraStatus]);

  const decide = () => {
    if (!activeDecision) return;
    saveChange({
      ...state,
      decisions: state.decisions.map((item) => item.id === activeDecision.id ? { ...item, status: 'decided', choice } : item),
      activity: [{ id: uid('activity'), timestamp: new Date().toISOString(), actor: state.project.clientNames, text: `Решение клиента: ${activeDecision.title} — ${choice}`, tone: 'positive' }, ...state.activity],
    });
    setDecisionId(null);
  };

  return (
    <div className="client-page page-stack">
      <section className="client-hero">
        <div className="client-hero__copy">
          <span className="client-hero__eyebrow"><Sparkles size={15} /> Личный кабинет дома</span>
          <h1>Здравствуйте, {state.project.clientNames}</h1>
          <p>Здесь только подтверждённые факты: что сделано, что принято, что будет дальше и какие решения нужны от вас.</p>
          <div className="client-hero__facts">
            <span><House size={17} /> {state.project.model} · {state.project.area} м²</span>
            <span><CalendarCheck2 size={17} /> Сдача: {formatDate(state.project.forecastDate, true)}</span>
          </div>
        </div>
        <div className="client-progress-ring" style={{ '--client-progress': `${progress.accepted * 3.6}deg` } as CSSProperties}>
          <div><strong>{progress.accepted}%</strong><span>принято</span></div>
        </div>
      </section>

      <section className="client-trust-strip">
        <div><ShieldCheck size={20} /><span><strong>{acceptedReports.length} отчёта</strong><small>приняты технадзором</small></span></div>
        <div><Images size={20} /><span><strong>{acceptedReports.reduce((sum, item) => sum + item.photos.length, 0)} фото</strong><small>в цифровом паспорте</small></span></div>
        <div><CheckCircle2 size={20} /><span><strong>{progress.physical}% физически</strong><small>{progress.accepted}% подтверждено</small></span></div>
        <div><Clock3 size={20} /><span><strong>По графику</strong><small>прогноз без сдвига</small></span></div>
      </section>

      <section className="client-grid client-grid--top">
        <article className="panel client-current-stage">
          <SectionHeader eyebrow="Сейчас на объекте" title={current.name} action={<StatusBadge label="В работе" tone="blue" />} />
          <div className="client-current-stage__progress"><ProgressBar value={current.progress} /><strong>{current.progress}%</strong></div>
          <div className="client-current-stage__details">
            <div><small>Выполняет</small><strong>{current.responsible}</strong></div>
            <div><small>План этапа</small><strong>{formatDate(current.planStart)} — {formatDate(current.forecastEnd)}</strong></div>
            <div><small>Следом</small><strong>{state.stages[current.order]?.name ?? 'Сдача дома'}</strong></div>
          </div>
          <div className="client-week-plan"><Check size={17} /><span><strong>На этой неделе:</strong> завершить второй этаж, проверить геометрию и подготовить контур к кровле.</span></div>
        </article>

        <article className="camera-card">
          <div className="camera-card__scene">
            <div className="camera-card__sky" />
            <div className="camera-card__ground" />
            <div className="camera-house"><span className="camera-house__roof" /><span className="camera-house__body"><i /><i /></span></div>
            <div className="camera-card__overlay"><span><Radio size={14} /> {camera?.label ?? 'Камера 01'} · {camera?.online ? 'онлайн' : camera?.configured ? 'нет сигнала' : 'не подключена'}</span><small>{camera?.online ? 'защищённый прямой эфир' : 'ожидает подключения'}</small></div>
            <button type="button" className="camera-play" aria-label="Открыть прямой эфир" disabled={!camera?.configured} onClick={() => setInfoModal('camera')}><Play size={22} fill="currentColor" /></button>
          </div>
          <div className="camera-card__footer"><span><Camera size={17} /><strong>Прямой эфир со стройки</strong></span><button type="button" disabled={!camera?.configured} onClick={() => setInfoModal('camera')}>{camera?.configured ? 'Открыть' : 'Не подключена'} <ChevronRight size={15} /></button></div>
        </article>
      </section>

      {waitingDecisions.length > 0 && (
        <section className="client-decisions">
          <div className="client-decisions__intro"><MessageCircle size={22} /><div><span className="eyebrow">Нужен ваш ответ</span><h2>Решения без задержки стройки</h2></div></div>
          <div className="client-decision-list">
            {waitingDecisions.map((decision) => (
              <button key={decision.id} type="button" onClick={() => { setDecisionId(decision.id); setChoice(decision.id === 'decision-1' ? 'Графит' : 'Вариант B'); }}><span><strong>{decision.title}</strong><small>Нужно до {formatDate(decision.dueDate)}</small></span><span>Выбрать <ArrowRight size={16} /></span></button>
            ))}
          </div>
        </section>
      )}

      <section className="panel client-reports">
        <SectionHeader eyebrow="Проверено технадзором" title="Отчёты о выполненных работах" action={<button type="button" className="text-button" onClick={() => setInfoModal('reports')}>Все отчёты <ChevronRight size={16} /></button>} />
        <div className="report-gallery">
          {acceptedReports.map((report, reportIndex) => {
            const stage = state.stages.find((item) => item.id === report.stageId);
            return (
              <article className="report-card" key={report.id}>
                <div className={`report-card__cover report-card__cover--${reportIndex + 1}`}>
                  {report.photos.find((photo) => photo.dataUrl)?.dataUrl ? <img src={report.photos.find((photo) => photo.dataUrl)?.dataUrl} alt={report.title} /> : <><span className="report-structure"><i /><i /><i /></span><span className="report-card__photo-count"><Images size={14} /> {report.photos.length}</span></>}
                  <span className="report-card__accepted"><Check size={14} /> Принято</span>
                </div>
                <div className="report-card__body"><span>{stage?.name}</span><h3>{report.title}</h3><p>{report.measurement ?? report.note}</p><div><small>{report.acceptedAt ? formatDateTime(report.acceptedAt) : ''}</small><button type="button" onClick={() => setReportId(report.id)}><Eye size={15} /> Смотреть</button></div></div>
              </article>
            );
          })}
        </div>
      </section>

      <section className="client-grid client-grid--bottom">
        <article className="panel client-payments">
          <SectionHeader eyebrow="Договор" title="Платежи" />
          <div className="payment-overview"><div><small>Стоимость строительства</small><strong>{money(state.project.contractValue)}</strong></div><div><small>Оплачено</small><strong>{money(finance.received)}</strong></div></div>
          <ProgressBar value={finance.received / state.project.contractValue * 100} />
          <div className="next-payment"><span><Clock3 size={17} /><span><small>Следующий платёж</small><strong>После приёмки тёплого контура</strong></span></span><strong>{money(1_400_000)}</strong></div>
          <p className="client-muted-note">Изменения стоимости появляются здесь только после вашего согласования.</p>
        </article>

        <article className="panel client-documents">
          <SectionHeader eyebrow="Цифровой паспорт" title="Документы дома" />
          <div className="document-list">
            {documents.slice(0, 4).map((document) => (
              <button type="button" key={document.id} onClick={() => setDocumentId(document.id)}><span className="document-list__icon">{document.type === 'Проект' ? <FileText size={18} /> : <FileCheck2 size={18} />}</span><span><strong>{document.name}</strong><small>{document.type} · обновлён {formatDate(document.updatedAt)}</small></span><Download size={17} /></button>
            ))}
          </div>
        </article>
      </section>

      <section className="client-promise">
        <ShieldCheck size={23} />
        <div><strong>5 лет гарантии — в цифровом паспорте дома</strong><p>После сдачи здесь останутся проект, исполнительная документация, оборудование, история работ и гарантийные обращения.</p></div>
        <button className="button button--light" type="button" onClick={() => setInfoModal('warranty')}>Как работает гарантия <ChevronRight size={16} /></button>
      </section>

      {activeDecision && (
        <Modal title={activeDecision.title} subtitle={`Ответ нужен до ${formatDate(activeDecision.dueDate, true)}. Решение попадёт в журнал проекта.`} onClose={() => setDecisionId(null)}>
          <div className="decision-options">
            {(activeDecision.id === 'decision-1' ? ['Натуральный дуб', 'Графит', 'Терракота'] : ['Вариант A', 'Вариант B', 'Нужна консультация']).map((option) => <button type="button" className={choice === option ? 'decision-option decision-option--selected' : 'decision-option'} onClick={() => setChoice(option)} key={option}><span>{option}</span>{choice === option && <CheckCircle2 size={18} />}</button>)}
          </div>
          <div className="decision-preview"><Eye size={18} /><span>В рабочей версии здесь будет визуализация выбора на фасаде или плане.</span></div>
          <div className="modal__actions"><button type="button" className="button button--ghost" onClick={() => setDecisionId(null)}>Отмена</button><button type="button" className="button button--primary" onClick={decide}><Check size={17} /> Подтвердить решение</button></div>
        </Modal>
      )}

      {infoModal === 'camera' && <Modal wide title="Камера на объекте" subtitle={`${state.project.code} · ${camera?.online ? 'камера онлайн' : 'камера недоступна'}`} onClose={() => setInfoModal(null)}>{camera?.configured ? <div className="client-camera-view"><iframe title={`Трансляция ${camera.label}`} src={`/api/camera/view?projectId=${encodeURIComponent(state.project.id)}`} allow="autoplay; fullscreen" allowFullScreen /><p>Поток открывается только после проверки пользователя и его роли в проекте.</p></div> : <div className="client-info-modal"><Camera size={28} /><h3>Камера ещё не подключена</h3><p>После установки оборудования здесь появится защищённая трансляция. Логин и пароль камеры не будут храниться в карточке проекта.</p></div>}</Modal>}

      {infoModal === 'reports' && <Modal wide title="Все принятые отчёты" subtitle="Клиент видит только работы, которые прошли контроль." onClose={() => setInfoModal(null)}><div className="entity-related-list">{acceptedReports.map((report) => <button type="button" key={report.id} onClick={() => { setInfoModal(null); setReportId(report.id); }}><span><strong>{report.title}</strong><small>{state.stages.find((item) => item.id === report.stageId)?.name} · {report.photos.length} фото</small></span><StatusBadge label="Принято" tone="positive" /></button>)}</div></Modal>}

      {selectedReport && <Modal wide title={selectedReport.title} subtitle={`${state.stages.find((item) => item.id === selectedReport.stageId)?.name} · ${selectedReport.zone}`} onClose={() => setReportId(null)}><div className="entity-detail-grid"><section className="entity-detail-card"><small>Результат</small><strong>{selectedReport.measurement ?? 'Замер не указан'}</strong><span>{selectedReport.note ?? 'Замечаний нет'}</span></section><section className="entity-detail-card"><small>Проверка</small><strong>{selectedReport.reviewer}</strong><span>{selectedReport.acceptedAt ? formatDateTime(selectedReport.acceptedAt) : 'Дата не указана'}</span></section><section className="entity-detail-card"><small>Доказательства</small><strong>{selectedReport.photos.length} фото</strong><span>{selectedReport.requiredShots.length} обязательных ракурсов</span></section></div></Modal>}

      {selectedDocument && <Modal title={selectedDocument.name} subtitle={`${selectedDocument.type} · обновлён ${formatDate(selectedDocument.updatedAt, true)}`} onClose={() => setDocumentId(null)}><div className="client-info-modal"><FileCheck2 size={28} /><h3>{selectedDocument.status === 'signed' ? 'Подписанный документ' : 'Актуальная версия'}</h3><p>{selectedDocument.fileName ? `Файл «${selectedDocument.fileName}» хранится в защищённом архиве проекта и доступен только участникам с разрешением.` : 'Карточка документа создана, но сам файл ещё не загружен в архив ИКИОМА ОС.'}</p>{selectedDocument.fileKey && <button type="button" className="button button--primary" onClick={() => window.open(`/api/documents/file?projectId=${encodeURIComponent(state.project.id)}&key=${encodeURIComponent(selectedDocument.fileKey ?? '')}`, '_blank', 'noopener,noreferrer')}><Download size={16} /> Открыть файл</button>}</div></Modal>}

      {infoModal === 'warranty' && <Modal title="Гарантия на дом" subtitle="История дома остаётся в ИКИОМА ОС после сдачи." onClose={() => setInfoModal(null)}><div className="client-info-modal"><ShieldCheck size={28} /><h3>5 лет единой истории гарантии</h3><p>В цифровом паспорте сохраняются принятые работы, материалы, оборудование и документы. Гарантийное обращение будет связано с конкретным узлом, исполнителем и актом приёмки.</p></div></Modal>}
    </div>
  );
}

