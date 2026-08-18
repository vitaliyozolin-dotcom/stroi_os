import { clean } from '../lib/validation.js';

const TELEGRAM_COMMAND_NAMES = [
  'task', 'tasks', 'stages', 'done', 'finance', 'expense', 'status',
  'note', 'report', 'doc', 'camera', 'project', 'help',
];

export const telegramCommandDistance = (left, right) => {
  const a = clean(left, 40).toLocaleLowerCase('en-US');
  const b = clean(right, 40).toLocaleLowerCase('en-US');
  const matrix = Array.from({ length: a.length + 1 }, (_, row) => (
    Array.from({ length: b.length + 1 }, (_, column) => row ? (column ? 0 : row) : column)
  ));
  for (let row = 1; row <= a.length; row += 1) {
    for (let column = 1; column <= b.length; column += 1) {
      const cost = a[row - 1] === b[column - 1] ? 0 : 1;
      matrix[row][column] = Math.min(
        matrix[row - 1][column] + 1,
        matrix[row][column - 1] + 1,
        matrix[row - 1][column - 1] + cost,
      );
      if (row > 1 && column > 1 && a[row - 1] === b[column - 2] && a[row - 2] === b[column - 1]) {
        matrix[row][column] = Math.min(matrix[row][column], matrix[row - 2][column - 2] + 1);
      }
    }
  }
  return matrix[a.length][b.length];
};

export const telegramCommandSuggestion = (value) => {
  const name = clean(value, 40).toLocaleLowerCase('en-US');
  if (!name) return '';
  const ranked = TELEGRAM_COMMAND_NAMES
    .map((candidate) => ({ candidate, distance: telegramCommandDistance(name, candidate) }))
    .sort((left, right) => left.distance - right.distance || left.candidate.localeCompare(right.candidate));
  return ranked[0]?.distance <= 1 ? ranked[0].candidate : '';
};

export const commandFromText = (value) => {
  const text = clean(value, 3000);
  const match = text.match(/^\/([a-z_]+)(?:@([a-z0-9_]+))?(?:\s+([\s\S]*))?$/i);
  return match ? {
    name: match[1].toLocaleLowerCase('en-US'),
    target: clean(match[2], 120).toLocaleLowerCase('en-US'),
    body: clean(match[3], 2400),
  } : null;
};

export const telegramCommandTargetsBot = (command, botUsername) => !command?.target
  || command.target === clean(botUsername, 120).replace(/^@/u, '').toLocaleLowerCase('en-US');

export const parseTelegramExpense = (value) => {
  const source = clean(value, 2400).replace(/\u00a0/gu, ' ').trim();
  const amountMatch = source.match(/\d[\d ]*(?:[.,]\d{1,2})?/u);
  if (!amountMatch || amountMatch.index === undefined) return null;
  const amount = Number(amountMatch[0].replace(/\s+/gu, '').replace(',', '.'));
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000) return null;
  const before = source.slice(0, amountMatch.index);
  const after = source.slice(amountMatch.index + amountMatch[0].length)
    .replace(/^\s*(?:₽|руб(?:\.?|ля|лей)?|р\.)\s*/iu, ' ');
  const description = clean(`${before} ${after}`.replace(/^\s*(?:на|за)\s+/iu, '').replace(/^[\s:—-]+|[\s:—-]+$/gu, ''), 500);
  return description ? { amount, description } : null;
};

export const naturalTelegramCommand = (value) => {
  const source = clean(value, 3000).trim();
  const text = source.toLocaleLowerCase('ru').replace(/ё/g, 'е');
  const writeIntent = source.match(/^(?:запиши(?:\s+в\s+ос)?|зафиксируй|добавь)\s+([а-яё]+)(?=\s|[:—-]|$)\s*[:—-]?\s*([\s\S]*)$/iu);
  if (writeIntent) {
    const token = writeIntent[1].toLocaleLowerCase('ru').replace(/ё/g, 'е');
    const expenseWords = ['расход', 'расхода', 'расходу', 'расходы', 'расходов', 'затрата', 'затрату', 'затраты', 'трата', 'трату', 'траты', 'оплата', 'оплату'];
    const likelyExpense = expenseWords.some((word) => telegramCommandDistance(token, word) <= 1);
    if (likelyExpense) return { name: 'expense', body: clean(writeIntent[2], 2400) };
  }
  const note = source.match(/^(?:запомни|зафиксируй|запиши(?:\s+в\s+ос)?|добавь\s+заметку)\s*[:—-]?\s*([\s\S]+)$/iu);
  if (note?.[1]) return { name: 'note', body: clean(note[1], 2400) };
  if (/(этап|этапы|стадии|ход работ)/u.test(text)) return { name: 'stages', body: '' };
  if (/(выполненн|завершенн|сделанн).{0,20}(задач|работ)|что (сделано|выполнено)/u.test(text)) return { name: 'done', body: '' };
  if (/(расход|доход|финанс|деньг|оплачен|получен)/u.test(text)) return { name: 'finance', body: '' };
  if (/(задач|дела).{0,20}(открыт|текущ|актив)|что делать/u.test(text)) return { name: 'tasks', body: '' };
  if (/(статус|состояние|что на объекте)/u.test(text)) return { name: 'status', body: '' };
  return null;
};

export const naturalTelegramIntent = (value) => naturalTelegramCommand(value)?.name ?? '';
