import { authenticatedIdentity, projectIdentity } from '../access-control.js';
import { json } from '../lib/http.js';
import { readJsonBodyLimited } from '../lib/request-body.js';
import { orderDirectoryReferences, validOrderRelationId, validOrderDate } from '../../src/domain/order-relations.js';

const kinds = ['party', 'plot', 'asset', 'agreement'];
const array = value => Array.isArray(value) ? value : [];
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const known = (value, fields) => object(value) && Object.keys(value).every(key => fields.includes(key));
const text = (value, max = 4000) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const optionalText = (value, max = 4000) => value === undefined || typeof value === 'string' && value.length <= max;
const optional = (value, predicate) => value === undefined || predicate(value);
const unique = values => [...new Set(values)];
const changes = result => Number(result?.meta?.changes ?? result?.changes ?? 0);
const stable = value => JSON.stringify(value, (_, item) => object(item) ? Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b))) : item);
const forbidden = () => json({ ok: false, error: 'order_directory_access_denied', message: 'Для справочника нужен доступ «Управление» к текущему заказу.' }, 403);
const sharedDenied = () => json({ ok: false, error: 'shared_record_access_denied', message: 'Общую запись может изменить собственник или управляющий всеми заказами, в которых она используется.' }, 403);
const conflict = () => json({ ok: false, error: 'revision_conflict', message: 'Запись справочника уже изменена. Обновите данные и повторите правку.' }, 409);
const referenceMessage = 'Общий участник, участок, объект или договор не найден, имеет другой тип либо недоступен для управления. Выберите запись из доступного справочника.';
const validIds = value => Array.isArray(value) && value.length <= 100 && value.every(validOrderRelationId) && new Set(value).size === value.length;
const area = value => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1e10;

/** Directory data is canonical; order-specific commercial facts do not belong here. */
export function validateOrderDirectoryData(kind, value) {
  const common = ['name', 'source', 'notes'];
  const fields = kind === 'party' ? [...common, 'partyType', 'phone', 'email', 'inn', 'legalName']
    : kind === 'plot' ? [...common, 'address', 'cadastralNumber', 'areaSqm', 'ownerPartyIds', 'communications', 'constraints']
      : kind === 'asset' ? [...common, 'assetType', 'plotId', 'houseAreaSqm', 'terraceAreaSqm', 'floors', 'technology']
        : [...common, 'number', 'partyIds', 'totalAmountCents', 'currency', 'status', 'signedDate', 'effectiveDate', 'endDate', 'documentIds', 'partySnapshots'];
  if (!kinds.includes(kind) || !known(value, fields) || !text(value.name, 300) || !optionalText(value.source) || !optionalText(value.notes)) return 'Укажите название и допустимые поля общей записи.';
  if (kind === 'party' && (!['person', 'company'].includes(value.partyType) || !['phone', 'email', 'inn', 'legalName'].every(key => optionalText(value[key], key === 'legalName' ? 300 : 240)))) return 'Проверьте тип участника, название и контактные данные.';
  if (kind === 'plot' && (!['address', 'cadastralNumber', 'communications', 'constraints'].every(key => optionalText(value[key]))
    || !optional(value.areaSqm, area) || !optional(value.ownerPartyIds, validIds))) return 'Проверьте участок, площадь, кадастровый номер и собственников.';
  if (kind === 'asset' && (!['house', 'bath', 'garage', 'other'].includes(value.assetType) || !optional(value.plotId, validOrderRelationId)
    || !optional(value.houseAreaSqm, area) || !optional(value.terraceAreaSqm, amount => typeof amount === 'number' && Number.isFinite(amount) && amount >= 0 && amount <= 1e10)
    || !optional(value.floors, amount => Number.isSafeInteger(amount) && amount > 0 && amount <= 200) || !optionalText(value.technology))) return 'Проверьте тип физического объекта, участок, площадь и этажность.';
  if (kind === 'agreement') {
    if (!['draft', 'signed'].includes(value.status) || value.currency !== 'RUB' || !optionalText(value.number, 240) || !validIds(value.partyIds)
      || !optional(value.totalAmountCents, amount => Number.isSafeInteger(amount) && amount >= 0) || !optional(value.documentIds, validIds)
      || !['signedDate', 'effectiveDate', 'endDate'].every(key => optional(value[key], validOrderDate))
      || value.effectiveDate && value.endDate && value.effectiveDate > value.endDate) return 'Проверьте общий подрядный договор, стороны, даты и полную сумму в копейках RUB.';
    if (value.status === 'signed' && (!Number.isSafeInteger(value.totalAmountCents) || !value.partyIds.length || !array(value.documentIds).length || !value.signedDate || !text(value.source))) return 'Для подписанного общего договора нужны точная полная сумма, стороны, подписанный документ, дата и источник.';
    if (value.partySnapshots !== undefined && (value.status !== 'signed' || !Array.isArray(value.partySnapshots) || value.partySnapshots.length !== value.partyIds.length
      || new Set(value.partySnapshots.map(row => row?.partyId)).size !== value.partyIds.length
      || value.partySnapshots.some(row => !known(row, ['partyId', 'name', 'partyType', 'inn', 'legalName']) || !value.partyIds.includes(row.partyId) || !text(row.name, 300)
        || !['person', 'company'].includes(row.partyType) || !optionalText(row.inn, 240) || !optionalText(row.legalName, 300)))) return 'Некорректный снимок сторон общего договора.';
  }
  return '';
}

const recordReferences = record => record?.kind === 'asset' && record.data.plotId ? [{ id: record.data.plotId, kind: 'plot' }]
  : record?.kind === 'plot' ? array(record.data.ownerPartyIds).map(id => ({ id, kind: 'party' }))
    : record?.kind === 'agreement' ? array(record.data.partyIds).map(id => ({ id, kind: 'party' })) : [];

const signedContract = row => ['signed', 'completed', 'terminated'].includes(row?.status);
const partySnapshot = (partyId, data) => ({ partyId, name: data.name, partyType: data.partyType, ...(data.inn ? { inn: data.inn } : {}), ...(data.legalName ? { legalName: data.legalName } : {}) });
const masterEvidenceError = (scope, master) => {
  const origin = scope.projects.find(project => project.id === master.originProjectId);
  const docs = new Map(array(origin?.state.documents).map(row => [row.id, row]));
  return !origin || !array(master.data.documentIds).length || master.data.documentIds.some(id => {
    const document = docs.get(id);
    return !document || document.category !== 'contract' || document.status !== 'signed' || document.clientVisible !== false || !(text(document.fileKey, 4000) || text(document.storageLocation, 4000))
      || document.fileKey && (typeof document.fileKey !== 'string' || !document.fileKey.startsWith(`${master.originProjectId}/`) || document.fileKey.includes('\\') || document.fileKey.split('/').some(part => ['.', '..'].includes(part)));
  }) ? 'Общий подписанный договор требует существующего подписанного документа категории «Договор» с файлом или местом хранения и выключенной публикацией клиенту в исходном заказе.' : '';
};
const masterDocumentChangesError = (masters, previousState, nextState) => {
  const before = new Map(array(previousState.documents).map(row => [row.id, row])), after = new Map(array(nextState.documents).map(row => [row.id, row]));
  for (const master of masters) for (const id of array(master.data.documentIds)) {
    const old = before.get(id), row = after.get(id);
    if (!old || !row || ['fileKey', 'sourceSha256', 'storageLocation', 'number', 'documentDate', 'category', 'status', 'clientVisible'].some(key => stable(old[key]) !== stable(row[key]))) return 'Документ подписанного общего договора защищён от удаления, замены и публикации. Добавьте отдельное новое основание.';
  }
  return '';
};
const agreementEvidence = (scope, master) => {
  const project = scope.projects.find(row => row.id === master.originProjectId);
  const documents = new Map(array(project?.state.documents).map(row => [row.id, row]));
  return array(master.data.documentIds).map(id => {
    const doc = documents.get(id), identities = [`document:${master.originProjectId}:${id}`];
    if (doc?.fileKey) identities.push(`file:${doc.fileKey}`);
    if (doc?.sourceSha256) identities.push(`sha256:${String(doc.sourceSha256).toLowerCase()}`);
    return identities;
  });
};
const duplicateAgreementEvidence = (scope, candidate) => {
  const evidence = agreementEvidence(scope, candidate);
  return scope.records.some(master => {
    if (master.id === candidate.id || master.kind !== 'agreement' || master.data.status !== 'signed') return false;
    const existing = new Set(agreementEvidence(scope, master).flat());
    // An amendment may add new signed evidence. Reusing only the same originals
    // under another UUID must not create a second independent allocation ceiling.
    return evidence.length > 0 && evidence.every(aliases => aliases.some(id => existing.has(id)));
  });
};

async function readScope(db, request, env) {
  const [projectResult, recordResult] = await Promise.all([
    db.prepare('SELECT project_id, state_json, revision FROM project_state ORDER BY project_id LIMIT 501').all(),
    db.prepare('SELECT id, kind, origin_project_id, payload_json, revision, created_at, created_by, updated_at, updated_by FROM order_directory_records ORDER BY id LIMIT 10001').all(),
  ]);
  if (array(projectResult?.results).length > 500 || array(recordResult?.results).length > 10000) throw new Error('directory_scope_too_large');
  const projects = array(projectResult?.results).map(row => {
    const state = JSON.parse(row.state_json);
    if (state?.project?.id !== row.project_id) throw new Error('invalid_project_snapshot');
    return { id: row.project_id, revision: Number(row.revision), state, identity: projectIdentity(request, env, state) };
  });
  const records = array(recordResult?.results).map(row => {
    const data = JSON.parse(row.payload_json);
    if (!validOrderRelationId(row.id) || validateOrderDirectoryData(row.kind, data)) throw new Error('invalid_directory_snapshot');
    return { id: row.id, kind: row.kind, data, originProjectId: row.origin_project_id, revision: Number(row.revision), createdAt: row.created_at, createdBy: row.created_by, updatedAt: row.updated_at, updatedBy: row.updated_by };
  });
  const recordMap = new Map(records.map(record => [record.id, record]));
  const managed = new Set(projects.filter(project => project.identity?.role === 'management').map(project => project.id));
  const isOwner = authenticatedIdentity(request, env)?.isOwner === true;
  const referencedBy = new Map(), projectReferences = new Map();
  const closure = (references, strict = false) => {
    const found = new Set(), queue = [...references];
    while (queue.length) {
      const reference = queue.pop(), record = recordMap.get(reference.id);
      if (!record || record.kind !== reference.kind) { if (strict) throw new Error('invalid_directory_reference'); continue; }
      if (found.has(record.id)) continue;
      found.add(record.id); queue.push(...recordReferences(record));
    }
    return found;
  };
  for (const project of projects) {
    const ids = closure(orderDirectoryReferences(project.state.orderRelations));
    projectReferences.set(project.id, ids);
    for (const id of ids) { const set = referencedBy.get(id) ?? new Set(); set.add(project.id); referencedBy.set(id, set); }
  }
  const visible = new Set();
  if (isOwner) for (const row of records) visible.add(row.id);
  else {
    const roots = records.filter(record => managed.has(record.originProjectId)).map(record => ({ id: record.id, kind: record.kind }));
    for (const projectId of managed) for (const id of projectReferences.get(projectId) ?? []) roots.push({ id, kind: recordMap.get(id).kind });
    for (const id of closure(roots)) visible.add(id);
  }
  const canManageRecordScope = id => {
    if (isOwner) return true;
    const record = recordMap.get(id);
    const references = referencedBy.get(id);
    return references?.size ? [...references].every(projectId => managed.has(projectId)) : managed.has(record?.originProjectId);
  };
  const canEdit = id => {
    const record = recordMap.get(id);
    if (record?.kind === 'agreement' && (record.data.status === 'signed' || !managed.has(record.originProjectId))) return false;
    return canManageRecordScope(id);
  };
  return { projects, records, recordMap, managed, isOwner, visible, referencedBy, projectReferences, canEdit, canManageRecordScope, closure };
}

function publicResponse(scope) {
  return { ok: true, records: scope.records.filter(row => scope.visible.has(row.id)).map(row => {
    const record = { ...row, canEdit: scope.canEdit(row.id) };
    if (!scope.managed.has(row.originProjectId)) {
      delete record.originProjectId;
      if (row.kind === 'agreement') { record.data = { ...row.data }; delete record.data.documentIds; }
    }
    if (row.kind === 'agreement' && !scope.canManageRecordScope(row.id)) {
      record.data = { ...record.data }; record.limitedScope = true;
      for (const field of ['totalAmountCents', 'source', 'notes', 'documentIds']) delete record.data[field];
    }
    return record;
  }), orders: scope.projects.filter(row => scope.managed.has(row.id)).map(row => {
    const relations = row.state.orderRelations, project = row.state.project;
    const references = [...(scope.projectReferences.get(row.id) ?? [])].map(id => scope.recordMap.get(id));
    return { id: row.id, code: project.code || '', name: project.name || '', status: relations?.status || project.status || 'active', revision: row.revision,
      ...(relations?.customerId ? { customerId: relations.customerId } : {}), ...(relations?.mode ? { mode: relations.mode } : {}),
      participantPartyIds: references.filter(record => record.kind === 'party').map(record => record.id),
      assetIds: references.filter(record => record.kind === 'asset').map(record => record.id), plotIds: references.filter(record => record.kind === 'plot').map(record => record.id),
      contractValue: !array(project.unknownFields).includes('contractValue') && typeof project.contractValue === 'number' && Number.isFinite(project.contractValue) ? project.contractValue : null };
  }) };
}

function referencesAccessible(scope, references) {
  for (const ref of references) {
    const record = scope.recordMap.get(ref.id);
    if (!record || record.kind !== ref.kind || !scope.visible.has(ref.id)) return false;
  }
  try {
    const all = scope.closure(references, true);
    return [...all].every(id => scope.visible.has(id));
  } catch { return false; }
}

/** Call before the synchronous order validator, using the same project-write transaction. */
export async function validateOrderDirectoryReferences({ db, request, env, previousState, nextState }) {
  const documentsChanged = previousState && stable(previousState.documents) !== stable(nextState?.documents);
  if (!nextState?.orderRelations && !documentsChanged) return '';
  // Normal foreman/client updates retain private relations through the existing merge.
  // They must not obtain directory access or be blocked from their unrelated work.
  const previousIdentity = previousState && projectIdentity(request, env, previousState);
  if (!documentsChanged && previousIdentity && previousIdentity.role !== 'management' && stable(previousState.orderRelations) === stable(nextState.orderRelations)) return '';
  if (!db) return 'Общий справочник недоступен. Связи заказа не сохранены.';
  try {
    if (documentsChanged) {
      const result = await db.prepare("SELECT id, payload_json FROM order_directory_records WHERE kind = 'agreement' AND origin_project_id = ?").bind(nextState.project.id).all();
      const masters = array(result?.results).map(row => ({ id: row.id, data: JSON.parse(row.payload_json) })).filter(row => row.data.status === 'signed');
      const evidenceError = masterDocumentChangesError(masters, previousState, nextState);
      if (evidenceError) return evidenceError;
    }
    if (!nextState?.orderRelations) return '';
    if (previousIdentity && previousIdentity.role !== 'management' && stable(previousState.orderRelations) === stable(nextState.orderRelations)) return '';
    const scope = await readScope(db, request, env);
    const existingProject = scope.projects.find(project => project.id === nextState.project?.id);
    // A new project can reuse an accessible directory entry, but cannot grant itself access.
    if (existingProject ? !scope.managed.has(existingProject.id) : !scope.isOwner) return 'Для изменения связей нужен доступ «Управление» к заказу.';
    const references = orderDirectoryReferences(nextState.orderRelations);
    if (!referencesAccessible(scope, references)) return referenceMessage;
    const sharedIds = new Set([...array(previousState?.orderRelations?.contracts), ...array(nextState.orderRelations.contracts)].map(row => row?.sharedAgreementId).filter(Boolean));
    for (const contract of array(nextState.orderRelations.contracts)) if (contract?.sharedAgreementId) {
      const master = scope.recordMap.get(contract.sharedAgreementId);
      if (master?.kind !== 'agreement' || contract.kind !== 'supplier') return 'Доля заказа должна ссылаться на общий подрядный договор.';
      if (signedContract(contract)) {
        if (master.data.status !== 'signed') return 'Сначала подпишите общее основание; затем фиксируйте долю заказа.';
        const evidenceError = masterEvidenceError(scope, master); if (evidenceError) return evidenceError;
        if (stable([...array(contract.partyIds)].sort()) !== stable([...master.data.partyIds].sort())
          || ['number', 'signedDate', 'effectiveDate', 'endDate'].some(key => (contract[key] || undefined) !== (master.data[key] || undefined))) return 'Стороны, номер и договорные даты доли должны соответствовать общему подписанному договору. Сроки конкретных работ задаются в составе работ заказа.';
      }
    }
    // A shared master is counted once; local contract amounts are only allocated parts.
    for (const id of sharedIds) {
      const master = scope.recordMap.get(id);
      if (master?.kind !== 'agreement') return referenceMessage;
      let allocated = 0;
      const portfolio = scope.projects.filter(project => project.id !== nextState.project.id).map(project => project.state).concat(nextState);
      for (const state of portfolio) {
        const contracts = array(state.orderRelations?.contracts), superseded = new Set(contracts.filter(signedContract).map(row => row.supersedesId).filter(Boolean));
        for (const contract of contracts.filter(row => row.sharedAgreementId === id && ['signed', 'completed'].includes(row.status) && !superseded.has(row.id))) {
          if (contract.kind !== 'supplier' || !Number.isSafeInteger(contract.amountCents) || contract.amountCents < 0 || !Number.isSafeInteger(allocated + contract.amountCents)) return 'Распределения общего договора требуют сверки точных сумм и оснований.';
          allocated += contract.amountCents;
        }
      }
      if (allocated && (master.data.status !== 'signed' || !Number.isSafeInteger(master.data.totalAmountCents)) || allocated > (master.data.totalAmountCents ?? 0)) return 'Сумма действующих долей заказов превышает полную сумму общего договора. Пересмотрите распределение; существующие доли других заказов сохраняются.';
    }
    if (nextState.orderRelations.customerId) nextState.project.clientNames = scope.recordMap.get(nextState.orderRelations.customerId).data.name;
    for (const contract of array(nextState.orderRelations.contracts)) {
      const before = array(previousState?.orderRelations?.contracts).find(row => row.id === contract?.id);
      if (['signed', 'completed', 'terminated'].includes(contract?.status) && !['signed', 'completed', 'terminated'].includes(before?.status)) {
        const master = contract.sharedAgreementId ? scope.recordMap.get(contract.sharedAgreementId) : null;
        contract.partySnapshots = master?.data.partySnapshots ? structuredClone(master.data.partySnapshots)
          : array(contract.partyIds).map(partyId => partySnapshot(partyId, scope.recordMap.get(partyId).data));
      }
    }
    return '';
  } catch (error) {
    return error?.message === 'directory_scope_too_large' ? 'Справочник достиг лимита проверяемого объёма. Нужна отдельная настройка; запись остановлена без изменений.' : 'Не удалось проверить общий справочник. Связи заказа не сохранены.';
  }
}

/** All shared mutations use the same advisory-locked transaction as project finance. */
export const createOrderDirectoryHandler = ({ ensureSchema }) => async (request, env) => {
  if (!env.DB) return json({ ok: false, error: 'storage_unavailable', message: 'Хранилище справочника недоступно.' }, 503);
  if (!authenticatedIdentity(request, env)) return forbidden();
  const projectId = new URL(request.url).searchParams.get('projectId');
  if (!validOrderRelationId(projectId)) return json({ ok: false, error: 'invalid_project_id', message: 'Укажите текущий заказ.' }, 422);
  if (!['GET', 'POST'].includes(request.method)) return json({ ok: false, error: 'method_not_allowed' }, 405);
  let input;
  if (request.method === 'POST') {
    if (typeof env.DB.financialTransaction !== 'function') return json({ ok: false, error: 'directory_transaction_unavailable', message: 'Атомарная запись справочника недоступна. Изменения не сохранены.' }, 503);
    try { input = await readJsonBodyLimited(request, 128 * 1024); }
    catch (error) { return json({ ok: false, error: error?.message === 'payload_too_large' ? 'payload_too_large' : 'invalid_json' }, error?.message === 'payload_too_large' ? 413 : 400); }
    const validation = validateOrderDirectoryData(input?.record?.kind, input?.record?.data);
    if (!known(input, ['record', 'expectedRevision', 'reason']) || !known(input.record, ['id', 'kind', 'data']) || !validOrderRelationId(input.record.id)
      || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || !text(input.reason, 2000) || validation) return json({ ok: false, error: 'invalid_directory_record', message: validation || 'Проверьте ID записи, текущую ревизию и причину изменения.' }, 422);
  }
  try {
    await ensureSchema(env.DB);
    if (request.method === 'GET') {
      const scope = await readScope(env.DB, request, env);
      if (!scope.managed.has(projectId)) return forbidden();
      return json(publicResponse(scope));
    }
    return await env.DB.financialTransaction(async db => {
      const scope = await readScope(db, request, env);
      if (!scope.managed.has(projectId)) return forbidden();
      const identity = scope.projects.find(project => project.id === projectId).identity;
      const old = scope.recordMap.get(input.record.id);
      if (old && !scope.visible.has(old.id) || !old && input.expectedRevision !== 0) return sharedDenied();
      if (old && old.revision !== input.expectedRevision) return conflict();
      if (old && old.kind !== input.record.kind) return json({ ok: false, error: 'immutable_record_identity', message: 'Тип и идентификатор общей записи защищены. Создайте отдельную запись другого типа.' }, 422);
      const data = Object.fromEntries(Object.entries(input.record.data).filter(([, value]) => value !== undefined).map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value]));
      if (old?.kind === 'agreement' && old.data.status === 'signed') return stable(old.data) === stable(data) ? json(publicResponse(scope))
        : json({ ok: false, error: 'signed_agreement_immutable', message: 'Подписанные условия общего договора защищены. Оформите новое договорное основание, сохранив предыдущую версию.' }, 422);
      if (old && !scope.canEdit(old.id)) return sharedDenied();
      const candidate = { id: input.record.id, kind: input.record.kind, data };
      if (!referencesAccessible(scope, recordReferences(candidate))) return json({ ok: false, error: 'invalid_directory_reference', message: referenceMessage }, 422);
      if (candidate.kind === 'agreement') {
        const originProjectId = old?.originProjectId ?? projectId;
        const origin = scope.projects.find(project => project.id === originProjectId), docs = new Set(array(origin?.state.documents).map(row => row.id));
        if (!scope.managed.has(originProjectId) || array(data.documentIds).some(id => !docs.has(id))) return json({ ok: false, error: 'invalid_agreement_documents', message: 'Документы общего договора должны существовать в исходном доступном заказе.' }, 422);
        if (data.status === 'signed') {
          const evidenceError = masterEvidenceError(scope, { ...candidate, originProjectId });
          if (evidenceError) return json({ ok: false, error: 'invalid_agreement_evidence', message: evidenceError }, 422);
          if (duplicateAgreementEvidence(scope, { ...candidate, originProjectId })) return json({ ok: false, error: 'duplicate_agreement_evidence', message: 'Этот набор подписанных оригиналов уже связан с общим договором. Используйте существующую карточку; новое основание требует отдельного подписанного документа.' }, 422);
          const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date());
          if (data.signedDate > today) return json({ ok: false, error: 'future_signature_date', message: 'Фактическая дата подписания не может находиться в будущем.' }, 422);
          data.partySnapshots = data.partyIds.map(partyId => partySnapshot(partyId, scope.recordMap.get(partyId).data));
        }
      }
      if (candidate.kind === 'plot' && data.cadastralNumber && scope.records.some(record => record.id !== candidate.id && record.kind === 'plot' && record.data.cadastralNumber?.replace(/\s/g, '').toLocaleLowerCase('ru-RU') === data.cadastralNumber.replace(/\s/g, '').toLocaleLowerCase('ru-RU'))) return json({ ok: false, error: 'duplicate_cadastral_number', message: 'Участок с этим кадастровым номером уже внесён. Используйте существующую запись; при недостатке доступа обратитесь к собственнику.' }, 422);
      if (old && stable(old.data) === stable(data)) return json(publicResponse(scope));
      const now = new Date().toISOString(), revision = (old?.revision ?? 0) + 1, payload = JSON.stringify(data), origin = old?.originProjectId ?? projectId;
      const mutation = old
        ? db.prepare('UPDATE order_directory_records SET payload_json = ?, revision = ?, updated_at = ?, updated_by = ? WHERE id = ? AND kind = ? AND revision = ?').bind(payload, revision, now, identity.name, candidate.id, candidate.kind, input.expectedRevision)
        : db.prepare('INSERT INTO order_directory_records (id, kind, origin_project_id, payload_json, revision, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING').bind(candidate.id, candidate.kind, origin, payload, revision, now, identity.name, now, identity.name);
      const audit = db.prepare(`INSERT INTO order_directory_audit (id, record_id, kind, revision, project_id, created_at, actor, actor_name, reason, payload_json)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM order_directory_records WHERE id = ? AND kind = ? AND revision = ? AND payload_json = ?)
        ON CONFLICT(id) DO NOTHING`).bind(`order-directory:${candidate.id}:${revision}`, candidate.id, candidate.kind, revision, projectId, now, identity.email, identity.name, input.reason.trim(), payload, candidate.id, candidate.kind, revision, payload);
      const results = await db.batch([mutation, audit]);
      if (changes(results?.[0]) !== 1 || changes(results?.[1]) !== 1) return conflict();
      return json(publicResponse(await readScope(db, request, env)));
    });
  } catch (error) {
    return json({ ok: false, error: error?.message === 'directory_scope_too_large' ? 'directory_scope_too_large' : 'storage_error', message: error?.message === 'directory_scope_too_large' ? 'Справочник достиг лимита проверяемого объёма; запись остановлена.' : 'Не удалось сохранить или прочитать справочник. Обновите данные и повторите.' }, error?.message === 'directory_scope_too_large' ? 503 : 500);
  }
};
