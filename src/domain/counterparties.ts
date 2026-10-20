import type { ContactsSnapshot } from './contexts';
import type { CounterpartyProfile } from '../entities/index';

export const counterpartySnapshot = (state: ContactsSnapshot, id: string) => JSON.stringify([
  state.project.id, id, id ? state.counterparties.find(profile => profile.id === id) : null,
]);

export const normalizeCounterparty = (draft: CounterpartyProfile): { ok: true; profile: CounterpartyProfile } | { ok: false; error: string } => {
  if (!draft.name.trim()) return { ok: false, error: 'Укажите название контрагента.' };
  if (!['contractor', 'supplier', 'service', 'client'].includes(draft.type)) return { ok: false, error: 'Выберите тип контрагента.' };
  if (!['active', 'probation', 'blocked'].includes(draft.status)) return { ok: false, error: 'Выберите статус контрагента.' };
  return { ok: true, profile: {
    ...draft, name: draft.name.trim(), specialty: draft.specialty?.trim(), contactName: draft.contactName?.trim(),
    phone: draft.phone?.trim(), email: draft.email?.trim(), inn: draft.inn?.trim(), kpp: draft.kpp?.trim(),
    ogrn: draft.ogrn?.trim(), legalName: draft.legalName?.trim(), legalAddress: draft.legalAddress?.trim(),
    bankName: draft.bankName?.trim(), bik: draft.bik?.trim(), settlementAccount: draft.settlementAccount?.trim(),
    correspondentAccount: draft.correspondentAccount?.trim(), internalOwner: draft.internalOwner?.trim(),
    paymentTerms: draft.paymentTerms?.trim(), warrantyTerms: draft.warrantyTerms?.trim(),
    serviceRegion: draft.serviceRegion?.trim(), notes: draft.notes?.trim(), tags: draft.tags?.map(tag => tag.trim()).filter(Boolean),
  } };
};
