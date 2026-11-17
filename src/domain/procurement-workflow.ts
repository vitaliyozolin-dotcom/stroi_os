import type { SupplySnapshot } from './contexts';
import type { ProcurementStatus, SupplierQuote } from '../entities/index';
export const procurementSnapshot = (state: SupplySnapshot, id: string, quotes = false) => JSON.stringify([state.project.id, state.procurement.find(item => item.id === id), quotes ? state.supplierQuotes.filter(quote => quote.procurementItemId === id) : null]);
export type ProcurementWorkflowInput = { itemId: string; expected: string } & (
  { action: 'advance' } | { action: 'receipt'; receivedQuantity: number; acceptedQuantity: number; expectedDeliveryDate: string; note: string } | { action: 'select'; quoteId: string } |
  { action: 'quote'; supplierId: string; amount: number; deliveryDays: number; paymentTerms: string; source: string; comment: string }
);
export type ProcurementTransition = { ok: true; changed: boolean; patch: Partial<Pick<SupplySnapshot, 'procurement' | 'supplierQuotes'>>; summary: string; tone: 'neutral' | 'positive' } | { ok: false; error: string };
const statuses: ProcurementStatus[] = ['need', 'rfq', 'ordered', 'in_transit', 'delivered', 'accepted', 'issued'];
const labels = ['потребность', 'сбор цен', 'заказано', 'в пути', 'доставлено', 'принято', 'выдано в работу'];
const money = (amount: number) => new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 2 }).format(amount);
export const transitionProcurement = (state: SupplySnapshot, input: ProcurementWorkflowInput, timestamp: string, quoteId: string): ProcurementTransition => {
  const item = state.procurement.find(item => item.id === input.itemId);
  if (!item) return { ok: false, error: 'Потребность не найдена. Обновите список.' };
  if (input.expected !== procurementSnapshot(state, item.id, input.action === 'select')) return { ok: false, error: 'Данные снабжения обновились. Откройте форму или карточку заново.' };
  if (input.action === 'receipt') {
    if (!['ordered', 'in_transit', 'delivered', 'accepted'].includes(item.status)) return { ok: false, error: 'Получение фиксируется после заказа материала.' };
    if (![input.receivedQuantity, input.acceptedQuantity].every(value => Number.isFinite(value) && value >= 0)
      || input.receivedQuantity > item.quantity || input.acceptedQuantity > input.receivedQuantity) return { ok: false, error: 'Проверьте количество: принято не больше полученного, получено не больше заказа.' };
    if (input.expectedDeliveryDate && (!/^\d{4}-\d{2}-\d{2}$/.test(input.expectedDeliveryDate) || !Number.isFinite(Date.parse(input.expectedDeliveryDate)) || new Date(input.expectedDeliveryDate).toISOString().slice(0, 10) !== input.expectedDeliveryDate)) return { ok: false, error: 'Укажите корректную дату поставки.' };
    const status: ProcurementStatus = input.acceptedQuantity === item.quantity ? 'accepted' : input.receivedQuantity === item.quantity ? 'delivered' : 'in_transit';
    return { ok: true, changed: true, tone: status === 'accepted' ? 'positive' : 'neutral', summary: `${item.item}: получено ${input.receivedQuantity}, принято ${input.acceptedQuantity} ${item.unit}`, patch: { procurement: state.procurement.map(row => row.id === item.id ? { ...row, status, receivedQuantity: input.receivedQuantity, acceptedQuantity: input.acceptedQuantity, expectedDeliveryDate: input.expectedDeliveryDate || undefined, receiptNote: input.note.trim() || undefined, deliveredAt: input.receivedQuantity === item.quantity ? row.deliveredAt || timestamp.slice(0, 10) : row.deliveredAt, risk: input.receivedQuantity < item.quantity ? `Не доставлено ${item.quantity - input.receivedQuantity} ${item.unit}` : input.acceptedQuantity < item.quantity ? `Не принято ${item.quantity - input.acceptedQuantity} ${item.unit}` : undefined } : row) } };
  }
  if (input.action === 'advance') {
    const index = statuses.indexOf(item.status);
    if (index < 0) return { ok: false, error: 'Неизвестный статус потребности.' };
    if (item.status === 'issued') return { ok: true, changed: false, patch: {}, summary: '', tone: 'neutral' };
    if (item.receivedQuantity !== undefined && ['in_transit', 'delivered'].includes(item.status) && (item.receivedQuantity < item.quantity || item.status === 'delivered' && Number(item.acceptedQuantity || 0) < item.quantity)) return { ok: false, error: 'Сначала уточните полученное и принятое количество.' };
    const status = statuses[index + 1], today = timestamp.slice(0, 10);
    return { ok: true, changed: true, summary: `${item.item}: ${labels[index + 1]}`, tone: ['accepted', 'issued'].includes(status) ? 'positive' : 'neutral', patch: {
      procurement: state.procurement.map(row => row.id === item.id ? { ...row, status, orderedAt: status === 'ordered' ? row.orderedAt ?? today : row.orderedAt, deliveredAt: ['delivered', 'accepted', 'issued'].includes(status) ? row.deliveredAt ?? today : row.deliveredAt, risk: ['accepted', 'issued'].includes(status) ? undefined : row.risk } : row),
    } };
  }
  const available = (id: string) => state.counterparties.find(profile => profile.id === id && profile.status !== 'blocked' && ['supplier', 'contractor'].includes(profile.type));
  if (input.action === 'quote') {
    const supplier = available(input.supplierId);
    if (!supplier) return { ok: false, error: 'Выберите доступного поставщика или подрядчика.' };
    if (!Number.isFinite(input.amount) || input.amount <= 0 || !Number.isSafeInteger(input.deliveryDays) || input.deliveryDays < 0 || !input.paymentTerms.trim()) return { ok: false, error: 'Укажите положительную сумму, целое число дней поставки и условия оплаты.' };
    const quote: SupplierQuote = { id: quoteId, procurementItemId: item.id, supplierId: supplier.id, supplier: supplier.name, amount: input.amount, deliveryDays: input.deliveryDays, paymentTerms: input.paymentTerms.trim(), source: input.source.trim() || 'Коммерческое предложение', comment: input.comment.trim() || undefined, status: 'received' };
    return { ok: true, changed: true, tone: 'neutral', summary: `Получено предложение ${supplier.name}: ${item.item} за ${money(input.amount)}`, patch: { supplierQuotes: [quote, ...state.supplierQuotes], procurement: state.procurement.map(row => row.id === item.id && row.status === 'need' ? { ...row, status: 'rfq' } : row) } };
  }
  const quote = state.supplierQuotes.find(quote => quote.id === input.quoteId && quote.procurementItemId === item.id);
  if (!quote || !Number.isFinite(quote.amount) || quote.amount <= 0) return { ok: false, error: 'Выберите корректное предложение этой потребности.' };
  const supplier = quote.supplierId ? available(quote.supplierId) : state.counterparties.filter(profile => profile.name === quote.supplier && available(profile.id));
  const profile = Array.isArray(supplier) ? supplier.length === 1 ? supplier[0] : undefined : supplier;
  if (!profile) return { ok: false, error: 'Поставщик предложения недоступен или неоднозначен.' };
  const procurement = state.procurement.map(row => row.id === item.id ? { ...row, supplier: profile.name, supplierId: profile.id, budget: quote.amount, budgetKnown: true, status: row.status === 'need' ? 'rfq' as const : row.status } : row);
  const supplierQuotes = state.supplierQuotes.map(row => row.procurementItemId === item.id ? { ...row, status: row.id === quote.id ? 'selected' as const : 'rejected' as const } : row);
  const changed = JSON.stringify(procurement) !== JSON.stringify(state.procurement) || JSON.stringify(supplierQuotes) !== JSON.stringify(state.supplierQuotes);
  return { ok: true, changed, tone: 'positive', summary: `${item.item}: выбран поставщик ${profile.name} за ${money(quote.amount)}`, patch: { procurement, supplierQuotes } };
};
