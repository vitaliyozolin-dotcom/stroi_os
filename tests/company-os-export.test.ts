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

test('IKIOMA export contains no customer PII and only unpaid obligations', () => {
  const payload = buildIkiomaCompanyOsPayload({
    generatedAt: '2026-08-18T07:00:00.000Z',
    stateRows: [{
      revision: 12,
      updated_at: '2026-08-18T06:55:00.000Z',
      state_json: JSON.stringify({
        project: { id: 'house-1', code: 'KEL-01', name: 'Келози' },
        financeEntries: [
          { id: 'e1', kind: 'expense', status: 'committed', amount: 500000, paidAmount: 100000, date: '2026-08-22', counterparty: 'Секретный поставщик' },
          { id: 'e2', kind: 'expense', status: 'paid', amount: 200000, date: '2026-08-20' },
          { id: 'i1', kind: 'income', status: 'committed', amount: 700000, date: '2026-08-21' },
        ],
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
  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes('Иван Иванов'), false);
  assert.equal(serialized.includes('+79990000000'), false);
  assert.equal(serialized.includes('private@example.com'), false);
  assert.equal(serialized.includes('Секретный поставщик'), false);
});
