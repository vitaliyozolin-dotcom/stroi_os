import type { AppState, Stage } from './types';

const IMPORT_MARKER = 'ppr-kelosi-2026-08-17-v2-exact';
const PREVIOUS_IMPORT_MARKER = 'ppr-kelosi-2026-08-17-v1';
const IMPORTED_AT = '2026-08-17T07:27:00.000Z';

const includesKelosi = (value?: string) => String(value || '').trim().toLocaleLowerCase('ru-RU').includes('келози');

const isKelosiProject = (state: AppState) => [
  state.project.name,
  state.project.code,
  state.project.address,
].some(includesKelosi);

const pprStage = ({
  id,
  order,
  name,
  shortName,
  planStart,
  planEnd,
  responsible,
}: {
  id: string;
  order: number;
  name: string;
  shortName: string;
  planStart: string;
  planEnd: string;
  responsible: string;
}): Stage => ({
  id,
  order,
  name,
  shortName,
  status: 'not_ready',
  // В исходном ППР нет весов. Единица нужна только технически для расчёта общего прогресса,
  // поэтому все строки равнозначны и не получают придуманного приоритета.
  weight: 1,
  progress: 0,
  planStart,
  planEnd,
  forecastEnd: planEnd,
  responsible,
});

export const applyKelosiPpr = (state: AppState): AppState => {
  if (!isKelosiProject(state) || state.activity.some((event) => event.id === IMPORT_MARKER)) return state;

  const responsible = state.project.foreman.trim() || 'Не назначен';
  const stages: Stage[] = [
    pprStage({ id: 'kelosi-ppr-1', order: 1, name: '1.Оформление сделки/покупка З/у/подписание договоров долевого участия в проекте', shortName: '1. Оформление сделки', planStart: '2026-08-10', planEnd: '2026-08-10', responsible }),
    pprStage({ id: 'kelosi-ppr-2', order: 2, name: '2.подготовка участка/выравнивание/вырубка деревьев/вывоз мусора', shortName: '2. Подготовка участка', planStart: '2026-08-10', planEnd: '2026-08-25', responsible }),
    pprStage({ id: 'kelosi-ppr-2-2', order: 3, name: '2.2 Заключение основных договоров на ТМЦ/изготовление СИП/окна ПВХ/поставка ТМЦ и пр.', shortName: '2.2 Договоры на ТМЦ', planStart: '2026-08-10', planEnd: '2026-08-25', responsible }),
    pprStage({ id: 'kelosi-ppr-3', order: 4, name: '3.Устройство фундамента ЖБ сваи', shortName: '3. ЖБ сваи', planStart: '2026-08-10', planEnd: '2026-08-15', responsible }),
    pprStage({ id: 'kelosi-ppr-3-1', order: 5, name: '3.1.Доставка  основных пиломатериалов/крепежа+пены', shortName: '3.1 Пиломатериалы', planStart: '2026-08-10', planEnd: '2026-08-15', responsible }),
    pprStage({ id: 'kelosi-ppr-4', order: 6, name: '4. Устройство обвязки свайного поля', shortName: '4. Обвязка свай', planStart: '2026-08-14', planEnd: '2026-08-16', responsible }),
    pprStage({ id: 'kelosi-ppr-5', order: 7, name: '5.Доставка СИП панелей .Сборка СИП перекрытия на отметке "0"', shortName: '5. СИП перекрытие «0»', planStart: '2026-08-16', planEnd: '2026-08-20', responsible }),
    pprStage({ id: 'kelosi-ppr-6', order: 8, name: '6.Доставка СИП панелей. Сборка наружных стен и каркасных перегородок', shortName: '6. Стены и перегородки', planStart: '2026-08-20', planEnd: '2026-08-27', responsible }),
    pprStage({ id: 'kelosi-ppr-7', order: 9, name: '7.Доставка СИП панелей. Сборка перекрытия под кровлю', shortName: '7. Перекрытие под кровлю', planStart: '2026-08-27', planEnd: '2026-09-10', responsible }),
    pprStage({ id: 'kelosi-ppr-7-1', order: 10, name: '7.1 Доставка профлиста(кровля+фасад)', shortName: '7.1 Профлист', planStart: '2026-08-25', planEnd: '2026-08-27', responsible }),
    pprStage({ id: 'kelosi-ppr-8', order: 11, name: '8. Монтаж окон ПВХ', shortName: '8. Окна ПВХ', planStart: '2026-08-27', planEnd: '2026-09-10', responsible }),
    pprStage({ id: 'kelosi-ppr-9', order: 12, name: '9. Утепление перегородок внутри.', shortName: '9. Утепление перегородок', planStart: '2026-08-27', planEnd: '2026-09-10', responsible }),
  ];

  return {
    ...state,
    schemaVersion: Math.max(Number(state.schemaVersion) || 0, 18),
    stages,
    activity: [
      {
        id: IMPORT_MARKER,
        timestamp: IMPORTED_AT,
        actor: 'Система',
        text: 'ППР.xlsx перенесён в проект Келози 1:1: 12 строк, исходные периоды, без добавленных зависимостей и весов',
        tone: 'neutral',
      },
      ...state.activity.filter((event) => event.id !== PREVIOUS_IMPORT_MARKER),
    ],
  };
};
