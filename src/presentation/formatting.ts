export const money = (value: number, compact = false) =>
  new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    maximumFractionDigits: 0,
    notation: compact ? 'compact' : 'standard',
  }).format(value);

export const shortMoney = (value: number) => {
  const absolute = Math.abs(value);
  if (absolute < 1_000) return `${Math.round(value).toLocaleString('ru-RU')} ₽`;
  if (absolute < 1_000_000) return `${(value / 1_000).toFixed(absolute >= 100_000 ? 0 : 1).replace('.', ',')} тыс. ₽`;
  return `${(value / 1_000_000).toFixed(absolute >= 10_000_000 ? 0 : 2).replace('.', ',')} млн ₽`;
};

export const formatDate = (value: string, withYear = false) =>
  new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'short',
    ...(withYear ? { year: 'numeric' } : {}),
  }).format(new Date(value));

export const formatDateTime = (value: string) =>
  new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
