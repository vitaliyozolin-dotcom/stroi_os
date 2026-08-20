import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIkiomaCompanyOsPayload, validateCompanyOsClaims } from '../sites/company-os-export.js';

test('Company OS claims are restricted to Company-OS main', () => {
  const now = 2_000_000_000;
  assert.equal(validateCompanyOsClaims({
    iss: 'https://token.actions.githubusercontent.com',
    aud: 'company-os-export',
    repository: 'vitaliyozolin-dotcom/Company-OS',
    ref: 'refs/heads/main',
    iat: now - 5,
    exp: now + 60,
  }, now), true);
  assert.throws(() => validateCompanyOsClaims({
    iss: 'https://token.actions.githubusercontent.com',
    aud: 'company-os-export',
    repository: 'someone/other-repo',
    ref: 'refs/heads/main',
    exp: now + 60,
  }, now), /invalid_repository/);
});

test('IKIOMA export contains no customer PII, only unpaid obligations and investor evidence', () => {
  const payload = buildIkiomaCompanyOsPayload({
    generatedAt: '2026-08-18T07:00:00.000Z',
    stateRows: [{
      revision: 12,
      updated_at: '2026-08-18T06:55:00.000Z',
      state_json: JSON.stringify({
        project: {
          id: 'house-1', code: 'KEL-01', name: 'Келози', contractValue: 7000000,
          targetCost: 5000000, startDate: '2026-06-01', targetDate: '2026-09-30',
          forecastDate: '2026-10-10', cameraStatus: 'online',
        },
        budgetLines: [{ plan: 5000000, forecast: 5400000 }],
        stages: [
          { id: 's1', name: 'Фундамент', shortName: 'Фундамент', weight: 50, progress: 100, status: 'accepted', planEnd: '2026-07-01', forecastEnd: '2026-07-01' },
          { id: 's2', name: 'Коробка', shortName: 'Коробка', weight: 50, progress: 40, status: 'in_progress', planEnd: '2026-08-20', forecastEnd: '2026-08-30' },
        ],
        financeEntries: [
          { id: 'e1', kind: 'expense', status: 'committed', amount: 500000, paidAmount: 100000, date: '2026-08-22', counterparty: 'Секретный поставщик' },
          { id: 'e2', kind: 'expense', status: 'paid', amount: 200000, date: '2026-08-20' },
          { id: 'i1', kind: 'income', status: 'committed', amount: 700000, date: '2026-08-21' },
        ],
        checkpoints: [{ status: 'accepted', photos: [{ id: 'p1' }] }, { status: 'pending', photos: [] }],
        fieldReports: [{ id: 'r1' }],
        documents: [{ id: 'd1' }],
        procurement: [{ item: 'SIP', risk: 'задержка' }],
        leads: [{
          id: 'lead-1', name: 'Иван Иванов', phone: '+79990000000', email: 'private@example.com',
          stage: 'estimate', createdAt: '2026-08-16T10:00:00Z', nextActionAt: '2026-08-18T10:00:00Z',
          budget: 7000000, owner: 'Менеджер',
        }],
      }),
    }],
  });

  assert.equal(payload.finance_projects.length, 1);
  assert.equal(payload.finance_projects[0].commitments.length, 1);
  assert.equal(payload.finance_projects[0].commitments[0].amount_rub, 400000);
  assert.equal(payload.finance_projects[0].bank_balance_confirmed, false);
  assert.equal(payload.sales_opportunities[0].stage, 'proposal');
  assert.equal(payload.sales_opportunities[0].value_rub, 7000000);

  assert.equal(payload.investor_projects.length, 1);
  const investor = payload.investor_projects[0];
  assert.equal(investor.forecast_cost_rub, 5400000);
  assert.equal(investor.physical_progress_pct, 70);
  assert.equal(investor.accepted_progress_pct, 50);
  assert.equal(investor.evidence.photos_count, 1);
  assert.equal(investor.risks.length, 1);

  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes('Иван Иванов'), false);
  assert.equal(serialized.includes('+79990000000'), false);
  assert.equal(serialized.includes('private@example.com'), false);
  assert.equal(serialized.includes('Секретный поставщик'), false);
});
