import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCSV, toCSV, unescapeFormula, decodeCSVBytes } from '../../web/js/csv.js';
import { createZip, crc32 } from '../../web/js/zip.js';
import { parseField, parseNotifyDays, parseLinksCell, findCardNumberLike, safeUrl, parseTags, parseMembers } from '../../web/js/validate.js';
import { LEDGERS } from '../../web/js/schema.js';

test('CSV round trip with quotes, newlines and formula guard', () => {
  const rows = [['名前', 'メモ'], ['a,b', '1行目\n2行目 "引用"'], ['=SUM(A1)', ' 空白 ']];
  const text = toCSV(rows);
  assert.ok(text.startsWith('\ufeff'));
  const back = parseCSV(text).map((r) => r.map(unescapeFormula));
  assert.deepEqual(back, rows);
  assert.deepEqual(parseCSV('a,b\r\n\r\n1,2'), [['a', 'b'], ['1', '2']]);
  assert.throws(() => parseCSV('"open'));
});

test('Shift_JIS CSV is decoded', () => {
  const sjis = Uint8Array.from([0x8c, 0xfb, 0x8d, 0xc0]); // 口座
  assert.equal(decodeCSVBytes(sjis), '口座');
  assert.equal(decodeCSVBytes(new TextEncoder().encode('口座')), '口座');
});

test('ZIP is readable by an independent implementation (Python zipfile)', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  const zip = createZip([{ name: '口座.csv', data: 'a,b\r\n' }, { name: 'photos/x/1.jpg', data: new Uint8Array([1, 2, 3]) }]);
  const dir = mkdtempSync(join(tmpdir(), 'zip-'));
  const file = join(dir, 'a.zip');
  writeFileSync(file, zip);
  const out = execFileSync('python3', ['-I', '-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print("|".join(i.filename+":"+str(i.file_size) for i in z.infolist()))', file]).toString().trim();
  assert.equal(out, '口座.csv:5|photos/x/1.jpg:3');
});

test('field validation', () => {
  const f = (key, ledger = 'cards') => LEDGERS[ledger].fields.find((x) => x.key === key);
  assert.deepEqual(parseField(f('last4'), '１２３４'), { value: '1234' });
  assert.ok(parseField(f('last4'), '12345').error);
  assert.deepEqual(parseField(f('expiry_ym'), '2027/5/1'), { value: '2027-05' });
  assert.deepEqual(parseField(f('annual_fee'), '1,100円'), { value: 1100 });
  assert.deepEqual(parseField(f('closing_day'), '末'), { value: 31 });
  assert.deepEqual(parseField(f('family_card'), 'はい'), { value: true });
  assert.deepEqual(parseField(f('cycle', 'contracts'), '年払い'), { value: 'yearly' });
  assert.ok(parseField(f('cycle', 'contracts'), '週払い').error);
  assert.deepEqual(parseField(f('renewal_date', 'contracts'), '2026/2/3'), { value: '2026-02-03' });
  assert.ok(parseField(f('renewal_date', 'contracts'), '2026-02-30').error);
  assert.ok(parseField(f('name'), '').error);
  assert.ok(parseField(f('manual_url', 'items'), 'javascript:alert(1)').error);
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl(' https://example.com/a '), 'https://example.com/a');
});

test('bank code / branch number are zero-padded and length-checked', () => {
  const bank = LEDGERS.accounts.fields.find((x) => x.key === 'bank_code');
  const branch = LEDGERS.accounts.fields.find((x) => x.key === 'branch_code');
  assert.deepEqual(parseField(bank, '36'), { value: '0036' }); // Excel dropped the leading zeros
  assert.deepEqual(parseField(bank, '０００９'), { value: '0009' });
  assert.deepEqual(parseField(branch, '225'), { value: '225' });
  assert.deepEqual(parseField(branch, '7'), { value: '007' });
  assert.deepEqual(parseField(branch, ''), { value: null });
  assert.equal(parseField(bank, '00369').error, '金融機関コードは数字4桁で入力してください。');
  assert.equal(parseField(branch, 'abc').error, '支店番号は数字3桁で入力してください。');
  assert.deepEqual(LEDGERS.accounts.fields.map((f) => f.key).slice(1, 6), ['institution', 'bank_code', 'branch', 'branch_code', 'kind']);
});

test('full account number: digits only, 4-14, separators removed', () => {
  const f = LEDGERS.accounts.fields.find((x) => x.key === 'account_no');
  assert.equal(f.label, '口座番号（全桁）');
  assert.ok(!LEDGERS.accounts.fields.some((x) => x.key === 'last4'), 'single input for the account number');
  assert.deepEqual(parseField(f, '0001234'), { value: '0001234' });
  assert.deepEqual(parseField(f, '１２３ ４５６７'), { value: '1234567' });
  assert.deepEqual(parseField(f, '123-4567'), { value: '1234567' });
  assert.deepEqual(parseField(f, ''), { value: null });
  assert.equal(parseField(f, '123').error, '口座番号（全桁）は数字4〜14桁で入力してください。');
  assert.ok(parseField(f, '123456789012345').error);
  assert.ok(parseField(f, '12a4567').error);
  // cards keep last 4 digits only
  assert.ok(parseField(LEDGERS.cards.fields.find((x) => x.key === 'last4'), '12345').error);
  assert.deepEqual(LEDGERS.accounts.csvAliases, { 摘要: '名称', 支店名: '支店', 預金科目: '種別', 口座番号: '口座番号（全桁）', 口座名義: '名義人' });
});

test('holder is a plain text value; family names are cleaned and limited', () => {
  const holder = LEDGERS.cards.fields.find((x) => x.key === 'holder');
  assert.equal(holder.type, 'holder');
  assert.deepEqual(parseField(holder, ' 山田 太郎 '), { value: '山田 太郎' });
  assert.deepEqual(parseField(holder, ''), { value: null });
  assert.deepEqual(parseMembers('山田 太郎\r\n\n 山田 花子 \n山田 太郎'), { value: ['山田 太郎', '山田 花子'] });
  assert.deepEqual(parseMembers(''), { value: [] });
  assert.ok(parseMembers(Array.from({ length: 11 }, (_, i) => `n${i}`).join('\n')).error);
  assert.ok(parseMembers('あ'.repeat(21)).error);
});

test('notify days, links and tags', () => {
  assert.deepEqual(parseNotifyDays('', 'warranty'), { value: undefined });
  assert.deepEqual(parseNotifyDays('なし', 'warranty'), { value: [] });
  assert.deepEqual(parseNotifyDays('7、30日前', 'warranty'), { value: [30, 7] });
  assert.ok(parseNotifyDays('abc', 'warranty').error);
  assert.deepEqual(parseLinksCell('ログイン|https://a.example/\nhttps://b.example/'), { value: [{ label: 'ログイン', url: 'https://a.example/' }, { label: 'リンク', url: 'https://b.example/' }] });
  assert.ok(parseLinksCell('x|ftp://a').error);
  assert.deepEqual(parseTags('銀行 生活費、銀行'), { value: ['銀行', '生活費'] });
});

test('card number detection (Luhn)', () => {
  assert.equal(findCardNumberLike('4111 1111 1111 1111'), true);
  assert.equal(findCardNumberLike('契約番号 1234567890123'), false);
  assert.equal(findCardNumberLike('下4桁 1234'), false);
});
