// MoneyForward ME CSV import. All rows are fictional.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMfRows, classifyMf, matchContract, normalizeText, summarizeMonth, plannedInMonth, personalTotal, settlementMemo, MF_HEADERS, depositMember, depositCandidates, depositEntryFor } from '../../web/js/mf.js';
import { parseCSV, decodeCSVBytes } from '../../web/js/csv.js';

const row = (o) => [o.c ?? '1', o.d ?? '2026/10/05', o.t ?? '', String(o.a ?? -1000), o.i ?? '共用口座', o.l ?? '食費', o.m ?? '食費', '', o.f ?? '0', o.id];

test('parses the MoneyForward columns (quoted; Shift_JIS decoding is covered by the CSV tests and the E2E)', () => {
  const text = `${MF_HEADERS.map((h) => `"${h}"`).join(',')}\n"1","2026/10/02","サンプル電力１０月","-8000","カードA","水道・光熱費","電気代","","0","id-1"\n`;
  const { items, errors } = parseMfRows(parseCSV(decodeCSVBytes(new TextEncoder().encode(text))));
  assert.deepEqual(errors, []);
  assert.deepEqual(items[0], {
    mf_id: 'id-1', date: '2026-10-02', description: 'サンプル電力１０月', amount: -8000, institution: 'カードA',
    category: '水道・光熱費', subcategory: '電気代', memo: null, counted: true, transfer: false,
  });
});

test('reports broken rows and a wrong file', () => {
  assert.match(parseMfRows([['日付', '金額']]).errors[0], /見つからない列/);
  const { errors } = parseMfRows([MF_HEADERS, row({ d: '10/5', id: 'a' }), row({ a: 'x', id: 'b' }), row({ id: '' }), row({ id: 'c' }), row({ id: 'c' })]);
  assert.equal(errors.length, 4);
  assert.match(errors[0], /2行目: 日付/);
  assert.match(errors[1], /3行目: 金額/);
  assert.match(errors[2], /4行目: ID/);
  assert.match(errors[3], /6行目: 同じ ID/);
});

test('keeps only the shared account and the cards paid from it', () => {
  const { items } = parseMfRows([MF_HEADERS,
    row({ i: '共用口座', id: '1' }), row({ i: 'ＪＣＢカード', id: '2' }), row({ i: '個人の銀行', id: '3' }), row({ i: '別のカード', id: '4' })]);
  const ctx = {
    sharedAccountId: 'acc-s',
    accounts: [{ id: 'acc-s', mf_name: '共用口座' }, { id: 'acc-p', mf_name: '個人の銀行' }],
    cards: [{ id: 'card-1', mf_name: 'JCBカード', debit_account_id: 'acc-s' }, { id: 'card-2', mf_name: '別のカード', debit_account_id: 'acc-p' }],
  };
  const r = classifyMf(items, ctx);
  assert.deepEqual(r.inScope.map((t) => [t.mf_id, t.account_id, t.card_id]), [['1', 'acc-s', null], ['2', null, 'card-1']]);
  assert.equal(r.skipped, 2);
  assert.equal(r.manual, 0);
  assert.deepEqual(r.unknown, [], 'names that are registered but out of scope are not "unknown"');
  assert.deepEqual(classifyMf(items, { ...ctx, accounts: [{ id: 'acc-s', mf_name: '共用口座' }], cards: [] }).unknown, ['ＪＣＢカード', '個人の銀行', '別のカード']);
});

test('hand-typed rows (保有金融機関「なし」) are never imported and not reported as unknown', () => {
  const { items } = parseMfRows([MF_HEADERS, row({ i: 'なし', id: 'm1' }), row({ i: '', id: 'm2' }), row({ i: '共用口座', id: 's1' })]);
  const r = classifyMf(items, { sharedAccountId: 'acc-s', accounts: [{ id: 'acc-s', mf_name: '共用口座' }], cards: [] });
  assert.deepEqual(r.inScope.map((t) => t.mf_id), ['s1']);
  assert.equal(r.manual, 2);
  assert.equal(r.skipped, 0);
  assert.deepEqual(r.unknown, []);
});

test('contract matching: width/case/space insensitive, longest keyword wins', () => {
  assert.equal(normalizeText('ＪＣＢ　カード'), 'jcbカード');
  const contracts = [
    { id: 'power', match_keywords: 'サンプル電力' },
    { id: 'phone', match_keywords: 'モバイル、ﾓﾊﾞｲﾙ' },
    { id: 'phone-family', match_keywords: 'モバイル家族' },
    { id: 'none', match_keywords: '' },
    { id: 'short', match_keywords: 'a' },
  ];
  assert.equal(matchContract('サンプル電力１０月１２３４', contracts), 'power');
  assert.equal(matchContract('ﾓﾊﾞｲﾙ 10月分', contracts), 'phone');
  assert.equal(matchContract('モバイル家族割', contracts), 'phone-family');
  assert.equal(matchContract('スーパー', contracts), null);
  assert.equal(matchContract('abc', contracts), null, 'one-letter keywords are ignored');
});

test('month summary: transfers and excluded rows are not added up', () => {
  const txs = [
    { id: 't1', amount: -8000, counted: true, transfer: false, contract_id: 'power', category: '水道・光熱費' },
    { id: 't2', amount: -3000, counted: true, transfer: false, contract_id: null, category: '食費' },
    { id: 't3', amount: -2000, counted: true, transfer: false, contract_id: null, category: '食費' },
    { id: 't4', amount: -13000, counted: false, transfer: true, contract_id: null, category: '現金・カード' },
    { id: 't5', amount: 50000, counted: true, transfer: false, contract_id: null, category: '収入' },
  ];
  const s = summarizeMonth(txs);
  assert.equal(s.inflow, 50000);
  assert.equal(s.outflow, 13000);
  assert.equal(s.byContract.get('power'), 8000);
  assert.deepEqual([...s.byCategory], [['食費', 5000]]);
  assert.deepEqual(s.unlinked.map((t) => t.id), ['t2', 't3']);
  assert.deepEqual(s.excluded.map((t) => t.id), ['t4']);
});

test('planned amount per month', () => {
  assert.equal(plannedInMonth({ amount: 5000, cycle: 'monthly' }, '2026-10'), 5000);
  assert.equal(plannedInMonth({ amount: 20000, cycle: 'yearly', renewal_date: '2027-05-01' }, '2026-05'), 20000);
  assert.equal(plannedInMonth({ amount: 20000, cycle: 'yearly', renewal_date: '2027-05-01' }, '2026-10'), 0);
  assert.equal(plannedInMonth({ amount: 5000, cycle: 'monthly', status: 'closed' }, '2026-10'), 0);
});

test('personal lines (個人負担) are left out of the shared totals; lines under review still count', () => {
  const txs = [
    { id: 'p1', date: '2025-06-09', description: 'サンプル会費', amount: -600, counted: true, transfer: false, personal_member_id: 'm-a', category: '教養・教育' },
    { id: 'p2', date: '2025-06-20', description: 'サンプル返金', amount: 100, counted: true, transfer: false, personal_member_id: 'm-a', category: '収入' },
    { id: 'r1', date: '2025-06-12', description: 'サンプル配信', amount: -980, counted: true, transfer: false, needs_review: true, category: '教養・教育' },
    { id: 's1', date: '2025-06-15', description: 'スーパー', amount: -3000, counted: true, transfer: false, category: '食費' },
  ];
  const s = summarizeMonth(txs);
  assert.deepEqual(s.personal.map((t) => t.id), ['p1', 'p2']);
  assert.deepEqual(s.review.map((t) => t.id), ['r1']);
  assert.equal(s.outflow, 3980, 'the line under review is still a shared cost');
  assert.equal(s.inflow, 0);
  assert.deepEqual([...s.byCategory].sort(), [['教養・教育', 980], ['食費', 3000]]);
  assert.equal(personalTotal(txs.slice(0, 2)), 500, 'refunds reduce what is owed');
  assert.equal(settlementMemo(txs.slice(0, 1)), '2025/06/09 サンプル会費 600円');
  assert.ok(settlementMemo(Array.from({ length: 100 }, () => txs[0])).length <= 2000);
});

test('deposits: recognised by the payer names, from the start month, never twice', () => {
  const members = [
    { id: 'm-a', transfer_names: 'サトウ ハナコ、スズキ ハナコ' },
    { id: 'm-b', transfer_names: 'サトウ タロウ' },
    { id: 'm-c', transfer_names: '' },
  ];
  const line = (o) => ({ id: o.id, date: o.date || '2026-02-10', description: o.d, amount: o.a ?? 50000, account_id: o.card ? null : 'acc-s', card_id: o.card ? 'c' : null, transfer: false, ...o.x });
  assert.equal(depositMember(line({ d: 'サトウ ハナコ' }), members), 'm-a');
  assert.equal(depositMember(line({ d: 'ｽｽﾞｷ ﾊﾅｺ' }), members), 'm-a', 'half-width kana and an old name');
  assert.equal(depositMember(line({ d: 'サトウ タロウ' }), members), 'm-b');
  assert.equal(depositMember(line({ d: '預金利息', a: 30 }), members), null);
  assert.equal(depositMember(line({ d: 'サトウ ハナコ', a: -1000 }), members), null, 'payments out are not deposits');
  assert.equal(depositMember(line({ d: 'サトウ ハナコ', card: true }), members), null, 'card lines are not deposits');
  const txs = [
    line({ id: 't1', d: 'サトウ ハナコ' }),
    line({ id: 't2', d: 'サトウ ハナコ', date: '2025-12-20' }),
    line({ id: 't3', d: 'サトウ タロウ', x: { deposit_entry_id: 'e1' } }),
    line({ id: 't4', d: 'サトウ タロウ', x: { deposit_ignored: true } }),
  ];
  assert.deepEqual(depositCandidates(txs, members).map((c) => [c.tx.id, c.member_id]), [['t1', 'm-a']]);
  assert.deepEqual(depositCandidates(txs, members, '2025-12').map((c) => c.tx.id), ['t1', 't2']);
  const e = depositEntryFor({ tx: txs[0], member_id: 'm-a' });
  assert.deepEqual([e.member_id, e.ym, e.kind, e.label, e.amount], ['m-a', '2026-02', 'deposit', '入金', 50000]);
  assert.match(e.memo, /2026\/02\/10 サトウ ハナコ/);
});
