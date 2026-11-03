import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categoryAdjustments, categoryRatioFor, categoryRatiosError, categoryRatioQuery, categoryRatiosStart, monthActual } from '../../web/js/budget.js';
import { statement, contribution } from '../../web/js/shared.js';

const ids = ['a', 'b'];
const year = (y, rows, ratio = { a: 55, b: 45 }) => ({ year: y, ratio, category_ratios: rows });
const elec = { category: '水道・光熱費', subcategory: '電気代', ratio: { a: 70, b: 30 }, from: '2027-01' };
const line = (date, amount, extra = {}) => ({ date, amount, category: '水道・光熱費', subcategory: '電気代', counted: true, transfer: false, ...extra });

test('a 小項目 row wins over a row for the whole 大項目, and rows apply from their month', () => {
  const all = { category: '水道・光熱費', subcategory: null, ratio: { a: 60, b: 40 }, from: '2027-01' };
  assert.equal(categoryRatioFor([all, elec], line('2027-01-05', -1), '2027-01'), elec);
  assert.equal(categoryRatioFor([all, elec], { category: '水道・光熱費', subcategory: 'ガス代' }, '2027-01'), all);
  assert.equal(categoryRatioFor([{ ...elec, from: '2027-03' }], line('2027-02-05', -1), '2027-02'), null);
});

test('corrections: line x (category ratio - year ratio), adding up to 0', () => {
  const out = categoryAdjustments({ txs: [line('2027-01-05', -20000), line('2027-02-05', -10001)], years: [year(2027, [elec])], members: [], memberIds: ids });
  assert.deepEqual(out.filter((e) => e.ym === '2027-01').map((e) => [e.member_id, e.amount]), [['a', 3000], ['b', -3000]]);
  const feb = out.filter((e) => e.ym === '2027-02');
  assert.equal(feb.reduce((n, e) => n + e.amount, 0), 0);
  assert.ok(feb.every((e) => e.kind === 'adjust' && e.virtual && e.label === '費目ごとの調整（電気代）'));
});

test('no corrections for other lines, transfers, uncounted lines or years without a row', () => {
  const txs = [line('2027-01-05', -20000, { transfer: true }), line('2027-01-06', -20000, { counted: false }), line('2027-01-07', -20000, { subcategory: 'ガス代' }), line('2026-12-05', -20000)];
  assert.deepEqual(categoryAdjustments({ txs, years: [year(2027, [elec]), year(2026, [])], members: [], memberIds: ids }), []);
});

test('a correction is part of what to pay, never 立替, and not spending of the budget', () => {
  const entries = [{ member_id: 'b', ym: '2027-01', kind: 'adjust', label: '費目ごとの調整（電気代）', amount: -3000 }];
  const rules = [{ member_id: 'b', label: '基本', amount: 77400, start_ym: '2027-01' }];
  const c = contribution(statement(rules, entries, 'b', '2027-01'));
  assert.equal(c.burden, 74400);
  assert.equal(c.advance + 0, 0);
  assert.equal(c.remaining, 74400);
  const actual = monthActual({ txs: [], shared: { rules, entries }, members: [], memberIds: ['b'], mapping: {}, contracts: [], ym: '2027-01' });
  assert.ok(actual.spendingTotal === 0 && actual.advances.length === 0);
});

test('checks of the rows typed in, and the lines to load', () => {
  assert.equal(categoryRatiosError([elec], ids), null);
  assert.match(categoryRatiosError([{ ...elec, ratio: { a: 70, b: 20 } }], ids), /合計100/);
  assert.match(categoryRatiosError([{ ...elec, ratio: { a: 70.5, b: 29.5 } }], ids), /整数/);
  assert.match(categoryRatiosError([{ ...elec, category: '' }], ids), /大項目/);
  assert.match(categoryRatiosError([elec, elec], ids), /2回/);
  assert.equal(categoryRatiosStart([year(2027, [elec]), year(2028, [{ ...elec, from: null }])]), '2027-01');
  assert.equal(categoryRatioQuery([year(2027, [])]), null);
  assert.match(categoryRatioQuery([year(2027, [elec])]), /^date=gte\.2027-01-01&category=in\.\("/);
});
