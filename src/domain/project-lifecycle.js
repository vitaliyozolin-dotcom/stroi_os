import { emptyOrderRelations } from './order-relations.js';
const clone = value => JSON.parse(JSON.stringify(value));
const clean = (value, max = 500) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const lifecycleDefinitions = [
  { key: 'brief', number: '0.1', title: 'Задание заказчика', question: 'Понятны пожелания, бюджет и ожидаемый срок?', role: 'Менеджер проекта', group: 'preparation', locked: true },
  { key: 'site', number: '0.2', title: 'Участок и исходные данные', question: 'Участок и необходимые исходные данные проверены?', role: 'Инженер', group: 'preparation', locked: true },
  { key: 'scope', number: '0.3', title: 'Проект и комплектация', question: 'Согласованы проект, комплектация и границы работ?', role: 'Руководитель строительства', group: 'preparation', locked: true },
  { key: 'estimate', number: '0.4', title: 'Внутренняя смета', question: 'Подготовлена и проверена смета себестоимости?', role: 'Сметчик', group: 'preparation', locked: true, documents: true },
  { key: 'commercial', number: '0.5', title: 'Предложение заказчику', question: 'Заказчик согласовал состав работ и цену?', role: 'Менеджер проекта', group: 'preparation', locked: true },
  { key: 'ppr', number: '0.6', title: 'ППР и деньги по датам', question: 'Согласован график и потребность в деньгах по работам?', role: 'Руководитель строительства и финансист', group: 'preparation', locked: true },
  { key: 'contract', number: '0.7', title: 'Договор подряда', question: 'Подписан договор с актуальными приложениями?', role: 'Менеджер проекта', group: 'preparation', locked: true, documents: true },
  { key: 'funding', number: '0.8', title: 'Финансирование строительства', question: 'Подтверждены доступные подрядчику деньги по срокам ППР?', role: 'Финансист', group: 'preparation', locked: true, documents: true },
  { key: 'escrow', number: '0.8а', title: 'Условия эскроу', question: 'Применимые условия открытия и наполнения эскроу выполнены?', role: 'Банковский специалист', group: 'preparation', locked: true, documents: true, escrow: true },
  { key: 'readiness', number: '0.9', title: 'Готовность к запуску', question: 'Команда, площадка, стартовые поставки и контроль готовы?', role: 'Руководитель строительства', group: 'preparation', locked: true },
  { key: 'customer_acceptance', number: '3.1', title: 'Приёмка заказчиком', question: 'Дом принят заказчиком, акт передачи подписан?', role: 'Руководитель проекта', group: 'handover', locked: true, documents: true },
  { key: 'handover_docs', number: '3.2', title: 'Документы и инструкции', question: 'Заказчику передан комплект документов и инструкций?', role: 'Руководитель проекта', group: 'handover', locked: true },
  { key: 'registration', number: '3.3', title: 'Кадастр и регистрация', question: 'Применимые процедуры оформления выполнены?', role: 'Кадастровый специалист', group: 'handover', documents: true },
  { key: 'bank_release', number: '3.4', title: 'Условия раскрытия эскроу', question: 'Банк подтвердил выполнение условий раскрытия?', role: 'Банковский специалист', group: 'handover', locked: true, documents: true, escrow: true },
  { key: 'settlement', number: '3.5', title: 'Деньги и взаиморасчёты', question: 'Деньги получены и итоговые взаиморасчёты сверены?', role: 'Финансист', group: 'handover', locked: true, documents: true },
];
export const lifecyclePhaseLabels = { preparation: 'Этап 0 · Подготовка', construction: 'Строительство', handover: 'Сдача и расчёты', closed: 'Проект закрыт', warranty: 'Гарантийное сопровождение' };
export const createLifecycle = (now, source = {}) => ({
  version: 1, phase: 'preparation', usesEscrow: 'unknown', scope: 'unknown', startedAt: now,
  ...source, items: lifecycleDefinitions.map(def => ({ key: def.key, status: 'pending', required: true, basis: '', documentIds: [] })), history: [],
});
const documentExists = (state, id) => state.documents?.some(doc => doc.id === id && doc.fileKey);
export const lifecycleItemBlockers = (state, key) => {
  const lifecycle = state.project?.lifecycle;
  const def = lifecycleDefinitions.find(row => row.key === key);
  const item = lifecycle?.items?.find(row => row.key === key);
  if (!def || !item) return ['Пункт подготовки отсутствует.'];
  if (def.escrow && lifecycle.usesEscrow === 'no') return [];
  const result = [];
  if (def.escrow && lifecycle.usesEscrow === 'unknown') result.push('Уточните, используется ли эскроу.');
  if (!clean(item.basis)) result.push('Укажите основание подтверждения.');
  if (def.documents && !(item.documentIds ?? []).some(id => documentExists(state, id))) result.push('Приложите документ с доступным оригиналом.');
  if (key === 'scope' && lifecycle.scope === 'unknown') result.push('Выберите комплектацию.');
  if (key === 'site' && !clean(state.project.address)) result.push('Укажите адрес или местонахождение участка в карточке заказа.');
  if (key === 'estimate' && (state.budgetMeta?.estimateKind !== 'internal_cost' || !(state.budgetLines ?? []).length)) result.push('Нужна внутренняя смета себестоимости; цена договора её не заменяет.');
  if (key === 'ppr') {
    if (!(state.stages ?? []).length || state.stages.some(stage => !stage.planStart || !stage.planEnd || stage.planEnd < stage.planStart)) result.push('Заполните даты работ в ППР.');
    const outgoing = (state.financeEntries ?? []).filter(entry => entry.kind === 'expense' && entry.amount > 0 && (entry.dueDate || entry.date) && entry.stageId && state.stages.some(stage => stage.id === entry.stageId));
    if (!outgoing.length && !(state.treasury?.cashPlans ?? []).some(plan => plan.kind === 'expense' && plan.amountCents > 0 && (plan.date || plan.dateRule?.stageId && state.stages.some(stage => stage.id === plan.dateRule.stageId)))) result.push('Добавьте расходный план с суммой и датой, связанный с работами ППР.');
  }
  const prerequisites = { site: ['brief'], scope: ['brief', 'site'], estimate: ['scope'], commercial: ['estimate'], ppr: ['scope', 'estimate'], contract: ['brief', 'site', 'scope', 'estimate', 'commercial'], readiness: ['contract', 'ppr', 'funding', ...(lifecycle.usesEscrow === 'yes' ? ['escrow'] : [])] };
  if (!lifecycle.legacyReview && (prerequisites[key] ?? []).some(requiredKey => lifecycle.items.find(row => row.key === requiredKey)?.status !== 'done' || lifecycleItemBlockers(state, requiredKey).length)) result.push('Сначала подтвердите предшествующие результаты подготовки.');
  if (key === 'contract' && !lifecycle.legacyReview) {
    const missing = ['brief', 'site', 'scope', 'estimate', 'commercial'].filter(requiredKey => lifecycle.items.find(row => row.key === requiredKey)?.status !== 'done' || lifecycleItemBlockers(state, requiredKey).length);
    if (missing.length) result.push('Сначала подтвердите задание, участок, комплектацию и обе сметы.');
  }
  if (key === 'contract' && !(item.documentIds ?? []).some(id => state.documents?.some(doc => doc.id === id && doc.fileKey && doc.status === 'signed' && doc.category === 'contract'))) result.push('Укажите подписанный договор.');
  if (key === 'funding') {
    const funding = state.project.funding?.contractor;
    if (!funding?.confirmed || !(funding.amountCents > 0) || !funding.date || !clean(funding.source) || !documentExists(state, funding.documentId)) result.push('Подтвердите источник оборотных средств, сумму, дату и документ в финансах.');
  }
  if (key === 'escrow') {
    const funding = state.project.funding;
    const deposit = funding?.escrow?.deposited;
    if (funding?.route !== 'escrow' || !clean(funding.bank) || !(clean(funding.escrowAccountId) || clean(funding.escrowAccountReference)) || !(deposit?.amountCents > 0) || !deposit.date || !documentExists(state, deposit.documentId)) result.push('Укажите банк, счёт эскроу и подтверждение его фактического наполнения в финансах.');
  }
  if (key === 'bank_release' && !state.project.funding?.escrow?.released?.documentId) result.push('Нужно подтверждение раскрытия эскроу в финансах.');
  if (key === 'settlement' && lifecycle.usesEscrow === 'yes' && !state.project.funding?.escrow?.received?.documentId) result.push('Нужно подтверждение получения средств эскроу в финансах.');
  if (key === 'customer_acceptance' && !(item.documentIds ?? []).some(id => state.documents?.some(doc => doc.id === id && doc.fileKey && doc.status === 'signed' && doc.category === 'act'))) result.push('Укажите подписанный акт передачи.');
  return result;
};
export const lifecycleGroupProgress = (state, group = 'preparation') => {
  const lifecycle = state.project?.lifecycle;
  if (!lifecycle) return { total: 0, completed: 0, pending: [] };
  const active = lifecycleDefinitions.filter(def => def.group === group && !(def.escrow && lifecycle.usesEscrow === 'no')).filter(def => lifecycle.items.find(item => item.key === def.key)?.required !== false);
  const pending = active.filter(def => {
    const item = lifecycle.items.find(row => row.key === def.key);
    if (item?.status === 'not_applicable' && !def.locked && clean(item.basis)) return false;
    return item?.status !== 'done' || lifecycleItemBlockers(state, def.key).length;
  });
  return { total: active.length, completed: active.length - pending.length, pending: pending.map(def => def.key) };
};
export const constructionLaunchBlockers = state => {
  const lifecycle = state.project?.lifecycle;
  if (!lifecycle) return []; // Existing construction is not retroactively blocked by a new empty checklist.
  if (lifecycle.legacyReview) return [];
  const pending = lifecycleGroupProgress(state).pending;
  return [...(state.project.funding?.route === 'escrow' && lifecycle.usesEscrow !== 'yes' ? ['Схема финансирования требует эскроу'] : []), ...(lifecycle.usesEscrow === 'unknown' ? ['Уточнить схему эскроу'] : []), ...pending.map(key => lifecycleDefinitions.find(def => def.key === key).title)];
};
export const validateLifecycleChanges = (previous, next, identity, now = new Date().toISOString()) => {
  const before = previous?.project?.lifecycle, after = next?.project?.lifecycle;
  if (after && (!Array.isArray(after.items) || after.items.some(item => !item || typeof item.key !== 'string' || !Array.isArray(item.documentIds)))) return 'Некорректный маршрут проекта.';
  if (after && !after.legacyReview) {
    const starts = (next.stages ?? []).some(stage => { const old = previous?.stages?.find(row => row.id === stage.id); return (!old?.actualStart && stage.actualStart) || (!old?.completedOn && stage.completedOn) || (['in_progress', 'awaiting_inspection', 'accepted', 'rework'].includes(stage.status) && stage.status !== old?.status); });
    if (starts && constructionLaunchBlockers(next).length) return `Не завершён этап 0: ${constructionLaunchBlockers(next).join(', ')}.`;
  }
  if (after && previous?.project.status !== 'completed' && next.project.status === 'completed') {
    if (!['closed', 'warranty'].includes(after.phase) || lifecycleGroupProgress(next, 'handover').pending.length || !next.stages?.length || next.stages.some(stage => stage.status !== 'accepted')) return 'Закрытие заказа доступно после приёмки работ и завершения маршрута сдачи.';
  }
  if (!after) return before ? 'Нельзя удалить историю подготовки проекта.' : '';
  if (same(before, after)) return '';
  if (identity.role !== 'management') return 'Подготовку и завершение проекта изменяет управление.';
  if (after.version !== 1 || !Object.hasOwn(lifecyclePhaseLabels, after.phase) || !['unknown', 'yes', 'no'].includes(after.usesEscrow) || !['unknown', 'warm_shell', 'engineering', 'turnkey', 'custom'].includes(after.scope) || !Array.isArray(after.items) || after.items.length !== lifecycleDefinitions.length) return 'Некорректный маршрут проекта.';
  if (new Set(after.items.map(item => item.key)).size !== lifecycleDefinitions.length) return 'Пункты маршрута не должны повторяться.';
  if (before && (before.sourceLeadId !== after.sourceLeadId || before.sourceProjectId !== after.sourceProjectId || !same(before.sourceDocumentIds, after.sourceDocumentIds) || before.startedAt !== after.startedAt || Boolean(before.legacyReview) !== Boolean(after.legacyReview))) return 'Источник и история запуска неизменяемы.';
  if (!before && after.legacyReview && (!previous || !previous.stages?.some(stage => ['in_progress', 'accepted', 'awaiting_inspection', 'rework'].includes(stage.status)))) return 'Режим сверки предназначен только для уже начатых объектов.';
  if (!before && previous && previous.stages?.some(stage => ['in_progress', 'accepted', 'awaiting_inspection', 'rework'].includes(stage.status)) && !after.legacyReview) return 'Для уже начатого объекта используйте режим сверки подготовки.';
  for (const def of lifecycleDefinitions) {
    const item = after.items.find(row => row.key === def.key);
    if (!item || !['pending', 'done', 'not_applicable'].includes(item.status) || typeof item.required !== 'boolean' || !Array.isArray(item.documentIds) || item.documentIds.length > 30 || typeof item.basis !== 'string' || item.basis.length > 3000) return 'Некорректный пункт маршрута.';
    if (def.locked && !item.required) return `Нельзя отключить обязательный пункт «${def.title}».`;
    if (item.status === 'not_applicable' && (def.locked && !(def.escrow && after.usesEscrow === 'no') || !clean(item.basis))) return `Для «${def.title}» необходимо выполнение или подтверждённое основание неприменимости.`;
    if (!item.required && !clean(item.basis)) return 'Укажите основание изменения обязательности.';
    if (item.documentIds.some(id => !next.documents?.some(doc => doc.id === id))) return 'Связанный документ не найден в проекте.';
    if ([item.planStart, item.planEnd, item.completedOn].some(value => value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value))) return 'Укажите действительную календарную дату.';
    if (item.planStart && item.planEnd && item.planEnd < item.planStart) return 'Окончание подэтапа не может быть раньше начала.';
    const old = before?.items.find(row => row.key === def.key);
    if (item.status === 'done' && (!old || !same(old, item))) {
      if (def.group === 'handover' && !['handover', 'closed', 'warranty'].includes(after.phase) && !after.legacyReview) return 'Результаты сдачи подтверждаются после завершения строительства.';
      const blockers = lifecycleItemBlockers(next, item.key);
      if (blockers.length) return `${def.title}: ${blockers.join(' ')}`;
      item.confirmedAt = now; item.confirmedBy = identity.name;
    }
  }
  if (before && before.phase !== after.phase) {
    const allowed = { preparation: ['construction'], construction: ['handover'], handover: ['closed'], closed: ['warranty'], warranty: [] };
    if (!allowed[before.phase]?.includes(after.phase)) return 'Переходите по последовательности маршрута проекта.';
    if (after.phase === 'construction' && constructionLaunchBlockers(next).length) return `Не завершён этап 0: ${constructionLaunchBlockers(next).join(', ')}.`;
    if (after.phase === 'handover' && (!next.stages?.length || next.stages.some(stage => stage.status !== 'accepted'))) return 'Сначала завершите и примите строительные работы.';
    if (after.phase === 'closed' && lifecycleGroupProgress(next, 'handover').pending.length) return 'Завершите применимые пункты сдачи и финансовой сверки.';
  }
  if (['closed', 'warranty'].includes(after.phase) && (lifecycleGroupProgress(next, 'handover').pending.length || !next.stages?.length || next.stages.some(stage => stage.status !== 'accepted'))) return 'Закрытый проект должен сохранять подтверждённую приёмку и результаты сдачи.';
  if (!before && after.phase !== 'preparation') return 'Новый маршрут начинается с подготовки.';
  after.history = [...(before?.history ?? []), { at: now, actor: identity.name, text: before?.phase !== after.phase ? `Маршрут: ${lifecyclePhaseLabels[after.phase]}` : 'Обновлены условия и результаты подготовки' }].slice(-300);
  return '';
};
export const leadProjectIdentity = async leadId => {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`ikioma-lead:${leadId}`));
  const hash = [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
  return { id: `lead-${hash.slice(0, 32)}`, code: `H-${hash.slice(0, 8).toUpperCase()}` };
};
export const leadHandoffBlockers = lead => [
  ...(!clean(lead?.name) || !clean(lead?.phone) ? ['Укажите имя и контакт клиента.'] : []),
  ...(!clean(lead?.owner) ? ['Назначьте ответственного.'] : []),
  ...(!clean(lead?.qualification?.address) && !clean(lead?.region) ? ['Укажите местонахождение или район поиска участка.'] : []),
  ...(!lead?.budget || lead.budget <= 0 ? ['Уточните ориентир бюджета клиента.'] : []),
  ...(!lead?.landStatus || lead.landStatus === 'unknown' ? ['Уточните статус участка.'] : []),
  ...(!lead?.mortgageStatus || lead.mortgageStatus === 'unknown' ? ['Уточните способ финансирования клиента.'] : []),
];
export const createLeadProjectState = (base, lead, identity, actor, now) => {
  const address = clean(lead.qualification?.address, 500);
  const relations = base.orderRelations;
  const linkedObjectId = lead.qualification?.sourceOrderObjectId || relations?.links?.find(link => link.kind === 'lead' && link.entityId === lead.id)?.objectId;
  const linkedObject = relations?.objects?.find(object => object.id === linkedObjectId);
  const orderRelations = linkedObject ? { ...emptyOrderRelations(), customerId: relations.customerId, mode: relations.mode, plotIds: [...relations.plotIds], participants: clone(relations.participants), objects: [{ ...clone(linkedObject), status: 'planned', actualStart: undefined, actualEnd: undefined, specifications: clone(linkedObject.specifications ?? []).map(spec => ({ ...spec, status: 'draft', documentIds: [], approvedAt: undefined, approvedBy: undefined, source: `Исходный заказ ${base.project.id}; спецификация ${spec.id}` })), activeSpecificationId: linkedObject.activeSpecificationId }], links: [{ id: `source-lead:${lead.id}`, kind: 'lead', entityId: lead.id, objectId: linkedObject.id }] } : emptyOrderRelations();
  const sourceDocumentIds = linkedObject ? [...new Set([...(linkedObject.specifications ?? []).flatMap(spec => spec.documentIds ?? []), ...(relations.links ?? []).filter(link => link.kind === 'document' && link.objectId === linkedObject.id).map(link => link.entityId)])].filter(id => base.documents.some(doc => doc.id === id)) : [];
  const name = address || `${clean(lead.region, 200)} · участок уточняется`;
  return {
    version: 1, schemaVersion: base.schemaVersion ?? 17,
    project: { ...identity, name, address, model: clean(lead.qualification?.projectModel, 200), area: Number(lead.houseArea) || 0,
      clientNames: lead.name, contractValue: 0, targetCost: 0, unknownFields: [...(!lead.houseArea ? ['area'] : []), 'contractValue', 'targetCost'],
      startDate: '', targetDate: '', forecastDate: '', foreman: '', cameraStatus: 'offline', createdAt: now, creationRequestId: `lead:${lead.id}`,
      source: `Обращение ${lead.id}`, status: 'draft', lifecycle: createLifecycle(now, { sourceLeadId: lead.id, sourceProjectId: base.project.id, sourceDocumentIds }) },
    ...(orderRelations ? { orderRelations } : {}),
    budgetMeta: { version: '—', source: 'Внутренняя смета ещё не подготовлена', estimateKind: 'unknown' },
    stages: [], budgetLines: [], financeEntries: [], procurement: [], counterparties: [], supplierQuotes: [], tasks: [], fieldReports: [], checkpoints: [], documents: [], decisions: [],
    leads: [{ ...clone(lead), projectId: identity.id, stage: 'preparation', preparedAt: now }],
    settings: { ...clone(base.settings), users: base.settings.users.filter(user => user.id === 'user-owner').map(user => ({ ...user })) },
    activity: [{ id: `created:${identity.id}`, timestamp: now, actor, text: `Проект ${identity.code} создан из обращения. Начат этап 0.`, tone: 'positive' }],
  };
};
