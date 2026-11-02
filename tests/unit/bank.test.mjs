// Bank statement balances and the import / low balance checks. All values are fictional.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBankRows, monthEndBalances, latestBalance, missingImports } from '../../web/js/bank.js';

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
  assert.deepEqual(missingImports('2026-11-04', { mf: null, bank: null }), []);
  assert.deepEqual(missingImports('2026-11-05', { mf: null, bank: null }), ['マネーフォワードの明細', '銀行の残高']);
  assert.deepEqual(missingImports('2026-11-09', { mf: '2026-10-31T16:00:00Z', bank: '2026-10-31T14:00:00Z' }), ['銀行の残高'], '01:00 JST on the 1st counts, 23:00 JST on the 31st does not');
  assert.deepEqual(missingImports('2026-11-09', { mf: '2026-11-03T00:00:00Z', bank: '2026-11-02T00:00:00Z' }), []);
});
