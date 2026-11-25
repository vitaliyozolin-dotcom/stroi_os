export const salesStages = [
  { key: 'lost', code: '0.1', label: 'Отказ' },
  { key: 'deferred', code: '0.2', label: 'Отложенный спрос' },
  { key: 'new', code: '0.5', label: 'Запрос внесён в базу' },
  { key: 'qualified', code: '0.6', label: 'Лид квалифицирован' },
  { key: 'preparation', code: '0.7', label: 'Передано руководителю проекта в расчёт' },
  { key: 'estimate', code: '0.8', label: 'Подготовлено предложение подрядчика' },
  { key: 'negotiation', code: '0.9', label: 'Заказчику отправлено первое КП' },
  { key: 'won', code: '0.95', label: 'Заключён договор' },
  { key: 'escrow_funded', code: '1.0', label: 'Эскроу наполнен' },
];
export const salesLabel = stage => {
  const def = salesStages.find(item => item.key === stage);
  return def ? `${def.code} · ${def.label}` : 'Требует сверки';
};
export const nextSalesStage = stage => {
  if (['lost', 'deferred', 'escrow_funded'].includes(stage)) return stage;
  const index = salesStages.findIndex(item => item.key === stage);
  return salesStages[index + 1]?.key ?? stage;
};
const filled = value => typeof value === 'string' && value.trim() !== '' && value !== 'unknown';
export function qualificationBlockers(lead) {
  const q = lead.qualification ?? {};
  const missing = [];
  if (!(lead.budget > 0)) missing.push('сумма бюджета');
  if (!filled(q.technology)) missing.push('технология');
  if (!['standard', 'individual'].includes(q.projectType)) missing.push('типовой или индивидуальный проект');
  if (!filled(q.projectModel) || !filled(q.completionScope)) missing.push('проект и комплектация');
  if (!filled(lead.mortgageStatus)) missing.push('с ипотекой или без');
  if (!filled(q.financingSource)) missing.push('источник финансирования');
  if (['needed', 'approved'].includes(lead.mortgageStatus)) {
    if (!['with', 'without'].includes(q.downPaymentMode)) missing.push('с ПВ или без ПВ');
    if (!filled(q.mortgageProgram)) missing.push('семейная или обычная ипотека');
  }
  if (!filled(lead.landStatus)) missing.push('статус участка');
  if (!['select', 'check'].includes(q.plotAction)) missing.push('подбор или проверка участка');
  return missing.length ? ['Заполните критерии квалификации: ' + missing.join(', ') + '.'] : [];
}

// Compare the same local clock time one calendar month later. Moscow is UTC+3,
// including at month end when the original day does not exist in the next month.
export function monthExpired(enteredAt, now) {
  const start = Date.parse(enteredAt);
  if (!Number.isFinite(start)) return false;
  const offset = 3 * 60 * 60 * 1000;
  const end = new Date(start + offset);
  const day = end.getUTCDate();
  end.setUTCMonth(end.getUTCMonth() + 1, 1);
  const lastDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
  end.setUTCDate(Math.min(day, lastDay));
  return Date.parse(now) > end.getTime() - offset;
}
export function migrateLead(lead, now, activity = []) {
  if (lead.stageEnteredAt && salesStages.some(def => def.key === lead.stage)) return lead;
  let stage = lead.stage;
  // Old labels described work in progress. Only carry milestones actually evidenced.
  if (['qualified', 'site_visit', 'estimate', 'negotiation'].includes(stage)) {
    stage = lead.projectId ? 'preparation' : qualificationBlockers(lead).length ? 'new' : 'qualified';
  }
  if (!salesStages.some(def => def.key === stage)) stage = 'new';
  const lastNew = stage === 'new' && lead.stage === 'new'
    ? activity.filter(event => event.text === `${lead.name}: этап «Новая»`).map(event => event.timestamp).sort().at(-1) : '';
  const stageEnteredAt = stage !== lead.stage ? now : lastNew || lead.preparedAt || lead.createdAt || now;
  return { ...lead, ...(stage !== lead.stage ? { previousStage: lead.stage } : {}), stage, stageEnteredAt };
}

export function escrowFundingBlockers(state) {
  const funding = state.project.funding;
  const plan = funding?.escrow?.planned, fact = funding?.escrow?.deposited;
  const lead = state.leads?.find(row => row.id === state.project.lifecycle?.sourceLeadId);
  const total = plan?.amountCents || Math.round((state.project.contractValue || 0) * 100);
  const missing = [];
  if (funding?.route !== 'escrow' || !filled(funding.bank) || !(filled(funding.escrowAccountId) || filled(funding.escrowAccountReference))) missing.push('Укажите банк и открытый счёт эскроу.');
  if (!(total > 0)) missing.push('Укажите сумму, которая должна поступить на эскроу.');
  if (!fact?.date || !filled(fact.source) || !(fact.amountCents > 0) || fact.amountCents < total) missing.push('Подтвердите поступление всей суммы на эскроу.');
  const mortgage = ['needed', 'approved'].includes(lead?.mortgageStatus) || state.orderRelations?.mortgages?.some(row => row.fundingRoute === 'escrow' && ['approved', 'funded'].includes(row.status));
  const bank = plan?.bankAmountCents ?? (lead?.mortgageStatus === 'approved' ? Math.round((lead.qualification?.approvedLoan || 0) * 100) : 0);
  if ((bank > 0 || mortgage) && (!(fact?.bankAmountCents > 0) || fact.bankAmountCents < bank)) missing.push('Подтвердите поступление кредитных средств банка.');
  const maternity = Math.max(plan?.maternityAmountCents || 0, Math.round((lead?.qualification?.maternityCapital || 0) * 100));
  if (maternity > 0 && !(fact?.maternityAmountCents >= maternity)) missing.push('Дождитесь полного перечисления маткапитала на эскроу.');
  return missing;
}
