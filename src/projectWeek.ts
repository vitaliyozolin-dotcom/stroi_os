const DAY_MS = 86_400_000;

const parseDate = (value: string) => new Date(`${value}T12:00:00Z`);

export const dateKey = (date: Date) => date.toISOString().slice(0, 10);

export const mondayOf = (value: string | Date) => {
  const date = typeof value === 'string' ? parseDate(value) : new Date(value.getTime());
  const day = date.getUTCDay();
  const delta = day === 0 ? -6 : 1 - day;
  date.setUTCDate(date.getUTCDate() + delta);
  return dateKey(date);
};

export const addDaysKey = (value: string, days: number) => {
  const date = parseDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return dateKey(date);
};

export const projectWeekNumber = (projectStart: string, date: string) => {
  const startMonday = parseDate(mondayOf(projectStart)).getTime();
  const dateMonday = parseDate(mondayOf(date)).getTime();
  return Math.floor((dateMonday - startMonday) / (7 * DAY_MS)) + 1;
};

export const projectWeekRange = (projectStart: string, date: string) => {
  const monday = mondayOf(date);
  return {
    number: projectWeekNumber(projectStart, date),
    start: monday,
    end: addDaysKey(monday, 6),
  };
};

export const stageWeekRange = (projectStart: string, stageStart: string, stageEnd: string) => ({
  start: projectWeekNumber(projectStart, stageStart),
  end: projectWeekNumber(projectStart, stageEnd),
});
