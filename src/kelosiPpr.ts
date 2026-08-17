import type { AppState, Stage } from './types';

const IMPORT_MARKER = 'ppr-kelosi-2026-08-17-v1';
const IMPORTED_AT = '2026-08-17T07:21:00.000Z';

const includesKelosi = (value?: string) => String(value || '').trim().toLocaleLowerCase('ru-RU').includes('келози');

const isKelosiProject = (state: AppState) => [
  state.project.name,
  state.project.code,
  state.project.address,
].some(includesKelosi);

const earlierDate = (current: string, candidate: string) => !current || candidate < current ? candidate : current;
const laterDate = (current: string, candidate: string) => !current || candidate > current ? candidate : current;

const stage = ({
  id,
  order,
  name,
  shortName,
  weight,
  planStart,
  planEnd,
  responsible,
  dependencyId,
  dependency,
  ready = false,
}: {
  id: string;
  order: number;
  name: string;
  shortName: string;
  weight: number;
  planStart: string;
  planEnd: string;
  responsible: string;
  dependencyId?: string;
  dependency?: string;
  ready?: boolean;
}): Stage => ({
  id,
  order,
  name,
  shortName,
  status: ready ? 'ready' : 'not_ready',
  weight,
  progress: 0,
  planStart,
  planEnd,
  forecastEnd: planEnd,
  responsible,
  dependencyId,
  dependency,
});

export const applyKelosiPpr = (state: AppState): AppState => {
  if (!isKelosiProject(state) || state.activity.some((event) => event.id === IMPORT_MARKER)) return state;

  const responsible = state.project.foreman.trim() || 'Не назначен';
  const stages: Stage[] = [
    stage({ id: 'kelosi-deal', order: 1, name: 'Оформление сделки / покупка земельного участка / подписание договоров долевого участия в проекте', shortName: 'Сделка и участок', weight: 3, planStart: '2026-08-10', planEnd: '2026-08-10', responsible, ready: true }),
    stage({ id: 'kelosi-site-prep', order: 2, name: 'Подготовка участка / выравнивание / вырубка деревьев / вывоз мусора', shortName: 'Подготовка участка', weight: 6, planStart: '2026-08-10', planEnd: '2026-08-25', responsible, ready: true }),
    stage({ id: 'kelosi-contracts', order: 3, name: 'Заключение основных договоров на ТМЦ / изготовление СИП / окна ПВХ / поставка ТМЦ и пр.', shortName: 'Договоры и ТМЦ', weight: 6, planStart: '2026-08-10', planEnd: '2026-08-25', responsible, ready: true }),
    stage({ id: 'kelosi-foundation', order: 4, name: 'Устройство фундамента — ЖБ сваи', shortName: 'ЖБ сваи', weight: 12, planStart: '2026-08-10', planEnd: '2026-08-15', responsible, ready: true }),
    stage({ id: 'kelosi-lumber', order: 5, name: 'Доставка основных пиломатериалов / крепежа / пены', shortName: 'Пиломатериалы', weight: 5, planStart: '2026-08-10', planEnd: '2026-08-15', responsible, ready: true }),
    stage({ id: 'kelosi-pile-strapping', order: 6, name: 'Устройство обвязки свайного поля', shortName: 'Обвязка свай', weight: 8, planStart: '2026-08-14', planEnd: '2026-08-16', responsible, ready: true }),
    stage({ id: 'kelosi-sip-floor', order: 7, name: 'Доставка СИП панелей. Сборка СИП перекрытия на отметке «0»', shortName: 'СИП перекрытие 0', weight: 10, planStart: '2026-08-16', planEnd: '2026-08-20', responsible, dependencyId: 'kelosi-pile-strapping', dependency: 'Обвязка свай' }),
    stage({ id: 'kelosi-sip-walls', order: 8, name: 'Доставка СИП панелей. Сборка наружных стен и каркасных перегородок', shortName: 'Стены и перегородки', weight: 14, planStart: '2026-08-20', planEnd: '2026-08-27', responsible, dependencyId: 'kelosi-sip-floor', dependency: 'СИП перекрытие 0' }),
    stage({ id: 'kelosi-roof-floor', order: 9, name: 'Доставка СИП панелей. Сборка перекрытия под кровлю', shortName: 'Перекрытие кровли', weight: 12, planStart: '2026-08-27', planEnd: '2026-09-10', responsible, dependencyId: 'kelosi-sip-walls', dependency: 'Стены и перегородки' }),
    stage({ id: 'kelosi-profsheet', order: 10, name: 'Доставка профлиста (кровля + фасад)', shortName: 'Профлист', weight: 5, planStart: '2026-08-25', planEnd: '2026-08-27', responsible, ready: true }),
    stage({ id: 'kelosi-windows', order: 11, name: 'Монтаж окон ПВХ', shortName: 'Окна ПВХ', weight: 10, planStart: '2026-08-27', planEnd: '2026-09-10', responsible, dependencyId: 'kelosi-sip-walls', dependency: 'Стены и перегородки' }),
    stage({ id: 'kelosi-insulation', order: 12, name: 'Утепление перегородок внутри', shortName: 'Утепление перегородок', weight: 9, planStart: '2026-08-27', planEnd: '2026-09-10', responsible, dependencyId: 'kelosi-sip-walls', dependency: 'Стены и перегородки' }),
  ];

  return {
    ...state,
    schemaVersion: Math.max(Number(state.schemaVersion) || 0, 18),
    project: {
      ...state.project,
      startDate: earlierDate(state.project.startDate, '2026-08-10'),
      targetDate: laterDate(state.project.targetDate, '2026-09-10'),
      forecastDate: laterDate(state.project.forecastDate, '2026-09-10'),
    },
    stages,
    activity: [
      {
        id: IMPORT_MARKER,
        timestamp: IMPORTED_AT,
        actor: 'Система',
        text: 'Импортирован график производства работ из ППР.xlsx для проекта Келози',
        tone: 'neutral',
      },
      ...state.activity,
    ],
  };
};
