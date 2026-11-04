import assert from 'node:assert/strict';
import test from 'node:test';
import { orderMoneyField, orderMoneyInput, orderNumberInput } from '../src/presentation/customer-order-forms.ts';

test('order money input preserves unknown, explicit zero and exact kopecks', () => {
  assert.equal(orderMoneyInput(''), undefined);
  assert.equal(orderMoneyInput('0'), 0);
  assert.equal(orderMoneyInput('1 000,29'), 100029);
  assert.equal(orderMoneyInput('0.07'), 7);
});

test('order money rejects unsupported precision, ambiguous input and unsafe amounts without rounding', () => {
  for (const value of ['10,001', '1e3', '-1', '−10', '1,2,3', 'Infinity', '90071992547410.00']) assert.throws(() => orderMoneyInput(value));
  assert.throws(() => orderMoneyInput('', { required: true }));
  assert.equal(orderMoneyInput('-12,34', { signed: true }), -1234);
  assert.equal(orderMoneyInput('90071992547409.91'), Number.MAX_SAFE_INTEGER);
  assert.equal(orderMoneyField(100029), '1000,29');
  assert.equal(orderMoneyField(0), '0');
  assert.equal(orderMoneyField(undefined), '');
});

test('areas and schedule impact distinguish unknown from zero and enforce integer day changes', () => {
  assert.equal(orderNumberInput('', 'Площадь'), undefined);
  assert.equal(orderNumberInput('0', 'Площадь'), 0);
  assert.equal(orderNumberInput('24,5', 'Площадь'), 24.5);
  assert.equal(orderNumberInput('-3', 'Дни', { signed: true, integer: true }), -3);
  assert.throws(() => orderNumberInput('3.5', 'Дни', { integer: true }));
  assert.throws(() => orderNumberInput('-1', 'Площадь'));
});
