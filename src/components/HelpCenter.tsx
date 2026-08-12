import { useEffect, useMemo, useState } from 'react';
import { BookOpen, ChevronLeft, ChevronRight, CircleDollarSign, FolderPlus, HelpCircle, ListTodo, Megaphone, PackageSearch, Settings2, ShieldCheck, UsersRound, X } from 'lucide-react';
import type { PageId } from '../types';
import { Modal } from './Ui';

type TourStep = { page?: PageId; selector: string; title: string; text: string; openProjects?: boolean };
type Topic = { id: string; title: string; text: string; icon: typeof HelpCircle; steps: TourStep[] };

const topics: Topic[] = [
  { id: 'project', title: 'Создать новый проект', text: 'От карточки дома до стартовой сметы и графика.', icon: FolderPlus, steps: [
    { selector: '[data-tour="project-list"]', title: '1. Реестр проектов', text: 'Здесь видны все дома. Вы можете переключаться между ними, не смешивая сметы, оплаты и историю.', openProjects: true },
    { selector: '[data-tour="new-project"]', title: '2. Создайте дом', text: 'Заполните клиента, адрес, площадь, стоимость договора, плановую себестоимость и сроки. Стартовая смета распределится по шаблону, затем её можно уточнить.', openProjects: true },
  ] },
  { id: 'money', title: 'От плана до оплаты', text: 'Как появляется план, обязательство, приёмка и платёж.', icon: CircleDollarSign, steps: [
    { page: 'finance', selector: '[data-tour="budget-plan"]', title: '1. План — это утверждённая смета', text: 'Источник и версия сметы показаны над таблицей. План не меняется от оплаты; прогноз меняется по договорам и рискам.' },
    { page: 'finance', selector: '[data-tour="finance-add"]', title: '2. Создайте обязательство', text: 'Укажите статью сметы, этап, контрагента, сумму и основание. Это ещё не оплата.' },
    { page: 'finance', selector: '[data-tour="finance-flow"]', title: '3. Примите и оплатите', text: 'После фактической приёмки фиксируется акт и принятая сумма. Затем отдельно вносится дата, сумма и документ платежа.' },
  ] },
  { id: 'tasks', title: 'Поставить задачу', text: 'Ответственный, срок, связь с этапом и подтверждённый результат.', icon: ListTodo, steps: [
    { page: 'tasks', selector: '[data-tour="task-add"]', title: '1. Создайте задачу', text: 'Укажите одного ответственного, срок и ожидаемый результат. При необходимости свяжите задачу с этапом, закупкой, контрагентом или проверкой качества.' },
    { page: 'tasks', selector: '[data-tour="task-workspace"]', title: '2. Контролируйте исполнение', text: 'Фильтры показывают мои, сегодняшние и просроченные задачи. Вкладка «Ответственные» показывает нагрузку и ближайший срок каждого участника.' },
  ] },
  { id: 'partners', title: 'Подрядчики и поставщики', text: 'Как создать карточку и связать с работой или заказом.', icon: UsersRound, steps: [
    { page: 'counterparties', selector: '[data-tour="counterparties"]', title: '1. Единый справочник', text: 'Сначала создайте контрагента: контакты, специализация и при необходимости реквизиты.' },
    { page: 'procurement', selector: '[data-tour="procurement-add"]', title: '2. Свяжите с закупкой', text: 'В потребности выберите существующего поставщика. Заказ, срок, бюджет и документы попадут в его историю.' },
  ] },
  { id: 'sales', title: 'Заявки и воронка', text: 'От заявки с ikioma.ru до договора и запуска проекта.', icon: Megaphone, steps: [
    { page: 'marketing', selector: '.marketing-funnel-panel', title: '1. Воронка продаж', text: 'Заявки с сайта попадают в этап «Новая». Для каждой заявки задайте ответственного, следующий контакт и срок.' },
    { page: 'marketing', selector: '.leads-panel', title: '2. Карточка обращения', text: 'Откройте заявку, уточните участок, финансирование и параметры дома. Переводите клиента по этапам до договора или фиксируйте отказ.' },
  ] },
  { id: 'supply', title: 'Снабжение и сроки', text: 'Потребность, коммерческие предложения, заказ и приёмка.', icon: PackageSearch, steps: [
    { page: 'procurement', selector: '[data-tour="procurement-add"]', title: '1. Создайте потребность', text: 'Привяжите материал к этапу, сроку потребности и бюджету. Риск поставки должен быть сформулирован как конкретное препятствие.' },
    { page: 'schedule', selector: '.page-title-row', title: '2. Сверьте с графиком', text: 'Поставка должна приходить до старта зависимого этапа. Блокировку и новый прогноз фиксируйте сразу, а не после срыва.' },
  ] },
  { id: 'quality', title: 'Качество и приёмка', text: 'Фотофиксация, замечания, скрытые работы и доступ клиента.', icon: ShieldCheck, steps: [
    { page: 'quality', selector: '.page-title-row', title: '1. Контрольная точка', text: 'Загрузите обязательные ракурсы и результаты измерений. Принятие должно опираться на факты, а не на устную договорённость.' },
    { page: 'quality', selector: '.page-stack', title: '2. Доработка или приёмка', text: 'Замечание создаёт управляемый возврат в работу. Только принятые результаты становятся основанием для оплаты и видимости клиенту.' },
  ] },
  { id: 'settings', title: 'Роли, Telegram и уведомления', text: 'Кому что видно и какие события уходят команде.', icon: Settings2, steps: [
    { page: 'settings', selector: '.settings-tabs', title: '1. Доступы и роли', text: 'Управление видит весь проект, прораб — производственные разделы, клиент — только отдельный клиентский контур.' },
    { page: 'settings', selector: '.settings-layout', title: '2. Каналы и события', text: 'Сначала подключите общий Telegram-чат, затем включите канал и нужные события. Тестовая кнопка подтверждает доставку провайдером.' },
  ] },
];

export function HelpCenter({ onNavigate, onOpenProjects, onComplete, openSignal = 0 }: { onNavigate: (page: PageId) => void; onOpenProjects: () => void; onComplete: () => void; openSignal?: number }) {
  const [open, setOpen] = useState(false);
  const [welcome, setWelcome] = useState(() => window.localStorage.getItem('stroios.help.seen.v1') !== 'yes');
  const [tour, setTour] = useState<Topic | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const step = tour?.steps[stepIndex];

  useEffect(() => { if (openSignal > 0) setOpen(true); }, [openSignal]);

  const activate = (topic: Topic, index = 0) => {
    const next = topic.steps[index];
    setOpen(false);
    setTour(topic);
    setStepIndex(index);
    if (next.page) onNavigate(next.page);
    if (next.openProjects) onOpenProjects();
  };

  useEffect(() => {
    if (!step) return;
    const update = () => {
      const element = document.querySelector(step.selector);
      setRect(element?.getBoundingClientRect() ?? null);
    };
    const timer = window.setTimeout(update, 180);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => { window.clearTimeout(timer); window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); };
  }, [step]);

  const calloutStyle = useMemo(() => {
    if (!rect) return { left: 16, top: 120 };
    const width = Math.min(340, window.innerWidth - 32);
    const below = rect.bottom + 14;
    const top = below + 190 < window.innerHeight ? below : Math.max(16, rect.top - 190);
    return { width, left: Math.min(window.innerWidth - width - 16, Math.max(16, rect.left)), top };
  }, [rect]);

  const closeWelcome = () => { window.localStorage.setItem('stroios.help.seen.v1', 'yes'); setWelcome(false); };
  const dismissTraining = () => {
    closeWelcome();
    window.localStorage.setItem('stroios.help.completed.v1', 'yes');
    setOpen(false);
    setTour(null);
    onComplete();
  };
  const next = () => {
    if (!tour) return;
    if (stepIndex >= tour.steps.length - 1) {
      window.localStorage.setItem('stroios.help.completed.v1', 'yes');
      setTour(null);
      onComplete();
      return;
    }
    activate(tour, stepIndex + 1);
  };

  return <>
    {welcome && !open && !tour && <div className="help-welcome"><button type="button" onClick={closeWelcome} aria-label="Закрыть"><X size={15} /></button><strong>Я помогу освоиться</strong><p>Покажу по шагам, как создать проект, внести смету и провести оплату.</p><button type="button" className="text-button" onClick={() => { closeWelcome(); setOpen(true); }}>Открыть обучение</button></div>}
    <div className="help-fab-wrap"><button type="button" className="help-fab" aria-label="Обучение" onClick={() => { closeWelcome(); setOpen(true); }}><HelpCircle size={24} /></button><button type="button" className="help-fab-dismiss" aria-label="Закрыть обучение" title="Закрыть обучение" onClick={dismissTraining}><X size={13} /></button></div>
    {open && <Modal title="С чем помочь?" subtitle="Выберите сценарий — система покажет нужные кнопки прямо на экране." onClose={() => setOpen(false)}><div className="help-topics">{topics.map((topic) => { const Icon = topic.icon; return <button type="button" key={topic.id} onClick={() => activate(topic)}><span><Icon size={21} /></span><div><strong>{topic.title}</strong><p>{topic.text}</p></div><ChevronRight size={18} /></button>; })}<article><span><BookOpen size={21} /></span><div><strong>Главное правило СтройОС</strong><p>Каждая сумма и дата должны иметь основание: этап, заказ, приёмку и документ.</p></div></article></div></Modal>}
    {tour && step && <div className="tour-layer"><button type="button" className="tour-scrim" aria-label="Закрыть обучение" onClick={() => setTour(null)} />{rect && <div className="tour-highlight" style={{ left: rect.left - 5, top: rect.top - 5, width: rect.width + 10, height: rect.height + 10 }} />}<section className="tour-callout" style={calloutStyle}><div className="tour-callout__progress">Шаг {stepIndex + 1} из {tour.steps.length}<button type="button" onClick={() => setTour(null)}><X size={16} /></button></div><h3>{step.title}</h3><p>{step.text}</p><div><button type="button" className="button button--ghost button--compact" disabled={stepIndex === 0} onClick={() => activate(tour, stepIndex - 1)}><ChevronLeft size={15} /> Назад</button><button type="button" className="button button--primary button--compact" onClick={next}>{stepIndex === tour.steps.length - 1 ? 'Готово' : 'Дальше'} <ChevronRight size={15} /></button></div></section></div>}
  </>;
}
