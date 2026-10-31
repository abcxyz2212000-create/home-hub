// End-to-end check in a real Chromium against tests/mock-supabase.mjs.
// Usage: node tests/e2e/run.mjs   (needs Playwright + Chromium installed globally; not part of `npm test`)
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { createMock, OWNER } from '../mock-supabase.mjs';
import { todayJST, toDayNumber, fromDayNumber } from '../../web/js/events.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const OUT = mkdtempSync(join(tmpdir(), 'homehub-e2e-'));

function pngBytes(w, h) {
  const row = Buffer.alloc(1 + w * 3, 0x80);
  row[0] = 0;
  const raw = zlib.deflateSync(Buffer.concat(Array.from({ length: h }, () => row)));
  const chunk = (t, d) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(d.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(t), d])));
    return Buffer.concat([len, Buffer.from(t), d, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', raw), chunk('IEND', Buffer.alloc(0))]);
}

const step = (name) => console.log(`- ${name}`);

const mock = createMock();
const { appUrl } = await mock.start();
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true, locale: 'ja-JP' });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
page.on('dialog', (d) => d.accept());

const fill = async (label, value) => page.getByLabel(label, { exact: true }).fill(value);
const save = async () => page.getByRole('button', { name: '保存' }).click();

try {
  step('login');
  await page.goto(appUrl);
  await fill('メールアドレス', OWNER.email);
  await fill('パスワード', 'wrong-password');
  await page.getByRole('button', { name: 'ログイン' }).click();
  await page.getByText('メールアドレスまたはパスワードが違います。').waitFor();
  await fill('パスワード', OWNER.password);
  await page.getByRole('button', { name: 'ログイン' }).click();
  await page.getByRole('heading', { name: '期限が近い予定' }).waitFor();

  step('account with validation error');
  await page.goto(`${appUrl}#/edit/accounts/new`);
  await fill('名称 *', '生活費口座');
  await fill('金融機関名', 'みどり銀行');
  await fill('口座番号下4桁', '12a4');
  await page.getByLabel('リンクの名前', { exact: true }).first().fill('ログイン');
  await page.getByLabel('URL', { exact: true }).first().fill('https://bank.example/login');
  await save();
  await page.getByText('口座番号下4桁は数字4桁で入力してください（全桁は保存しません）。').waitFor();
  await fill('口座番号下4桁', '1234');
  await save();
  await page.getByRole('heading', { name: '生活費口座' }).waitFor();
  assert.equal(mock.db.accounts[0].last4, '1234');
  assert.deepEqual(mock.db.accounts[0].links, [{ label: 'ログイン', url: 'https://bank.example/login' }]);

  step('card linked to the account');
  await page.goto(`${appUrl}#/edit/cards/new`);
  await fill('カード名 *', 'メインカード');
  await page.getByLabel('有効期限（年月）', { exact: true }).fill(todayJST().slice(0, 7));
  await page.getByLabel('引き落とし口座', { exact: true }).selectOption({ label: '生活費口座' });
  await fill('年会費（円）', '1100');
  await fill('年会費の発生月', '12');
  await fill('通知: カード有効期限（何日前）', '60 30');
  await save();
  await page.getByRole('heading', { name: 'メインカード' }).waitFor();
  assert.deepEqual(mock.db.cards[0].notify_days, { card_expiry: [60, 30] });

  step('contracts (card and account payment)');
  const in7 = fromDayNumber(toDayNumber(todayJST()) + 7);
  await page.goto(`${appUrl}#/edit/contracts/new`);
  await fill('契約名 *', '火災保険');
  await page.getByLabel('種類', { exact: true }).selectOption('保険');
  await fill('金額（円）', '24000');
  await page.getByLabel('周期', { exact: true }).selectOption({ label: '年払い' });
  await page.getByLabel('支払方法', { exact: true }).selectOption({ label: 'メインカード' });
  await page.getByLabel('更新日', { exact: true }).fill(in7);
  await page.getByLabel('自動更新', { exact: true }).check();
  await save();
  await page.getByRole('heading', { name: '火災保険' }).waitFor();
  await page.goto(`${appUrl}#/edit/contracts/new`);
  await fill('契約名 *', 'インターネット');
  await page.getByLabel('種類', { exact: true }).selectOption('通信');
  await fill('金額（円）', '5000');
  await page.getByLabel('周期', { exact: true }).selectOption({ label: '月払い' });
  await page.getByLabel('支払方法', { exact: true }).selectOption({ label: '生活費口座' });
  await fill('メモ', 'カード 4111 1111 1111 1111'); // triggers the card number warning (accepted by the dialog handler)
  await save();
  await page.getByRole('heading', { name: 'インターネット' }).waitFor();

  step('relations on the account page');
  await page.goto(`${appUrl}#/view/accounts/${mock.db.accounts[0].id}`);
  await page.getByRole('heading', { name: 'この口座から引き落とされているカード' }).waitFor();
  const accountText = await page.locator('#view').innerText();
  assert.match(accountText, /この口座から引き落とされているカード\nメインカード/);
  assert.match(accountText, /この口座から直接支払っている契約\nインターネット/);
  assert.match(accountText, /上記カード経由で支払っている契約\n火災保険/);

  step('home: events, monthly total, shortcuts');
  await page.goto(appUrl);
  await page.getByText('7,000円').waitFor();
  const home = await page.locator('#view').innerText();
  assert.match(home, /あと7日[\s\S]*火災保険/);
  assert.match(home, /メインカード\nカード有効期限/);
  assert.ok(await page.getByRole('link', { name: 'みどり銀行' }).isVisible());
  await page.screenshot({ path: join(OUT, 'home.png'), fullPage: true });

  step('family members, holder drop-down, bank code and branch number');
  await page.goto(`${appUrl}#/edit/accounts/new`);
  assert.equal(await page.getByLabel('名義人', { exact: true }).evaluate((el) => el.tagName), 'INPUT', 'free text until members exist');
  await page.goto(`${appUrl}#/settings`);
  await page.getByLabel('家族の名前（1行に1人）', { exact: true }).fill('山田 太郎\n\n山田 花子\n山田 太郎');
  await page.getByRole('button', { name: '家族の名前を保存' }).click();
  await page.getByText('家族の名前を保存しました。').waitFor();
  assert.deepEqual(mock.db.settings.find((s) => s.key === 'members').value, ['山田 太郎', '山田 花子']);
  await page.goto(`${appUrl}#/edit/accounts/new`);
  assert.equal(await page.getByLabel('名義人', { exact: true }).evaluate((el) => el.tagName), 'SELECT');
  assert.deepEqual(await page.getByLabel('名義人', { exact: true }).locator('option').allInnerTexts(), ['（未設定）', '山田 太郎', '山田 花子']);
  await fill('名称 *', '給与口座');
  await page.getByLabel('名義人', { exact: true }).selectOption('山田 花子');
  await fill('金融機関コード', '12a4'); // the input itself stops at 4 characters; non-digits are caught on save
  await fill('支店番号', '25');
  await save();
  await page.getByText('金融機関コードは数字4桁で入力してください。').waitFor();
  await fill('金融機関コード', '36');
  await save();
  await page.getByRole('heading', { name: '給与口座' }).waitFor();
  const salary = mock.db.accounts.find((a) => a.name === '給与口座');
  assert.equal(salary.bank_code, '0036');
  assert.equal(salary.branch_code, '025');
  assert.equal(salary.holder, '山田 花子');
  assert.match(await page.locator('#view').innerText(), /金融機関コード\n0036/);
  assert.equal(salary.last4 ?? null, null, 'no full account number stored');

  step('holder outside the list stays visible and editable');
  mock.db.accounts.find((a) => a.name === '生活費口座').holder = '旧姓 太郎';
  await page.goto(`${appUrl}#/edit/accounts/${mock.db.accounts.find((a) => a.name === '生活費口座').id}`);
  await page.reload(); // the app keeps loaded data in memory; reload to read the changed row
  await page.getByLabel('名義人', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('名義人', { exact: true }).inputValue(), '旧姓 太郎');
  await page.getByText('旧姓 太郎（一覧にない）').waitFor({ state: 'attached' });
  await page.getByRole('link', { name: 'キャンセル' }).click();

  step('item with photo upload');
  await page.goto(`${appUrl}#/edit/items/new`);
  await fill('品名 *', '冷蔵庫');
  await page.getByLabel('保証期限', { exact: true }).fill(in7);
  await save();
  await page.getByRole('heading', { name: '冷蔵庫' }).waitFor();
  await page.locator('#photo-input').setInputFiles({ name: 'receipt.png', mimeType: 'image/png', buffer: pngBytes(2400, 1800) });
  await page.getByText('1枚の写真を保存しました。').waitFor();
  assert.equal(mock.files.size, 2);
  const sizes = [...mock.files.values()].map((b) => b.length);
  assert.ok(sizes.every((s) => s > 0 && s < 400000), `compressed sizes ${sizes}`);
  await page.locator('.photo-open img[src^="blob:"]').waitFor();
  await page.screenshot({ path: join(OUT, 'item.png'), fullPage: true });

  step('settings: VAPID keys and usage');
  await page.goto(`${appUrl}#/settings`);
  await page.getByRole('button', { name: '通知の鍵を作成' }).click();
  await page.getByText('鍵を作成しました').waitFor();
  const secret = await page.getByLabel('秘密の値', { exact: true }).inputValue();
  assert.equal(Buffer.from(secret, 'base64url').length, 32);
  assert.equal(Buffer.from(mock.db.settings.find((s) => s.key === 'vapid_public_key').value, 'base64url').length, 65);
  await page.getByText(/写真（1枚）/).waitFor();

  step('CSV export and import');
  const [exp] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '口座', exact: true }).last().click()]);
  const exported = readFileSync(await exp.path(), 'utf8');
  assert.match(exported, /^﻿ID,名称,金融機関名/);
  assert.match(exported, /生活費口座,みどり銀行/);
  const csv = (text) => ({ name: 'cards.csv', mimeType: 'text/csv', buffer: Buffer.from(`﻿${text}`) });
  await page.getByLabel('取り込む台帳', { exact: true }).selectOption({ label: 'クレジットカード' });
  await page.getByLabel(/CSVファイル/).setInputFiles(csv('カード名,引き落とし口座,有効期限（年月）\r\nサブカード,存在しない口座,2027/5/1\r\n'));
  await page.getByRole('button', { name: '取り込む' }).click();
  await page.getByText('エラーがあるため取り込みませんでした。').waitFor();
  await page.getByText(/2行目: 引き落とし口座「存在しない口座」/).waitFor();
  await page.getByLabel(/CSVファイル/).setInputFiles(csv('カード名,引き落とし口座,有効期限（年月）,家族カードあり\r\nサブカード,生活費口座,2027/5/1,はい\r\n'));
  await page.getByRole('button', { name: '取り込む' }).click();
  await page.getByText('取り込みました（追加 1件、更新 0件）。').waitFor();
  const sub = mock.db.cards.find((c) => c.name === 'サブカード');
  assert.equal(sub.expiry_ym, '2027-05');
  assert.equal(sub.family_card, true);
  assert.equal(sub.debit_account_id, mock.db.accounts[0].id);

  step('CSV: holder must be in the family list; codes are padded');
  await page.goto(`${appUrl}#/settings`);
  await page.getByLabel('取り込む台帳').selectOption({ label: '口座' });
  await page.getByLabel(/CSVファイル/).setInputFiles(csv('名称,金融機関コード,支店番号,名義人\r\n貯蓄口座,36,225,佐藤 一郎\r\n長すぎ口座,00369,1,山田 太郎\r\n'));
  await page.getByRole('button', { name: '取り込む' }).click();
  await page.getByText(/2行目: 名義人「佐藤 一郎」が家族の名前の一覧にありません/).waitFor();
  await page.getByText(/3行目: 金融機関コードは数字4桁で入力してください。/).waitFor();
  assert.ok(!mock.db.accounts.some((a) => a.name === '貯蓄口座'));
  await page.getByLabel(/CSVファイル/).setInputFiles(csv('名称,金融機関コード,支店番号,名義人\r\n貯蓄口座,36,225,山田 太郎\r\n'));
  await page.getByRole('button', { name: '取り込む' }).click();
  await page.getByText('取り込みました（追加 1件、更新 0件）。').waitFor();
  const saving = mock.db.accounts.find((a) => a.name === '貯蓄口座');
  assert.equal(saving.bank_code, '0036');
  assert.equal(saving.holder, '山田 太郎');
  const [tpl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '口座', exact: true }).first().click()]);
  assert.match(readFileSync(await tpl.path(), 'utf8'), /^\ufeffID,名称,金融機関名,金融機関コード,支店,支店番号,種別,口座番号下4桁/);

  step('full backup ZIP');
  const [zipDl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '全データを書き出す（ZIP）' }).click()]);
  const zipPath = join(OUT, 'backup.zip');
  writeFileSync(zipPath, readFileSync(await zipDl.path()));
  const listing = execFileSync('python3', ['-I', '-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print("\\n".join(z.namelist()))', zipPath]).toString();
  for (const name of ['口座.csv', 'クレジットカード.csv', '契約・固定費.csv', '書類・家電.csv', 'ポイントカード・会員情報.csv', '写真一覧.csv']) assert.ok(listing.includes(name), name);
  assert.match(listing, /photos\/.+\.jpg/);
  assert.ok(mock.db.settings.some((s) => s.key === 'last_backup_at'));

  step('delete account (references are cleared)');
  const accountsBefore = mock.db.accounts.length;
  const removedId = mock.db.accounts[0].id;
  await page.goto(`${appUrl}#/view/accounts/${removedId}`);
  await page.getByRole('button', { name: '削除' }).click();
  await page.getByRole('heading', { name: '口座', exact: true }).waitFor();
  assert.equal(mock.db.accounts.length, accountsBefore - 1);
  assert.ok(mock.db.cards.every((c) => c.debit_account_id !== removedId));

  step('logout');
  await page.goto(`${appUrl}#/settings`);
  await page.getByRole('button', { name: 'ログアウト', exact: true }).click();
  await page.getByRole('button', { name: 'ログイン' }).waitFor();

  step('desktop layout + dark mode screenshot');
  const desk = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
  await desk.goto(appUrl);
  await desk.getByLabel('メールアドレス', { exact: true }).fill(OWNER.email);
  await desk.getByLabel('パスワード', { exact: true }).fill(OWNER.password);
  await desk.getByRole('button', { name: 'ログイン' }).click();
  await desk.getByText(/円$/).first().waitFor();
  await desk.goto(`${appUrl}#/settings`);
  await desk.getByText(/写真（1枚）/).waitFor();
  await desk.screenshot({ path: join(OUT, 'settings-dark.png'), fullPage: true });

  const unexpected = errors.filter((e) => !/status of 40[01]|invalid_grant/.test(e)); // expected: the wrong-password attempt
  assert.deepEqual(unexpected, [], 'browser errors');
  console.log(`E2E passed. Screenshots: ${OUT}`);
} catch (e) {
  await page.screenshot({ path: join(OUT, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(`E2E failed: ${e.stack}\nBrowser errors: ${JSON.stringify(errors, null, 1)}\nScreenshot: ${join(OUT, 'failure.png')}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  await mock.stop();
}
