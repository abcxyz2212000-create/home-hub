import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceAt, applyPriceChange, periodText, sortedHistory } from '../../web/js/prices.js';
import { plannedInMonth } from '../../web/js/mf.js';

test('amount by period: the month decides the amount', () => {
  const c = { amount: 6000, cycle: 'yearly', renewal_date: '2027-04-18',
    price_history: [{ amount: 6000, from: '2026-04', to: null }, { amount: 5000, from: '2022-04', to: '2026-03' }] };
  assert.equal(priceAt(c, '2025-04'), 5000);
  assert.equal(priceAt(c, '2026-04'), 6000);
  assert.equal(priceAt(c, '2022-03'), 0, 'before the first period');
  assert.equal(plannedInMonth(c, '2024-04'), 5000);
  assert.equal(plannedInMonth(c, '2026-04'), 6000);
  assert.equal(plannedInMonth(c, '2026-05'), 0, 'yearly: only in the renewal month');
  assert.equal(priceAt({ amount: 4000, price_history: [] }, '2020-01'), 4000, 'no history = current amount always');
});

test('changing the amount ends the running period the month before', () => {
  let h = applyPriceChange([], 11000, 12000, '2026-12');
  assert.deepEqual(h, [{ amount: 11000, from: null, to: '2026-11' }, { amount: 12000, from: '2026-12', to: null }]);
  h = applyPriceChange(h, 12000, 12500, '2027-04');
  assert.deepEqual(h.map((p) => [p.amount, p.from, p.to]), [[11000, null, '2026-11'], [12000, '2026-12', '2027-03'], [12500, '2027-04', null]]);
  // corrected again from an earlier month: later periods are replaced
  h = applyPriceChange(h, 12500, 13000, '2027-01');
  assert.deepEqual(h.map((p) => [p.amount, p.from, p.to]), [[11000, null, '2026-11'], [12000, '2026-12', '2026-12'], [13000, '2027-01', null]]);
  assert.deepEqual(applyPriceChange([], null, 500, '2026-05'), [{ amount: 500, from: '2026-05', to: null }]);
  assert.equal(periodText({ from: null, to: '2026-11' }), '最初〜2026年11月');
  assert.equal(periodText({ from: '2026-12', to: null }), '2026年12月〜');
  assert.deepEqual(sortedHistory(null), []);
});
