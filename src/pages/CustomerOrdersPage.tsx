import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowUpRight, Building2, Check, ChevronRight, FileText, Landmark, Link2, Mail, MapPin, Pencil, Plus, RefreshCw, Search, Users, X } from 'lucide-react';
import type { AppState, AuthenticatedUser, OrderChangeRequest, OrderContract, OrderDirectoryRecord, OrderDirectoryResponse, OrderLink, OrderLinkKind, OrderMode, OrderMortgage, OrderObjectScope, OrderParticipant, OrderParticipantRole, OrderRelationsState, OrderSpecification, OrderStatus, OrderWarrantyCase } from '../entities/index';
import type { StateChangeSink } from '../application/state-change';
import { emptyOrderRelations, orderContractTotals, orderContractValueCents } from '../domain/order-relations.js';
import { effectiveBudgetLines, paidAmountFor } from '../domain/index';
import { fetchOrderDirectory, saveOrderDirectoryRecord, type OrderDirectoryWrite } from '../infrastructure/order-directory';
import { commitOrderRelationsProject, orderRelationsFingerprint } from '../infrastructure/order-relations-project';
import type { PageId } from '../presentation/navigation';
import { formatDate, formatDateTime, money } from '../presentation/formatting';
import { orderMoneyField, orderMoneyInput, orderNumberInput, orderSelectedIds } from '../presentation/customer-order-forms';
import { OrderEditorModal, type OrderEditorField, type OrderEditorOption, type OrderEditorValues } from '../components/customer-orders/OrderEditorModal';
import { SectionHeader, StatusBadge } from '../components/Ui';
import { OrderChangeImpactPanel } from '../components/OrderChangeImpactPanel';
import { OrderObjectCostsPanel } from '../components/OrderObjectCostsPanel';
import './customer-orders.css';

type PartyRecord = Extract<OrderDirectoryRecord, { kind: 'party' }>;
type PlotRecord = Extract<OrderDirectoryRecord, { kind: 'plot' }>;
type AssetRecord = Extract<OrderDirectoryRecord, { kind: 'asset' }>;
type AgreementRecord = Extract<OrderDirectoryRecord, { kind: 'agreement' }>;
type OrderTab = 'participants' | 'objects' | 'contracts' | 'financing' | 'changes' | 'links' | 'warranty' | 'history';
type Editor = {
  id: string; title: string; subtitle?: string; fields: OrderEditorField[]; initialValues: OrderEditorValues;
  submitLabel?: string; summary?: ReactNode; renderHint?: (values: OrderEditorValues) => ReactNode;
  onSubmit: (values: OrderEditorValues) => void | Promise<void>;
};

const modeLabels: Record<OrderMode, string> = { client_land: 'Строительство на земле заказчика', land_and_build: 'Участок и строительство', ready_sale: 'Продажа готового объекта', additional_work: 'Дополнительные работы' };
const orderStatusLabels: Record<OrderStatus, string> = { draft: 'Черновик', active: 'В работе', on_hold: 'Приостановлен', completed: 'Завершён', canceled: 'Отменён' };
const participantLabels: Record<OrderParticipantRole, string> = { customer: 'Заказчик', co_customer: 'Созаказчик', land_owner: 'Собственник участка', payer: 'Плательщик', borrower: 'Заёмщик', guarantor: 'Поручитель', contractor: 'Подрядчик', supplier: 'Поставщик', bank: 'Банк', agent: 'Агент', representative: 'Представитель', other: 'Другой участник' };
const objectStatusLabels = { planned: 'Запланирован', active: 'В работе', completed: 'Работы завершены', canceled: 'Работы отменены' };
const contractKindLabels = { customer: 'С заказчиком', supplier: 'С подрядчиком / поставщиком', finance: 'Финансирование' };
const contractStatusLabels = { draft: 'Черновик', signed: 'Подписан', completed: 'Исполнен', terminated: 'Расторгнут' };
const mortgageStatusLabels = { draft: 'Черновик', submitted: 'Заявка подана', approved: 'Одобрена', rejected: 'Отказ', funded: 'Выдана, поступление подтверждено', canceled: 'Отменена' };
const changeStatusLabels = { draft: 'Черновик', submitted: 'На согласовании', approved: 'Утверждено', rejected: 'Отклонено', applied: 'Выполнено' };
const warrantyStatusLabels = { open: 'Зарегистрировано', in_progress: 'В работе', resolved: 'Устранено', closed: 'Закрыто' };
const assetTypeLabels = { house: 'Дом', bath: 'Баня', garage: 'Гараж', other: 'Другой объект' };
const linkLabels: Record<OrderLinkKind, string> = { stage: 'Этап работ', budget: 'Статья бюджета', finance: 'Финансовая запись', procurement: 'Поставка', task: 'Задача', document: 'Документ', lead: 'Заявка на продажу', counterparty: 'Контрагент' };
const linkPages: Record<OrderLinkKind, PageId> = { stage: 'schedule', budget: 'finance', finance: 'finance', procurement: 'procurement', task: 'tasks', document: 'project', lead: 'marketing', counterparty: 'counterparties' };
const sectionLabels: Record<string, string> = { customerId: 'Заказчик', mode: 'Вид заказа', status: 'Статус заказа', contractPricing: 'Источник цены', plotIds: 'Участки', participants: 'Участники', objects: 'Объекты и комплектации', contracts: 'Договоры', mortgages: 'Ипотека', changeRequests: 'Изменения', links: 'Связи разделов', warrantyCases: 'Гарантия', costAllocations: 'Распределение затрат' };
const tabLabels: Record<OrderTab, string> = { participants: 'Участники', objects: 'Участки и объекты', contracts: 'Договоры', financing: 'Ипотека', changes: 'Изменения', links: 'Связи разделов', warranty: 'Гарантия', history: 'История' };
const options = (labels: Record<string, string>): OrderEditorOption[] => Object.entries(labels).map(([value, label]) => ({ value, label }));
const textValue = (value: string | undefined) => value?.trim() || undefined;
const stringNumber = (value: number | undefined) => value === undefined ? '' : String(value);
const id = () => crypto.randomUUID();
const put = <T extends { id: string }>(rows: T[], row: T): T[] => rows.some(item => item.id === row.id) ? rows.map(item => item.id === row.id ? row : item) : [...rows, row];
const centsText = (value: number | null | undefined) => value === undefined || value === null ? 'Не указано' : money(value / 100);
const areaText = (value: number | undefined) => value === undefined ? 'Не указана' : `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value)} м²`;
const approvedChanges = (relations: OrderRelationsState, objectId?: string) => relations.changeRequests.filter(row => ['approved', 'applied'].includes(row.status) && (!objectId || !row.objectIds.length || row.objectIds.includes(objectId))).map(row => ({ value: row.id, label: row.title }));
const reasonField: OrderEditorField = { name: 'saveReason', label: 'Основание записи', type: 'textarea', required: true, maxLength: 2000, hint: 'Коротко укажите, что изменилось и на каком основании. Это останется в истории.' };
const docField = (state: AppState, required = false): OrderEditorField => ({ name: 'documentIds', label: 'Документы этого заказа', type: 'multi', required, options: state.documents.map(row => ({ value: row.id, label: row.name })), hint: 'Сначала добавьте файл в документы проекта. Выбранные документы остаются в общем реестре заказа.' });
const sourceField: OrderEditorField = { name: 'source', label: 'Источник / основание', type: 'textarea', hint: 'Например: подписанное приложение, письмо или решение с датой.' };

function EmptySection({ title, children }: { title: string; children: ReactNode }) {
  return <div className="customer-orders__empty"><Link2 size={25} /><strong>{title}</strong><p>{children}</p></div>;
}

function RecordBadge({ status, label }: { status: string; label: string }) {
  const tone = ['signed', 'approved', 'completed', 'applied', 'resolved', 'funded'].includes(status) ? 'positive'
    : ['canceled', 'terminated', 'rejected'].includes(status) ? 'danger'
      : ['submitted', 'on_hold', 'open'].includes(status) ? 'warning' : status === 'active' || status === 'in_progress' ? 'blue' : 'neutral';
  return <StatusBadge label={label} tone={tone} />;
}

function FormNote({ children }: { children: ReactNode }) { return <p className="customer-orders__balance-note">{children}</p>; }

function ChangedRecord({ path, before, after, resolveName }: { path: string; before: unknown; after: unknown; resolveName: (id: string) => string }) {
  const section = path.split('/')[0];
  const valueText = (value: unknown): string => {
    if (value === null || value === undefined) return 'Не указано';
    if (typeof value === 'boolean') return value ? 'Включено' : 'Выключено';
    if (typeof value === 'string') return section === 'customerId' ? resolveName(value) : orderStatusLabels[value as OrderStatus] ?? modeLabels[value as OrderMode] ?? value;
    if (Array.isArray(value)) return section === 'plotIds' ? value.map(item => resolveName(String(item))).join(', ') || 'Не выбраны' : `${value.length} записей`;
    if (typeof value === 'object') {
      const row = value as Record<string, unknown>;
      const label = typeof row.title === 'string' ? row.title : typeof row.partyId === 'string' ? `${resolveName(row.partyId)}${typeof row.role === 'string' ? ` · ${participantLabels[row.role as OrderParticipantRole] ?? row.role}` : ''}` : typeof row.reason === 'string' ? row.reason : sectionLabels[section] ?? 'Запись';
      const status = typeof row.status === 'string' ? ({ ...contractStatusLabels, ...changeStatusLabels, ...objectStatusLabels, ...mortgageStatusLabels, ...warrantyStatusLabels } as Record<string, string>)[row.status] ?? row.status : '';
      return `${label}${status ? ` — ${status}` : ''}${typeof row.amountCents === 'number' ? `, ${centsText(row.amountCents)}` : ''}${Array.isArray(row.specifications) ? ` · версий комплектации: ${row.specifications.length}` : ''}`;
    }
    return String(value);
  };
  return <div className="customer-orders__history-change"><strong>{sectionLabels[section] ?? 'Сведения'}</strong><span>{before == null ? 'Добавлено' : after == null ? 'Удалено' : valueText(before)}{after == null ? '' : ` → ${valueText(after)}`}</span></div>;
}

export interface CustomerOrdersPageProps {
  state: AppState;
  session: AuthenticatedUser;
  onChange: StateChangeSink;
  onNavigate: (page: PageId, entityId?: string) => void;
  onOpenProject: (projectId: string, page?: PageId) => void;
  onCreateOrder: (customerId?: string) => void;
  syncPhase?: string;
  focusId?: string | null;
}

export function CustomerOrdersPage({ state, session, onChange, onNavigate, onOpenProject, onCreateOrder, syncPhase, focusId }: CustomerOrdersPageProps) {
  const [directory, setDirectory] = useState<OrderDirectoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [reload, setReload] = useState(0);
  const [mode, setMode] = useState<'directory' | 'order'>('directory');
  const [tab, setTab] = useState<OrderTab>('participants');
  const [query, setQuery] = useState('');
  const [customersOnly, setCustomersOnly] = useState(false);
  const [selectedId, setSelectedId] = useState(state.orderRelations?.customerId ?? '');
  const [editor, setEditor] = useState<Editor | null>(null);
  const [notice, setNotice] = useState('');
  const stateRef = useRef(state), phaseRef = useRef(syncPhase), activeProject = useRef(state.project.id), writeControllers = useRef(new Set<AbortController>());
  stateRef.current = state; phaseRef.current = syncPhase; activeProject.current = state.project.id;
  const relations = state.orderRelations ?? emptyOrderRelations();

  useEffect(() => {
    const controller = new AbortController();
    if (session.role !== 'management') { setLoading(false); return () => controller.abort(); }
    setLoading(true); setLoadError('');
    fetchOrderDirectory(state.project.id, controller.signal).then(response => {
      if (controller.signal.aborted) return;
      setDirectory(response);
      setSelectedId(previous => response.records.some(record => record.kind === 'party' && record.id === previous) ? previous
        : stateRef.current.orderRelations?.customerId ?? response.records.find(record => record.kind === 'party')?.id ?? '');
    }).catch(error => {
      if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : 'Не удалось загрузить заказчиков. Повторите запрос.');
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [state.project.id, session.role, session.email, reload]);

  useEffect(() => {
    setEditor(null); setNotice(''); setDirectory(null); setSelectedId(stateRef.current.orderRelations?.customerId ?? '');
    return () => { writeControllers.current.forEach(controller => controller.abort()); writeControllers.current.clear(); };
  }, [state.project.id]);

  useEffect(() => {
    if (!focusId) return;
    if (directory?.records.some(record => record.id === focusId && record.kind === 'party')) { setSelectedId(focusId); setMode('directory'); return; }
    const current = stateRef.current.orderRelations;
    const collection: [OrderTab, { id: string }[] | undefined][] = [['objects', current?.objects], ['contracts', current?.contracts], ['financing', current?.mortgages], ['changes', current?.changeRequests], ['warranty', current?.warrantyCases], ['participants', current?.participants], ['links', current?.links]];
    const found = collection.find(([, rows]) => rows?.some(row => row.id === focusId));
    if (found) { setTab(found[0]); setMode('order'); }
  }, [focusId, directory]);

  const parties = useMemo(() => (directory?.records ?? []).filter((record): record is PartyRecord => record.kind === 'party').sort((a, b) => a.data.name.localeCompare(b.data.name, 'ru')), [directory]);
  const plots = useMemo(() => (directory?.records ?? []).filter((record): record is PlotRecord => record.kind === 'plot'), [directory]);
  const assets = useMemo(() => (directory?.records ?? []).filter((record): record is AssetRecord => record.kind === 'asset'), [directory]);
  const agreements = useMemo(() => (directory?.records ?? []).filter((record): record is AgreementRecord => record.kind === 'agreement'), [directory]);
  const recordMap = useMemo(() => new Map((directory?.records ?? []).map(record => [record.id, record])), [directory]);
  const partyName = (partyId?: string) => partyId ? recordMap.get(partyId)?.data.name ?? 'Контакт недоступен' : 'Не указан';
  const objectName = (objectId?: string) => relations.objects.find(row => row.id === objectId)?.title ?? 'Объект не указан';
  const partyOptions = parties.map(record => ({ value: record.id, label: record.data.name }));
  const objectOptions = relations.objects.map(row => ({ value: row.id, label: row.title }));
  const orders = useMemo(() => {
    const currentRelations = state.orderRelations;
    const currentPlots = [...new Set([...(currentRelations?.plotIds ?? []), ...(currentRelations?.objects ?? []).flatMap(scope => {
      const asset = recordMap.get(scope.assetId); return asset?.kind === 'asset' && asset.data.plotId ? [asset.data.plotId] : [];
    })])];
    const currentParties = [...new Set([
      ...(currentRelations?.participants.map(row => row.partyId) ?? []), ...(currentRelations?.contracts.flatMap(row => row.partyIds) ?? []),
      ...(currentRelations?.mortgages.flatMap(row => [...row.borrowerPartyIds, ...(row.bankPartyId ? [row.bankPartyId] : [])]) ?? []),
      ...currentPlots.flatMap(plotId => { const plot = recordMap.get(plotId); return plot?.kind === 'plot' ? plot.data.ownerPartyIds ?? [] : []; }),
    ])];
    const current = {
      id: state.project.id, code: state.project.code, name: state.project.name,
      status: state.orderRelations?.status ?? state.project.status ?? 'active',
      revision: directory?.orders.find(row => row.id === state.project.id)?.revision ?? 0,
      customerId: state.orderRelations?.customerId, mode: state.orderRelations?.mode,
      participantPartyIds: currentParties,
      assetIds: state.orderRelations?.objects.map(row => row.assetId) ?? [], plotIds: currentPlots,
      contractValue: state.project.unknownFields?.includes('contractValue') ? null : state.project.contractValue,
    };
    return [...(directory?.orders ?? []).filter(row => row.id !== current.id), current];
  }, [directory, state.project, state.orderRelations, recordMap]);
  const customerIds = new Set(orders.map(row => row.customerId).filter(Boolean));
  const searchValue = query.trim().toLocaleLowerCase('ru');
  const visibleParties = parties.filter(record => (!customersOnly || customerIds.has(record.id)) && (!searchValue || [record.data.name, record.data.legalName, record.data.phone, record.data.email, record.data.inn].filter(Boolean).join(' ').toLocaleLowerCase('ru').includes(searchValue)));
  const selected = parties.find(record => record.id === selectedId);
  const selectedOrders = orders.filter(row => row.customerId === selectedId);
  const participatingOrders = orders.filter(row => row.customerId !== selectedId && row.participantPartyIds.includes(selectedId));
  const totals = orderContractTotals(relations);
  const editsBlocked = loading || !directory || ['loading', 'saving', 'offline', 'conflict'].includes(syncPhase ?? '');
  const relationsBlocked = editsBlocked || !state.orderRelations;
  const requiredReason = (values: OrderEditorValues) => { const reason = values.saveReason?.trim(); if (!reason) throw new Error('Укажите основание записи.'); return reason; };

  const openRelationEditor = (configuration: Omit<Editor, 'id' | 'onSubmit'>, mutate: (next: OrderRelationsState, values: OrderEditorValues) => void) => {
    const expected = orderRelationsFingerprint(stateRef.current);
    setEditor({ ...configuration, id: id(), fields: [...configuration.fields, reasonField], onSubmit: values => {
      if (['loading', 'saving', 'offline', 'conflict'].includes(phaseRef.current ?? '')) throw new Error('Дождитесь подтверждения синхронизации заказа. Если есть конфликт, сначала разрешите его через статус сохранения.');
      const current = stateRef.current;
      const next = structuredClone(current.orderRelations ?? emptyOrderRelations());
      mutate(next, values);
      commitOrderRelationsProject(current, next, session, requiredReason(values), expected, onChange);
      setEditor(null); setNotice('Изменение передано на сохранение. Подтверждение сервера появится в статусе синхронизации заказа.');
    } });
  };

  const saveDirectory = async (input: OrderDirectoryWrite) => {
    const projectId = stateRef.current.project.id, controller = new AbortController();
    writeControllers.current.add(controller);
    try {
      const response = await saveOrderDirectoryRecord(projectId, input, controller.signal);
      if (controller.signal.aborted || activeProject.current !== projectId) return;
      setDirectory(response); setEditor(null); setLoadError('');
      if (input.record.kind === 'party') setSelectedId(input.record.id);
      setNotice(input.record.kind === 'party' ? 'Контакт сохранён. При необходимости свяжите его с заказом или добавьте ему роль участника.' : 'Общая карточка сохранена. Теперь её можно выбрать в текущем заказе.');
    } finally { writeControllers.current.delete(controller); }
  };

  const openParty = (record?: PartyRecord) => {
    if (record && !record.canEdit) return;
    const data = record?.data, recordId = record?.id ?? id();
    setEditor({ id: id(), title: record ? 'Изменить контакт' : 'Новый контакт', subtitle: 'Карточка используется во всех доступных связанных заказах. Совпадение имени или телефона не объединяет контакты.',
      fields: [
        { name: 'name', label: 'Имя или название', required: true, maxLength: 300 },
        { name: 'partyType', label: 'Тип контакта', type: 'select', required: true, options: options({ person: 'Человек', company: 'Организация' }) },
        { name: 'phone', label: 'Телефон', type: 'tel', maxLength: 80 }, { name: 'email', label: 'Электронная почта', type: 'email', maxLength: 240 },
        { name: 'legalName', label: 'Полное наименование', maxLength: 500 }, { name: 'inn', label: 'ИНН', maxLength: 20 }, sourceField,
        { name: 'notes', label: 'Примечания', type: 'textarea' }, reasonField,
      ],
      initialValues: { name: data?.name ?? '', partyType: data?.partyType ?? 'person', phone: data?.phone ?? '', email: data?.email ?? '', legalName: data?.legalName ?? '', inn: data?.inn ?? '', source: data?.source ?? '', notes: data?.notes ?? '', saveReason: '' },
      renderHint: values => {
        const name = values.name.trim().toLocaleLowerCase('ru'), phone = values.phone.replace(/\D/g, ''), email = values.email.trim().toLocaleLowerCase('ru');
        const matches = parties.filter(row => row.id !== recordId && (name && row.data.name.trim().toLocaleLowerCase('ru') === name || phone.length > 5 && row.data.phone?.replace(/\D/g, '') === phone || email && row.data.email?.toLocaleLowerCase('ru') === email));
        return matches.length ? <FormNote>Есть похожие контакты: {matches.map(row => row.data.name).join(', ')}. Проверьте список; при сохранении будет отдельная карточка.</FormNote> : null;
      },
      onSubmit: values => saveDirectory({ record: { id: recordId, kind: 'party', data: { name: values.name.trim(), partyType: values.partyType as 'person' | 'company', phone: textValue(values.phone), email: textValue(values.email), legalName: textValue(values.legalName), inn: textValue(values.inn), source: textValue(values.source), notes: textValue(values.notes) } }, expectedRevision: record?.revision ?? 0, reason: requiredReason(values) }),
    });
  };

  const openPlot = (record?: PlotRecord) => {
    if (record && !record.canEdit) return;
    const data = record?.data, recordId = record?.id ?? id();
    setEditor({ id: id(), title: record ? 'Карточка участка' : 'Новый участок', subtitle: 'Общий участок можно использовать в следующих заказах. Указанные здесь параметры относятся к самой земле.',
      fields: [{ name: 'name', label: 'Название участка', required: true, maxLength: 300 }, { name: 'cadastralNumber', label: 'Кадастровый номер', maxLength: 100 },
        { name: 'address', label: 'Адрес', fullWidth: true }, { name: 'areaSqm', label: 'Площадь, м²', type: 'number', min: 0 },
        { name: 'ownerPartyIds', label: 'Собственники', type: 'multi', options: partyOptions },
        { name: 'communications', label: 'Коммуникации', type: 'textarea' }, { name: 'constraints', label: 'Ограничения и условия', type: 'textarea' }, sourceField,
        { name: 'notes', label: 'Примечания', type: 'textarea' }, reasonField],
      initialValues: { name: data?.name ?? '', cadastralNumber: data?.cadastralNumber ?? '', address: data?.address ?? '', areaSqm: stringNumber(data?.areaSqm), ownerPartyIds: data?.ownerPartyIds?.join('|') ?? '', communications: data?.communications ?? '', constraints: data?.constraints ?? '', source: data?.source ?? '', notes: data?.notes ?? '', saveReason: '' },
      onSubmit: values => saveDirectory({ record: { id: recordId, kind: 'plot', data: { name: values.name.trim(), cadastralNumber: textValue(values.cadastralNumber), address: textValue(values.address), areaSqm: orderNumberInput(values.areaSqm, 'Площадь участка'), ownerPartyIds: orderSelectedIds(values.ownerPartyIds), communications: textValue(values.communications), constraints: textValue(values.constraints), source: textValue(values.source), notes: textValue(values.notes) } }, expectedRevision: record?.revision ?? 0, reason: requiredReason(values) }),
    });
  };

  const openAsset = (record?: AssetRecord) => {
    if (record && !record.canEdit) return;
    const data = record?.data, recordId = record?.id ?? id();
    setEditor({ id: id(), title: record ? 'Карточка физического объекта' : 'Новый физический объект', subtitle: 'Для повторного заказа выбирайте существующий дом. Комплектация и состав работ задаются отдельно для каждого заказа.',
      fields: [{ name: 'name', label: 'Название объекта', required: true, maxLength: 300 }, { name: 'assetType', label: 'Тип', type: 'select', required: true, options: options(assetTypeLabels) },
        { name: 'plotId', label: 'Участок', type: 'select', options: plots.map(row => ({ value: row.id, label: row.data.name })) },
        { name: 'houseAreaSqm', label: 'Площадь здания, м²', type: 'number', min: 0 }, { name: 'terraceAreaSqm', label: 'Площадь террасы, м²', type: 'number', min: 0 },
        { name: 'floors', label: 'Этажей', type: 'number', min: 1, max: 200, step: '1' }, { name: 'technology', label: 'Технология строительства' }, sourceField,
        { name: 'notes', label: 'Примечания', type: 'textarea' }, reasonField],
      initialValues: { name: data?.name ?? '', assetType: data?.assetType ?? 'house', plotId: data?.plotId ?? '', houseAreaSqm: stringNumber(data?.houseAreaSqm), terraceAreaSqm: stringNumber(data?.terraceAreaSqm), floors: stringNumber(data?.floors), technology: data?.technology ?? '', source: data?.source ?? '', notes: data?.notes ?? '', saveReason: '' },
      onSubmit: values => saveDirectory({ record: { id: recordId, kind: 'asset', data: { name: values.name.trim(), assetType: values.assetType as 'house' | 'bath' | 'garage' | 'other', plotId: textValue(values.plotId), houseAreaSqm: orderNumberInput(values.houseAreaSqm, 'Площадь здания'), terraceAreaSqm: orderNumberInput(values.terraceAreaSqm, 'Площадь террасы'), floors: orderNumberInput(values.floors, 'Этажей', { integer: true }), technology: textValue(values.technology), source: textValue(values.source), notes: textValue(values.notes) } }, expectedRevision: record?.revision ?? 0, reason: requiredReason(values) }),
    });
  };

  const openOrderSettings = (customerId?: string) => {
    const transitionMap: Record<OrderStatus, OrderStatus[]> = { draft: ['draft', 'active', 'on_hold', 'canceled'], active: ['active', 'on_hold', 'completed', 'canceled'], on_hold: ['on_hold', 'active', 'completed', 'canceled'], completed: ['completed', 'active'], canceled: ['canceled'] };
    const customerLocked = relations.contracts.some(row => row.kind === 'customer' && row.status !== 'draft');
    const initial = !state.orderRelations;
    const initialStatus: OrderStatus = initial ? state.project.status === 'completed' ? 'completed' : state.project.status === 'archived' ? 'canceled' : state.project.status === 'active' || !state.project.status ? 'active' : 'draft' : relations.status;
    const initialScopeId = id();
    openRelationEditor({ title: 'Сведения о текущем заказе', subtitle: state.project.name,
      summary: initial ? <FormNote>Подключите существующий заказ явно. Его текущий статус — {orderStatusLabels[initialStatus]}. Для заказа в работе выберите заказчика и участок или объект. Для завершённого заказа нужны объект и фактические даты работ.</FormNote> : undefined,
      fields: [{ name: 'customerId', label: 'Основной заказчик', type: 'select', options: partyOptions, disabled: customerLocked, hint: customerLocked ? 'Заказчик подписанного заказа защищён. Для новой стороны создайте отдельный заказ.' : 'Контакт выбирается явно; имя в старой карточке проекта само по себе не создаёт связь.' },
        { name: 'mode', label: 'Вид заказа', type: 'select', required: true, options: options(modeLabels) },
        { name: 'status', label: 'Статус заказа', type: 'select', required: true, options: (initial ? [initialStatus] : transitionMap[relations.status]).map(value => ({ value, label: orderStatusLabels[value] })) },
        ...(initial ? [
          { name: 'initialPlotIds', label: 'Участки текущего заказа', type: 'multi' as const, options: plots.map(plot => ({ value: plot.id, label: plot.data.name })) },
          { name: 'initialAssetId', label: 'Физический объект', type: 'select' as const, options: assets.map(asset => ({ value: asset.id, label: asset.data.name })) },
          { name: 'initialObjectTitle', label: 'Название работ по объекту', maxLength: 300 },
          { name: 'initialActualStart', label: 'Фактическое начало работ по объекту', type: 'date' as const },
          { name: 'initialActualEnd', label: 'Фактическое завершение работ по объекту', type: 'date' as const },
        ] : [])],
      initialValues: { customerId: customerLocked ? relations.customerId ?? '' : customerId ?? relations.customerId ?? '', mode: relations.mode, status: initialStatus, initialPlotIds: '', initialAssetId: '', initialObjectTitle: '', initialActualStart: '', initialActualEnd: '', saveReason: '' },
    }, (next, values) => {
      next.customerId = textValue(values.customerId); next.mode = values.mode as OrderMode; next.status = values.status as OrderStatus;
      if (initial) {
        next.plotIds = orderSelectedIds(values.initialPlotIds);
        if (values.initialAssetId) {
          if (!values.initialObjectTitle.trim()) throw new Error('Укажите название работ по выбранному объекту.');
          next.objects.push({ id: initialScopeId, assetId: values.initialAssetId, title: values.initialObjectTitle.trim(), status: next.status === 'completed' ? 'completed' : next.status === 'active' ? 'active' : next.status === 'canceled' ? 'canceled' : 'planned', specifications: [], actualStart: textValue(values.initialActualStart), actualEnd: textValue(values.initialActualEnd) });
        }
      }
    });
  };

  const openParticipant = (row?: OrderParticipant) => {
    const rowId = row?.id ?? id();
    openRelationEditor({ title: row ? 'Роль участника' : 'Добавить участника',
      fields: [{ name: 'partyId', label: 'Контакт', type: 'select', required: true, options: partyOptions }, { name: 'role', label: 'Роль в заказе', type: 'select', required: true, options: options(participantLabels) },
        { name: 'projectCounterpartyId', label: 'Карточка в разделе подрядчиков', type: 'select', options: state.counterparties.map(item => ({ value: item.id, label: item.name })), hint: 'Связь с существующей карточкой подрядчика или поставщика этого заказа.' },
        { name: 'notes', label: 'Зона ответственности / условия', type: 'textarea' }],
      initialValues: { partyId: row?.partyId ?? '', role: row?.role ?? 'customer', projectCounterpartyId: row?.projectCounterpartyId ?? '', notes: row?.notes ?? '', saveReason: '' },
    }, (next, values) => { next.participants = put(next.participants, { id: rowId, partyId: values.partyId, role: values.role as OrderParticipantRole, projectCounterpartyId: textValue(values.projectCounterpartyId), notes: textValue(values.notes) }); });
  };

  const openPlotLinks = () => openRelationEditor({ title: 'Участки текущего заказа',
    fields: [{ name: 'plotIds', label: 'Связанные участки', type: 'multi', options: plots.map(row => ({ value: row.id, label: row.data.name })), hint: 'Один участок можно связать с несколькими заказами.' }], initialValues: { plotIds: relations.plotIds.join('|'), saveReason: '' },
  }, (next, values) => { next.plotIds = orderSelectedIds(values.plotIds); });

  const openObject = (row?: OrderObjectScope) => {
    const rowId = row?.id ?? id(), available = assets.filter(asset => row?.assetId === asset.id || !relations.objects.some(item => item.assetId === asset.id));
    const statuses = row?.status === 'completed' || row?.status === 'canceled' ? [row.status] : row?.status === 'active' ? ['active', 'completed', 'canceled'] : ['planned', 'active', 'completed', 'canceled'];
    openRelationEditor({ title: row ? 'Работы по объекту' : 'Добавить объект в заказ', subtitle: 'Физический объект остаётся общим. Состав работ и его версии относятся к текущему заказу.',
      fields: [{ name: 'assetId', label: 'Физический объект', type: 'select', required: true, disabled: Boolean(row), options: available.map(asset => ({ value: asset.id, label: asset.data.name })) },
        { name: 'title', label: 'Работы в рамках этого заказа', required: true, maxLength: 300, placeholder: 'Например: строительство дома или устройство террасы' },
        { name: 'status', label: 'Статус работ', type: 'select', required: true, options: statuses.map(value => ({ value, label: objectStatusLabels[value as keyof typeof objectStatusLabels] })) },
        { name: 'actualStart', label: 'Фактическое начало', type: 'date', disabled: Boolean(row?.actualStart) }, { name: 'actualEnd', label: 'Фактическое завершение', type: 'date', disabled: Boolean(row?.actualEnd) }],
      initialValues: { assetId: row?.assetId ?? '', title: row?.title ?? '', status: row?.status ?? 'planned', actualStart: row?.actualStart ?? '', actualEnd: row?.actualEnd ?? '', saveReason: '' },
    }, (next, values) => { next.objects = put(next.objects, { ...(row ?? { specifications: [] }), id: rowId, assetId: values.assetId, title: values.title.trim(), status: values.status as OrderObjectScope['status'], actualStart: textValue(values.actualStart), actualEnd: textValue(values.actualEnd) }); });
  };

  const openSpecification = (scope: OrderObjectScope, draft?: OrderSpecification, preselectedChange?: string) => {
    const previous = draft ?? scope.specifications.find(spec => spec.id === scope.activeSpecificationId) ?? scope.specifications.at(-1);
    const specId = draft?.id ?? id(), version = draft?.version ?? scope.specifications.length + 1;
    openRelationEditor({ title: `${draft ? 'Комплектация' : 'Новая комплектация'} · версия ${version}`, subtitle: scope.title,
      summary: <FormNote>При утверждении эта версия станет действующей. Предыдущие утверждённые условия сохранятся. Для версии после первой требуется согласованное изменение.</FormNote>,
      fields: [{ name: 'title', label: 'Название комплектации', required: true, maxLength: 300 }, { name: 'status', label: 'Состояние', type: 'select', required: true, options: options({ draft: 'Черновик', approved: 'Утвердить и применять' }) },
        { name: 'scope', label: 'Состав работ и включённые условия', type: 'textarea', required: true }, { name: 'model', label: 'Проект / модель' },
        { name: 'houseAreaSqm', label: 'Площадь здания по договору, м²', type: 'number', min: 0 }, { name: 'terraceAreaSqm', label: 'Площадь террасы по договору, м²', type: 'number', min: 0 },
        { name: 'floors', label: 'Этажей', type: 'number', min: 1, max: 200, step: '1' }, { name: 'technology', label: 'Технология' }, { name: 'finish', label: 'Отделка / готовность' },
        { name: 'plannedStart', label: 'Начало по условиям заказа', type: 'date' }, { name: 'plannedEnd', label: 'Завершение по условиям заказа', type: 'date' },
        { name: 'changeRequestId', label: 'Утверждённое изменение', type: 'select', options: approvedChanges(relations, scope.id) }, sourceField, docField(state)],
      initialValues: { title: previous?.title ?? 'Основная комплектация', status: draft?.status ?? 'draft', scope: previous?.scope ?? '', model: previous?.model ?? '', houseAreaSqm: stringNumber(previous?.houseAreaSqm), terraceAreaSqm: stringNumber(previous?.terraceAreaSqm), floors: stringNumber(previous?.floors), technology: previous?.technology ?? '', finish: previous?.finish ?? '', plannedStart: previous?.plannedStart ?? '', plannedEnd: previous?.plannedEnd ?? '', changeRequestId: preselectedChange ?? draft?.changeRequestId ?? '', source: draft?.source ?? '', documentIds: draft?.documentIds.join('|') ?? '', saveReason: '' },
    }, (next, values) => {
      const specification: OrderSpecification = { ...(draft ?? {}), id: specId, version, title: values.title.trim(), scope: values.scope.trim(), status: values.status as OrderSpecification['status'], model: textValue(values.model), houseAreaSqm: orderNumberInput(values.houseAreaSqm, 'Площадь здания'), terraceAreaSqm: orderNumberInput(values.terraceAreaSqm, 'Площадь террасы'), floors: orderNumberInput(values.floors, 'Этажей', { integer: true }), technology: textValue(values.technology), finish: textValue(values.finish), plannedStart: textValue(values.plannedStart), plannedEnd: textValue(values.plannedEnd), source: textValue(values.source), documentIds: orderSelectedIds(values.documentIds), changeRequestId: textValue(values.changeRequestId) };
      next.objects = next.objects.map(item => item.id === scope.id ? { ...item, specifications: put(item.specifications, specification), ...(specification.status === 'approved' ? { activeSpecificationId: specification.id } : {}) } : item);
    });
  };

  const openAgreement = (record?: AgreementRecord) => {
    if (record && (!record.canEdit || record.data.status === 'signed')) return;
    const data = record?.data, recordId = record?.id ?? id();
    const evidence = state.documents.filter(document => document.category === 'contract' && document.status === 'signed' && (document.fileKey || document.storageLocation));
    setEditor({ id: id(), title: record ? 'Общий договор подрядчика' : 'Новый общий договор подрядчика', subtitle: 'Одна полная сумма и подписанные условия для нескольких заказов. Доли каждого заказа задаются отдельно.',
      fields: [{ name: 'name', label: 'Название общего договора', required: true, maxLength: 300 }, { name: 'number', label: 'Номер договора' },
        { name: 'status', label: 'Состояние', type: 'select', required: true, options: options({ draft: 'Черновик', signed: 'Подписан' }) },
        { name: 'totalAmount', label: 'Полная сумма по всем заказам, ₽', type: 'money', hint: 'Пусто — сумма ещё не определена. После подписания она защищена.' },
        { name: 'partyIds', label: 'Стороны общего договора', type: 'multi', options: partyOptions },
        { name: 'signedDate', label: 'Дата подписания', type: 'date' }, { name: 'effectiveDate', label: 'Начало действия', type: 'date' }, { name: 'endDate', label: 'Окончание действия', type: 'date' },
        { ...docField(state), options: evidence.map(document => ({ value: document.id, label: document.name })), hint: 'Для подписания выберите документ из этого заказа: категория «Договор», статус «Подписан», с файлом или указанным местом хранения.' }, sourceField,
        { name: 'notes', label: 'Условия и примечания', type: 'textarea' }, reasonField],
      initialValues: { name: data?.name ?? '', number: data?.number ?? '', status: data?.status ?? 'draft', totalAmount: orderMoneyField(data?.totalAmountCents), partyIds: data?.partyIds.join('|') ?? '', signedDate: data?.signedDate ?? '', effectiveDate: data?.effectiveDate ?? '', endDate: data?.endDate ?? '', documentIds: data?.documentIds?.join('|') ?? '', source: data?.source ?? '', notes: data?.notes ?? '', saveReason: '' },
      summary: <FormNote>После подписания общие условия сохраняются без редактирования. Подписанный документ хранится в заказе, из которого создана эта карточка.</FormNote>,
      onSubmit: values => saveDirectory({ record: { id: recordId, kind: 'agreement', data: { name: values.name.trim(), number: textValue(values.number), status: values.status as 'draft' | 'signed', totalAmountCents: orderMoneyInput(values.totalAmount, { required: values.status === 'signed' }), currency: 'RUB', partyIds: orderSelectedIds(values.partyIds), signedDate: textValue(values.signedDate), effectiveDate: textValue(values.effectiveDate), endDate: textValue(values.endDate), documentIds: orderSelectedIds(values.documentIds), source: textValue(values.source), notes: textValue(values.notes) } }, expectedRevision: record?.revision ?? 0, reason: requiredReason(values) }),
    });
  };

  const openContract = (draft?: OrderContract, previous?: OrderContract) => {
    const base = draft ?? previous, contractId = draft?.id ?? id();
    const masterFrom = (values: OrderEditorValues) => agreements.find(record => record.id === values.sharedAgreementId)?.data;
    const shared = (values: OrderEditorValues) => Boolean(values.sharedAgreementId);
    openRelationEditor({ title: previous ? 'Новая версия договора' : draft ? 'Договор' : 'Новый договор',
      summary: <FormNote>{previous ? `Договор «${previous.title}» останется в истории. Укажите полную итоговую сумму новой версии, включая прежние условия. ` : ''}Для подписанного договора обязательны стороны, сумма, документ, дата подписания и источник. Суммы договоров разных типов учитываются отдельно.</FormNote>,
      fields: [{ name: 'sharedAgreementId', label: 'Общий договор подрядчика', type: 'select', disabled: Boolean(previous), options: agreements.map(record => ({ value: record.id, label: `${record.data.name} · ${record.data.status === 'signed' ? 'подписан' : 'черновик'}` })), hint: 'Выберите, если один договор подрядчика охватывает несколько заказов. Полная сумма хранится в общей карточке.', fullWidth: true },
        { name: 'title', label: 'Название договора / работ в этом заказе', required: true, maxLength: 300 }, { name: 'number', label: 'Номер договора', disabledWhen: shared, valueFrom: values => masterFrom(values) ? masterFrom(values)!.number ?? '' : undefined },
        { name: 'kind', label: 'Тип договора', type: 'select', required: true, disabled: Boolean(previous || draft?.supersedesId), disabledWhen: shared, valueFrom: values => shared(values) ? 'supplier' : undefined, options: options(contractKindLabels) },
        { name: 'status', label: 'Состояние', type: 'select', required: true, options: options({ draft: 'Черновик', signed: 'Подписан' }) },
        { name: 'amount', label: 'Сумма по текущему заказу, ₽', type: 'money', hint: 'Для общего договора — только доля этого заказа. Для отдельного — полная сумма. Пусто — неизвестно, ноль — явно согласованная нулевая сумма.' },
        { name: 'partyIds', label: 'Стороны договора', type: 'multi', options: partyOptions, disabledWhen: shared, valueFrom: values => masterFrom(values)?.partyIds.join('|') }, { name: 'objectIds', label: 'Объекты договора', type: 'multi', options: objectOptions },
        { name: 'signedDate', label: 'Дата подписания', type: 'date', disabledWhen: shared, valueFrom: values => masterFrom(values) ? masterFrom(values)!.signedDate ?? '' : undefined }, { name: 'effectiveDate', label: 'Начало действия', type: 'date', disabledWhen: shared, valueFrom: values => masterFrom(values) ? masterFrom(values)!.effectiveDate ?? '' : undefined }, { name: 'endDate', label: 'Окончание действия', type: 'date', disabledWhen: shared, valueFrom: values => masterFrom(values) ? masterFrom(values)!.endDate ?? '' : undefined },
        { name: 'changeRequestId', label: 'Утверждённое изменение', type: 'select', options: approvedChanges(relations), hint: 'Обязательно при подписании новой версии существующего договора.' }, sourceField, docField(state)],
      initialValues: { sharedAgreementId: base?.sharedAgreementId ?? '', title: base?.title ?? '', number: base?.number ?? '', kind: base?.kind ?? 'customer', status: draft?.status ?? 'draft', amount: orderMoneyField(base?.amountCents), partyIds: base?.partyIds.join('|') ?? relations.customerId ?? '', objectIds: base?.objectIds.join('|') ?? '', signedDate: draft?.signedDate ?? '', effectiveDate: base?.effectiveDate ?? '', endDate: base?.endDate ?? '', changeRequestId: draft?.changeRequestId ?? '', source: draft?.source ?? '', documentIds: draft?.documentIds.join('|') ?? '', saveReason: '' },
      renderHint: values => { const master = masterFrom(values); return master ? <FormNote>Общий договор: {master.name}. Полная сумма: {agreements.find(record => record.id === values.sharedAgreementId)?.limitedScope ? 'доступна сотруднику с правами на все связанные заказы' : centsText(master.totalAmountCents)}. {master.status === 'signed' ? 'Подписан' : 'Пока не подписан — сохраните долю как черновик'}. Введите только сумму, относящуюся к этому заказу. Условия сторон и даты берутся из общей карточки.</FormNote> : null; },
    }, (next, values) => {
      const master = masterFrom(values);
      if (values.sharedAgreementId && !master) throw new Error('Общий договор недоступен. Обновите справочник и повторите выбор.');
      const row: OrderContract = { ...(draft ?? {}), id: contractId, title: values.title.trim(), sharedAgreementId: textValue(values.sharedAgreementId), number: master ? master.number : textValue(values.number), kind: master ? 'supplier' : values.kind as OrderContract['kind'], status: values.status as OrderContract['status'], amountCents: orderMoneyInput(values.amount, { required: values.status === 'signed' }), currency: 'RUB', partyIds: master ? [...master.partyIds] : orderSelectedIds(values.partyIds), objectIds: orderSelectedIds(values.objectIds), signedDate: master ? master.signedDate : textValue(values.signedDate), effectiveDate: master ? master.effectiveDate : textValue(values.effectiveDate), endDate: master ? master.endDate : textValue(values.endDate), changeRequestId: textValue(values.changeRequestId), source: textValue(values.source), documentIds: orderSelectedIds(values.documentIds), supersedesId: previous?.id ?? draft?.supersedesId };
      next.contracts = put(next.contracts, row);
    });
  };

  const closeContract = (row: OrderContract) => openRelationEditor({ title: 'Завершить договор', subtitle: row.title,
    summary: <FormNote>Подписанные условия сохраняются. Платежи, задолженность и возвраты ведутся в разделе «Финансы» и не исчезают после закрытия договора.</FormNote>,
    fields: [{ name: 'status', label: 'Результат', type: 'select', required: true, options: options({ completed: 'Договор исполнен', terminated: 'Договор расторгнут' }) },
      { name: 'closedReason', label: 'Основание закрытия', type: 'textarea', required: true }, { name: 'closureChangeId', label: 'Согласованное расторжение', type: 'select', options: approvedChanges(relations), hint: 'Обязательно при расторжении.' }],
    initialValues: { status: 'completed', closedReason: '', closureChangeId: '', saveReason: '' },
  }, (next, values) => { next.contracts = next.contracts.map(item => item.id === row.id ? { ...item, status: values.status as 'completed' | 'terminated', closedReason: values.closedReason.trim(), closureChangeId: values.status === 'terminated' ? textValue(values.closureChangeId) : undefined } : item); });

  const openContractPricing = () => {
    const preview = orderContractValueCents({ ...relations, contractPricing: true });
    openRelationEditor({ title: 'Источник цены заказа',
      summary: <FormNote>Цена в карточке проекта сейчас: {state.project.unknownFields?.includes('contractValue') ? 'не указана' : money(state.project.contractValue)}. По действующим подписанным договорам с заказчиком: {centsText(preview)}. Подрядные и кредитные договоры в цену продажи не входят.</FormNote>,
      fields: [{ name: 'contractPricing', label: 'Определять цену заказа по подписанным договорам с заказчиком', type: 'checkbox', hint: 'После включения подписанные новые версии договоров будут обновлять цену в существующей карточке проекта.' }],
      initialValues: { contractPricing: relations.contractPricing ? 'true' : '', saveReason: '' },
    }, (next, values) => { next.contractPricing = values.contractPricing === 'true'; });
  };

  const openChange = (row?: OrderChangeRequest) => {
    const changeId = row?.id ?? id();
    const statuses = row?.status === 'submitted' ? ['submitted', 'approved', 'rejected'] : ['draft', 'submitted', 'approved', 'rejected'];
    openRelationEditor({ title: row ? 'Согласование изменения' : 'Новое изменение заказа',
      summary: <FormNote>Укажите влияние на цену, себестоимость и срок отдельно. Утверждение фиксирует решение; новые условия договора и комплектации оформляются следующими версиями.</FormNote>,
      fields: [{ name: 'title', label: 'Что меняется', required: true, maxLength: 300 }, { name: 'status', label: 'Состояние', type: 'select', required: true, options: statuses.map(value => ({ value, label: changeStatusLabels[value as keyof typeof changeStatusLabels] })) },
        { name: 'reason', label: 'Причина и содержание изменения', type: 'textarea', required: true }, { name: 'objectIds', label: 'Затронутые объекты', type: 'multi', options: objectOptions, hint: 'Если не выбраны, изменение относится ко всему заказу.' },
        { name: 'priceDelta', label: 'Изменение цены для заказчика, ₽', type: 'money', hint: 'Минус уменьшает цену. Пусто — влияние ещё не оценено.' },
        { name: 'costDelta', label: 'Изменение себестоимости, ₽', type: 'money' }, { name: 'scheduleDeltaDays', label: 'Изменение срока, дней', type: 'number', min: -3650, max: 3650, step: '1', hint: 'Плюс — позднее, минус — раньше. Ноль — без изменения срока.' }, sourceField, docField(state)],
      initialValues: { title: row?.title ?? '', status: row?.status ?? 'draft', reason: row?.reason ?? '', objectIds: row?.objectIds.join('|') ?? '', priceDelta: orderMoneyField(row?.priceDeltaCents), costDelta: orderMoneyField(row?.costDeltaCents), scheduleDeltaDays: stringNumber(row?.scheduleDeltaDays), source: row?.source ?? '', documentIds: row?.documentIds.join('|') ?? '', saveReason: '' },
    }, (next, values) => { next.changeRequests = put(next.changeRequests, { ...(row ?? {}), id: changeId, title: values.title.trim(), status: values.status as OrderChangeRequest['status'], reason: values.reason.trim(), objectIds: orderSelectedIds(values.objectIds), priceDeltaCents: orderMoneyInput(values.priceDelta, { signed: true }), costDeltaCents: orderMoneyInput(values.costDelta, { signed: true }), scheduleDeltaDays: orderNumberInput(values.scheduleDeltaDays, 'Изменение срока', { signed: true, integer: true }), source: textValue(values.source), documentIds: orderSelectedIds(values.documentIds) }); });
  };

  const applyChange = (row: OrderChangeRequest) => openRelationEditor({ title: 'Зафиксировать выполнение изменения', subtitle: row.title,
    summary: <FormNote>Проверьте новые версии комплектации, договора и связанные задачи. Эта отметка сама не создаёт оплат и не меняет график работ.</FormNote>,
    fields: [{ name: 'implementationNote', label: 'Что выполнено и где зафиксирован результат', type: 'textarea', required: true }], initialValues: { implementationNote: row.implementationNote ?? '', saveReason: '' },
  }, (next, values) => { next.changeRequests = next.changeRequests.map(item => item.id === row.id ? { ...item, status: 'applied', implementationNote: values.implementationNote.trim() } : item); });

  const openMortgage = (row?: OrderMortgage) => {
    const mortgageId = row?.id ?? id();
    const lockedDecision = Boolean(row && ['approved', 'funded', 'rejected', 'canceled'].includes(row.status));
    const transitions: Record<OrderMortgage['status'], OrderMortgage['status'][]> = { draft: ['draft', 'submitted', 'approved', 'rejected', 'canceled'], submitted: ['submitted', 'approved', 'rejected', 'canceled'], approved: ['approved', 'funded', 'canceled'], rejected: ['rejected'], funded: ['funded'], canceled: ['canceled'] };
    const actualIncomes = state.financeEntries.filter(entry => entry.kind === 'income' && (paidAmountFor(entry, state) > 0 || entry.id === row?.financeEntryId));
    openRelationEditor({ title: row ? 'Ипотечная заявка' : 'Новая ипотечная заявка',
      summary: <FormNote>Одобрение и эскроу отражают условия финансирования. Деньги появляются в учёте после записи фактического поступления в разделе «Финансы». Для выданного кредита выберите это поступление.</FormNote>,
      fields: [{ name: 'program', label: 'Программа / название заявки', required: true, maxLength: 300, disabled: lockedDecision },
        { name: 'status', label: 'Состояние', type: 'select', required: true, options: transitions[row?.status ?? 'draft'].map(value => ({ value, label: mortgageStatusLabels[value] })) },
        { name: 'bankPartyId', label: 'Банк', type: 'select', options: partyOptions, disabled: lockedDecision }, { name: 'borrowerPartyIds', label: 'Заёмщики', type: 'multi', options: partyOptions, disabled: lockedDecision },
        { name: 'contractId', label: 'Связанный договор', type: 'select', options: relations.contracts.map(item => ({ value: item.id, label: item.title })), disabled: lockedDecision },
        { name: 'fundingRoute', label: 'Порядок расчётов', type: 'select', options: options({ direct: 'Прямое поступление', escrow: 'Через эскроу' }), disabled: lockedDecision },
        { name: 'requestedAmount', label: 'Запрошено, ₽', type: 'money', disabled: lockedDecision }, { name: 'approvedAmount', label: 'Одобрено банком, ₽', type: 'money', disabled: lockedDecision },
        { name: 'downPayment', label: 'Первоначальный взнос, ₽', type: 'money', disabled: lockedDecision }, { name: 'submittedDate', label: 'Дата подачи', type: 'date', disabled: lockedDecision },
        { name: 'decisionDate', label: 'Дата решения банка', type: 'date', disabled: lockedDecision }, { name: 'fundedDate', label: 'Дата выдачи', type: 'date', disabled: row?.status === 'funded' || row?.status === 'canceled' || row?.status === 'rejected' },
        { name: 'financeEntryId', label: 'Подтверждённое поступление в финансах', type: 'select', disabled: row?.status === 'funded' || row?.status === 'canceled' || row?.status === 'rejected', options: actualIncomes.map(entry => ({ value: entry.id, label: `${entry.description} · ${money(paidAmountFor(entry, state))}${paidAmountFor(entry, state) <= 0 ? ' · ранее связанное поступление' : ''}`, disabled: paidAmountFor(entry, state) <= 0 })) },
        { ...sourceField, disabled: lockedDecision }, docField(state), { name: 'notes', label: 'Комментарий', type: 'textarea' }],
      initialValues: { program: row?.program ?? '', status: row?.status ?? 'draft', bankPartyId: row?.bankPartyId ?? '', borrowerPartyIds: row?.borrowerPartyIds.join('|') ?? '', contractId: row?.contractId ?? '', fundingRoute: row?.fundingRoute ?? '', requestedAmount: orderMoneyField(row?.requestedAmountCents), approvedAmount: orderMoneyField(row?.approvedAmountCents), downPayment: orderMoneyField(row?.downPaymentCents), submittedDate: row?.submittedDate ?? '', decisionDate: row?.decisionDate ?? '', fundedDate: row?.fundedDate ?? '', financeEntryId: row?.financeEntryId ?? '', source: row?.source ?? '', documentIds: row?.documentIds.join('|') ?? '', notes: row?.notes ?? '', saveReason: '' },
    }, (next, values) => { next.mortgages = put(next.mortgages, { ...(row ?? {}), id: mortgageId, program: values.program.trim(), status: values.status as OrderMortgage['status'], bankPartyId: textValue(values.bankPartyId), borrowerPartyIds: orderSelectedIds(values.borrowerPartyIds), contractId: textValue(values.contractId), fundingRoute: textValue(values.fundingRoute) as OrderMortgage['fundingRoute'], requestedAmountCents: orderMoneyInput(values.requestedAmount), approvedAmountCents: orderMoneyInput(values.approvedAmount), downPaymentCents: orderMoneyInput(values.downPayment), submittedDate: textValue(values.submittedDate), decisionDate: textValue(values.decisionDate), fundedDate: textValue(values.fundedDate), financeEntryId: textValue(values.financeEntryId), source: textValue(values.source), documentIds: orderSelectedIds(values.documentIds), notes: textValue(values.notes) }); });
  };

  const sourceRecords = useMemo(() => [
    ...state.stages.map(row => ({ kind: 'stage' as const, id: row.id, title: row.name })),
    ...effectiveBudgetLines(state).map(row => ({ kind: 'budget' as const, id: row.id, title: row.name })),
    ...state.financeEntries.map(row => ({ kind: 'finance' as const, id: row.id, title: `${row.description} · ${money(row.amount)}` })),
    ...state.procurement.map(row => ({ kind: 'procurement' as const, id: row.id, title: row.item })),
    ...state.tasks.map(row => ({ kind: 'task' as const, id: row.id, title: row.title })),
    ...state.documents.map(row => ({ kind: 'document' as const, id: row.id, title: row.name })),
    ...state.leads.map(row => ({ kind: 'lead' as const, id: row.id, title: row.name })),
    ...state.counterparties.map(row => ({ kind: 'counterparty' as const, id: row.id, title: row.name })),
  ], [state.stages, state.budgetLines, state.treasury, state.financeEntries, state.procurement, state.tasks, state.documents, state.leads, state.counterparties]);

  const openLink = (row?: OrderLink, context?: { changeRequestId?: string; warrantyCaseId?: string; objectId?: string }) => {
    const linkId = row?.id ?? id();
    openRelationEditor({ title: row ? 'Связь с разделом заказа' : 'Связать существующую запись',
      summary: <FormNote>Выберите запись из действующего раздела заказа и укажите, к чему она относится. Финансовые суммы, задачи и этапы остаются в своих разделах.</FormNote>,
      fields: [{ name: 'sourceRecord', label: 'Запись из раздела', type: 'select', required: true, fullWidth: true, options: sourceRecords.map(item => ({ value: JSON.stringify([item.kind, item.id]), label: `${linkLabels[item.kind]} · ${item.title}` })) },
        { name: 'objectId', label: 'Объект', type: 'select', options: objectOptions }, { name: 'contractId', label: 'Договор', type: 'select', options: relations.contracts.map(item => ({ value: item.id, label: item.title })) },
        { name: 'participantId', label: 'Участник', type: 'select', options: relations.participants.map(item => ({ value: item.id, label: `${partyName(item.partyId)} · ${participantLabels[item.role]}` })) },
        { name: 'changeRequestId', label: 'Изменение заказа', type: 'select', options: relations.changeRequests.map(item => ({ value: item.id, label: item.title })) },
        { name: 'warrantyCaseId', label: 'Гарантийное обращение', type: 'select', options: relations.warrantyCases.map(item => ({ value: item.id, label: item.title })) },
        { name: 'notes', label: 'Назначение связи', type: 'textarea' }],
      initialValues: { sourceRecord: row ? JSON.stringify([row.kind, row.entityId]) : '', objectId: row?.objectId ?? context?.objectId ?? '', contractId: row?.contractId ?? '', participantId: row?.participantId ?? '', changeRequestId: row?.changeRequestId ?? context?.changeRequestId ?? '', warrantyCaseId: row?.warrantyCaseId ?? context?.warrantyCaseId ?? '', notes: row?.notes ?? '', saveReason: '' },
    }, (next, values) => {
      const [kind, entityId] = JSON.parse(values.sourceRecord) as [OrderLinkKind, string];
      if (!sourceRecords.some(item => item.kind === kind && item.id === entityId)) throw new Error('Выберите существующую запись текущего заказа.');
      next.links = put(next.links, { id: linkId, kind, entityId, objectId: textValue(values.objectId), contractId: textValue(values.contractId), participantId: textValue(values.participantId), changeRequestId: textValue(values.changeRequestId), warrantyCaseId: textValue(values.warrantyCaseId), notes: textValue(values.notes) });
    });
  };

  const removeLink = (row: OrderLink) => openRelationEditor({ title: 'Убрать связь', fields: [],
    summary: <FormNote>Связь будет убрана из этой карточки. Исходная запись «{sourceRecords.find(item => item.kind === row.kind && item.id === row.entityId)?.title ?? linkLabels[row.kind]}» останется в своём разделе.</FormNote>,
    initialValues: { saveReason: '' }, submitLabel: 'Убрать связь',
  }, next => { next.links = next.links.filter(item => item.id !== row.id); });

  const openWarranty = (row?: OrderWarrantyCase) => {
    const warrantyId = row?.id ?? id();
    const transitions: Record<OrderWarrantyCase['status'], OrderWarrantyCase['status'][]> = { open: ['open', 'in_progress', 'resolved', 'closed'], in_progress: ['in_progress', 'resolved', 'closed'], resolved: ['resolved', 'in_progress', 'closed'], closed: ['closed'] };
    openRelationEditor({ title: row ? 'Гарантийное обращение' : 'Новое гарантийное обращение',
      fields: [{ name: 'title', label: 'Тема обращения', required: true, maxLength: 300 }, { name: 'objectId', label: 'Объект', type: 'select', required: true, options: objectOptions, disabled: Boolean(row) },
        { name: 'description', label: 'Что произошло', type: 'textarea', required: true }, { name: 'status', label: 'Состояние', type: 'select', required: true, options: transitions[row?.status ?? 'open'].map(value => ({ value, label: warrantyStatusLabels[value] })) },
        { name: 'responsiblePartyId', label: 'Ответственный', type: 'select', options: partyOptions }, { name: 'openedDate', label: 'Дата обращения', type: 'date', required: true, disabled: Boolean(row) },
        { name: 'dueDate', label: 'Срок решения', type: 'date' }, { name: 'resolvedDate', label: 'Фактическая дата решения', type: 'date' }, { name: 'resolution', label: 'Результат / решение', type: 'textarea' }, sourceField, docField(state)],
      initialValues: { title: row?.title ?? '', objectId: row?.objectId ?? '', description: row?.description ?? '', status: row?.status ?? 'open', responsiblePartyId: row?.responsiblePartyId ?? '', openedDate: row?.openedDate ?? '', dueDate: row?.dueDate ?? '', resolvedDate: row?.resolvedDate ?? '', resolution: row?.resolution ?? '', source: row?.source ?? '', documentIds: row?.documentIds.join('|') ?? '', saveReason: '' },
    }, (next, values) => { next.warrantyCases = put(next.warrantyCases, { ...(row ?? {}), id: warrantyId, title: values.title.trim(), objectId: values.objectId, description: values.description.trim(), status: values.status as OrderWarrantyCase['status'], responsiblePartyId: textValue(values.responsiblePartyId), openedDate: values.openedDate, dueDate: textValue(values.dueDate), resolvedDate: textValue(values.resolvedDate), resolution: textValue(values.resolution), source: textValue(values.source), documentIds: orderSelectedIds(values.documentIds) }); });
  };

  const documentLinks = (documentIds: string[]) => documentIds.length ? <div className="customer-orders__document-links">{documentIds.map(documentId => <button key={documentId} type="button" className="customer-orders__link-button" onClick={() => onNavigate('project', documentId)}><FileText size={15} />{state.documents.find(row => row.id === documentId)?.name ?? 'Документ'}<ArrowUpRight size={14} /></button>)}</div> : null;
  const contextLinks = (predicate: (link: OrderLink) => boolean) => {
    const rows = relations.links.filter(predicate);
    return rows.length ? <div className="customer-orders__document-links">{rows.map(link => <button key={link.id} type="button" className="customer-orders__link-button" onClick={() => onNavigate(linkPages[link.kind], link.entityId)}><Link2 size={14} />{sourceRecords.find(item => item.kind === link.kind && item.id === link.entityId)?.title ?? linkLabels[link.kind]}<ArrowUpRight size={14} /></button>)}</div> : null;
  };

  if (session.role !== 'management') return <section className="panel"><SectionHeader title="Заказчики и заказы" /><p>Раздел доступен сотрудникам с правом управления заказом.</p></section>;

  const renderOrderCard = (order: typeof orders[number]) => <article key={order.id} className="customer-orders__order-card" data-current={order.id === state.project.id}>
    <div className="customer-orders__order-card-head"><div><small>{order.code}{order.id === state.project.id ? ' · открыт сейчас' : ''}</small><h3>{order.name}</h3></div><RecordBadge status={order.status} label={orderStatusLabels[order.status as OrderStatus] ?? ({ workspace: 'Рабочая среда', archived: 'В архиве' } as Record<string, string>)[order.status] ?? 'Заказ'} /></div>
    <p>{order.mode ? modeLabels[order.mode] : 'Связи заказа ещё не настроены'}</p>
    <div className="customer-orders__order-facts"><span><small>Цена заказа</small><strong>{order.contractValue === null ? 'Не указана' : money(order.contractValue)}</strong></span><span><small>Объекты</small><strong>{order.assetIds.length}</strong></span><span><small>Участки</small><strong>{order.plotIds.length}</strong></span></div>
    <div className="customer-orders__actions"><button type="button" className="customer-orders__link-button" onClick={() => { if (order.id === state.project.id) setMode('order'); else onOpenProject(order.id, 'customers'); }}>Открыть связи заказа<ChevronRight size={16} /></button><button type="button" className="customer-orders__link-button" onClick={() => order.id === state.project.id ? onNavigate('finance') : onOpenProject(order.id, 'finance')}>Финансы<ArrowUpRight size={15} /></button></div>
  </article>;

  const linkedPlotIds = new Set([...relations.plotIds, ...relations.objects.map(scope => {
    const asset = recordMap.get(scope.assetId); return asset?.kind === 'asset' ? asset.data.plotId : undefined;
  }).filter((value): value is string => Boolean(value))]);

  return <div className="page-stack customer-orders">
    <div className="page-title-row"><div><span className="eyebrow">Заказчик · объекты · исполнение</span><h1>Заказчики и заказы</h1><p>Один контакт для повторных заказов. Участники, условия, документы и изменения связаны с конкретным заказом.</p></div>
      <div className="customer-orders__actions"><button type="button" className="button button--ghost" onClick={() => setReload(value => value + 1)} disabled={loading}><RefreshCw size={16} />Обновить</button>{session.isOwner ? <button type="button" className="button button--primary" onClick={() => onCreateOrder(selected?.id)} disabled={editsBlocked}><Plus size={17} />Новый заказ</button> : null}</div>
    </div>
    {notice ? <div className="customer-orders__notice" role="status"><span>{notice}</span><button type="button" aria-label="Закрыть уведомление" onClick={() => setNotice('')}><X size={17} /></button></div> : null}
    {loadError ? <div className="customer-orders__error" role="alert">{loadError} <button type="button" className="customer-orders__link-button" onClick={() => setReload(value => value + 1)}>Повторить</button></div> : null}
    {syncPhase === 'offline' || syncPhase === 'conflict' ? <p className="customer-orders__section-note">{syncPhase === 'conflict' ? 'Есть конфликт сохранения. Разрешите его через статус синхронизации, затем продолжите изменение заказа.' : 'Нет подтверждённой связи с сервером. Данные доступны для просмотра; изменения продолжатся после синхронизации.'}</p> : null}
    <div className="customer-orders__switch" role="group" aria-label="Режим просмотра"><button type="button" aria-pressed={mode === 'directory'} onClick={() => setMode('directory')}><Users size={17} />Заказчики</button><button type="button" aria-pressed={mode === 'order'} onClick={() => setMode('order')}><Link2 size={17} />Текущий заказ</button></div>

    {loading && !directory ? <section className="panel customer-orders__loading" aria-live="polite"><RefreshCw size={24} /><span>Загружаем доступные контакты и заказы…</span></section> : null}

    {mode === 'directory' && directory ? <div className="customer-orders__layout">
      <aside className="panel customer-orders__directory" aria-label="Контакты"><SectionHeader title="Контакты" action={<button type="button" className="customer-orders__link-button" disabled={loading} onClick={() => openParty()} aria-label="Добавить контакт"><Plus size={19} /></button>} />
        <div className="customer-orders__search"><Search size={17} /><input value={query} onChange={event => setQuery(event.target.value)} aria-label="Поиск по имени, телефону, почте или ИНН" placeholder="Имя, телефон, ИНН" type="search" /></div>
        <label className="customer-orders__filter"><input type="checkbox" checked={customersOnly} onChange={event => setCustomersOnly(event.target.checked)} />Только заказчики</label>
        <div className="customer-orders__contact-list">{visibleParties.map(record => <button key={record.id} type="button" className="customer-orders__contact" aria-pressed={selectedId === record.id} onClick={() => setSelectedId(record.id)}>{record.data.partyType === 'company' ? <Building2 size={18} /> : <Users size={18} />}<span><strong>{record.data.name}</strong><small>{record.data.phone || record.data.email || (record.data.partyType === 'company' ? 'Организация' : 'Контакт без телефона')}</small></span></button>)}</div>
        {!visibleParties.length ? <EmptySection title={parties.length ? 'Нет совпадений' : 'Начните с заказчика'}>{parties.length ? 'Измените запрос или снимите фильтр.' : 'Добавьте контакт, затем явно свяжите с ним текущий заказ.'}</EmptySection> : null}
        <button type="button" className="customer-orders__link-button" onClick={() => openParty()} disabled={loading}><Plus size={16} />Добавить контакт</button>
      </aside>
      <div className="customer-orders__customer">{selected ? <>
        <section className="panel customer-orders__identity"><div className="customer-orders__identity-head"><div><span className="eyebrow">{selected.data.partyType === 'company' ? 'Организация' : 'Контакт'}</span><h2>{selected.data.name}</h2>{selected.data.legalName ? <p>{selected.data.legalName}</p> : null}</div><div className="customer-orders__actions">{selected.canEdit ? <button type="button" className="button button--ghost" onClick={() => openParty(selected)} disabled={loading}><Pencil size={15} />Изменить</button> : null}{session.isOwner ? <button type="button" className="button button--primary" onClick={() => onCreateOrder(selected.id)} disabled={editsBlocked}><Plus size={16} />Заказ для клиента</button> : null}</div></div>
          <div className="customer-orders__contact-data">{selected.data.phone ? <a href={`tel:${selected.data.phone.replace(/[^\d+]/g, '')}`}>{selected.data.phone}</a> : null}{selected.data.email ? <a href={`mailto:${selected.data.email}`}><Mail size={16} />{selected.data.email}</a> : null}{selected.data.inn ? <span>ИНН {selected.data.inn}</span> : null}</div>
          {selected.data.notes ? <p>{selected.data.notes}</p> : null}{selected.data.source ? <p>Источник: {selected.data.source}</p> : null}
          <div className="customer-orders__stats"><div className="customer-orders__stat"><small>Доступных заказов</small><strong>{selectedOrders.length}</strong></div><div className="customer-orders__stat"><small>В работе</small><strong>{selectedOrders.filter(order => order.status === 'active').length}</strong></div><div className="customer-orders__stat"><small>Физических объектов</small><strong>{new Set(selectedOrders.flatMap(order => order.assetIds)).size}</strong></div></div>
          {relations.customerId !== selected.id ? <button type="button" className="customer-orders__link-button" disabled={editsBlocked} onClick={() => openOrderSettings(selected.id)}><Link2 size={16} />Связать с текущим заказом «{state.project.code}»</button> : <p className="customer-orders__linked"><Check size={16} />Основной заказчик текущего заказа</p>}
          {!selected.canEdit ? <p>Общую карточку может изменить сотрудник, который управляет всеми связанными заказами.</p> : null}
        </section>
        <section className="panel customer-orders__section"><SectionHeader title="Заказы заказчика" eyebrow="В пределах вашего доступа" />{selectedOrders.length ? <div className="customer-orders__order-list">{selectedOrders.map(renderOrderCard)}</div> : <EmptySection title="Связанных заказов пока нет">Свяжите контакт с текущим заказом или создайте новый. Другие участники и их роли добавляются внутри заказа.</EmptySection>}</section>
        {participatingOrders.length ? <section className="panel customer-orders__section"><SectionHeader title="Участие в других заказах" /><div className="customer-orders__order-list">{participatingOrders.map(renderOrderCard)}</div></section> : null}
      </> : <section className="panel"><EmptySection title="Выберите контакт">В карточке появятся его заказы, объекты и переходы в существующие разделы.</EmptySection></section>}</div>
    </div> : null}

    {mode === 'order' ? <div className="customer-orders__current">
      {!state.orderRelations ? <p className="customer-orders__section-note">У этого заказа ещё нет общей карточки связей. Создайте или выберите контакт, участок и объект, затем нажмите «Настроить». Первичная настройка сохранит текущий статус проекта.</p> : null}
      <section className="panel customer-orders__context"><div><span className="eyebrow">Текущий заказ · {state.project.code}</span><h2>{state.project.name}</h2><p>{relations.customerId ? partyName(relations.customerId) : 'Заказчик пока не связан'} · {state.orderRelations ? modeLabels[relations.mode] : 'Настройте связи заказа'}</p></div><div className="customer-orders__actions"><RecordBadge status={relations.status} label={state.orderRelations ? orderStatusLabels[relations.status] : 'Связи не настроены'} /><button type="button" className="button button--ghost" onClick={() => openOrderSettings()} disabled={editsBlocked}><Pencil size={15} />Настроить</button><button type="button" className="button button--ghost" onClick={() => onNavigate('project')}><ArrowUpRight size={15} />Карточка проекта</button></div></section>
      <div className="customer-orders__tabs" role="tablist" aria-label="Разделы текущего заказа">{(Object.keys(tabLabels) as OrderTab[]).map(tabId => <button key={tabId} id={`customer-order-tab-${tabId}`} type="button" role="tab" aria-selected={tab === tabId} aria-controls={`customer-order-panel-${tabId}`} tabIndex={tab === tabId ? 0 : -1} onClick={() => setTab(tabId)} onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); const keys = Object.keys(tabLabels) as OrderTab[], current = keys.indexOf(tabId);
        const next = event.key === 'Home' ? keys[0] : event.key === 'End' ? keys.at(-1)! : keys[(current + (event.key === 'ArrowRight' ? 1 : keys.length - 1)) % keys.length];
        setTab(next); document.getElementById(`customer-order-tab-${next}`)?.focus();
      }}>{tabLabels[tabId]}</button>)}</div>
      <section className="panel customer-orders__section" id={`customer-order-panel-${tab}`} role="tabpanel" aria-labelledby={`customer-order-tab-${tab}`} tabIndex={0}>

        {tab === 'participants' ? <>
          <SectionHeader title="Участники и ответственность" action={<div className="customer-orders__actions"><button type="button" className="button button--ghost" onClick={() => openParty()} disabled={loading || !directory}><Plus size={16} />Новый контакт</button><button type="button" className="button button--primary" onClick={() => openParticipant()} disabled={relationsBlocked || !parties.length}><Plus size={16} />Добавить участника</button></div>} />
          <p>У одного контакта могут быть разные роли. Основной заказчик выбирается в настройках заказа; плательщик, собственник земли и заёмщик указываются отдельно.</p>
          {relations.participants.length ? <div className="customer-orders__cards customer-orders__cards--grid">{relations.participants.map(row => <article className="customer-orders__record" key={row.id} id={row.id}><div className="customer-orders__record-head"><div><small>{participantLabels[row.role]}</small><h3>{partyName(row.partyId)}</h3></div><button type="button" className="customer-orders__link-button" aria-label={`Изменить роль: ${partyName(row.partyId)}`} onClick={() => openParticipant(row)} disabled={relationsBlocked}><Pencil size={16} /></button></div>{row.notes ? <p>{row.notes}</p> : null}<div className="customer-orders__actions"><button type="button" className="customer-orders__link-button" onClick={() => { setSelectedId(row.partyId); setMode('directory'); }}>Карточка контакта<ChevronRight size={15} /></button>{row.projectCounterpartyId ? <button type="button" className="customer-orders__link-button" onClick={() => onNavigate('counterparties', row.projectCounterpartyId)}>Подрядчик / поставщик<ArrowUpRight size={15} /></button> : null}</div>{contextLinks(link => link.participantId === row.id)}</article>)}</div> : <EmptySection title="Участники пока не добавлены">Выберите существующий контакт и назначьте роль в текущем заказе. Новый контакт можно создать здесь.</EmptySection>}
        </> : null}

        {tab === 'objects' ? <>
          <SectionHeader title="Участки и объекты" action={<div className="customer-orders__actions"><button type="button" className="button button--ghost" disabled={loading || !directory} onClick={() => openPlot()}><Plus size={16} />Создать участок</button><button type="button" className="button button--ghost" disabled={loading || !directory} onClick={() => openAsset()}><Plus size={16} />Создать объект</button><button type="button" className="button button--primary" disabled={relationsBlocked || !assets.length} onClick={() => openObject()}><Link2 size={16} />Добавить в заказ</button></div>} />
          <p>Выберите существующий участок или дом для повторного заказа. Объём работ и комплектация хранятся в версиях этого заказа.</p>
          <div className="customer-orders__actions"><button type="button" className="customer-orders__link-button" disabled={relationsBlocked || !plots.length} onClick={openPlotLinks}><MapPin size={16} />Выбрать участки заказа</button></div>
          {linkedPlotIds.size ? <div className="customer-orders__cards customer-orders__cards--grid">{[...linkedPlotIds].map(plotId => { const record = recordMap.get(plotId); if (record?.kind !== 'plot') return <article key={plotId} className="customer-orders__record"><h3>Участок недоступен</h3><p>Обновите данные или проверьте доступ.</p></article>; return <article className="customer-orders__record" key={record.id}><div className="customer-orders__record-head"><div><small>{relations.plotIds.includes(record.id) ? 'Участок заказа' : 'Участок связанного объекта'}</small><h3>{record.data.name}</h3></div>{record.canEdit ? <button type="button" className="customer-orders__link-button" aria-label={`Изменить участок ${record.data.name}`} onClick={() => openPlot(record)} disabled={loading}><Pencil size={16} /></button> : null}</div><p>{record.data.address || 'Адрес не указан'}</p><dl><div><dt>Кадастровый номер</dt><dd>{record.data.cadastralNumber || 'Не указан'}</dd></div><div><dt>Площадь</dt><dd>{areaText(record.data.areaSqm)}</dd></div><div><dt>Собственники</dt><dd>{record.data.ownerPartyIds?.length ? record.data.ownerPartyIds.map(partyName).join(', ') : 'Не указаны'}</dd></div></dl>{record.data.communications ? <p>Коммуникации: {record.data.communications}</p> : null}{record.data.constraints ? <p>Условия: {record.data.constraints}</p> : null}</article>; })}</div> : null}
          <h3 className="customer-orders__subheading">Работы по объектам</h3>
          {relations.objects.length ? <div className="customer-orders__cards">{relations.objects.map(scope => {
            const asset = recordMap.get(scope.assetId), active = scope.specifications.find(spec => spec.id === scope.activeSpecificationId);
            return <article key={scope.id} id={scope.id} className="customer-orders__record"><div className="customer-orders__record-head"><div><small>{asset?.kind === 'asset' ? `${assetTypeLabels[asset.data.assetType]} · ${asset.data.name}` : 'Физический объект недоступен'}</small><h3>{scope.title}</h3></div><RecordBadge status={scope.status} label={objectStatusLabels[scope.status]} /></div>
              {active ? <><p><strong>Действует: {active.title}, версия {active.version}</strong></p><p>{active.scope}</p><dl><div><dt>Площадь здания</dt><dd>{areaText(active.houseAreaSqm)}</dd></div><div><dt>Терраса</dt><dd>{areaText(active.terraceAreaSqm)}</dd></div><div><dt>Технология / отделка</dt><dd>{[active.technology, active.finish].filter(Boolean).join(' · ') || 'Не указано'}</dd></div><div><dt>Срок по условиям</dt><dd>{active.plannedStart ? formatDate(active.plannedStart, true) : 'Начало не указано'} — {active.plannedEnd ? formatDate(active.plannedEnd, true) : 'окончание не указано'}</dd></div></dl>{documentLinks(active.documentIds)}</> : <p>Утверждённая комплектация пока не задана. Добавьте состав работ и подтвердите его основание.</p>}
              {scope.actualStart || scope.actualEnd ? <p>Фактически: {scope.actualStart ? formatDate(scope.actualStart, true) : 'начало не указано'} — {scope.actualEnd ? formatDate(scope.actualEnd, true) : 'работы продолжаются'}</p> : null}
              <div className="customer-orders__actions"><button type="button" className="customer-orders__link-button" onClick={() => openObject(scope)} disabled={relationsBlocked}><Pencil size={15} />Работы и даты</button><button type="button" className="customer-orders__link-button" onClick={() => openSpecification(scope)} disabled={relationsBlocked}><Plus size={15} />Версия комплектации</button>{asset?.kind === 'asset' && asset.canEdit ? <button type="button" className="customer-orders__link-button" onClick={() => openAsset(asset)} disabled={loading}>Общая карточка объекта<ArrowUpRight size={15} /></button> : null}<button type="button" className="customer-orders__link-button" onClick={() => openLink(undefined, { objectId: scope.id })} disabled={relationsBlocked || !sourceRecords.length}><Link2 size={15} />Связать этап / запись</button></div>
              {contextLinks(link => link.objectId === scope.id)}
              {scope.specifications.length ? <details><summary>Все версии комплектации · {scope.specifications.length}</summary>{[...scope.specifications].reverse().map(spec => <div className="customer-orders__version" data-current={spec.id === scope.activeSpecificationId} key={spec.id}><strong>Версия {spec.version} · {spec.title} · {spec.status === 'approved' ? 'Утверждена' : 'Черновик'}{spec.id === scope.activeSpecificationId ? ' · действует' : ''}</strong><p>{spec.scope}</p><small>{[spec.model, spec.technology, spec.finish, spec.houseAreaSqm === undefined ? undefined : areaText(spec.houseAreaSqm)].filter(Boolean).join(' · ')}</small>{spec.source ? <small>Основание: {spec.source}</small> : null}{spec.approvedAt ? <small>{spec.approvedBy} · {formatDateTime(spec.approvedAt)}</small> : null}{spec.changeRequestId ? <small>Изменение: {relations.changeRequests.find(change => change.id === spec.changeRequestId)?.title ?? 'Согласование'}</small> : null}{documentLinks(spec.documentIds)}{spec.status === 'draft' ? <button type="button" className="customer-orders__link-button" onClick={() => openSpecification(scope, spec)} disabled={relationsBlocked}><Pencil size={14} />Изменить / утвердить</button> : null}</div>)}</details> : null}
            </article>;
          })}</div> : <EmptySection title="Объекты пока не связаны">Создайте карточку физического объекта или выберите существующую через «Добавить в заказ». Затем задайте состав работ и первую комплектацию.</EmptySection>}
          {state.orderRelations ? <OrderObjectCostsPanel state={state} session={session} onChange={onChange} onNavigate={onNavigate} syncPhase={syncPhase} /> : null}
        </> : null}

        {tab === 'contracts' ? <>
          <SectionHeader title="Договоры и подписанные условия" action={<div className="customer-orders__actions"><button type="button" className="button button--ghost" disabled={relationsBlocked} onClick={openContractPricing}>Источник цены</button><button type="button" className="button button--ghost" disabled={loading || !directory} onClick={() => openAgreement()}><Plus size={16} />Общий договор подрядчика</button><button type="button" className="button button--primary" disabled={relationsBlocked} onClick={() => openContract()}><Plus size={16} />Добавить договор</button></div>} />
          <div className="customer-orders__stats"><div className="customer-orders__stat"><small>С заказчиком</small><strong>{centsText(totals.customerCents)}</strong></div><div className="customer-orders__stat"><small>С подрядчиками / поставщиками</small><strong>{centsText(totals.supplierCents)}</strong></div><div className="customer-orders__stat"><small>Финансирование</small><strong>{centsText(totals.financeCents)}</strong></div></div>
          <p>{relations.contractPricing ? 'Цена заказа определяется действующими подписанными договорами с заказчиком.' : 'Цена заказа берётся из существующей карточки проекта. Чтобы обновлять её по договорам, выберите «Источник цены».'} В итогах учтены текущие подписанные и исполненные договоры. Черновики, расторгнутые и заменённые версии исключены.</p>
          <div className="customer-orders__actions"><button type="button" className="customer-orders__link-button" onClick={() => onNavigate('project')}><FileText size={16} />Добавить подтверждающий документ</button><button type="button" className="customer-orders__link-button" onClick={() => onNavigate('finance')}>Оплаты и обязательства<ArrowUpRight size={15} /></button></div>
          {relations.contracts.length ? <div className="customer-orders__cards">{[...relations.contracts].reverse().map(row => {
            const successor = relations.contracts.find(item => item.supersedesId === row.id && item.status !== 'draft');
            return <article className="customer-orders__record" key={row.id} id={row.id}><div className="customer-orders__record-head"><div><small>{contractKindLabels[row.kind]}{row.number ? ` · № ${row.number}` : ''}</small><h3>{row.title}</h3></div><RecordBadge status={row.status} label={successor ? 'Заменён новой версией' : contractStatusLabels[row.status]} /></div><dl><div><dt>{row.sharedAgreementId ? 'Доля текущего заказа' : 'Полная сумма'}</dt><dd>{centsText(row.amountCents)}</dd></div><div><dt>Стороны</dt><dd>{row.partySnapshots?.length ? row.partySnapshots.map(party => party.legalName || party.name).join(', ') : row.partyIds.length ? row.partyIds.map(partyName).join(', ') : 'Не указаны'}</dd></div><div><dt>Подписан</dt><dd>{row.signedDate ? formatDate(row.signedDate, true) : 'Не указано'}</dd></div><div><dt>Объекты</dt><dd>{row.objectIds.length ? row.objectIds.map(objectName).join(', ') : 'Весь заказ'}</dd></div></dl>
              {row.source ? <p>Основание: {row.source}</p> : null}{row.closedReason ? <p>Закрытие: {row.closedReason}</p> : null}{row.supersedesId ? <p>Новая версия договора «{relations.contracts.find(item => item.id === row.supersedesId)?.title ?? 'Предыдущий договор'}». Полная сумма заменяет предыдущую.</p> : null}{row.changeRequestId ? <p>Согласование: {relations.changeRequests.find(item => item.id === row.changeRequestId)?.title ?? 'Изменение'}</p> : null}
              {documentLinks(row.documentIds)}{contextLinks(link => link.contractId === row.id)}
              <div className="customer-orders__actions">{row.status === 'draft' ? <button type="button" className="customer-orders__link-button" disabled={relationsBlocked} onClick={() => openContract(row)}><Pencil size={15} />Изменить / подписать</button> : !successor ? <button type="button" className="customer-orders__link-button" disabled={relationsBlocked} onClick={() => openContract(undefined, row)}><Plus size={15} />Новая версия</button> : null}{row.status === 'signed' && !successor ? <button type="button" className="customer-orders__link-button" disabled={relationsBlocked} onClick={() => closeContract(row)}>Завершить / расторгнуть</button> : null}</div>
            </article>;
          })}</div> : <EmptySection title="Договоры пока не добавлены">Создайте черновик, выберите стороны и документы. После подписания исходные условия будут защищены; изменения оформляются новой версией.</EmptySection>}
          {agreements.length ? <><h3 className="customer-orders__subheading">Общие договоры подрядчиков</h3><p>Полная сумма относится ко всем заказам по договору. В текущий заказ включается только его доля через «Добавить договор».</p><div className="customer-orders__cards">{agreements.map(record => <article className="customer-orders__record" key={record.id}><div className="customer-orders__record-head"><div><small>{record.data.number ? `№ ${record.data.number}` : 'Общий договор'}</small><h3>{record.data.name}</h3></div><RecordBadge status={record.data.status} label={contractStatusLabels[record.data.status]} /></div><dl><div><dt>Полная сумма по всем заказам</dt><dd>{record.limitedScope ? 'Ограничен доступ' : centsText(record.data.totalAmountCents)}</dd></div><div><dt>Стороны</dt><dd>{record.data.partySnapshots?.length ? record.data.partySnapshots.map(party => party.legalName || party.name).join(', ') : record.data.partyIds.map(partyName).join(', ') || 'Не указаны'}</dd></div></dl>{record.limitedScope ? <p>Полные условия доступны сотруднику, который управляет всеми связанными заказами.</p> : null}{record.data.source ? <p>Основание: {record.data.source}</p> : null}{record.originProjectId === state.project.id ? documentLinks(record.data.documentIds ?? []) : record.originProjectId ? <button type="button" className="customer-orders__link-button" onClick={() => onOpenProject(record.originProjectId!, 'project')}>Документы исходного заказа<ArrowUpRight size={15} /></button> : null}{record.canEdit && record.data.status === 'draft' ? <button type="button" className="customer-orders__link-button" disabled={loading} onClick={() => openAgreement(record)}><Pencil size={15} />Изменить / подписать общий договор</button> : null}</article>)}</div></> : null}
        </> : null}

        {tab === 'financing' ? <>
          <SectionHeader title="Ипотечные заявки" action={<button type="button" className="button button--primary" disabled={relationsBlocked} onClick={() => openMortgage()}><Plus size={16} />Добавить заявку</button>} />
          <p>Каждая заявка сохраняет собственное решение банка. Одобрение, первоначальный взнос и эскроу не создают приход или расход денег.</p><button type="button" className="customer-orders__link-button" onClick={() => onNavigate('finance')}><Landmark size={16} />Проверить фактические поступления<ArrowUpRight size={15} /></button>
          {relations.mortgages.length ? <div className="customer-orders__cards">{relations.mortgages.map(row => <article key={row.id} id={row.id} className="customer-orders__record"><div className="customer-orders__record-head"><div><small>{partyName(row.bankPartyId)}</small><h3>{row.program}</h3></div><RecordBadge status={row.status} label={mortgageStatusLabels[row.status]} /></div><dl><div><dt>Запрошено</dt><dd>{centsText(row.requestedAmountCents)}</dd></div><div><dt>Одобрено</dt><dd>{centsText(row.approvedAmountCents)}</dd></div><div><dt>Первоначальный взнос</dt><dd>{centsText(row.downPaymentCents)}</dd></div><div><dt>Порядок расчётов</dt><dd>{row.fundingRoute === 'escrow' ? 'Эскроу' : row.fundingRoute === 'direct' ? 'Прямое поступление' : 'Не указан'}</dd></div><div><dt>Заёмщики</dt><dd>{row.borrowerPartyIds.map(partyName).join(', ') || 'Не указаны'}</dd></div><div><dt>Решение банка</dt><dd>{row.decisionDate ? formatDate(row.decisionDate, true) : 'Дата не указана'}</dd></div></dl>{row.notes ? <p>{row.notes}</p> : null}{row.source ? <p>Основание: {row.source}</p> : null}{documentLinks(row.documentIds)}<div className="customer-orders__actions"><button type="button" className="customer-orders__link-button" disabled={relationsBlocked} onClick={() => openMortgage(row)}><Pencil size={15} />Сведения и статус</button>{row.financeEntryId ? <button type="button" className="customer-orders__link-button" onClick={() => onNavigate('finance', row.financeEntryId)}>Подтверждённое поступление<ArrowUpRight size={15} /></button> : null}</div></article>)}</div> : <EmptySection title="Ипотечных заявок пока нет">Добавьте банк и заёмщиков в контакты, затем создайте заявку. Собственные средства заказчика отражаются в существующем финансовом разделе.</EmptySection>}
        </> : null}

        {tab === 'changes' ? <>
          <SectionHeader title="Изменения и согласования" action={<button type="button" className="button button--primary" disabled={relationsBlocked} onClick={() => openChange()}><Plus size={16} />Новое изменение</button>} />
          <p>Сначала зафиксируйте влияние и согласование, затем выпустите новую комплектацию или договор. После фактического выполнения укажите результат.</p>
          {relations.changeRequests.length ? <div className="customer-orders__cards">{[...relations.changeRequests].reverse().map(row => <article className="customer-orders__record" key={row.id} id={row.id}><div className="customer-orders__record-head"><div><h3>{row.title}</h3><small>{row.objectIds.length ? row.objectIds.map(objectName).join(', ') : 'Весь заказ'}</small></div><RecordBadge status={row.status} label={changeStatusLabels[row.status]} /></div><p>{row.reason}</p><dl><div><dt>Влияние на цену</dt><dd>{centsText(row.priceDeltaCents)}</dd></div><div><dt>Влияние на себестоимость</dt><dd>{centsText(row.costDeltaCents)}</dd></div><div><dt>Влияние на срок</dt><dd>{row.scheduleDeltaDays === undefined ? 'Не оценено' : row.scheduleDeltaDays === 0 ? 'Без изменения' : `${row.scheduleDeltaDays > 0 ? '+' : ''}${row.scheduleDeltaDays} дн.`}</dd></div></dl>{row.source ? <p>Основание: {row.source}</p> : null}{row.implementationNote ? <p>Результат: {row.implementationNote}</p> : null}{row.approvedAt ? <small>Утвердил: {row.approvedBy} · {formatDateTime(row.approvedAt)}</small> : null}{documentLinks(row.documentIds)}{contextLinks(link => link.changeRequestId === row.id)}
            <div className="customer-orders__actions">{row.status === 'draft' || row.status === 'submitted' ? <button type="button" className="customer-orders__link-button" disabled={relationsBlocked} onClick={() => openChange(row)}><Pencil size={15} />Рассмотреть изменение</button> : null}{row.status === 'approved' ? <><button type="button" className="customer-orders__link-button" disabled={relationsBlocked} onClick={() => applyChange(row)}><Check size={15} />Зафиксировать выполнение</button>{row.objectIds.length === 1 && relations.objects.some(scope => scope.id === row.objectIds[0]) ? <button type="button" className="customer-orders__link-button" disabled={relationsBlocked} onClick={() => openSpecification(relations.objects.find(scope => scope.id === row.objectIds[0])!, undefined, row.id)}><Plus size={15} />Новая комплектация</button> : null}</> : null}<button type="button" className="customer-orders__link-button" disabled={relationsBlocked || !sourceRecords.length} onClick={() => openLink(undefined, { changeRequestId: row.id })}><Link2 size={15} />Связать задачу / запись</button></div>
          </article>)}</div> : <EmptySection title="Изменений пока нет">Здесь фиксируются дополнительные работы, корректировки цены, комплектации и сроков. Первоначально утверждённые условия сохраняются.</EmptySection>}
          <OrderChangeImpactPanel state={state} session={session} onNavigate={onNavigate} />
        </> : null}

        {tab === 'links' ? <>
          <SectionHeader title="Связи с рабочими разделами" action={<button type="button" className="button button--primary" disabled={relationsBlocked || !sourceRecords.length} onClick={() => openLink()}><Plus size={16} />Добавить связь</button>} />
          <p>Объект, договор, участник, изменение и гарантийное обращение могут ссылаться на существующие записи заказа. Одна запись может относиться к нескольким объектам; связь не распределяет и не повторяет её сумму.</p>
          <div className="customer-orders__section-nav">{([['schedule', 'График работ'], ['finance', 'Бюджет и финансы'], ['procurement', 'Снабжение'], ['tasks', 'Задачи'], ['project', 'Документы'], ['counterparties', 'Подрядчики и поставщики']] as [PageId, string][]).map(([page, label]) => <button type="button" key={page} className="customer-orders__link-button" onClick={() => onNavigate(page)}>{label}<ArrowUpRight size={15} /></button>)}</div>
          {relations.links.length ? <div className="customer-orders__cards">{relations.links.map(row => <article className="customer-orders__record" key={row.id} id={row.id}><div className="customer-orders__record-head"><div><small>{linkLabels[row.kind]}</small><h3>{sourceRecords.find(item => item.kind === row.kind && item.id === row.entityId)?.title ?? 'Исходная запись недоступна'}</h3></div><button type="button" className="customer-orders__link-button" onClick={() => onNavigate(linkPages[row.kind], row.entityId)} aria-label="Открыть исходную запись"><ArrowUpRight size={19} /></button></div><div className="customer-orders__tags">{row.objectId ? <span className="customer-orders__tag">{objectName(row.objectId)}</span> : null}{row.contractId ? <span className="customer-orders__tag">{relations.contracts.find(item => item.id === row.contractId)?.title}</span> : null}{row.participantId ? <span className="customer-orders__tag">{partyName(relations.participants.find(item => item.id === row.participantId)?.partyId)}</span> : null}{row.changeRequestId ? <span className="customer-orders__tag">{relations.changeRequests.find(item => item.id === row.changeRequestId)?.title}</span> : null}{row.warrantyCaseId ? <span className="customer-orders__tag">{relations.warrantyCases.find(item => item.id === row.warrantyCaseId)?.title}</span> : null}</div>{row.notes ? <p>{row.notes}</p> : null}<div className="customer-orders__actions"><button type="button" className="customer-orders__link-button" onClick={() => openLink(row)} disabled={relationsBlocked}><Pencil size={15} />Изменить связь</button><button type="button" className="customer-orders__link-button" onClick={() => removeLink(row)} disabled={relationsBlocked}>Убрать связь</button></div></article>)}</div> : <EmptySection title="Связей пока нет">Создайте нужную запись в рабочем разделе, затем свяжите её с объектом или договором. Для оплаты, закупки или задачи используются прежние формы ИКИОМА.</EmptySection>}
        </> : null}

        {tab === 'warranty' ? <>
          <SectionHeader title="Гарантийные обращения" action={<button type="button" className="button button--primary" disabled={relationsBlocked || !relations.objects.length} onClick={() => openWarranty()}><Plus size={16} />Новое обращение</button>} />
          <p>Обращение относится к объекту этого заказа. Свяжите его с задачей, подтверждающими документами и расходами в существующих разделах.</p>
          {relations.warrantyCases.length ? <div className="customer-orders__cards">{[...relations.warrantyCases].reverse().map(row => <article className="customer-orders__record" key={row.id} id={row.id}><div className="customer-orders__record-head"><div><small>{objectName(row.objectId)}</small><h3>{row.title}</h3></div><RecordBadge status={row.status} label={warrantyStatusLabels[row.status]} /></div><p>{row.description}</p><dl><div><dt>Дата обращения</dt><dd>{formatDate(row.openedDate, true)}</dd></div><div><dt>Срок решения</dt><dd>{row.dueDate ? formatDate(row.dueDate, true) : 'Не указан'}</dd></div><div><dt>Ответственный</dt><dd>{partyName(row.responsiblePartyId)}</dd></div></dl>{row.resolution ? <p>Решение: {row.resolution}{row.resolvedDate ? ` · ${formatDate(row.resolvedDate, true)}` : ''}</p> : null}{row.source ? <p>Основание: {row.source}</p> : null}{documentLinks(row.documentIds)}{contextLinks(link => link.warrantyCaseId === row.id)}<div className="customer-orders__actions">{row.status !== 'closed' ? <button type="button" className="customer-orders__link-button" disabled={relationsBlocked} onClick={() => openWarranty(row)}><Pencil size={15} />Обновить / закрыть</button> : null}<button type="button" className="customer-orders__link-button" disabled={relationsBlocked || !sourceRecords.length} onClick={() => openLink(undefined, { warrantyCaseId: row.id, objectId: row.objectId })}><Link2 size={15} />Связать задачу / запись</button></div></article>)}</div> : <EmptySection title="Гарантийных обращений пока нет">После привязки объекта можно зарегистрировать обращение, назначить ответственного и сохранить подтверждение решения.</EmptySection>}
        </> : null}

        {tab === 'history' ? <>
          <SectionHeader title="История связей заказа" eyebrow="Подтверждённые сервером изменения" />
          <p>Здесь сохраняются автор, время, основание и изменённые сведения. Подписанные договоры, утверждённые комплектации и решения остаются в своих разделах.</p>
          {relations.history.length ? <ol className="customer-orders__timeline">{[...relations.history].reverse().map(entry => <li key={entry.id}><strong>{entry.reason}</strong><small>{entry.by} · {formatDateTime(entry.at)}</small><small>{entry.sections.map(section => sectionLabels[section] ?? section).join(' · ')}</small>{entry.changes?.length ? <details><summary>Что изменилось</summary><div className="customer-orders__history-details">{entry.changes.map((change, index) => <ChangedRecord key={`${change.path}-${index}`} {...change} resolveName={recordId => recordMap.get(recordId)?.data.name ?? 'Связанная карточка'} />)}</div></details> : null}</li>)}</ol> : <EmptySection title="Подтверждённых изменений пока нет">История появится после первого сохранения связей заказа на сервере.</EmptySection>}
        </> : null}
      </section>
    </div> : null}
    {editor ? <OrderEditorModal key={editor.id} {...editor} onClose={() => setEditor(null)} /> : null}
  </div>;
}
