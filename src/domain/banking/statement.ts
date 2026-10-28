/** Local statement parsing only. Import and reconciliation require an explicit review. */
export type BankDirection = 'in' | 'out';
export interface BankStatementRow {
  rowNumber: number;
  date: string;
  amountCents: number;
  direction: BankDirection;
  externalId?: string;
  documentNumber?: string;
  purpose: string;
  counterparty: string;
  payerAccount?: string;
  recipientAccount?: string;
  statementAccount?: string;
}
export interface BankColumnMapping {
  date: number;
  amount?: number;
  debit?: number;
  credit?: number;
  direction?: number;
  externalId?: number;
  documentNumber?: number;
  purpose?: number;
  counterparty?: number;
  payerAccount?: number;
  recipientAccount?: number;
  currency?: number;
}
export interface BankStatementPreview {
  format: 'csv' | '1c';
  headers: string[];
  mapping: BankColumnMapping | null;
  rows: BankStatementRow[];
  errors: { rowNumber: number; message: string }[];
  warnings: string[];
  accounts: string[];
}
const clean = (value: unknown) => String(value ?? '').trim();
const normalized = (value: string) => value.toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/[\s_.():/\\-]+/g, '');
const dateValid = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date + 'T12:00:00Z')) && new Date(date + 'T12:00:00Z').toISOString().slice(0, 10) === date;
export function parseBankDate(value: string): string | null {
  const raw = clean(value), dotted = /^(\d{2})[./](\d{2})[./](\d{4})$/.exec(raw);
  const result = dotted ? `${dotted[3]}-${dotted[2]}-${dotted[1]}` : raw;
  return dateValid(result) ? result : null;
}
/** Exact decimal parsing: rejects rounding, exponents and ambiguous punctuation. */
export function parseBankMoney(value: string): number | null {
  const raw = clean(value).replace(/[\s\u00a0\u202f]/g, '').replace(/(?:₽|руб\.?|RUB)$/i, '');
  if (raw.length > 64 || !/^[+-]?\d+(?:[.,]\d{1,2})?$/.test(raw)) return null;
  const negative = raw.startsWith('-'), unsigned = raw.replace(/^[+-]/, ''), [whole, fraction = ''] = unsigned.split(/[.,]/);
  const result = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  const signed = negative ? -result : result;
  return signed <= BigInt(Number.MAX_SAFE_INTEGER) && signed >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(signed) : null;
}
const fieldNames: Record<keyof BankColumnMapping, string[]> = {
  date: ['дата', 'датаплатежа', 'датаоперации', 'датапроводки', 'датасписания', 'operationdate', 'date'],
  amount: ['сумма', 'суммаоперации', 'amount'], debit: ['дебет', 'списание', 'расход', 'debit', 'outflow'], credit: ['кредит', 'зачисление', 'приход', 'credit', 'inflow'],
  direction: ['направление', 'типоперации', 'direction', 'type'], externalId: ['идентификатор', 'идоперации', 'idоперации', 'идентификатороперации', 'externalid', 'transactionid', 'id'],
  documentNumber: ['номер', 'номердокумента', 'номерплатежа', 'documentnumber', 'number'], purpose: ['назначение', 'назначениеплатежа', 'описание', 'purpose', 'description'],
  counterparty: ['контрагент', 'получательплательщик', 'counterparty'], payerAccount: ['счетплательщика', 'плательщиксчет', 'payeraccount'], recipientAccount: ['счетполучателя', 'получательсчет', 'recipientaccount'], currency: ['валюта', 'кодвалюты', 'currency'],
};
export function detectBankColumns(headers: string[]): BankColumnMapping | null {
  const found: Partial<BankColumnMapping> = {};
  for (const [field, names] of Object.entries(fieldNames)) {
    const index = headers.findIndex(header => names.includes(normalized(header)));
    if (index >= 0) found[field as keyof BankColumnMapping] = index;
  }
  return found.date !== undefined ? found as BankColumnMapping : null;
}
function csvRows(source: string): string[][] {
  const first = source.split(/\r?\n/, 1)[0];
  const counts = [';', '\t', ','].map(delimiter => { let count = 0, quoted = false; for (const char of first) { if (char === '"') quoted = !quoted; else if (!quoted && char === delimiter) count++; } return { delimiter, count }; });
  const delimiter = counts.sort((a, b) => b.count - a.count)[0].delimiter;
  const rows: string[][] = []; let row: string[] = [], value = '', quoted = false, closed = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') { value += '"'; i++; }
      else if (char === '"') { quoted = false; closed = true; }
      else value += char;
    } else if (char === '"') {
      if (value || closed) throw new Error('Кавычки внутри непроцитированной ячейки CSV.');
      quoted = true;
    } else if (char === delimiter) { row.push(value); value = ''; closed = false; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i++;
      row.push(value); if (row.some(cell => clean(cell))) rows.push(row); row = []; value = ''; closed = false;
    } else if (!closed || /\s/.test(char)) { if (!closed) value += char; }
    else throw new Error('Лишний текст после закрывающей кавычки CSV.');
    if (rows.length > 5000) throw new Error('В одном импорте допускается до 5000 строк.');
  }
  if (quoted) throw new Error('Незакрытая кавычка CSV.');
  row.push(value); if (row.some(cell => clean(cell))) rows.push(row);
  return rows;
}
const directionValue = (value: string): BankDirection | null => clean(value) === '-' ? 'out' : clean(value) === '+' ? 'in' : ['in', 'income', 'credit', 'приход', 'поступление', 'зачисление', '+'].includes(normalized(value)) ? 'in'
  : ['out', 'expense', 'debit', 'расход', 'списание', 'выплата', '-'].includes(normalized(value)) ? 'out' : null;
function parseCsv(source: string, mapping?: BankColumnMapping): BankStatementPreview {
  const rawRows = csvRows(source), headers = rawRows.shift()?.map(clean) ?? [];
  const map = mapping ?? detectBankColumns(headers);
  const result: BankStatementPreview = { format: 'csv', headers, mapping: map, rows: [], errors: [], warnings: [], accounts: [] };
  if (!headers.length) { result.errors.push({ rowNumber: 1, message: 'Файл пуст.' }); return result; }
  if (!map || map.date < 0 || map.date >= headers.length || map.amount === undefined && map.debit === undefined && map.credit === undefined) {
    result.warnings.push('Сопоставьте столбцы даты и суммы либо списания/зачисления.'); return result;
  }
  const indices = Object.values(map).filter(index => index !== undefined);
  if (indices.some(index => !Number.isInteger(index) || index < 0 || index >= headers.length) || new Set(indices).size !== indices.length) {
    result.errors.push({ rowNumber: 1, message: 'Каждому полю нужен отдельный существующий столбец.' }); return result;
  }
  rawRows.forEach((cells, index) => {
    const rowNumber = index + 2;
    try {
      if (cells.length !== headers.length) throw new Error(`Ожидалось ${headers.length} ячеек, получено ${cells.length}.`);
      const at = (key: keyof BankColumnMapping) => map[key] === undefined ? '' : clean(cells[map[key]!]);
      if (at('currency') && !['RUB', 'RUR', '643', 'РУБ', 'РУБ.', '₽'].includes(at('currency').toLocaleUpperCase('ru'))) throw new Error('Поддерживается выписка в рублях. Конвертация валюты не выполняется.');
      const date = parseBankDate(at('date')); if (!date) throw new Error('Некорректная дата. Используйте ДД.ММ.ГГГГ или ГГГГ-ММ-ДД.');
      let amountCents: number | null = null, direction: BankDirection | null = null;
      if (map.debit !== undefined || map.credit !== undefined) {
        const debit = at('debit') ? parseBankMoney(at('debit')) : 0, credit = at('credit') ? parseBankMoney(at('credit')) : 0;
        if (debit === null || credit === null || debit < 0 || credit < 0 || Boolean(debit) === Boolean(credit)) throw new Error('Заполните ровно одну положительную сумму: списание или зачисление.');
        amountCents = debit || credit; direction = debit ? 'out' : 'in';
      } else {
        const signed = parseBankMoney(at('amount')); if (signed === null || signed === 0) throw new Error('Некорректная или нулевая сумма; допустимы две цифры после запятой.');
        direction = map.direction === undefined ? signed < 0 ? 'out' : 'in' : directionValue(at('direction'));
        if (!direction) throw new Error('Направление не распознано: укажите приход/расход или in/out.');
        if (signed < 0 && direction === 'in') throw new Error('Отрицательная сумма противоречит направлению поступления.');
        amountCents = Math.abs(signed);
      }
      result.rows.push({ rowNumber, date, amountCents: amountCents!, direction: direction!, purpose: at('purpose'), counterparty: at('counterparty'),
        ...(at('externalId') ? { externalId: at('externalId') } : {}), ...(at('documentNumber') ? { documentNumber: at('documentNumber') } : {}),
        ...(at('payerAccount') ? { payerAccount: at('payerAccount') } : {}), ...(at('recipientAccount') ? { recipientAccount: at('recipientAccount') } : {}) });
    } catch (error) { result.errors.push({ rowNumber, message: error instanceof Error ? error.message : 'Строка не распознана.' }); }
  });
  if (map.amount !== undefined && map.direction === undefined && map.debit === undefined && map.credit === undefined) result.warnings.push('Направление определено знаком суммы: плюс — поступление, минус — списание. Проверьте это правило перед импортом.');
  return result;
}
function parse1c(source: string, selectedAccount?: string): BankStatementPreview {
  const result: BankStatementPreview = { format: '1c', headers: [], mapping: null, rows: [], errors: [], warnings: [], accounts: [] };
  const lines = source.split(/\r?\n/), documents: { fields: Record<string, string>; rowNumber: number }[] = []; let current: typeof documents[number] | null = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim(), split = line.indexOf('='), key = split >= 0 ? line.slice(0, split) : line, value = split >= 0 ? line.slice(split + 1).trim() : '';
    if (key === 'СекцияДокумент') { if (current) result.errors.push({ rowNumber: current.rowNumber, message: 'Секция документа не закрыта.' }); current = { rowNumber: index + 1, fields: {} }; }
    else if (key === 'КонецДокумента') { if (current) documents.push(current); current = null; }
    else if (current) current.fields[key] = value;
    else if (key === 'РасчСчет' && value && !result.accounts.includes(value)) result.accounts.push(value);
  }
  if (current) result.errors.push({ rowNumber: current.rowNumber, message: 'Секция документа не закрыта.' });
  if (documents.length > 5000) throw new Error('В одном импорте допускается до 5000 строк.');
  const account = selectedAccount || (result.accounts.length === 1 ? result.accounts[0] : '');
  if (!account) { result.warnings.push('Выберите расчётный счёт выписки: он нужен для определения направления.'); return result; }
  if (result.accounts.length && !result.accounts.includes(account)) { result.errors.push({ rowNumber: 1, message: 'Выбранный счёт отсутствует в заголовке выписки.' }); return result; }
  for (const { fields, rowNumber } of documents) {
    try {
      if (fields.Валюта && !['RUB', 'RUR', '643', 'РУБ', 'РУБ.', '₽'].includes(fields.Валюта.toLocaleUpperCase('ru'))) throw new Error('Поддерживается выписка в рублях.');
      const payer = fields.ПлательщикСчет || fields.ПлательщикРасчСчет, recipient = fields.ПолучательСчет || fields.ПолучательРасчСчет;
      if (payer === account && recipient === account) throw new Error('Одинаковый счёт плательщика и получателя; требуется ручная проверка.');
      const direction = payer === account ? 'out' : recipient === account ? 'in' : null;
      if (!direction) continue; // Statement can contain several accounts; show selected account only.
      const date = parseBankDate((direction === 'out' ? fields.ДатаСписано : fields.ДатаПоступило) || '');
      if (!date) throw new Error('Нет корректной даты списания/зачисления. Дата документа не заменяет дату движения денег.');
      const amountCents = parseBankMoney(fields.Сумма || '');
      if (!date || !amountCents || amountCents < 0) throw new Error('Некорректная дата движения или сумма.');
      result.rows.push({ rowNumber, date, amountCents, direction, statementAccount: account, payerAccount: payer, recipientAccount: recipient,
        documentNumber: fields.Номер || undefined, externalId: fields.ИдентификаторОперации || fields.ИдентификаторДокумента || undefined,
        purpose: fields.НазначениеПлатежа || '', counterparty: direction === 'out' ? fields.Получатель || fields.Получатель1 || '' : fields.Плательщик || fields.Плательщик1 || '' });
    } catch (error) { result.errors.push({ rowNumber, message: error instanceof Error ? error.message : 'Строка не распознана.' }); }
  }
  if (!result.rows.length && !result.errors.length) result.warnings.push('Для выбранного счёта нет денежных движений.');
  return result;
}
export function parseBankStatement(source: string, options: { mapping?: BankColumnMapping; accountNumber?: string } = {}): BankStatementPreview {
  const text = source.replace(/^\uFEFF/, '');
  if (text.length > 5_000_000) throw new Error('Размер выписки превышает 5 МБ. Разделите период.');
  return /^1CClientBankExchange(?:\r?\n|$)/.test(text) ? parse1c(text, options.accountNumber) : parseCsv(text, options.mapping);
}
/** Strong bank ID when present; otherwise a reviewable composite identity stable across file re-exports. */
export function bankStatementIdentity(row: BankStatementRow, accountId: string): { key: string; strength: 'bank_id' | 'composite' } {
  const parts = row.externalId ? ['bank-id', accountId, row.externalId] : ['bank-row', accountId, row.date, row.direction, row.amountCents, row.documentNumber ?? '', row.payerAccount ?? '', row.recipientAccount ?? '', normalized(row.counterparty), normalized(row.purpose)];
  const input = JSON.stringify(parts); let hash = 14695981039346656037n;
  for (let index = 0; index < input.length; index++) hash = BigInt.asUintN(64, (hash ^ BigInt(input.charCodeAt(index))) * 1099511628211n);
  return { key: `statement-v1:${hash.toString(16).padStart(16, '0')}`, strength: row.externalId ? 'bank_id' : 'composite' };
}
