import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ymAdd, ymLabel, ruleApplies, participantIds, firstYM, history, statement } from '../../web/js/shared.js';
import { parseField } from '../../web/js/validate.js';

// Fictional household, same structure as the former spreadsheet.
const A = 'm-a';
const B = 'm-b';
const rules = [
  { id: 'r1', member_id: A, label: '基本', amount: 120000, start_ym: '2022-01', end_ym: '2022-12', created_at: '1' },
  { id: 'r2', member_id: A, label: '基本', amount: 90000, start_ym: '2023-01', end_ym: null, created_at: '2' },
  { id: 'r3', member_id: A, label: '家賃', amount: -80000, start_ym: '2022-01', end_ym: null, created_at: '3' },
  { id: 'r4', member_id: B, label: '基本', amount: 70000, start_ym: '2022-01', end_ym: null, created_at: '4' },
  { id: 'r5', member_id: B, label: 'dアニ', amount: -500, start_ym: '2022-01', end_ym: null, created_at: '5' },
];
const entries = [
  { id: 'e1', member_id: A, ym: '2022-01', kind: 'deposit', label: '入金', amount: 40000, created_at: 'a' },
  { id: 'e2', member_id: A, ym: '2022-02', kind: 'charge', label: '管理費', amount: -3000, created_at: 'b' },
  { id: 'e3', member_id: B, ym: '2022-02', kind: 'deposit', label: '入金', amount: 100000, created_at: 'c' },
];

test('month arithmetic and labels', () => {
  assert.equal(ymAdd('2022-12', 1), '2023-01');
  assert.equal(ymAdd('2023-01', -1), '2022-12');
  assert.equal(ymAdd('2022-05', 25), '2024-06');
  assert.equal(ymLabel('2025-09'), '2025年9月');
});

test('rule periods include both ends; open end continues', () => {
  assert.ok(ruleApplies(rules[0], '2022-01'));
  assert.ok(ruleApplies(rules[0], '2022-12'));
  assert.ok(!ruleApplies(rules[0], '2023-01'));
  assert.ok(ruleApplies(rules[1], '2030-07'));
});

test('participants and the first month', () => {
  assert.deepEqual(participantIds(rules, entries).sort(), [A, B]);
  assert.equal(firstYM(rules, entries), '2022-01');
  assert.equal(firstYM([], []), null);
});

test('statement follows carry -> total -> deposit -> balance', () => {
  const jan = statement(rules, entries, A, '2022-01');
  assert.equal(jan.carry, 0);
  assert.equal(jan.charges, 40000);
  assert.equal(jan.deposit, 40000);
  assert.equal(jan.balance, 0);
  const feb = statement(rules, entries, A, '2022-02');
  assert.deepEqual(feb.items.map((i) => [i.label, i.amount]), [['基本', 120000], ['家賃', -80000], ['管理費', -3000]]);
  assert.equal(feb.charges, 37000);
  assert.equal(feb.balance, 37000);
  // the base amount changes in 2023 (the old rule has an end month)
  const jan23 = statement(rules, entries, A, '2023-01');
  assert.equal(jan23.charges, 90000 - 80000);
  assert.equal(jan23.carry, 37000 + 40000 * 10);
});

test('history carries the balance month by month', () => {
  const h = history(rules, entries, B, '2022-03');
  assert.deepEqual(h.map((r) => r.balance), [69500, 39000, 108500]);
  assert.equal(h[1].carry, 69500);
  assert.equal(statement(rules, entries, B, '2022-03').balance, 108500);
  assert.deepEqual(history(rules, entries, B, '2021-12'), []);
});

test('signed yen input', () => {
  const f = { key: 'amount', label: '金額', type: 'yen', required: true };
  assert.equal(parseField(f, '-2,500').value, -2500);
  assert.equal(parseField(f, '▲500').value, -500);
  assert.equal(parseField(f, '－８００００円').value, -80000);
  assert.equal(parseField(f, '90000').value, 90000);
  assert.ok(parseField(f, '0').error);
  assert.ok(parseField(f, '1.5').error);
  assert.ok(parseField(f, '').error);
  assert.ok(parseField({ ...f, min: 1 }, '-5').error);
});
