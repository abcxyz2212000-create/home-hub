// Parsing of OCR text. All texts are fictional.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOcrText, findAmount, findDate, receiptMemo } from '../../web/js/ocr.js';

test('receipt: total, date, store and items', () => {
  const text = [
    'サンプルマート 中央店',
    'TEL 03-1234-5678',
    '領収書',
    '2026年10月15日(木) 18:42',
    '牛乳 ¥198',
    '食パン 2点 ¥356',
    'トイレットペーパー ¥498*',
    '小計 ¥1,052',
    '(内消費税等 ¥84)',
    '合計 ¥1,052',
    'お預り ¥2,000',
    'お釣 ¥948',
  ].join('\n');
  const r = parseOcrText(text, 'receipt');
  assert.equal(r.amount, 1052);
  assert.equal(r.date, '2026-10-15');
  assert.equal(r.store, 'サンプルマート 中央店');
  assert.deepEqual(r.items, ['牛乳', '食パン 2点', 'トイレットペーパー']);
  assert.equal(receiptMemo(r), 'サンプルマート 中央店：牛乳、食パン 2点、トイレットペーパー');
});

test('full-width characters and the total on the next line', () => {
  const r = parseOcrText('サンプル薬局\n２０２６／１０／０３\n合　計\n￥３，２８０\n', 'receipt');
  assert.equal(r.amount, 3280);
  assert.equal(r.date, '2026-10-03');
});

test('bank transfer screen: transfer amount and date (not the fee or the balance)', () => {
  const text = [
    '振込が完了しました',
    '受付日時 2026/10/25 09:12',
    '振込先 サンプル銀行 本店 普通 1234567',
    '振込金額 80,000円',
    '振込手数料 0円',
    '残高 123,456円',
  ].join('\n');
  assert.deepEqual(parseOcrText(text, 'transfer'), { amount: 80000, date: '2026-10-25' });
});

test('dates: Reiwa, invalid dates ignored; amounts: fallback to the largest yen amount', () => {
  assert.equal(findDate('令和8年4月1日'), '2026-04-01');
  assert.equal(findDate('2026/02/30 2026/03/01'), '2026-03-01');
  assert.equal(findDate('10/5'), null);
  assert.equal(findAmount(['商品A 300円', '商品B 1,200円', 'TEL 03-1111-2222']), 1200);
  assert.equal(findAmount(['なにもない']), null);
  assert.ok(receiptMemo({ store: 'あ'.repeat(150), items: ['い'.repeat(100)] }).length <= 200);
});
