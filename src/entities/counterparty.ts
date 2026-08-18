export type CounterpartyType = 'contractor' | 'supplier' | 'service' | 'client';
export type CounterpartyStatus = 'active' | 'probation' | 'blocked';

export interface CounterpartyProfile {
  id: string;
  name: string;
  type: CounterpartyType;
  status: CounterpartyStatus;
  specialty?: string;
  contactName?: string;
  phone?: string;
  email?: string;
  inn?: string;
  legalName?: string;
  kpp?: string;
  ogrn?: string;
  legalAddress?: string;
  bankName?: string;
  bik?: string;
  settlementAccount?: string;
  correspondentAccount?: string;
  internalOwner?: string;
  paymentTerms?: string;
  warrantyTerms?: string;
  serviceRegion?: string;
  notes?: string;
  tags?: string[];
}
