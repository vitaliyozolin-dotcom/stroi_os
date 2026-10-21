import type {UserRole, DashboardWidget, NotificationSettings} from '../../entities/index';
export const roleLabels: Record<UserRole, string> = { management: 'Управление', foreman: 'Прораб', client: 'Клиент' };
export const widgetLabels: Record<DashboardWidget, { title: string; text: string }> = {
  project: { title: 'Карточка проекта', text: 'Дом, адрес и быстрые действия' },
  progress: { title: 'Физический прогресс', text: 'Факт и принятый объём работ' },
  finance: { title: 'Экономика проекта', text: 'План, факт и прогноз маржи' },
  decisions: { title: 'Требует решения', text: 'Блокеры, риски и ответы клиента' },
  cashflow: { title: 'Денежный поток', text: 'Поступления и выплаты по неделям' },
  quality: { title: 'Контроль качества', text: 'Проверки и скрытые работы' },
  supply: { title: 'Ближайшие поставки', text: 'Закупки и риски сроков' },
  tasks: { title: 'Задачи команды', text: 'Ответственные, сроки и просрочки' },
  activity: { title: 'Журнал проекта', text: 'Последние изменения участников' },
};
export const eventLabels: Record<keyof NotificationSettings['events'], { title: string; text: string }> = {
  financeApproval: { title: 'Согласование оплаты', text: 'Расход готов к приёмке или оплате' },
  supplyRisk: { title: 'Риск поставки', text: 'Срок, цена или поставщик требуют внимания' },
  qualityRework: { title: 'Возврат на доработку', text: 'Технадзор отклонил работу' },
  leadWithoutAction: { title: 'Заявка без действия', text: 'Менеджер пропустил следующий контакт' },
  scheduleDelay: { title: 'Отклонение от графика', text: 'Прогноз этапа вышел за план' },
  taskAssigned: { title: 'Новая задача', text: 'Назначен ответственный или задача передана другому' },
  taskOverdue: { title: 'Просрочка задачи', text: 'Срок прошёл, а задача не закрыта' },
  projectActivity: { title: 'Все изменения проекта', text: 'Отправлять изменения объекта в общий Telegram-чат' },
};

export function Toggle({ checked, onChange, label, disabled = false }: { checked: boolean; onChange: () => void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" disabled={disabled} aria-checked={checked} aria-label={label} className={checked ? 'toggle toggle--on' : 'toggle'} onClick={onChange}><span /></button>;
}
