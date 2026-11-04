// Shared Node/browser rules. These relations never create payments, costs or stages.
import { validateOrderObjectCostAllocations } from './order-object-costs.js';
import { validateFinanceLedgerShape, ledgerEntryPaidCents } from './finance-ledger.js';
import { effectiveBudgetLines } from './finance-totals.js';
const own = (value, key) => Object.prototype.hasOwnProperty.call(value ?? {}, key);
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const nonblank = (value, max = 4000) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const optionalText = (value, max = 4000) => value === undefined || typeof value === 'string' && value.length <= max;
const integer = Number.isSafeInteger;
const nonnegative = value => integer(value) && value >= 0;
const optional = (value, predicate) => value === undefined || predicate(value);
const list = value => Array.isArray(value) ? value : [];
const stable = value => JSON.stringify(value, (_, item) => object(item)
  ? Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b))) : item);
const same = (a, b) => stable(a) === stable(b);
const unique = values => [...new Set(values)];
const pickWithout = (value, keys) => Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => !keys.includes(key)));
const known = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const money = (row, keys, signed = false) => keys.every(key => optional(row[key], signed ? integer : nonnegative));
const validIdList = value => Array.isArray(value) && value.length <= 500 && value.every(validOrderRelationId) && new Set(value).size === value.length;
const byId = rows => new Map(list(rows).map(row => [row?.id, row]));
const stampKeys = ['recordedAt', 'recordedBy', 'approvedAt', 'approvedBy', 'signedAt', 'signedBy', 'closedAt', 'closedBy', 'fundedAt', 'fundedBy', 'appliedAt', 'appliedBy'];
const collections = ['participants', 'objects', 'contracts', 'mortgages', 'changeRequests', 'links', 'warrantyCases', 'costAllocations'];
const fields = ['version', 'customerId', 'mode', 'status', 'contractPricing', 'plotIds', ...collections];
const idsFor = { stage: 'stages', budget: 'budgetLines', finance: 'financeEntries', procurement: 'procurement', task: 'tasks', document: 'documents', lead: 'leads', counterparty: 'counterparties' };
const roles = ['customer', 'co_customer', 'land_owner', 'payer', 'borrower', 'guarantor', 'contractor', 'supplier', 'bank', 'agent', 'representative', 'other'];
const signedContract = row => ['signed', 'completed', 'terminated'].includes(row?.status);
const approvedChange = row => ['approved', 'applied'].includes(row?.status);
const signedFields = ['status', 'closureChangeId', 'closedReason', 'closedAt', 'closedBy'];
const projectStatusFor = status => ({ draft: 'draft', active: 'active', on_hold: 'active', completed: 'completed', canceled: 'archived' })[status];

export const validOrderRelationId = value => typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,120}$/.test(value);
export const validOrderDate = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};
export const emptyOrderRelations = () => ({ version: 1, mode: 'client_land', status: 'draft', plotIds: [], participants: [], objects: [], contracts: [], mortgages: [], changeRequests: [], links: [], warrantyCases: [], history: [] });

/** Read-time defaults only. Write validation must inspect the submitted value. */
export function normalizeOrderRelations(value) {
  if (!object(value)) return undefined;
  const result = { ...emptyOrderRelations(), ...structuredClone(value) };
  // Do not discard unknown fields or coerce malformed values: validation reports them.
  for (const key of [...collections.filter(key => key !== 'costAllocations'), 'plotIds', 'history']) if (result[key] === undefined) result[key] = [];
  return result;
}

/** All canonical identifiers used by an order, with their required directory kinds. */
export function orderDirectoryReferences(relations) {
  const result = [], seen = new Set();
  const add = (id, kind) => { if (typeof id === 'string' && !seen.has(`${kind}:${id}`)) { seen.add(`${kind}:${id}`); result.push({ id, kind }); } };
  add(relations?.customerId, 'party');
  for (const id of list(relations?.plotIds)) add(id, 'plot');
  for (const row of list(relations?.participants)) add(row?.partyId, 'party');
  for (const row of list(relations?.objects)) add(row?.assetId, 'asset');
  for (const row of list(relations?.contracts)) {
    for (const id of list(row?.partyIds)) add(id, 'party');
    add(row?.sharedAgreementId, 'agreement');
  }
  for (const row of list(relations?.mortgages)) {
    add(row?.bankPartyId, 'party');
    for (const id of list(row?.borrowerPartyIds)) add(id, 'party');
  }
  for (const row of list(relations?.warrantyCases)) add(row?.responsiblePartyId, 'party');
  return result;
}

/** Current full values are separate for customer, supplier and finance contracts. */
export function orderContractTotals(relations) {
  const rows = list(relations?.contracts), replaced = new Set(rows.filter(signedContract).map(row => row.supersedesId).filter(Boolean));
  const result = {};
  for (const kind of ['customer', 'supplier', 'finance']) {
    const knownRows = rows.filter(row => row.kind === kind && signedContract(row));
    if (!knownRows.length) { result[`${kind}Cents`] = null; continue; }
    let total = 0;
    for (const row of knownRows.filter(row => row.status !== 'terminated' && !replaced.has(row.id))) {
      if (!nonnegative(row.amountCents) || !integer(total + row.amountCents)) { total = null; break; }
      total += row.amountCents;
    }
    result[`${kind}Cents`] = total;
  }
  return result;
}
export const orderContractValueCents = relations => relations?.contractPricing === true ? orderContractTotals(relations).customerCents : null;

const transition = (before, after, map) => !before || before === after || list(map[before]).includes(after);
const validRows = rows => Array.isArray(rows) && rows.length <= 500 && rows.every(row => object(row) && validOrderRelationId(row.id)) && new Set(rows.map(row => row.id)).size === rows.length;
const validStrings = (row, keys, max = 4000) => keys.every(key => optionalText(row[key], max));
const validDates = (row, keys) => keys.every(key => optional(row[key], validOrderDate));
const validRef = value => optional(value, validOrderRelationId);
const stampError = (old, row) => stampKeys.some(key => !same(old?.[key], row[key])) ? 'Служебные отметки автора и времени устанавливает сервер. Обновите данные.' : '';
const documentError = (row, documentIds) => !validIdList(row.documentIds) || row.documentIds.some(id => !documentIds.has(id))
  ? 'Документы должны существовать в текущем заказе; ссылка на документ другого заказа недопустима.' : '';
const preserve = (oldRows, rows, protectedRow, message) => list(oldRows).some(row => protectedRow(row) && !list(rows).some(next => next.id === row.id)) ? message : '';
const checkedDateRange = (row, start, end) => !(row[start] && row[end] && row[start] > row[end]);
const future = (row, keys, today) => today && keys.some(key => row[key] && row[key] > today);

function validateShape(previous, next, identity, now) {
  const old = previous?.orderRelations, relations = next?.orderRelations;
  if (!relations) return old ? 'Нельзя удалить связи заказа и их историю.' : '';
  if (!known(relations, [...fields, 'changeReason', 'history']) || relations.version !== 1 || !['client_land', 'land_and_build', 'ready_sale', 'additional_work'].includes(relations.mode)
    || !['draft', 'active', 'on_hold', 'completed', 'canceled'].includes(relations.status) || !validRef(relations.customerId)
    || !optional(relations.contractPricing, value => typeof value === 'boolean') || !validIdList(relations.plotIds)
    || collections.some(key => !(key === 'costAllocations' && relations[key] === undefined) && !validRows(relations[key])) || !Array.isArray(relations.history)
    || !optionalText(relations.changeReason, 2000)) return 'Некорректная структура связей заказа: проверьте поля, уникальные ID и допустимые размеры списков.';
  if (!same(relations.history, old?.history ?? [])) return 'История связей заказа защищена; обновите данные.';
  const changed = fields.some(key => !same(old?.[key], relations[key]));
  if (!same(old, relations) && identity?.role !== 'management') return 'Связи заказа меняет только роль «Управление».';
  if (old && changed && !nonblank(relations.changeReason, 2000)) return 'Укажите причину изменения связей заказа.';
  if (!transition(old?.status, relations.status, { draft: ['active', 'on_hold', 'canceled'], active: ['on_hold', 'completed', 'canceled'], on_hold: ['active', 'completed', 'canceled'], completed: ['active'], canceled: [] })) return 'Недопустимый переход статуса заказа. Отменённый заказ сохраняется; для новых работ создайте новый заказ.';
  if (relations.status === 'active' && (!relations.customerId || !relations.objects.length && !relations.plotIds.length)) return 'Перед запуском заказа укажите заказчика и объект или участок.';
  if (relations.status === 'completed' && (!relations.objects.length || relations.objects.some(row => !['completed', 'canceled'].includes(row.status)))) return 'Для завершения заказа завершите работы по объектам или явно отмените их.';
  if (old?.customerId !== relations.customerId && list(old?.contracts).some(row => row.kind === 'customer' && signedContract(row))) return 'Заказчик подписанного заказа защищён. Изменение стороны оформляется отдельно с сохранением первоначального заказа.';
  const today = now && Number.isFinite(Date.parse(now)) ? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date(now)) : null;
  if (now && !today) return 'Некорректное серверное время.';
  if (Object.values(idsFor).some(key => next[key] !== undefined && (!Array.isArray(next[key]) || next[key].some(row => !object(row) || !nonblank(row.id, 500))))) return 'Некорректный реестр исходных записей заказа; связи не сохранены.';
  const objects = byId(relations.objects), contracts = byId(relations.contracts), changes = byId(relations.changeRequests), participants = byId(relations.participants), warranties = byId(relations.warrantyCases);
  const documents = new Set(list(next.documents).map(row => row.id)), counterparties = new Set(list(next.counterparties).map(row => row.id));
  const changeFor = (id, objectIds = []) => {
    const change = changes.get(id);
    return approvedChange(change) && (!change.objectIds.length || objectIds.every(objectId => change.objectIds.includes(objectId)));
  };
  const factError = row => validStrings(row, stampKeys, 240) ? '' : 'Некорректные служебные отметки записи.';
  for (const row of relations.participants) {
    if (!known(row, ['id', 'partyId', 'role', 'projectCounterpartyId', 'notes']) || !validOrderRelationId(row.partyId) || !roles.includes(row.role) || !validRef(row.projectCounterpartyId) || !optionalText(row.notes)
      || row.projectCounterpartyId && !counterparties.has(row.projectCounterpartyId)) return 'Участнику нужны существующий общий контакт, роль и корректная ссылка на контрагента текущего заказа.';
  }
  if (new Set(relations.participants.map(row => `${row.partyId}:${row.role}`)).size !== relations.participants.length) return 'Один участник с одной ролью уже добавлен в заказ.';
  for (const row of relations.changeRequests) {
    const before = list(old?.changeRequests).find(item => item.id === row.id);
    if (!known(row, ['id', 'title', 'reason', 'status', 'objectIds', 'priceDeltaCents', 'costDeltaCents', 'scheduleDeltaDays', 'documentIds', 'source', 'implementationNote', ...stampKeys])
      || !nonblank(row.title, 300) || !nonblank(row.reason) || !['draft', 'submitted', 'approved', 'rejected', 'applied'].includes(row.status)
      || !validIdList(row.objectIds) || row.objectIds.some(id => !objects.has(id)) || !money(row, ['priceDeltaCents', 'costDeltaCents'], true)
      || !optional(row.scheduleDeltaDays, value => integer(value) && Math.abs(value) <= 3650) || !validStrings(row, ['source', 'implementationNote']) || factError(row)) return 'Проверьте описание изменения, связанные объекты и точные суммы в копейках.';
    const error = documentError(row, documents) || stampError(before, row); if (error) return error;
    if (!transition(before?.status, row.status, { draft: ['submitted', 'approved', 'rejected'], submitted: ['approved', 'rejected'], approved: ['applied'], rejected: [], applied: [] })) return 'Недопустимый переход статуса согласования изменения.';
    if (approvedChange(row) && !nonblank(row.source)) return 'Для утверждённого изменения укажите основание согласования.';
    if (row.status === 'applied' && !nonblank(row.implementationNote)) return 'Для выполненного изменения опишите фактический результат.';
    if (before && ['approved', 'applied', 'rejected'].includes(before.status)
      && !same(pickWithout(before, ['status', 'implementationNote', 'appliedAt', 'appliedBy']), pickWithout(row, ['status', 'implementationNote', 'appliedAt', 'appliedBy']))) return 'Согласованные и отклонённые условия изменения защищены. Создайте новое изменение.';
    if (before?.status === 'applied' && !same(before, row)) return 'Результат выполненного изменения защищён. Добавьте новое изменение.';
  }
  const changeDeletion = preserve(old?.changeRequests, relations.changeRequests, row => row.status !== 'draft', 'Нельзя удалить переданное на согласование или рассмотренное изменение.'); if (changeDeletion) return changeDeletion;
  const allSpecIds = new Set();
  for (const row of relations.objects) {
    const before = list(old?.objects).find(item => item.id === row.id);
    if (!known(row, ['id', 'assetId', 'title', 'status', 'specifications', 'activeSpecificationId', 'actualStart', 'actualEnd', 'recordedAt', 'recordedBy'])
      || !validOrderRelationId(row.assetId) || !nonblank(row.title, 300) || !['planned', 'active', 'completed', 'canceled'].includes(row.status)
      || !validRows(row.specifications) || row.specifications.length > 100 || !validRef(row.activeSpecificationId)
      || !validDates(row, ['actualStart', 'actualEnd']) || !checkedDateRange(row, 'actualStart', 'actualEnd') || future(row, ['actualStart', 'actualEnd'], today) || factError(row)) return 'Проверьте объект заказа, версии комплектации и фактические даты.';
    const stamp = stampError(before, row); if (stamp) return stamp;
    if (before && before.assetId !== row.assetId) return 'Физический объект связи защищён. Добавьте другую связь с объектом, сохранив прежнюю историю.';
    if (!transition(before?.status, row.status, { planned: ['active', 'completed', 'canceled'], active: ['completed', 'canceled'], completed: [], canceled: [] })) return 'Завершённые и отменённые работы по объекту сохраняются; дополнительные работы оформляйте новым заказом.';
    if (before?.actualStart && before.actualStart !== row.actualStart || before?.actualEnd && before.actualEnd !== row.actualEnd) return 'Записанные фактические даты объекта защищены; исправление требует отдельного решения.';
    if (row.status === 'completed' && (!row.actualStart || !row.actualEnd)) return 'Для завершённого объекта укажите фактическое начало и окончание работ.';
    const sortedVersions = row.specifications.map(spec => spec.version).sort((a, b) => a - b);
    if (sortedVersions.some((version, index) => !integer(version) || version !== index + 1)) return 'Версии комплектации должны последовательно нумероваться с 1 без дублей.';
    for (const spec of row.specifications) {
      const oldSpec = list(before?.specifications).find(item => item.id === spec.id);
      if (!known(spec, ['id', 'version', 'status', 'title', 'scope', 'model', 'houseAreaSqm', 'terraceAreaSqm', 'floors', 'technology', 'finish', 'plannedStart', 'plannedEnd', 'source', 'documentIds', 'changeRequestId', ...stampKeys])
        || allSpecIds.has(spec.id) || !['draft', 'approved'].includes(spec.status) || !nonblank(spec.title, 300) || !nonblank(spec.scope)
        || !validStrings(spec, ['model', 'technology', 'finish', 'source']) || !validDates(spec, ['plannedStart', 'plannedEnd']) || !checkedDateRange(spec, 'plannedStart', 'plannedEnd')
        || !optional(spec.houseAreaSqm, value => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1e8)
        || !optional(spec.terraceAreaSqm, value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e8)
        || !optional(spec.floors, value => integer(value) && value > 0 && value <= 200) || !validRef(spec.changeRequestId) || factError(spec)) return 'Проверьте версию, состав работ, параметры и даты комплектации.';
      allSpecIds.add(spec.id);
      const error = documentError(spec, documents) || stampError(oldSpec, spec); if (error) return error;
      if (oldSpec?.status === 'approved' && !same(oldSpec, spec)) return 'Утверждённая комплектация защищена. Создайте следующую версию через согласованное изменение.';
      if (oldSpec && oldSpec.version !== spec.version) return 'Номер сохранённой версии комплектации защищён.';
      if (spec.status === 'approved') {
        if (!nonblank(spec.source)) return 'Для утверждённой комплектации укажите основание согласования.';
        if (spec.version > 1 && !changeFor(spec.changeRequestId, [row.id])) return 'Новая утверждённая версия комплектации требует согласованного изменения для этого объекта.';
      }
      if (spec.changeRequestId && !changes.has(spec.changeRequestId)) return 'Связанное изменение комплектации не найдено в текущем заказе.';
    }
    const deletion = preserve(before?.specifications, row.specifications, spec => spec.status === 'approved', 'Нельзя удалить утверждённую комплектацию.'); if (deletion) return deletion;
    const active = row.specifications.find(spec => spec.id === row.activeSpecificationId);
    if (row.activeSpecificationId && active?.status !== 'approved') return 'Действующей можно выбрать только утверждённую комплектацию объекта.';
    const oldActive = list(before?.specifications).find(spec => spec.id === before.activeSpecificationId);
    if (oldActive?.status === 'approved' && row.activeSpecificationId !== oldActive.id && (!active || active.version <= oldActive.version || !changeFor(active.changeRequestId, [row.id]))) return 'Замена действующей комплектации требует следующей утверждённой версии и согласованного изменения; исходная версия сохраняется.';
  }
  if (new Set(relations.objects.map(row => row.assetId)).size !== relations.objects.length) return 'Физический объект уже связан с этим заказом. Добавьте новую версию его состава работ.';
  const objectDeletion = preserve(old?.objects, relations.objects, row => row.status !== 'planned' || list(row.specifications).some(spec => spec.status === 'approved'), 'Нельзя удалить объект с фактическими работами или утверждённой комплектацией.'); if (objectDeletion) return objectDeletion;
  const successorIds = new Set();
  for (const row of relations.contracts) {
    const before = list(old?.contracts).find(item => item.id === row.id);
    if (!known(row, ['id', 'kind', 'title', 'number', 'partyIds', 'partySnapshots', 'objectIds', 'status', 'amountCents', 'currency', 'signedDate', 'effectiveDate', 'endDate', 'documentIds', 'source', 'supersedesId', 'sharedAgreementId', 'changeRequestId', 'closureChangeId', 'closedReason', ...stampKeys])
      || !['customer', 'supplier', 'finance'].includes(row.kind) || !['draft', 'signed', 'completed', 'terminated'].includes(row.status) || !nonblank(row.title, 300)
      || !validStrings(row, ['number', 'source', 'closedReason']) || !validIdList(row.partyIds) || !validIdList(row.objectIds) || row.objectIds.some(id => !objects.has(id))
      || !money(row, ['amountCents']) || row.currency !== 'RUB' || !validDates(row, ['signedDate', 'effectiveDate', 'endDate'])
      || !checkedDateRange(row, 'effectiveDate', 'endDate') || !['supersedesId', 'sharedAgreementId', 'changeRequestId', 'closureChangeId'].every(key => validRef(row[key])) || factError(row)) return 'Проверьте договор, стороны, объекты и сумму в копейках RUB.';
    const error = documentError(row, documents) || stampError(before, row); if (error) return error;
    if (row.partySnapshots !== undefined && (!signedContract(row) || !Array.isArray(row.partySnapshots) || row.partySnapshots.length !== row.partyIds.length
      || new Set(row.partySnapshots.map(party => party?.partyId)).size !== row.partyIds.length
      || row.partySnapshots.some(party => !known(party, ['partyId', 'name', 'partyType', 'inn', 'legalName']) || !row.partyIds.includes(party.partyId) || !nonblank(party.name, 300) || !['person', 'company'].includes(party.partyType) || !validStrings(party, ['inn', 'legalName'], 300)))) return 'Некорректный снимок подписанных сторон договора.';
    if (!transition(before?.status, row.status, { draft: ['signed'], signed: ['completed', 'terminated'], completed: [], terminated: [] })) return 'Подписанный договор нельзя вернуть в черновик или повторно открыть. Создайте новую версию.';
    if (row.sharedAgreementId && row.kind !== 'supplier') return 'Доли общего договора применяются только к подрядным и поставочным договорам.';
    if (signedContract(row) && (!nonnegative(row.amountCents) || !row.partyIds.length || !row.documentIds.length && !row.sharedAgreementId || !row.signedDate || !nonblank(row.source) || future(row, ['signedDate'], today))) return 'Для подписанного договора нужны сумма, стороны, документ, фактическая дата подписания и источник.';
    if (signedContract(row) && row.kind === 'customer' && (!relations.customerId || !row.partyIds.includes(relations.customerId))) return 'Подписанный клиентский договор должен включать основного заказчика.';
    if (signedContract(before) && !same(pickWithout(before, signedFields), pickWithout(row, signedFields))) return 'Подписанный договор и его сумма защищены. Создайте новую версию договора с полной суммой.';
    if (['completed', 'terminated'].includes(before?.status) && !same(before, row)) return 'Закрытый договор защищён от изменения.';
    if (['completed', 'terminated'].includes(row.status) && !nonblank(row.closedReason)) return 'Укажите основание закрытия договора; существующие обязательства сохраняются.';
    if (row.status === 'terminated' && !changeFor(row.closureChangeId, row.objectIds)) return 'Расторжение договора требует утверждённого изменения; платежи и обязательства остаются в финансовом учёте.';
    if (row.status === 'draft' || row.status === 'signed') {
      if (row.closureChangeId || row.closedReason || row.closedAt || row.closedBy) return 'Основание закрытия заполняется только у завершённого или расторгнутого договора.';
    }
    if (row.supersedesId) {
      const replaced = contracts.get(row.supersedesId);
      if (!replaced || replaced.id === row.id || replaced.kind !== row.kind || !signedContract(replaced)) return 'Новая версия должна ссылаться на подписанный договор того же типа в этом заказе.';
      const chain = new Set([row.id]); let cursor = replaced;
      while (cursor) { if (chain.has(cursor.id)) return 'Циклическая связь версий договора запрещена.'; chain.add(cursor.id); cursor = contracts.get(cursor.supersedesId); }
      if (signedContract(row)) {
        if (successorIds.has(row.supersedesId)) return 'У договора уже есть подписанная следующая версия. Продолжите последнюю версию.';
        successorIds.add(row.supersedesId);
        if (!changeFor(row.changeRequestId, row.objectIds)) return 'Подписание новой версии договора требует согласованного изменения.';
      }
    }
    if (row.changeRequestId && !changes.has(row.changeRequestId) || row.closureChangeId && !changes.has(row.closureChangeId)) return 'Согласование договора не найдено в текущем заказе.';
  }
  const contractDeletion = preserve(old?.contracts, relations.contracts, signedContract, 'Нельзя удалить подписанный договор и его обязательства.'); if (contractDeletion) return contractDeletion;
  for (const row of relations.mortgages) {
    const before = list(old?.mortgages).find(item => item.id === row.id);
    if (!known(row, ['id', 'bankPartyId', 'borrowerPartyIds', 'contractId', 'program', 'fundingRoute', 'status', 'requestedAmountCents', 'approvedAmountCents', 'downPaymentCents', 'submittedDate', 'decisionDate', 'fundedDate', 'financeEntryId', 'documentIds', 'source', 'notes', ...stampKeys])
      || !validRef(row.bankPartyId) || !validIdList(row.borrowerPartyIds) || !validRef(row.contractId) || row.contractId && !contracts.has(row.contractId)
      || !nonblank(row.program, 300) || !optional(row.fundingRoute, value => ['direct', 'escrow'].includes(value)) || !['draft', 'submitted', 'approved', 'rejected', 'funded', 'canceled'].includes(row.status)
      || !money(row, ['requestedAmountCents', 'approvedAmountCents', 'downPaymentCents']) || !validDates(row, ['submittedDate', 'decisionDate', 'fundedDate'])
      || !checkedDateRange(row, 'submittedDate', 'decisionDate') || !checkedDateRange(row, 'decisionDate', 'fundedDate')
      || !validRef(row.financeEntryId) || !validStrings(row, ['source', 'notes']) || factError(row)) return 'Проверьте ипотечную заявку, банк, заёмщиков, даты и суммы.';
    const error = documentError(row, documents) || stampError(before, row); if (error) return error;
    if (!transition(before?.status, row.status, { draft: ['submitted', 'approved', 'rejected', 'canceled'], submitted: ['approved', 'rejected', 'canceled'], approved: ['funded', 'canceled'], funded: [], rejected: [], canceled: [] })) return 'Недопустимый переход ипотечной заявки. Для нового решения банка создайте новую заявку.';
    if (['submitted', 'approved', 'funded', 'rejected'].includes(row.status) && (!row.bankPartyId || !row.borrowerPartyIds.length || !nonblank(row.source))) return 'У отправленной ипотечной заявки нужны банк, заёмщики и источник.';
    if (['approved', 'funded', 'rejected'].includes(row.status) && (!row.decisionDate || future(row, ['decisionDate'], today))) return 'Для решения банка укажите фактическую дату.';
    if (['approved', 'funded'].includes(row.status) && !nonnegative(row.approvedAmountCents)) return 'Укажите утверждённую банком сумму в копейках.';
    const approvedBefore = before && (before.approvedAt || ['approved', 'funded'].includes(before.status));
    const decisionFields = ['bankPartyId', 'borrowerPartyIds', 'contractId', 'program', 'fundingRoute', 'requestedAmountCents', 'approvedAmountCents', 'downPaymentCents', 'submittedDate', 'decisionDate', 'source'];
    if (approvedBefore && decisionFields.some(key => !same(before[key], row[key]))) return 'Сохранённое решение банка защищено. Создайте новую ипотечную заявку.';
    if (before && ['rejected', 'canceled'].includes(before.status) && !same(pickWithout(before, ['notes', 'documentIds']), pickWithout(row, ['notes', 'documentIds']))) return 'Закрытая ипотечная заявка защищена от изменения.';
    if (before && before.status !== 'draft' && before.documentIds.some(id => !row.documentIds.includes(id))) return 'Документы рассмотренной ипотечной заявки сохраняются.';
    const entry = list(next.financeEntries).find(item => item.id === row.financeEntryId);
    if (row.financeEntryId && (!entry || entry.kind !== 'income')) return 'Факт выдачи ипотеки должен ссылаться на поступление в финансовом учёте текущего заказа.';
    if (row.status === 'funded') {
      if (!row.fundedDate || future(row, ['fundedDate'], today) || !entry) return 'Выдача ипотеки подтверждается фактической датой и уже записанным поступлением денег. Одобрение банка платежа не создаёт.';
      if (before?.status !== 'funded') {
        const ledgerError = validateFinanceLedgerShape(next.financeLedger); if (ledgerError) return ledgerError;
        if (next.treasury?.entryPlans !== undefined && (!Array.isArray(next.treasury.entryPlans) || next.treasury.entryPlans.some(plan => !object(plan) || plan.paymentFacts !== undefined && (!Array.isArray(plan.paymentFacts) || plan.paymentFacts.some(fact => !object(fact)))))
          || entry.payments !== undefined && (!Array.isArray(entry.payments) || entry.payments.some(payment => !object(payment)))) return 'Некорректная структура подтверждения ипотечного поступления.';
        const paidCents = ledgerEntryPaidCents(next, entry.id);
        if (!Number.isSafeInteger(paidCents) || paidCents <= 0) return 'Выдача ипотеки подтверждается фактической датой и уже записанным поступлением денег. Одобрение банка платежа не создаёт.';
      }
    }
    if (before?.status === 'funded' && !same(pickWithout(before, ['notes', 'documentIds']), pickWithout(row, ['notes', 'documentIds']))) return 'Факт выдачи ипотеки защищён от изменения.';
  }
  const mortgageDeletion = preserve(old?.mortgages, relations.mortgages, row => row.status !== 'draft', 'Нельзя удалить отправленную или рассмотренную ипотечную заявку.'); if (mortgageDeletion) return mortgageDeletion;
  for (const row of relations.warrantyCases) {
    const before = list(old?.warrantyCases).find(item => item.id === row.id);
    if (!known(row, ['id', 'objectId', 'title', 'description', 'status', 'openedDate', 'dueDate', 'resolvedDate', 'responsiblePartyId', 'documentIds', 'resolution', 'source', ...stampKeys])
      || !objects.has(row.objectId) || !nonblank(row.title, 300) || !nonblank(row.description) || !['open', 'in_progress', 'resolved', 'closed'].includes(row.status)
      || !validOrderDate(row.openedDate) || !validDates(row, ['dueDate', 'resolvedDate']) || !checkedDateRange(row, 'openedDate', 'resolvedDate')
      || !checkedDateRange(row, 'openedDate', 'dueDate') || future(row, ['openedDate', 'resolvedDate'], today)
      || !validRef(row.responsiblePartyId) || !validStrings(row, ['resolution', 'source']) || factError(row)) return 'Проверьте гарантийное обращение, объект, описание и даты.';
    const error = documentError(row, documents) || stampError(before, row); if (error) return error;
    if (!transition(before?.status, row.status, { open: ['in_progress', 'resolved', 'closed'], in_progress: ['resolved', 'closed'], resolved: ['in_progress', 'closed'], closed: [] })) return 'Закрытое гарантийное обращение сохраняется. При повторном обращении создайте новую запись.';
    if (['resolved', 'closed'].includes(row.status) && (!row.resolvedDate || !nonblank(row.resolution) || !nonblank(row.source))) return 'Для решения гарантийного обращения нужны дата, результат и подтверждающий источник.';
    if (before && (before.objectId !== row.objectId || before.openedDate !== row.openedDate)) return 'Объект и исходная дата гарантийного обращения защищены.';
    if (before?.status === 'closed' && !same(before, row)) return 'Закрытое гарантийное обращение защищено от изменения.';
  }
  const warrantyDeletion = preserve(old?.warrantyCases, relations.warrantyCases, () => true, 'Нельзя удалить зарегистрированное гарантийное обращение.'); if (warrantyDeletion) return warrantyDeletion;
  let budgetReferences = [];
  if (relations.links.some(row => row.kind === 'budget')) {
    try { budgetReferences = effectiveBudgetLines(next); }
    catch { return 'Некорректная структура действующей версии бюджета для связи с заказом.'; }
  }
  const linkKeys = new Set();
  for (const row of relations.links) {
    if (!known(row, ['id', 'kind', 'entityId', 'objectId', 'contractId', 'participantId', 'changeRequestId', 'warrantyCaseId', 'notes'])
      || !own(idsFor, row.kind) || !validOrderRelationId(row.entityId) || !validStrings(row, ['notes'])
      || !(row.kind === 'budget' ? budgetReferences : list(next[idsFor[row.kind]])).some(item => item.id === row.entityId)) return 'Связь должна указывать на существующую запись соответствующего раздела текущего заказа.';
    for (const [key, map] of [['objectId', objects], ['contractId', contracts], ['participantId', participants], ['changeRequestId', changes], ['warrantyCaseId', warranties]]) {
      if (!validRef(row[key]) || row[key] && !map.has(row[key])) return 'Объект связи не найден в текущем заказе.';
    }
    const linkKey = stable(pickWithout(row, ['id', 'notes']));
    if (linkKeys.has(linkKey)) return 'Такая связь уже существует.';
    linkKeys.add(linkKey);
  }
  if (relations.contractPricing === true && orderContractValueCents(relations) === null) return 'Для расчёта цены по договорам нужен хотя бы один подписанный клиентский договор с точной суммой.';
  if (relations.contractPricing === true && Math.round(orderContractValueCents(relations) / 100 * 100) !== orderContractValueCents(relations)) return 'Цена слишком велика для точного отображения копеек в действующей карточке проекта.';
  const totals = orderContractTotals(relations);
  if (['customer', 'supplier', 'finance'].some(kind => relations.contracts.some(row => row.kind === kind && signedContract(row)) && totals[`${kind}Cents`] === null)) return 'Итог договоров выходит за точный диапазон суммы в копейках.';
  const protectedDocuments = new Set([
    ...list(old?.contracts).filter(signedContract).flatMap(row => row.documentIds),
    ...list(old?.objects).flatMap(row => list(row.specifications).filter(spec => spec.status === 'approved').flatMap(spec => spec.documentIds)),
    ...list(old?.changeRequests).filter(approvedChange).flatMap(row => row.documentIds),
    ...list(old?.mortgages).filter(row => row.status !== 'draft').flatMap(row => row.documentIds),
  ]);
  const previousDocs = byId(previous?.documents), nextDocs = byId(next.documents);
  for (const id of protectedDocuments) {
    const before = previousDocs.get(id), after = nextDocs.get(id);
    if (!before || !after || ['fileKey', 'sourceSha256', 'storageLocation', 'number', 'documentDate', 'category'].some(key => !same(before[key], after[key]))) return 'Документ утверждённого или подписанного основания защищён. Загрузите новую версию отдельным документом.';
  }
  if (old && relations.status === 'canceled' && old.status !== 'canceled') {
    if (list(previous.financeEntries).some(row => !list(next.financeEntries).some(item => item.id === row.id))) return 'Отмена заказа не удаляет финансовые обязательства и платежи. Оформите возврат или закрытие в финансовом разделе.';
    for (const key of ['operations', 'loans', 'retentions', 'confirmations']) if (list(previous.financeLedger?.[key]).some(row => !list(next.financeLedger?.[key]).some(item => item.id === row.id))) return 'При отмене заказа существующий финансовый журнал сохраняется.';
  }
  const allocationError = validateOrderObjectCostAllocations(previous, next, identity);
  if (allocationError) return allocationError;
  return '';
}

function changeEvidence(before, after, changed) {
  const changes = [];
  for (const field of changed) {
    if (collections.includes(field)) {
      const oldRows = byId(before?.[field]), nextRows = byId(after[field]);
      for (const id of unique([...oldRows.keys(), ...nextRows.keys()])) if (!same(oldRows.get(id), nextRows.get(id))) changes.push({ path: `${field}/${id}`, before: structuredClone(oldRows.get(id) ?? null), after: structuredClone(nextRows.get(id) ?? null) });
    } else changes.push({ path: field, before: structuredClone(before?.[field] ?? null), after: structuredClone(after[field] ?? null) });
  }
  return changes;
}

/** Without now, validation is pure. Server stamps are applied only after all checks pass. */
export function validateOrderRelationsChanges(previous, next, identity, now) {
  const error = validateShape(previous, next, identity, now); if (error) return error;
  const old = previous?.orderRelations, relations = next?.orderRelations;
  if (!relations) return '';
  if (now) {
    const allocationError = validateOrderObjectCostAllocations(previous, next, identity, now);
    if (allocationError) return allocationError;
  }
  const changed = fields.filter(key => !same(old?.[key], relations[key]));
  if (now && changed.length) {
    const by = identity?.name || identity?.id || 'Управление';
    const stamp = (row, previousRow, event) => {
      if (!previousRow) { row.recordedAt = now; row.recordedBy = by; }
      if (event && !previousRow?.[`${event}At`]) { row[`${event}At`] = now; row[`${event}By`] = by; }
    };
    for (const row of relations.objects) {
      const before = list(old?.objects).find(item => item.id === row.id); stamp(row, before);
      for (const spec of row.specifications) stamp(spec, list(before?.specifications).find(item => item.id === spec.id), spec.status === 'approved' ? 'approved' : null);
    }
    for (const row of relations.contracts) {
      const before = list(old?.contracts).find(item => item.id === row.id); stamp(row, before, signedContract(row) ? 'signed' : null);
      if (['completed', 'terminated'].includes(row.status)) stamp(row, before, 'closed');
    }
    for (const row of relations.mortgages) {
      const before = list(old?.mortgages).find(item => item.id === row.id); stamp(row, before, ['approved', 'funded'].includes(row.status) ? 'approved' : null);
      if (row.status === 'funded') stamp(row, before, 'funded');
    }
    for (const row of relations.changeRequests) {
      const before = list(old?.changeRequests).find(item => item.id === row.id); stamp(row, before, approvedChange(row) ? 'approved' : null);
      if (row.status === 'applied') stamp(row, before, 'applied');
    }
    for (const row of relations.warrantyCases) stamp(row, list(old?.warrantyCases).find(item => item.id === row.id), row.status === 'closed' ? 'closed' : null);
    relations.history = [...(old?.history ?? []), { id: `order:${next.project.id}:${now}:${(old?.history?.length ?? 0) + 1}`, at: now, by,
      ...(identity?.email ? { actorEmail: identity.email } : {}), reason: relations.changeReason?.trim() || 'Созданы связи заказа', sections: changed,
      changes: changeEvidence(old, relations, changed) }];
  }
  if (now && relations.contractPricing === true) {
    next.project.contractValue = orderContractValueCents(relations) / 100;
    if (Array.isArray(next.project.unknownFields)) next.project.unknownFields = next.project.unknownFields.filter(field => field !== 'contractValue');
  }
  if (now) next.project.status = projectStatusFor(relations.status);
  return '';
}

/** Ready-to-apply UI patch; retains authoritative history and leaves server timestamps alone. */
export function prepareOrderRelationsUpdate(state, nextRelations, identity, reason) {
  const relations = structuredClone(nextRelations);
  relations.changeReason = typeof reason === 'string' ? reason.trim() : '';
  const next = { ...state, project: { ...state.project }, orderRelations: relations };
  const error = validateOrderRelationsChanges(state, next, identity);
  if (error) return { ok: false, error };
  const cents = orderContractValueCents(relations);
  return { ok: true, orderRelations: relations, projectStatus: projectStatusFor(relations.status), ...(relations.contractPricing === true && cents !== null ? { contractValue: cents / 100 } : {}) };
}

/** Immutable array helper for draft edits; approval rules are checked by prepare/validate. */
export function upsertOrderRelation(relations, collection, row) {
  if (!collections.includes(collection) || !validOrderRelationId(row?.id)) throw new Error('Неизвестный раздел или ID связи заказа.');
  const result = structuredClone(relations); result[collection] ??= [];
  const index = result[collection].findIndex(item => item.id === row.id);
  if (index < 0) result[collection].push(structuredClone(row)); else result[collection][index] = structuredClone(row);
  return result;
}

/** An approved baseline is copied into a new draft; no approved fact is modified. */
export function createOrderSpecificationVersion(scope, id, changeRequestId) {
  if (!validOrderRelationId(id) || !validRef(changeRequestId)) throw new Error('Некорректный ID версии или изменения.');
  const previous = scope.specifications.find(row => row.id === scope.activeSpecificationId) ?? scope.specifications.at(-1);
  if (!previous) return { id, version: 1, status: 'draft', title: scope.title, scope: '', documentIds: [], ...(changeRequestId ? { changeRequestId } : {}) };
  const result = pickWithout(structuredClone(previous), [...stampKeys, 'changeRequestId']);
  return { ...result, id, version: Math.max(...scope.specifications.map(row => row.version)) + 1, status: 'draft', documentIds: [], ...(changeRequestId ? { changeRequestId } : {}) };
}
