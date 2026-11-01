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

// ---- contracts paid from a personal account (共通の費用)
import { contractDeduction, planRuleSync, ruleSchedule } from '../../web/js/shared.js';

const ctx = {
  sharedAccountId: 'acc-shared',
  accounts: [
    { id: 'acc-shared', name: '共通', holder_id: null },
    { id: 'acc-a', name: 'Aの口座', holder_id: A },
    { id: 'acc-none', name: '名義なし', holder_id: null },
  ],
  cards: [{ id: 'card-a', debit_account_id: 'acc-a' }, { id: 'card-x', debit_account_id: null }],
};
const rent = { id: 'k-rent', name: '家賃', shared_cost: true, status: 'active', amount: 80000, cycle: 'monthly', pay_account_id: 'acc-a', pay_card_id: null };

test('deduction: only shared costs paid from a personal account with a holder', () => {
  assert.deepEqual(contractDeduction(rent, ctx).target, { member_id: A, label: '家賃', amount: -80000, month_of_year: null });
  assert.equal(contractDeduction({ ...rent, shared_cost: false }, ctx).target, null);
  assert.match(contractDeduction({ ...rent, pay_account_id: 'acc-shared' }, ctx).reason, /共通口座から払う/);
  assert.match(contractDeduction({ ...rent, pay_account_id: 'acc-none' }, ctx).reason, /名義人がない/);
  assert.match(contractDeduction({ ...rent, pay_account_id: null }, ctx).reason, /支払元の口座が未設定/);
  assert.match(contractDeduction({ ...rent, status: 'closed' }, ctx).reason, /解約済み/);
  assert.match(contractDeduction({ ...rent, amount: null }, ctx).reason, /金額が未入力/);
  // paid by card: the card's debit account decides
  assert.equal(contractDeduction({ ...rent, pay_account_id: null, pay_card_id: 'card-a' }, ctx).target.member_id, A);
  assert.match(contractDeduction({ ...rent, pay_account_id: null, pay_card_id: 'card-x' }, ctx).reason, /カードの引き落とし口座/);
  // yearly: once a year in the month of the renewal date
  const ins = { ...rent, name: '家財保険', cycle: 'yearly', amount: 20000, renewal_date: '2027-05-10' };
  assert.deepEqual(contractDeduction(ins, ctx).target, { member_id: A, label: '家財保険', amount: -20000, month_of_year: 5 });
  assert.match(contractDeduction({ ...ins, renewal_date: null }, ctx).reason, /更新日/);
});

test('rule sync keeps past months: end at the previous month, then a new rule', () => {
  const target = { member_id: A, label: '家賃', amount: -80000, month_of_year: null };
  // no rule yet -> create from this month
  assert.deepEqual(planRuleSync('k-rent', target, [], '2026-11'),
    { end: [], remove: [], update: [], create: [{ ...target, contract_id: 'k-rent', start_ym: '2026-11' }] });
  // adopted manual rule with the same amount -> nothing to do (history kept)
  const old = { id: 'r-old', member_id: A, label: '家賃', amount: -80000, start_ym: '2022-01', end_ym: null, contract_id: 'k-rent' };
  assert.deepEqual(planRuleSync('k-rent', target, [old], '2026-11'), { end: [], remove: [], update: [], create: [] });
  // rent goes up -> old rule ends in October, new one from November
  const up = { ...target, amount: -85000 };
  assert.deepEqual(planRuleSync('k-rent', up, [old], '2026-11'),
    { end: [{ id: 'r-old', end_ym: '2026-10' }], remove: [], update: [], create: [{ ...up, contract_id: 'k-rent', start_ym: '2026-11' }] });
  // changed again in the same month -> the rule made this month is replaced, not kept
  const made = { id: 'r-new', member_id: A, label: '家賃', amount: -85000, start_ym: '2026-11', end_ym: null, contract_id: 'k-rent' };
  const ended = { ...old, end_ym: '2026-10' };
  assert.deepEqual(planRuleSync('k-rent', { ...target, amount: -86000 }, [ended, made], '2026-11'),
    { end: [], remove: ['r-new'], update: [], create: [{ ...target, amount: -86000, contract_id: 'k-rent', start_ym: '2026-11' }] });
  // no longer a deduction (unmarked / closed / paid from the shared account)
  assert.deepEqual(planRuleSync('k-rent', null, [old], '2026-11'), { end: [{ id: 'r-old', end_ym: '2026-10' }], remove: [], update: [], create: [] });
  // renamed contract -> label follows, history kept
  assert.deepEqual(planRuleSync('k-rent', { ...target, label: '家賃（A棟）' }, [old], '2026-11'),
    { end: [], remove: [], update: [{ id: 'r-old', label: '家賃（A棟）' }], create: [] });
  // other contracts' rules are untouched
  assert.deepEqual(planRuleSync('k-other', null, [old], '2026-11'), { end: [], remove: [], update: [], create: [] });
});

test('yearly rules count only in their month', () => {
  const yearly = [{ id: 'y', member_id: A, label: '家財保険', amount: -20000, start_ym: '2026-01', end_ym: null, month_of_year: 5 }];
  assert.deepEqual(history(yearly, [], A, '2026-06').map((r) => r.charges), [0, 0, 0, 0, -20000, 0]);
  assert.equal(ruleSchedule(yearly[0]), '毎年5月・2026年1月〜');
  assert.equal(ruleSchedule({ start_ym: '2022-01', end_ym: '2022-12' }), '2022年1月〜2022年12月');
});
