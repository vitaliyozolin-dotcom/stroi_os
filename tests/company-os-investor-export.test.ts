import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIkiomaInvestorPayload } from '../sites/company-os-investor-export.js';

test('investor export is aggregated and excludes customer/address/people data', () => {
  const payload = buildIkiomaInvestorPayload({
    generatedAt: '2026-08-18T08:00:00.000Z',
    stateRows: [{
      revision: 9,
      updated_at: '2026-08-18T07:55:00.000Z',
      state_json: JSON.stringify({
        project: {
          id: 'house-1', code: 'KEL-01', name: 'Келози', model: 'Контур', area: 120,
          clientNames: 'Секретный клиент', address: 'Секретный адрес',
          contractValue: 7_000_000, targetCost: 5_000_000,
          startDate: '2026-07-01', targetDate: '2026-10-01', forecastDate: '2026-10-20',
        },
        budgetLines: [{ id: 'b1', forecast: 5_400_000 }],
        financeEntries: [
          { id: 'e1', kind: 'expense', status: 'paid', amount: 1_000_000, counterparty: 'Секретный поставщик' },
          { id: 'e2', kind: 'expense', status: 'accepted', amount: 500_000, acceptedAmount: 400_000, paidAmount: 100_000 },
        ],
        stages: [
          { id: 's1', name: 'Фундамент', status: 'accepted', weight: 30, progress: 100, planStart: '2026-07-01', planEnd: '2026-07-15', forecastEnd: '2026-07-15' },
          { id: 's2', name: 'Контур', status: 'in_progress', weight: 70, progress: 40, planStart: '2026-07-16', planEnd: '2026-09-01', forecastEnd: '2026-09-10' },
        ],
        checkpoints: [
          { id: 'q1', stageId: 's1', status: 'accepted', photos: [{ id: 'p1', uploadedBy: 'Сотрудник', dataUrl: 'secret' }] },
          { id: 'q2', stageId: 's2', status: 'in_review', photos: [] },
        ],
        tasks: [{ id: 't1', status: 'todo', dueDate: '2020-01-01', assigneeName: 'Сотрудник' }],
        procurement: [{ id: 'p1', risk: 'Задержка', supplier: 'Секретный поставщик' }],
        documents: [{ id: 'd1', name: 'Секретный договор', fileKey: 'private' }],
      }),
    }],
  });

  assert.equal(payload.meta.project, 'ikioma-investor');
  assert.equal(payload.investor_projects.length, 1);
  const project = payload.investor_projects[0];
  assert.equal(project.forecast_cost_rub, 5_400_000);
  assert.equal(project.paid_cost_rub, 1_100_000);
  assert.equal(project.accepted_cost_rub, 400_000);
  assert.equal(project.quality.photos_count, 1);
  assert.equal(project.procurement.risk_count, 1);
  assert.equal(project.tasks.overdue_count, 1);
  const serialized = JSON.stringify(payload);
  for (const forbidden of ['Секретный клиент', 'Секретный адрес', 'Секретный поставщик', 'Сотрудник', 'dataUrl', 'fileKey']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});
