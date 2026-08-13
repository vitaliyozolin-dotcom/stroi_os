export const addCalendarDays = (date, days) => {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
};

export const isoDate = (date = new Date()) => date.toISOString().slice(0, 10);

// Telegram historically used these names for the same UTC calendar operations.
export const addDays = addCalendarDays;
export const dateKey = isoDate;
