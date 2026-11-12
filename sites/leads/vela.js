import { clean } from '../lib/validation.js';

const CATALOG = 'https://ikioma.ru/vela/catalog.json';
const release = /^\d{4}-\d{2}-\d{2}\.\d{1,5}$/;
const requestKey = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const serviceKey = /^[a-z][a-z0-9-]{1,39}$/;
const consentVersion = 'pd-20261113-v2';
const kinds = { estimate: 'Расчёт для участка', mortgage: 'Финансирование', consultation: 'Консультация по ВЕЛА', visit: 'Просмотр объекта ИКИОМА' };
const lands = { own: 'Есть участок', search: 'Участок подбирается', undecided: 'Пока не определился' };
const pages = new Set(['/', '/na-svoem-uchastke/', '/semejnaya-ipoteka/', '/zemlya-i-dom/']);
const attributionKeys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'yclid'];
const rubles = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });

const own = (object, key) => typeof key === 'string' && Object.hasOwn(object, key);
const formatMoney = value => rubles.format(value) + ' ₽';
const normalizedLine = (value, max) => clean(value, max).replace(/[\r\n\t]/g, ' ');
const versionError = reason => ({ error: reason });
const validPrice = price => Number.isSafeInteger(price) && price >= 1 && price <= 100_000_000;

export const parseVelaLead = (payload) => {
  const path = clean(payload.page, 150);
  const page = path.endsWith('/') ? path : path + '/';
  const phone = clean(payload.phone, 20);
  const email = normalizedLine(payload.email, 180);
  const requestId = clean(payload.requestId, 40).toLowerCase();
  const catalogVersion = clean(payload.catalogVersion, 24);
  if (payload.project !== 'ВЕЛА' || !requestKey.test(requestId) || !release.test(catalogVersion) ||
      !own(kinds, payload.kind) || !own(lands, payload.land) || !pages.has(page) ||
      !/^\+[1-9]\d{9,14}$/.test(phone) || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) ||
      !Array.isArray(payload.selection) || payload.selection.length > 50 ||
      payload.selection.some(id => typeof id !== 'string' || !serviceKey.test(id))) return versionError('invalid_lead');

  if (payload.consent?.accepted !== true || payload.consent?.version !== consentVersion) return versionError('invalid_consent');
  const utm = Object.fromEntries(attributionKeys.flatMap(key => {
    const value = normalizedLine(payload.attribution?.utm?.[key], 160);
    return value ? [[key, value]] : [];
  }));

  let mortgage = null;
  if (payload.mortgage != null) {
    const { budget, down, years, rate } = payload.mortgage;
    if (!validPrice(budget) || !Number.isFinite(down) || down < 0 || down > 100 ||
        !Number.isInteger(years) || years < 1 || years > 50 || !Number.isFinite(rate) || rate < 0 || rate > 100) return versionError('invalid_mortgage');
    mortgage = { budget, down, years, rate };
  }
  return {
    requestId, catalogVersion, page, phone, email,
    name: normalizedLine(payload.name, 120), comment: clean(payload.comment, 500),
    kind: payload.kind, land: payload.land, selection: [...new Set(payload.selection)].sort(),
    mortgage, consentVersion,
    attribution: { utm, channel: utm.utm_source || (utm.yclid ? 'yandex_direct' : normalizedLine(payload.attribution?.channel, 160) || 'direct') },
  };
};

let cached;
export async function fetchVelaCatalog(version) {
  if (cached?.value.version === version && cached.expires > Date.now()) return cached.value;
  const response = await fetch(CATALOG, {
    headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(3500),
  });
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('catalog_unavailable');
  const catalog = await response.json();
  if (catalog.project !== 'ВЕЛА' || catalog.published !== true || !release.test(catalog.version) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(catalog.validFrom) ||
      catalog.validFrom > new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date()) ||
      !validPrice(catalog.base?.price) || catalog.base.id !== 'kit' ||
      !Array.isArray(catalog.groups) || catalog.groups.some(group => !Array.isArray(group.services))) throw new Error('catalog_invalid');
  cached = { value: catalog, expires: Date.now() + 60_000 };
  return catalog;
}

export function describeVelaLead(input, catalog, createdAt) {
  if (input.catalogVersion !== catalog.version) return versionError('catalog_changed');
  const services = catalog.groups.flatMap(group => group.services);
  const byId = new Map(services.map(service => [service.id, service]));
  if (input.selection.some(id => !byId.has(id))) return versionError('invalid_selection');
  const resolved = [catalog.base, ...input.selection.map(id => byId.get(id))].map(({ id, title, price }) => ({ id, title: normalizedLine(title, 160), price }));
  if (resolved.some(row => !row.title || row.price !== null && !validPrice(row.price))) throw new Error('catalog_invalid');
  const known = resolved.filter(row => row.price !== null);
  const pending = resolved.filter(row => row.price === null).map(({ id, title }) => ({ id, title }));
  const total = known.reduce((sum, row) => sum + row.price, 0);
  let mortgage = null;
  if (input.mortgage) {
    const { budget, down, years, rate } = input.mortgage;
    const deposit = budget * down / 100;
    const principal = budget - deposit;
    const monthlyRate = rate / 1200;
    const months = years * 12;
    const payment = monthlyRate === 0 ? principal / months : principal * monthlyRate / -Math.expm1(-months * Math.log1p(monthlyRate));
    mortgage = { ...input.mortgage, deposit, principal, payment };
  }
  const detail = {
    project: 'ВЕЛА', kind: input.kind, land: input.land, known, pending, total, mortgage,
    page: input.page, attribution: input.attribution,
    catalogVersion: input.catalogVersion, pricesFrom: catalog.validFrom,
    consent: { acceptedAt: createdAt, version: input.consentVersion, document: 'https://ikioma.ru/consent/' },
    comment: input.comment,
  };
  const message = [
    'ВЕЛА · ' + kinds[input.kind],
    'Выбранные позиции с ценой — от ' + formatMoney(total) + ' (' + input.catalogVersion + ')',
    'Участок — ' + lands[input.land],
    'Выбрано: ' + known.map(row => row.title + ' от ' + formatMoney(row.price)).join(', '),
    pending.length ? 'Индивидуально: ' + pending.map(row => row.title).join(', ') : '',
    mortgage ? 'Ипотечный сценарий: бюджет ' + formatMoney(mortgage.budget) + ', взнос ' + formatMoney(mortgage.deposit) +
      ', ставка ' + mortgage.rate + '%, срок ' + mortgage.years + ' г., платёж ' + formatMoney(mortgage.payment) + '/мес.' : '',
    'Страница: ' + input.page + ' · Источник: ' + input.attribution.channel,
    Object.entries(input.attribution.utm).map(([key, value]) => key + '=' + value).join(', '),
    'Согласие: ' + input.consentVersion + ' · ' + createdAt,
    input.comment ? 'Комментарий: ' + input.comment : '',
  ].filter(Boolean).join('\n');
  return { detail, message };
}
