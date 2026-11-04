/** Money input is parsed digit-by-digit; no float multiplication or silent rounding. */
export function orderMoneyInput(value: string, { signed = false, required = false }: { signed?: boolean; required?: boolean } = {}): number | undefined {
  const cleaned = value.trim().replace(/[\s\u00a0\u202f]/g, '').replace(',', '.');
  if (!cleaned) {
    if (required) throw new Error('Укажите сумму.');
    return undefined;
  }
  const pattern = signed ? /^(-?)(\d+)(?:\.(\d{1,2}))?$/ : /^()(\d+)(?:\.(\d{1,2}))?$/;
  const match = pattern.exec(cleaned);
  if (!match) throw new Error('Укажите сумму в рублях, не более двух знаков после запятой.');
  const cents = BigInt(match[2]) * 100n + BigInt((match[3] ?? '').padEnd(2, '0'));
  const result = Number(match[1] ? -cents : cents);
  if (!Number.isSafeInteger(result)) throw new Error('Сумма превышает допустимое значение.');
  return result;
}

export function orderMoneyField(value: number | undefined): string {
  if (value === undefined) return '';
  const absolute = Math.abs(value), cents = absolute % 100;
  return `${value < 0 ? '-' : ''}${Math.floor(absolute / 100)}${cents ? `,${String(cents).padStart(2, '0')}` : ''}`;
}

export function orderNumberInput(value: string, label: string, { signed = false, integer = false }: { signed?: boolean; integer?: boolean } = {}): number | undefined {
  if (!value.trim()) return undefined;
  const cleaned = value.trim().replace(',', '.');
  if (!(signed ? /^-?\d+(?:\.\d+)?$/ : /^\d+(?:\.\d+)?$/).test(cleaned)) throw new Error(`Проверьте поле «${label}».`);
  const number = Number(cleaned);
  if (!Number.isFinite(number) || Math.abs(number) > Number.MAX_SAFE_INTEGER || (integer && !Number.isInteger(number))) throw new Error(`Проверьте поле «${label}».`);
  return number;
}

export const orderSelectedIds = (value: string | undefined): string[] => [...new Set((value ?? '').split('|').filter(Boolean))];
