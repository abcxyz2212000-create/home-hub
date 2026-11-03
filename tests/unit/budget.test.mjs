import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shares, percents, proposal, baseRule, planBaseChange, advanceCategory, monthActual, compareRows, applyFrom } from '../../web/js/budget.js';

test('shares and whole percentages from reference amounts', () => {
  const p = percents({ a: 294.6, b: 258.1 }, ['a', 'b']);
  assert.deepEqual([p.get('a'), p.get('b')], [53, 47]);
  assert.deepEqual([...percents({ a: 57, b: 43 }, ['a', 'b']).values()], [57, 43]);
  assert.deepEqual([...shares({}, ['a', 'b']).values()], [0.5, 0.5], 'no ratio yet: the same for everyone');
  assert.deepEqual([...percents({ a: 1, b: 1, c: 1 }, ['a', 'b', 'c']).values()].reduce((n, v) => n + v, 0), 100);
});

test('今月分 proposed from the budget, rounded to 100円, adding up to the total', () => {
  const rows = [{ category: '住宅', monthly: 93550 }, { category: '食費', monthly: 5000 }];
  const p = proposal(rows, { savings_monthly: 112257, ratio: { a: 57, b: 43 } }, ['a', 'b']);
  assert.equal(p.spending, 98550);
  assert.equal(p.total, 210807);
  assert.equal(p.perMember.get('a') + p.perMember.get('b'), 210807);
  assert.equal(p.perMember.get('b'), 90600, '210807 x 0.43 = 90647 -> 90600');
});

test('the base amount changes from a month on; past months stay', () => {
  const rules = [
    { id: 'r1', member_id: 'a', label: '基本', amount: 70000, start_ym: '2025-01', end_ym: null },
    { id: 'r2', member_id: 'a', label: '家賃', amount: -82350, start_ym: '2025-01', end_ym: null, contract_id: 'k' },
  ];
  assert.equal(baseRule(rules, 'a', '2026-12').id, 'r1');
  assert.deepEqual(planBaseChange(rules, 'a', '2027-01', 80000, '2026-12'), {
    end: { id: 'r1', end_ym: '2026-12' }, update: null,
    create: { member_id: 'a', label: '基本', amount: 80000, start_ym: '2027-01', end_ym: null },
  });
  assert.deepEqual(planBaseChange(rules, 'a', '2025-01', 80000, '2024-12').update, { id: 'r1', amount: 80000 }, 'a rule starting that month is changed in place');
  assert.deepEqual(planBaseChange(rules, 'a', '2027-01', 70000, '2026-12'), { end: null, update: null, create: null });
  assert.equal(planBaseChange([], 'b', '2027-01', 50000, '2026-12').create.label, '基本');
});

test('category of a 立替: its own choice, then the contract kind, else 未分類', () => {
  const contracts = [{ id: 'k', category: '住居' }];
  assert.equal(advanceCategory({ label: '家賃', rule: { contract_id: 'k' } }, {}, contracts), '住宅');
  assert.equal(advanceCategory({ label: '家賃', rule: { contract_id: 'k' } }, { 家賃: 'その他' }, contracts), 'その他');
  assert.equal(advanceCategory({ label: '管理費', entry: {} }, {}, contracts), '未分類');
  assert.equal(advanceCategory({ label: 'dアニ', rule: { contract_id: 'k' } }, { 'contract:k': '通信費', dアニ: 'その他' }, contracts), '通信費', 'the contract\'s own first');
  assert.equal(advanceCategory({ label: '管理費', entry: {} }, { 管理費: '住宅' }, contracts), '住宅');
});

test('actual of a month: the shared account by 大項目 plus 立替; people\'s money and transfers left out', () => {
  const members = [{ id: 'a', nickname: 'しん', transfer_names: 'シン' }, { id: 'b', nickname: 'はる' }];
  const txs = [
    { amount: -12000, category: '食費', counted: true, transfer: false, description: 'スーパー' },
    { amount: 500, category: '食費', counted: true, transfer: false, description: '返品' },
    { amount: -5000, category: '通信費', counted: true, transfer: false, description: 'ネット', contract_id: 'n' },
    { amount: -30000, category: 'カード', counted: true, transfer: true, description: '引き落とし' },
    { amount: -800, category: '日用品', counted: false, transfer: false, description: '対象外' },
    { amount: -2000, category: '趣味・娯楽', counted: true, transfer: false, description: '本', personal_member_id: 'a' },
    { amount: 70000, category: '収入', counted: true, transfer: false, description: '入金', deposit_entry_id: 'd' },
    { amount: 42, category: '収入', counted: true, transfer: false, description: '預金利息' },
    { amount: -1751, category: '食費', counted: true, transfer: false, description: '手入力', institution: 'なし' },
  ];
  const shared = {
    rules: [{ id: 'r1', member_id: 'a', label: '基本', amount: 70000, start_ym: '2026-01' },
      { id: 'r2', member_id: 'a', label: '家賃', amount: -82350, start_ym: '2026-01', contract_id: 'k' }],
    entries: [{ member_id: 'a', ym: '2026-11', kind: 'deposit', amount: 70000 },
      { member_id: 'b', ym: '2026-11', kind: 'charge', label: '管理費', amount: -3000 }],
  };
  const a = monthActual({ txs, shared, members, memberIds: ['a', 'b'], mapping: { 管理費: '住宅' }, contracts: [{ id: 'k', category: '住居' }], ym: '2026-11' });
  assert.equal(a.spending.get('食費'), 13251, 'hand-typed lines count in the budget');
  assert.equal(a.spending.get('通信費'), 5000);
  assert.equal(a.spending.get('住宅'), 85350, '家賃 82,350 + 管理費 3,000');
  assert.equal(a.spending.has('日用品'), false);
  assert.equal(a.spending.has('趣味・娯楽'), false);
  assert.equal(a.fromAccount, 18251);
  assert.equal(a.fromAdvance, 85350);
  assert.equal(a.income, 70000 + 82350 + 3000);
});

test('compare rows: budget x months, in MoneyForward\'s order, empty rows left out', () => {
  const rows = compareRows([{ category: '住宅', monthly: 90000, memo: '更新料込み' }, { category: '食費', monthly: 0 }],
    new Map([['食費', 12000], ['住宅', 85350]]), 2);
  assert.deepEqual(rows.map((r) => [r.category, r.budget, r.actual, r.diff]), [['食費', 0, 12000, 12000], ['住宅', 180000, 85350, -94650]]);
  assert.equal(rows[1].memo, '更新料込み');
});

test('今月分 from the income: savings is what is left of it', () => {
  const rows = [{ category: '住宅', monthly: 93550 }, { category: '水道・光熱費', monthly: 47193 }];
  const p = proposal(rows, { income_monthly: 253000, ratio: { a: 359.5, b: 299.6 } }, ['a', 'b']);
  assert.deepEqual([p.total, p.spending, p.savings], [253000, 140743, 112257]);
  assert.equal(p.perMember.get('a') + p.perMember.get('b'), 253000);
  assert.equal(p.perMember.get('b'), 115000, '253000 x 45.45% = 114,996 -> 115,000');
});

test('the budget changes base amounts from next month, within its year', () => {
  assert.equal(applyFrom(2026, '2026-11'), '2026-12');
  assert.equal(applyFrom(2027, '2026-11'), '2027-01');
  assert.equal(applyFrom(2026, '2026-12'), null, 'the year is over');
  assert.equal(applyFrom(2023, '2026-11'), null, 'past years never change');
  const rules = [
    { id: 'r1', member_id: 'a', label: '基本', amount: 70000, start_ym: '2025-01', end_ym: '2026-12' },
    { id: 'r2', member_id: 'a', label: '基本', amount: 90000, start_ym: '2027-01', end_ym: null },
  ];
  const plan = planBaseChange(rules, 'a', '2026-12', 80000, '2026-11');
  assert.deepEqual(plan.create, { member_id: 'a', label: '基本', amount: 80000, start_ym: '2026-12', end_ym: '2026-12' }, 'ends before the next year\'s rule');
});
