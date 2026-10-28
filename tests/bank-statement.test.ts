import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBankStatement, parseBankMoney, parseBankDate, bankStatementIdentity } from '../src/domain/banking/statement.ts';

test('bank amounts parse exact kopecks and reject rounding, exponents, mixed separators and overflow', () => {
  assert.equal(parseBankMoney('1 234,56 ₽'), 123456);
  assert.equal(parseBankMoney('-1\u00a0234.5'), -123450);
  assert.equal(parseBankMoney('+0,01'), 1);
  for (const raw of ['12.345', '1,000.20', 'NaN', '1e3', '90071992547409.92', '']) assert.equal(parseBankMoney(raw), null, raw);
});
test('bank dates require unambiguous ISO or day-first full-year dates', () => {
  assert.equal(parseBankDate('28.10.2026'), '2026-10-28');
  assert.equal(parseBankDate('2026-10-28'), '2026-10-28');
  for (const raw of ['02/03/26', '2026-02-29', '31.04.2026', '2026-10-28T00:00:00Z', '']) assert.equal(parseBankDate(raw), null);
});
test('CSV autodetect handles Russian debit/credit and quoted multiline purpose without executing text', () => {
  const result = parseBankStatement('Дата;Дебет;Кредит;Контрагент;Назначение платежа;ID\r\n28.10.2026;1 234,56;;Поставщик;"Материалы; первая партия\n=HYPERLINK(test)";bank1\r\n29.10.2026;;2000,01;Клиент;Оплата;bank2');
  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.rows.map(row => [row.date, row.amountCents, row.direction]), [['2026-10-28', 123456, 'out'], ['2026-10-29', 200001, 'in']]);
  assert.ok(result.rows[0].purpose.includes('=HYPERLINK(test)'));
});
test('CSV explicit mapping supports unfamiliar bank headings and makes unsigned inference visible', () => {
  const source = 'Value;Operation day;What\n-12,55;2026-10-28;Transfer';
  const initial = parseBankStatement(source); assert.equal(initial.rows.length, 0); assert.ok(initial.warnings.length);
  const mapped = parseBankStatement(source, { mapping: { date: 1, amount: 0, purpose: 2 } });
  assert.equal(mapped.rows[0].amountCents, 1255); assert.equal(mapped.rows[0].direction, 'out'); assert.ok(mapped.warnings.length);
});
test('CSV rejects conflicting directions and double debit-credit without hiding row errors', () => {
  const a = parseBankStatement('Date;Amount;Direction\n2026-10-28;-10;in\n2026-10-29;12;out');
  assert.equal(a.errors.length, 1); assert.equal(a.errors[0].rowNumber, 2); assert.equal(a.rows.length, 1); assert.equal(a.rows[0].direction, 'out');
  const b = parseBankStatement('Дата;Дебет;Кредит\n28.10.2026;10;20\n28.10.2026;;\n28.10.2026;-10;');
  assert.equal(b.rows.length, 0); assert.equal(b.errors.length, 3);
});
test('CSV rejects duplicate column mappings, malformed quoting and wrong row width', () => {
  assert.ok(parseBankStatement('Date;Amount\n2026-10-28;10', { mapping: { date: 0, amount: 0 } }).errors.length);
  assert.throws(() => parseBankStatement('Date;Amount\n"2026-10-28;10'), /кавычка/);
  assert.equal(parseBankStatement('Date;Amount\n2026-10-28;10;extra').errors.length, 1);
});
const oneC = (account = '4070001') => `1CClientBankExchange\nВерсияФормата=1.03\nКодировка=Windows\nРасчСчет=${account}\nСекцияДокумент=Платежное поручение\nНомер=45\nДата=27.10.2026\nДатаСписано=28.10.2026\nСумма=1000.11\nПлательщикСчет=4070001\nПолучательСчет=4070002\nПолучатель=Поставщик\nНазначениеПлатежа=Счёт 5\nКонецДокумента\nСекцияДокумент=Платежное поручение\nНомер=46\nДата=27.10.2026\nДатаПоступило=29.10.2026\nСумма=1000.12\nПлательщикСчет=4070003\nПолучательСчет=4070001\nПлательщик=Клиент\nКонецДокумента\nКонецФайла`;
test('1C uses actual debit/credit date and the selected account to determine direction', () => {
  const result = parseBankStatement(oneC());
  assert.equal(result.format, '1c'); assert.deepEqual(result.accounts, ['4070001']); assert.equal(result.errors.length, 0);
  assert.deepEqual(result.rows.map(row => [row.date, row.amountCents, row.direction, row.counterparty]), [['2026-10-28', 100011, 'out', 'Поставщик'], ['2026-10-29', 100012, 'in', 'Клиент']]);
});
test('1C with several account headers requires explicit account selection and does not reverse money', () => {
  const source = oneC().replace('РасчСчет=4070001', 'РасчСчет=4070001\nРасчСчет=4070002').replace('ПолучательСчет=4070002', 'ПолучательСчет=4070002\nДатаПоступило=28.10.2026');
  assert.equal(parseBankStatement(source).rows.length, 0);
  const second = parseBankStatement(source, { accountNumber: '4070002' });
  assert.equal(second.rows.length, 1); assert.equal(second.rows[0].direction, 'in');
  assert.ok(parseBankStatement(source, { accountNumber: 'unknown' }).errors.length);
});
test('1C incomplete sections and impossible same-account cash are reported', () => {
  assert.ok(parseBankStatement(oneC().replace('КонецДокумента\nКонецФайла', 'КонецФайла')).errors.length);
  assert.ok(parseBankStatement(oneC().replace('ПолучательСчет=4070002', 'ПолучательСчет=4070001')).errors.length);
});
test('bank ID identity stays stable over overlapping exports but different transaction IDs never collapse', () => {
  const a = parseBankStatement('Date;Amount;ID\n2026-10-28;-100;a\n2026-10-28;-100;b').rows;
  assert.notEqual(bankStatementIdentity(a[0], 'account').key, bankStatementIdentity(a[1], 'account').key);
  assert.equal(bankStatementIdentity({ ...a[0], rowNumber: 900, purpose: 'Updated description' }, 'account').key, bankStatementIdentity(a[0], 'account').key);
  assert.notEqual(bankStatementIdentity(a[0], 'other-account').key, bankStatementIdentity(a[0], 'account').key);
});
test('weak composite identity is marked for review and distinguishes document numbers, dates and direction', () => {
  const row = parseBankStatement('Date;Amount;Number;Description\n2026-10-28;-100;10;Material').rows[0];
  const first = bankStatementIdentity(row, 'account'); assert.equal(first.strength, 'composite');
  assert.equal(bankStatementIdentity({ ...row, rowNumber: 500 }, 'account').key, first.key);
  assert.notEqual(bankStatementIdentity({ ...row, documentNumber: '11' }, 'account').key, first.key);
  assert.notEqual(bankStatementIdentity({ ...row, direction: 'in' }, 'account').key, first.key);
});

test('1C document date never substitutes a missing actual cash date', () => {
  const result = parseBankStatement(oneC().replace('ДатаСписано=28.10.2026', 'ДатаСписано='));
  assert.equal(result.errors.length, 1); assert.equal(result.rows.length, 1); assert.equal(result.rows[0].direction, 'in');
});
