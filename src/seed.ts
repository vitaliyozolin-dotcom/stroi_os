import type { AppState, BudgetLine, Stage, SystemUser } from './entities/index';
import { uid } from './infrastructure/runtime.ts';

const DAY_MS = 86_400_000;

const dateKey = (date: Date) => date.toISOString().slice(0, 10);

const addDays = (value: string, days: number) => {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return dateKey(date);
};

const defaultStart = dateKey(new Date());
const defaultTarget = addDays(defaultStart, 120);

const stageTemplates = [
  { id: 'prebuild', name: 'Подготовка участка и временные сети', shortName: 'Подготовка', weight: 5, duration: 7 },
  { id: 'foundation', name: 'Фундамент', shortName: 'Фундамент', weight: 10, duration: 10 },
  { id: 'floor', name: 'Перекрытие и нижняя обвязка', shortName: 'Перекрытие', weight: 6, duration: 7 },
  { id: 'sip', name: 'Сборка силового и SIP-контура', shortName: 'SIP-контур', weight: 15, duration: 14 },
  { id: 'roof', name: 'Кровля', shortName: 'Кровля', weight: 8, duration: 10 },
  { id: 'openings', name: 'Окна и входные двери', shortName: 'Окна', weight: 6, duration: 7 },
  { id: 'facade', name: 'Фасад и защита контура', shortName: 'Фасад', weight: 7, duration: 14 },
  { id: 'electric', name: 'Электрика', shortName: 'Электрика', weight: 7, duration: 10 },
  { id: 'engineering', name: 'Вода, канализация, ОВиК', shortName: 'Инженерия', weight: 10, duration: 14 },
  { id: 'rough', name: 'Черновая отделка', shortName: 'Черновая', weight: 7, duration: 12 },
  { id: 'finish', name: 'Чистовая отделка', shortName: 'Чистовая', weight: 7, duration: 14 },
  { id: 'commissioning', name: 'Пусконаладка и испытания', shortName: 'Испытания', weight: 7, duration: 7 },
  { id: 'handover', name: 'Сдача дома клиенту', shortName: 'Сдача', weight: 5, duration: 4 },
] as const;

export const buildStages = (startDate: string, targetDate: string, foreman = '', activateFirst = true): Stage[] => {
  const startTime = new Date(`${startDate}T12:00:00Z`).getTime();
  const targetTime = new Date(`${targetDate}T12:00:00Z`).getTime();
  const availableDays = Math.max(13, Math.round((targetTime - startTime) / DAY_MS));
  const templateDays = stageTemplates.reduce((sum, stage) => sum + stage.duration, 0);
  let cursor = 0;

  return stageTemplates.map((template, index) => {
    const startOffset = Math.min(availableDays - 1, Math.round(cursor / templateDays * availableDays));
    cursor += template.duration;
    const endOffset = index === stageTemplates.length - 1
      ? availableDays
      : Math.max(startOffset + 1, Math.round(cursor / templateDays * availableDays));
    const responsible = index === 0 && foreman.trim() ? foreman.trim() : 'Не назначен';
    return {
      id: template.id,
      order: index + 1,
      name: template.name,
      shortName: template.shortName,
      status: activateFirst && index === 0 ? 'ready' : 'not_ready',
      weight: template.weight,
      progress: 0,
      planStart: addDays(startDate, startOffset),
      planEnd: addDays(startDate, endOffset),
      forecastEnd: addDays(startDate, endOffset),
      responsible,
      dependencyId: index > 0 ? stageTemplates[index - 1].id : undefined,
      dependency: index > 0 ? stageTemplates[index - 1].shortName : undefined,
    };
  });
};

const budgetTemplate: Array<BudgetLine & { share: number }> = [
  { id: 'bl-prebuild', stageIds: ['prebuild'], name: 'Подготовка участка', plan: 0, forecast: 0, share: 0.04 },
  { id: 'bl-foundation', stageIds: ['foundation'], name: 'Фундамент', plan: 0, forecast: 0, share: 0.13 },
  { id: 'bl-structure', stageIds: ['floor', 'sip'], name: 'Силовой контур и SIP', plan: 0, forecast: 0, share: 0.25 },
  { id: 'bl-roof', stageIds: ['roof'], name: 'Кровля', plan: 0, forecast: 0, share: 0.10 },
  { id: 'bl-openings', stageIds: ['openings'], name: 'Окна и двери', plan: 0, forecast: 0, share: 0.08 },
  { id: 'bl-facade', stageIds: ['facade'], name: 'Фасад', plan: 0, forecast: 0, share: 0.09 },
  { id: 'bl-engineering', stageIds: ['electric', 'engineering'], name: 'Инженерные системы', plan: 0, forecast: 0, share: 0.17 },
  { id: 'bl-finish', stageIds: ['rough', 'finish'], name: 'Отделка', plan: 0, forecast: 0, share: 0.11 },
  { id: 'bl-management', stageIds: ['commissioning', 'handover'], name: 'Управление и резерв', plan: 0, forecast: 0, share: 0.03 },
];

const emptyBudget = (): BudgetLine[] => budgetTemplate.map(({ share: _share, ...line }) => ({ ...line }));

const owner: SystemUser = {
  id: 'user-owner',
  name: 'Виталий Озолин',
  email: 'vitaliyozolin@gmail.com',
  role: 'management',
  status: 'active',
};

export const photoStandard = [
  'Общий вид зоны',
  'Средний план работы',
  'Крупный план узла',
  'Замер с читаемым прибором',
  'Маркировка материала',
  'Результат испытания',
  'Итог после устранения замечаний',
];

export const seedState: AppState = {
  version: 1,
  schemaVersion: 17,
  project: {
    id: 'workspace-initial',
    code: 'NEW',
    name: 'Новый проект',
    address: '',
    model: '',
    area: 0,
    clientNames: '',
    contractValue: 0,
    targetCost: 0,
    startDate: defaultStart,
    targetDate: defaultTarget,
    forecastDate: defaultTarget,
    foreman: '',
    cameraStatus: 'offline',
    createdAt: new Date().toISOString(),
    source: 'Чистое рабочее пространство',
    status: 'workspace',
  },
  budgetMeta: {
    version: '—',
    source: 'Смета не загружена',
    note: 'План появится после загрузки или ручного подтверждения сметы.',
  },
  stages: buildStages(defaultStart, defaultTarget, '', false),
  budgetLines: emptyBudget(),
  financeEntries: [],
  procurement: [],
  counterparties: [],
  supplierQuotes: [],
  leads: [],
  tasks: [],
  fieldReports: [],
  settings: {
    schemaVersion: 17,
    users: [owner],
    notifications: {
      channels: { email: false, telegram: false, browser: true },
      events: {
        financeApproval: true,
        supplyRisk: true,
        qualityRework: true,
        leadWithoutAction: true,
        scheduleDelay: true,
        taskAssigned: true,
        taskOverdue: true,
        projectActivity: true,
      },
    },
    dashboardWidgets: ['project', 'progress', 'finance', 'decisions', 'cashflow', 'quality', 'supply', 'tasks', 'activity'],
  },
  checkpoints: [],
  documents: [],
  decisions: [],
  activity: [],
};

export const createProjectState = (base: AppState, input: {
  code: string;
  name: string;
  address: string;
  model: string;
  area: number;
  clientNames: string;
  contractValue: number;
  targetCost: number;
  startDate: string;
  targetDate: string;
  foreman: string;
  source: string;
  actor: string;
}): AppState => {
  const createdAt = new Date().toISOString();
  const targetCost = Math.max(0, input.targetCost);
  const budgetLines = budgetTemplate.map(({ share, ...line }, index) => {
    const plan = index === budgetTemplate.length - 1
      ? targetCost - budgetTemplate.slice(0, -1).reduce((sum, item) => sum + Math.round(targetCost * item.share / 1000) * 1000, 0)
      : Math.round(targetCost * share / 1000) * 1000;
    return { ...line, plan: Math.max(0, plan), forecast: Math.max(0, plan) };
  });

  return {
    version: 1,
    schemaVersion: 17,
    project: {
      id: uid('house'),
      code: input.code.trim(),
      name: input.name.trim(),
      address: input.address.trim(),
      model: input.model.trim(),
      area: input.area,
      clientNames: input.clientNames.trim(),
      contractValue: input.contractValue,
      targetCost,
      startDate: input.startDate,
      targetDate: input.targetDate,
      forecastDate: input.targetDate,
      foreman: input.foreman.trim(),
      cameraStatus: 'offline',
      createdAt,
      source: input.source.trim() || 'Создан вручную в ИКИОМА ОС',
      status: 'active',
    },
    budgetMeta: {
      version: targetCost > 0 ? 'Черновик v1' : '—',
      source: targetCost > 0 ? 'Предварительный шаблон от плановой себестоимости' : 'Смета не загружена',
      importedAt: targetCost > 0 ? createdAt : undefined,
      note: targetCost > 0
        ? 'Это не утверждённая смета. Проверьте каждую статью по рабочему проекту и коммерческим предложениям.'
        : 'Загрузите смету или заполните план по статьям вручную.',
    },
    stages: buildStages(input.startDate, input.targetDate, input.foreman, true),
    budgetLines,
    financeEntries: [],
    procurement: [],
    counterparties: JSON.parse(JSON.stringify(base.counterparties)) as AppState['counterparties'],
    supplierQuotes: [],
    leads: [],
    tasks: [],
    fieldReports: [],
    settings: {
      ...JSON.parse(JSON.stringify(base.settings)) as AppState['settings'],
      // Доступ к каждому объекту назначается явно. Новый проект наследует только
      // профиль владельца и никогда — клиентов или сотрудников другого объекта.
      users: base.settings.users.filter((user) => user.id === 'user-owner').map((user) => ({ ...user })),
    },
    checkpoints: [],
    documents: [],
    decisions: [],
    activity: [{
      id: uid('activity'),
      timestamp: createdAt,
      actor: input.actor,
      text: `Создан проект ${input.code.trim()} · ${input.name.trim()}`,
      tone: 'positive',
    }],
  };
};
