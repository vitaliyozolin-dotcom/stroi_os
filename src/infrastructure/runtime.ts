export const uid = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
export const systemClock = { now: () => new Date().toISOString() };
export const runtimeIdGenerator = { next: uid };
