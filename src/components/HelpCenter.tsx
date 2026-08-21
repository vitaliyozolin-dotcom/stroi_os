import { requestApi } from '../infrastructure/api-http';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  BookOpen, CalendarRange, Check, ChevronLeft, ChevronRight, CircleDollarSign, FolderPlus,
  HelpCircle, ListTodo, Megaphone, MessageSquareWarning, PackageSearch, Send, Settings2,
  ShieldCheck, X,
} from 'lucide-react';
import type { PageId } from '../presentation/navigation';
import { Field, Modal } from './Ui';

type TourStep = { page?: PageId; selector: string; title: string; text: string; openProjects?: boolean };
type Topic = { id: string; title: string; text: string; icon: typeof HelpCircle; steps: TourStep[] };
type FeedbackItem = { id: string; createdAt: string; createdBy: string; page: string; category: string; title: string; details: string; status: string };

const COMPLETED_KEY = 'stroios.help.completed.v2';
const DISMISSED_KEY = 'stroios.help.dismissed.v2';

const topics: Topic[] = [
  { id: 'project', title: 'Проекты и карточка дома', text: 'Создание объекта, документы, команда и исходные данные.', icon: FolderPlus, steps: [
    { selector: '[data-tour="project-list"]', title: '1. Реестр проектов', text: 'Здесь переключаются между домами. Сметы, оплаты и история каждого объекта хранятся отдельно.', openProjects: true },
    { selector: '[data-tour="new-project"]', title: '2. Создайте объект', text: 'Заполните клиента, адрес, площадь, стоимость, плановую себестоимость и сроки.', openProjects: true },
    { page: 'project', selector: '[data-tour="nav-project"]', title: '3. Карточка проекта', text: 'Здесь находятся параметры дома, участники, документы, решения и журнал объекта.' },
  ] },
  { id: 'leads', title: 'Заявки и воронка', text: 'От формы ИКИОМА до следующего действия менеджера.', icon: Megaphone, steps: [
    { page: 'marketing', selector: '[data-tour="nav-marketing"]', title: 'Маркетинг и заявки', text: 'Новые заявки с сайта появляются здесь. Назначьте ответственного, этап воронки и ближайшее действие.' },
  ] },
  { id: 'money', title: 'Смета, приёмка и оплата', text: 'План, обязательство, акт, платёж и прогноз маржи.', icon: CircleDollarSign, steps: [
    { page: 'finance', selector: '[data-tour="budget-plan"]', title: '1. План — утверждённая смета', text: 'План не меняется от оплаты; прогноз меняется по договорам, факту и рискам.' },
    { page: 'finance', selector: '[data-tour="finance-add"]', title: '2. Создайте обязательство', text: 'Укажите статью, этап, контрагента, сумму и основание. Это ещё не оплата.' },
    { page: 'finance', selector: '[data-tour="finance-flow"]', title: '3. Примите и оплатите', text: 'Сначала фиксируется приёмка и акт, затем отдельно дата, сумма и документ платежа.' },
  ] },
  { id: 'tasks', title: 'Задачи и ответственность', text: 'Один ответственный, срок и подтверждённый результат.', icon: ListTodo, steps: [
    { page: 'tasks', selector: '[data-tour="task-add"]', title: '1. Создайте задачу', text: 'Укажите ответственного, срок, результат и связь с этапом, закупкой или проверкой.' },
    { page: 'tasks', selector: '[data-tour="task-workspace"]', title: '2. Контролируйте исполнение', text: 'Фильтры показывают мои, сегодняшние и просроченные задачи, а вкладка ответственности — загрузку команды.' },
  ] },
  { id: 'schedule', title: 'Этапы и график', text: 'Плановые даты, прогноз, блокировки и приёмка этапа.', icon: CalendarRange, steps: [
    { page: 'schedule', selector: '[data-tour="nav-schedule"]', title: 'Этапы и график', text: 'Обновляйте прогноз, фиксируйте блокировки и передавайте завершённый этап на проверку.' },
  ] },
  { id: 'supply', title: 'Снабжение и контрагенты', text: 'Потребность, поставщик, заказ, доставка и документы.', icon: PackageSearch, steps: [
    { page: 'counterparties', selector: '[data-tour="counterparties"]', title: '1. Единый справочник', text: 'Создайте карточку подрядчика или поставщика с контактами, специализацией и реквизитами.' },
    { page: 'procurement', selector: '[data-tour="procurement-add"]', title: '2. Создайте потребность', text: 'Свяжите поставщика, этап, бюджет, дату поставки и документы заказа.' },
  ] },
  { id: 'quality', title: 'Качество и скрытые работы', text: 'Фотофиксация, проверка, доработка и приёмка.', icon: ShieldCheck, steps: [
    { page: 'quality', selector: '[data-tour="nav-quality"]', title: 'Контроль качества', text: 'Создайте точку контроля до закрытия работ, приложите подтверждение и дождитесь приёмки.' },
  ] },
  { id: 'settings', title: 'Доступы и уведомления', text: 'Роли, Telegram, тест сообщений и настройки проекта.', icon: Settings2, steps: [
    { page: 'settings', selector: '[data-tour="nav-settings"]', title: 'Настройки', text: 'Здесь управляют участниками и ролями, подключают общий Telegram-чат и отправляют тестовое уведомление.' },
    { selector: '[data-tour="profile-menu"]', title: 'Профиль и выход', text: 'Нажмите на профиль справа сверху, чтобы открыть настройки или безопасно выйти из аккаунта.' },
  ] },
];

export function HelpCenter({ projectId, currentPage, onNavigate, onOpenProjects, onCloseProjects }: { projectId: string; currentPage: PageId; onNavigate: (page: PageId) => void; onOpenProjects: () => void; onCloseProjects: () => void }) {
  const [open, setOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [welcome, setWelcome] = useState(() => window.localStorage.getItem('stroios.help.seen.v1') !== 'yes');
  const [dismissed, setDismissed] = useState(() => window.localStorage.getItem(DISMISSED_KEY) === 'yes');
  const [completed, setCompleted] = useState<string[]>(() => {
    try { return JSON.parse(window.localStorage.getItem(COMPLETED_KEY) || '[]') as string[]; } catch { return []; }
  });
  const [tour, setTour] = useState<Topic | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [feedback, setFeedback] = useState({ category: 'Ошибка', title: '', details: '' });
  const [feedbackItems, setFeedbackItems] = useState<FeedbackItem[]>([]);
  const [feedbackStatus, setFeedbackStatus] = useState('');
  const step = tour?.steps[stepIndex];
  const trainingFinished = completed.length >= topics.length;
  const showFeedbackFab = dismissed || trainingFinished;

  const activate = (topic: Topic, index = 0) => {
    const next = topic.steps[index];
    setOpen(false);
    setTour(topic);
    setStepIndex(index);
    if (next.openProjects) onOpenProjects();
    else onCloseProjects();
    if (next.page) onNavigate(next.page);
  };

  useEffect(() => {
    if (!step) return;
    const update = () => setRect(document.querySelector(step.selector)?.getBoundingClientRect() ?? null);
    const timer = window.setTimeout(update, 180);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => { window.clearTimeout(timer); window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); };
  }, [step]);

  useEffect(() => {
    if (!feedbackOpen) return;
    void requestApi(`/api/developer-feedback?projectId=${encodeURIComponent(projectId)}`, { headers: { Accept: 'application/json' } })
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((body: { items?: FeedbackItem[] }) => setFeedbackItems(body.items ?? []))
      .catch(() => setFeedbackItems([]));
  }, [feedbackOpen, projectId]);

  const calloutStyle = useMemo(() => {
    if (!rect) return { left: 16, top: 120 };
    const width = Math.min(340, window.innerWidth - 32);
    const below = rect.bottom + 14;
    const top = below + 190 < window.innerHeight ? below : Math.max(16, rect.top - 190);
    return { width, left: Math.min(window.innerWidth - width - 16, Math.max(16, rect.left)), top };
  }, [rect]);

  const closeWelcome = () => { window.localStorage.setItem('stroios.help.seen.v1', 'yes'); setWelcome(false); };
  const dismissTraining = () => { closeWelcome(); window.localStorage.setItem(DISMISSED_KEY, 'yes'); setDismissed(true); setOpen(false); setTour(null); };
  const next = () => {
    if (!tour) return;
    if (stepIndex >= tour.steps.length - 1) {
      const nextCompleted = Array.from(new Set([...completed, tour.id]));
      setCompleted(nextCompleted);
      window.localStorage.setItem(COMPLETED_KEY, JSON.stringify(nextCompleted));
      setTour(null);
      return;
    }
    activate(tour, stepIndex + 1);
  };

  const submitFeedback = async (event: FormEvent) => {
    event.preventDefault();
    if (!feedback.title.trim() || !feedback.details.trim()) return;
    setFeedbackStatus('Отправляем…');
    try {
      const response = await requestApi('/api/developer-feedback', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ projectId, page: currentPage, ...feedback }) });
      const body = await response.json() as { item?: FeedbackItem; error?: string };
      if (!response.ok || !body.item) throw new Error(body.error ?? 'request_failed');
      setFeedbackItems((items) => [body.item!, ...items]);
      setFeedback({ category: 'Ошибка', title: '', details: '' });
      setFeedbackStatus('Правка сохранена и видна разработчику.');
    } catch {
      setFeedbackStatus('Не удалось сохранить. Проверьте соединение и повторите.');
    }
  };

  return <>
    {welcome && !open && !tour && !showFeedbackFab && <div className="help-welcome"><button type="button" onClick={dismissTraining} aria-label="Закрыть обучение"><X size={15} /></button><strong>Я помогу освоиться</strong><p>Покажу ключевые процессы: от заявки и сметы до поставки, качества и уведомлений.</p><button type="button" className="text-button" onClick={() => { closeWelcome(); setOpen(true); }}>Открыть обучение</button></div>}
    <div className="help-fab-wrap">
      {!showFeedbackFab && <button type="button" className="help-fab-dismiss" aria-label="Закрыть обучение и открыть правки разработчику" onClick={dismissTraining}><X size={13} /></button>}
      <button type="button" className={`help-fab ${showFeedbackFab ? 'help-fab--feedback' : ''}`} aria-label={showFeedbackFab ? 'Правки разработчику' : 'Обучение'} onClick={() => { closeWelcome(); showFeedbackFab ? setFeedbackOpen(true) : setOpen(true); }}>
        {showFeedbackFab ? <><MessageSquareWarning size={20} /><span>Правки</span></> : <HelpCircle size={24} />}
      </button>
    </div>
    {open && <Modal title="Обучение ИКИОМА ОС" subtitle={`${completed.length} из ${topics.length} разделов пройдено. Можно закрыть обучение — на его месте появятся «Правки».`} onClose={() => setOpen(false)}><div className="help-topics">{topics.map((topic) => { const Icon = topic.icon; const done = completed.includes(topic.id); return <button type="button" key={topic.id} onClick={() => activate(topic)}><span>{done ? <Check size={21} /> : <Icon size={21} />}</span><div><strong>{topic.title}</strong><p>{topic.text}</p></div><ChevronRight size={18} /></button>; })}<article><span><BookOpen size={21} /></span><div><strong>Главное правило ИКИОМА ОС</strong><p>Каждая сумма и дата должны иметь основание: этап, заказ, приёмку и документ.</p></div></article><button type="button" className="help-dismiss-row" onClick={dismissTraining}><span><X size={20} /></span><div><strong>Закрыть обучение</strong><p>Вместо него появится раздел «Правки разработчику».</p></div><ChevronRight size={18} /></button></div></Modal>}
    {feedbackOpen && <Modal title="Правки разработчику" subtitle="Правки сохраняются в серверной очереди ИКИОМА ОС. Разработчик видит проект, раздел, автора и время отправки." onClose={() => setFeedbackOpen(false)}><form className="developer-feedback" onSubmit={submitFeedback}><div className="form-grid form-grid--2"><Field label="Тип"><select value={feedback.category} onChange={(event) => setFeedback((value) => ({ ...value, category: event.target.value }))}><option>Ошибка</option><option>Улучшение</option><option>Вопрос</option></select></Field><Field label="Раздел"><input value={currentPage} readOnly /></Field></div><Field label="Коротко"><input value={feedback.title} maxLength={160} required placeholder="Что нужно исправить" onChange={(event) => setFeedback((value) => ({ ...value, title: event.target.value }))} /></Field><Field label="Подробности"><textarea value={feedback.details} maxLength={3000} required rows={5} placeholder="Что произошло, что ожидали и как воспроизвести" onChange={(event) => setFeedback((value) => ({ ...value, details: event.target.value }))} /></Field><button type="submit" className="button button--primary"><Send size={16} /> Отправить разработчику</button>{feedbackStatus && <p className="developer-feedback__status">{feedbackStatus}</p>}</form>{feedbackItems.length > 0 && <section className="developer-feedback__history"><strong>Очередь для разработчика</strong>{feedbackItems.slice(0, 10).map((item) => <article key={item.id}><span>{item.category} · {item.status === 'new' ? 'новая' : item.status}</span><strong>{item.title}</strong><p>{item.details}</p><small>{item.createdBy} · раздел {item.page} · {new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(item.createdAt))}</small></article>)}</section>}</Modal>}
    {tour && step && <div className="tour-layer"><button type="button" className="tour-scrim" aria-label="Закрыть обучение" onClick={() => setTour(null)} />{rect && <div className="tour-highlight" style={{ left: rect.left - 5, top: rect.top - 5, width: rect.width + 10, height: rect.height + 10 }} />}<section className="tour-callout" style={calloutStyle}><div className="tour-callout__progress">Шаг {stepIndex + 1} из {tour.steps.length}<button type="button" onClick={() => setTour(null)}><X size={16} /></button></div><h3>{step.title}</h3><p>{step.text}</p><div><button type="button" className="button button--ghost button--compact" disabled={stepIndex === 0} onClick={() => activate(tour, stepIndex - 1)}><ChevronLeft size={15} /> Назад</button><button type="button" className="button button--primary button--compact" onClick={next}>{stepIndex === tour.steps.length - 1 ? 'Готово' : 'Дальше'} <ChevronRight size={15} /></button></div></section></div>}
  </>;
}
