const date = value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
  const stamp = Date.parse(`${value}T12:00:00Z`);
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === value ? stamp : null;
};
const DAY = 86_400_000;
export function projectScheduleDashboard(state, forecast, today) {
  const rows = [...state.stages].filter(stage => stage.schedule?.kind !== 'summary').sort((a,b) => a.order - b.order).map(stage => {
    const planned = forecast.rows.find(item => item.id === stage.id);
    const complete = ['accepted','awaiting_inspection'].includes(stage.status);
    const start = complete ? stage.actualStart || stage.completedOn || stage.actualEnd || null : planned?.start || stage.planStart || null;
    const end = complete ? stage.completedOn || stage.actualEnd || stage.completionObservedOn || null : planned?.end || stage.forecastEnd || stage.planEnd || null;
    return { id:stage.id, name:stage.shortName || stage.name, status:stage.status, start:date(start) === null ? null : start, end:date(end) === null ? null : end, progress: Math.max(0, Math.min(100, stage.progress || 0)) };
  });
  const dates = [today, state.project.targetDate, ...rows.flatMap(row => [row.start,row.end])].filter(value => date(value) !== null).sort();
  const first = dates[0] || today, last = dates.at(-1) || today;
  const total = Math.max(DAY, date(last) - date(first));
  const position = value => date(value) === null ? null : Math.max(0, Math.min(100, (date(value) - date(first)) / total * 100));
  const exactForecast = ['observed','incomplete'].includes(forecast.kind) ? null : date(forecast.end);
  const contract = date(state.project.targetDate);
  return { first, last, contractDelta: exactForecast !== null && contract !== null ? Math.round((exactForecast-contract)/DAY) : null,
    todayPosition: position(today), contractPosition: position(state.project.targetDate),
    rows: rows.map(row => ({ ...row, left:Math.min(99.3,position(row.start) || 0), width:row.start && row.end ? Math.max(0.7, (date(row.end)-date(row.start))/total*100) : 0 })) };
}
