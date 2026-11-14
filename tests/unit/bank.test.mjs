// Bank statement balances and the import / low balance checks. All values are fictional.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBankRows, monthEndBalances, latestBalance, missingImports, lastImports } from '../../web/js/bank.js';
import { importAlert } from '../../web/js/alerts.js';

test('bank CSV: the balance at the end of each day, then of each month', () => {
  const rows = [['取引日', '入出金(円)', '取引後残高(円)', '入出金内容'],
    ['20250110', '-33311', '80650', 'カード'], ['20250124', '-11000', '69650', '駐車場'], ['20250124', '159120', '228770', '入金'],
    ['20250210', '-62846', '165924', 'カード'], ['', '', '', '']];
  const { balances, errors } = parseBankRows(rows);
  assert.deepEqual(errors, []);
  assert.deepEqual(balances, [{ date: '2025-01-10', balance: 80650 }, { date: '2025-01-24', balance: 228770 }, { date: '2025-02-10', balance: 165924 }]);
  assert.deepEqual(monthEndBalances(balances).map((m) => [m.ym, m.balance]), [['2025-01', 228770], ['2025-02', 165924]]);
  assert.deepEqual(latestBalance(balances), { date: '2025-02-10', balance: 165924 });
  assert.match(parseBankRows([['日付', '金額']]).errors[0], /見つからない列/);
  assert.equal(parseBankRows([rows[0], ['2025/1/1', '1', 'x', '']]).errors.length, 1);
});

test('import reminder from the 5th until both are imported this month (Japan time)', () => {
  const keys = (list) => list.map((k) => k.key);
  assert.deepEqual(missingImports('2026-11-04', { mf: null, bank: null }), []);
  assert.deepEqual(keys(missingImports('2026-11-05', { mf: null, bank: null })), ['mf', 'bank']);
  assert.deepEqual(keys(missingImports('2026-11-09', { mf: '2026-10-31T16:00:00Z', bank: '2026-10-31T14:00:00Z' })), ['bank'], '01:00 JST on the 1st counts, 23:00 JST on the 31st does not');
  assert.deepEqual(missingImports('2026-11-09', { mf: '2026-11-03T00:00:00Z', bank: '2026-11-02T00:00:00Z' }), []);
  assert.equal(missingImports('2026-11-09', { mf: '2026-10-03T01:00:00Z', bank: null })[0].last, '2026-10-03');
});

test('lastImports: the later of the saved time and the newest row', () => {
  assert.deepEqual(lastImports({ mf_imported_at: null, bank_imported_at: '2026-11-02T12:58:43Z' }, { mf: '2026-11-03T13:44:29Z', bank: '2026-11-01T00:00:00Z' }),
    { mf: '2026-11-03T13:44:29Z', bank: '2026-11-02T12:58:43Z' });
  assert.deepEqual(lastImports({}, { mf: null, bank: 'not a date' }), { mf: null, bank: null });
  // the saved time was lost, but the lines imported on 3 November still count
  assert.deepEqual(missingImports('2026-11-08', lastImports({ bank_imported_at: '2026-11-02T12:58:43Z' }, { mf: '2026-11-03 13:44:29.78+00', bank: null })), []);
});

test('importAlert names the month and the previous import', () => {
  const one = importAlert(missingImports('2026-11-09', { mf: '2026-10-03T01:00:00Z', bank: '2026-11-02T00:00:00Z' }), '2026-11-09');
  assert.equal(one.body, '10月分のマネーフォワードの明細がまだ取り込まれていません（前回の取り込み 10/3）。');
  const both = importAlert(missingImports('2027-01-06', { mf: null, bank: '2026-12-02T00:00:00Z' }), '2027-01-06');
  assert.equal(both.body, '12月分のマネーフォワードの明細・銀行の残高がまだ取り込まれていません（前回の取り込み：マネーフォワード なし、銀行 2026/12/2）。');
});
