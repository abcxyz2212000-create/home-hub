// End-to-end check in a real Chromium against tests/mock-supabase.mjs.
// Usage: node tests/e2e/run.mjs   (needs Playwright + Chromium installed globally; not part of `npm test`)
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { createMock, OWNER, MEMBER, STRANGER } from '../mock-supabase.mjs';
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
const now = new Date().toISOString();
mock.db.members.push({ id: 'm-admin', name: '共通（管理者）', email: OWNER.email, role: 'admin', active: true, created_at: now, updated_at: now });
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
  await fill('口座番号（全桁）', '12a4567');
  await page.getByLabel('リンクの名前', { exact: true }).first().fill('ログイン');
  await page.getByLabel('URL', { exact: true }).first().fill('https://bank.example/login');
  await save();
  await page.getByText('口座番号（全桁）は数字4〜14桁で入力してください。').waitFor();
  await fill('口座番号（全桁）', '000 1234');
  await save();
  await page.getByRole('heading', { name: '生活費口座' }).waitFor();
  assert.equal(mock.db.accounts[0].account_no, '0001234');
  assert.equal(mock.db.accounts[0].last4, '1234', 'last 4 digits derived from the full number');

  step('full account number is masked until revealed');
  const accountView = await page.locator('#view').innerText();
  assert.match(accountView, /●●●1234/);
  assert.doesNotMatch(accountView, /0001234/);
  await page.getByRole('button', { name: '表示' }).click();
  await page.getByText('0001234', { exact: true }).waitFor();
  await page.getByRole('button', { name: '隠す' }).click();
  await page.getByText('●●●1234', { exact: true }).waitFor();
  assert.doesNotMatch(await page.locator('#view').innerText(), /0001234/);
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
  await page.getByText('7,000円', { exact: true }).waitFor();
  assert.ok(await page.getByRole('img', { name: /今日から60日先までの期限/ }).isVisible(), 'deadline timeline');
  assert.ok(await page.getByRole('img', { name: '固定費の種類別の月額' }).isVisible(), 'fixed cost bars');
  assert.ok(await page.getByRole('img', { name: /お金の流れ/ }).isVisible(), 'money flow (compact)');
  assert.match(await page.locator('.dash-head').innerText(), /こんにちは、共通（管理者）さん/);
  assert.match(await page.locator('.kpis').innerText(), /固定費 \/ 月\n7,000円[\s\S]*期限 30日以内\n\d+件/);
  const home = await page.locator('#view').innerText();
  assert.match(home, /あと7日[\s\S]*火災保険/);
  assert.match(home, /メインカード\nカード有効期限/);
  assert.ok(await page.getByRole('link', { name: 'みどり銀行' }).isVisible());
  await page.screenshot({ path: join(OUT, 'home.png'), fullPage: true });

  step('user master: an administrator adds members; holder is chosen from them');
  await page.goto(`${appUrl}#/settings`);
  await page.getByRole('link', { name: '＋ ユーザーを追加' }).click();
  await fill('名前 *', '山田 太郎');
  await save();
  await page.getByRole('heading', { name: '設定', exact: true }).waitFor();
  await page.getByRole('link', { name: '＋ ユーザーを追加' }).click();
  await fill('名前 *', '山田 花子');
  await fill('ログイン用メールアドレス', 'Hanako@Example.com');
  await save();
  await page.getByRole('heading', { name: '設定', exact: true }).waitFor();
  const taro = mock.db.members.find((m) => m.name === '山田 太郎');
  const hanako = mock.db.members.find((m) => m.name === '山田 花子');
  assert.deepEqual([taro.email ?? null, taro.role, taro.active], [null, 'member', true]);
  assert.equal(hanako.email, 'hanako@example.com', 'email is stored in lower case');
  await page.getByText('ログインなし').first().waitFor();
  await page.goto(`${appUrl}#/edit/accounts/new`);
  const holderOptions = await page.getByLabel('名義人', { exact: true }).locator('option').allInnerTexts();
  assert.deepEqual([...holderOptions].sort(), ['（未設定）', '共通（管理者）', '山田 太郎', '山田 花子'].sort());
  await fill('名称 *', '給与口座');
  await page.getByLabel('名義人', { exact: true }).selectOption({ label: '山田 花子' });
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
  assert.equal(salary.holder_id, hanako.id);
  const salaryView = await page.locator('#view').innerText();
  assert.match(salaryView, /金融機関コード\n0036/);
  assert.match(salaryView, /名義人\n山田 花子/);
  assert.equal(salary.account_no ?? null, null);
  assert.equal(salary.last4 ?? null, null);

  step('change history is shown on the detail page, newest first');
  const living = mock.db.accounts.find((a) => a.name === '生活費口座');
  mock.db.audit_log.push(
    { id: 1, at: '2026-11-01T01:00:00Z', table_name: 'accounts', record_id: living.id, record_name: '生活費口座', action: 'insert', actor_name: '共通（管理者）', changes: {} },
    { id: 2, at: '2026-11-01T02:00:00Z', table_name: 'accounts', record_id: living.id, record_name: '生活費口座', action: 'update', actor_name: '山田 花子',
      changes: { bank_code: [null, '0036'], account_no: ['●●●1234', '●●●5678'], holder_id: [null, hanako.id], kind: [null, '普通'], mf_linked: [false, true] } },
    { id: 3, at: '2026-11-01T03:00:00Z', table_name: 'cards', record_id: living.id, record_name: '別の台帳', action: 'delete', actor_name: '他人', changes: {} },
  );
  await page.goto(`${appUrl}#/view/accounts/${living.id}`);
  await page.getByText('金融機関コード: （なし） → 0036').waitFor();
  const historyText = await page.locator('section', { has: page.getByRole('heading', { name: '変更履歴' }) }).innerText();
  for (const line of ['山田 花子', '口座番号（全桁）: ●●●1234 → ●●●5678', '名義人: （なし） → 山田 花子', '種別: （なし） → 普通', 'マネーフォワード連携: いいえ → はい', '追加しました']) {
    assert.ok(historyText.includes(line), `history shows: ${line}`);
  }
  assert.ok(historyText.indexOf('金融機関コード') < historyText.indexOf('追加しました'), 'newest first');
  assert.ok(!historyText.includes('他人'), 'only this record');

  step('an inactive member stays visible as (無効) on records that use it');
  living.holder_id = taro.id;
  taro.active = false;
  await page.goto(`${appUrl}#/edit/accounts/${living.id}`);
  await page.reload(); // the app keeps loaded data in memory; reload to read the changed rows
  await page.getByLabel('名義人', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('名義人', { exact: true }).inputValue(), taro.id);
  await page.getByText('山田 太郎（無効）').waitFor({ state: 'attached' });
  await page.getByRole('link', { name: 'キャンセル' }).click();
  taro.active = true;
  await page.reload();

  step('the last administrator cannot be demoted');
  await page.goto(`${appUrl}#/member/m-admin`);
  await page.getByLabel('権限 *', { exact: true }).selectOption({ label: '一般' });
  await save();
  await page.getByText(/管理者が1人もいなくなるため/).waitFor();
  assert.equal(mock.db.members.find((m) => m.id === 'm-admin').role, 'admin');
  await page.getByRole('link', { name: 'キャンセル' }).click();

  step('money flow page: accounts -> cards -> contracts with links to the records');
  await page.getByRole('link', { name: 'お金の流れ' }).click();
  await page.getByRole('heading', { name: '口座 → カード → 契約（月額）' }).waitFor();
  const flowSvg = page.getByRole('img', { name: /口座からカード・契約へのお金の流れ/ });
  const flowText = await flowSvg.evaluate((el) => el.textContent);
  for (const t of ['生活費口座', '月 7,000円', 'メインカード', '火災保険', '2,000円※', 'インターネット', '5,000円']) assert.ok(flowText.includes(t), `flow shows ${t}`);
  assert.match(await page.locator('table').innerText(), /生活費口座\s+7,000円/);
  await flowSvg.locator('a', { hasText: 'メインカード' }).click();
  await page.getByRole('heading', { name: 'メインカード' }).waitFor();

  step('card list shows card faces');
  await page.goto(`${appUrl}#/list/cards`);
  await page.locator('.cc').first().waitFor();
  const face = await page.locator('.cc-wrap').first().innerText();
  assert.match(face, /メインカード/);
  assert.match(face, /●●●● ●●●● ●●●● ●●●●|●●●● ●●●● ●●●● \d{4}/);
  assert.match(face, /引き落とし: 生活費口座/);
  assert.match(face, /年会費 1,100円（12月）/);
  assert.match(face, /期限まで\d+日/, 'expiring card is flagged');

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

  step('CSV: holder must be in the user master; codes are padded');
  await page.goto(`${appUrl}#/settings`);
  await page.getByLabel('取り込む台帳').selectOption({ label: '口座' });
  await page.getByLabel(/CSVファイル/).setInputFiles(csv('名称,金融機関コード,支店番号,名義人\r\n貯蓄口座,36,225,佐藤 一郎\r\n長すぎ口座,00369,1,山田 太郎\r\n'));
  await page.getByRole('button', { name: '取り込む' }).click();
  await page.getByText(/2行目: 名義人「佐藤 一郎」がユーザーマスターにありません/).waitFor();
  await page.getByText(/3行目: 金融機関コードは数字4桁で入力してください。/).waitFor();
  assert.ok(!mock.db.accounts.some((a) => a.name === '貯蓄口座'));
  await page.getByLabel(/CSVファイル/).setInputFiles(csv('名称,金融機関コード,支店番号,名義人\r\n貯蓄口座,36,225,山田 太郎\r\n'));
  await page.getByRole('button', { name: '取り込む' }).click();
  await page.getByText('取り込みました（追加 1件、更新 0件）。').waitFor();
  const saving = mock.db.accounts.find((a) => a.name === '貯蓄口座');
  assert.equal(saving.bank_code, '0036');
  assert.equal(saving.holder_id, taro.id);
  const [tpl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '口座', exact: true }).first().click()]);
  assert.match(readFileSync(await tpl.path(), 'utf8'), /^\ufeffID,名称,金融機関名,金融機関コード,支店,支店番号,種別,口座番号（全桁）,用途/);

  step('CSV: the existing 口座マスタ sheet (title row + its own headers) imports as-is');
  await page.getByLabel('取り込む台帳').selectOption({ label: '口座' });
  await page.getByLabel(/CSVファイル/).setInputFiles(csv('口座マスタ,,,,,,\r\n摘要,金融機関コード,支店番号,支店名,預金科目,口座番号,口座名義\r\nテスト銀行,0036,225,テスト支店,普通,7654321,山田 太郎\r\n'));
  await page.getByRole('button', { name: '取り込む' }).click();
  await page.getByText('取り込みました（追加 1件、更新 0件）。').waitFor();
  const sheet = mock.db.accounts.find((a) => a.name === 'テスト銀行');
  assert.deepEqual(
    [sheet.bank_code, sheet.branch_code, sheet.branch, sheet.kind, sheet.account_no, sheet.last4, sheet.holder_id],
    ['0036', '225', 'テスト支店', '普通', '7654321', '4321', taro.id],
  );
  await page.getByLabel(/CSVファイル/).setInputFiles(csv('名称,摘要\r\nA,B\r\n'));
  await page.getByRole('button', { name: '取り込む' }).click();
  await page.getByText(/見出し「名称」が重複しています/).waitFor();

  step('full backup ZIP');
  const [zipDl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '全データを書き出す（ZIP）' }).click()]);
  const zipPath = join(OUT, 'backup.zip');
  writeFileSync(zipPath, readFileSync(await zipDl.path()));
  const listing = execFileSync('python3', ['-I', '-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print("\\n".join(z.namelist()))', zipPath]).toString();
  for (const name of ['口座.csv', 'クレジットカード.csv', '契約・固定費.csv', '書類・家電.csv', 'ポイントカード・会員情報.csv', '写真一覧.csv']) assert.ok(listing.includes(name), name);
  assert.match(listing, /photos\/.+\.jpg/);
  const accountsCsv = execFileSync('python3', ['-I', '-c', 'import sys,zipfile; print(zipfile.ZipFile(sys.argv[1]).read("口座.csv").decode("utf-8-sig"))', zipPath]).toString();
  assert.match(accountsCsv, /7654321/, 'backup keeps the full account number');
  assert.ok(mock.db.settings.some((s) => s.key === 'last_backup_at'));

  step('delete account (references are cleared)');
  const accountsBefore = mock.db.accounts.length;
  const removedId = mock.db.accounts[0].id;
  await page.goto(`${appUrl}#/view/accounts/${removedId}`);
  await page.getByRole('button', { name: '削除' }).click();
  await page.getByRole('heading', { name: '口座', exact: true }).waitFor();
  assert.equal(mock.db.accounts.length, accountsBefore - 1);
  assert.ok(mock.db.cards.every((c) => c.debit_account_id !== removedId));

  step('a regular member: no import, no user editing, no shortcut settings');
  const login = async (p, user) => {
    p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    p.on('dialog', (d) => d.accept());
    await p.goto(appUrl);
    await p.getByLabel('メールアドレス', { exact: true }).fill(user.email);
    await p.getByLabel('パスワード', { exact: true }).fill(user.password);
    await p.getByRole('button', { name: 'ログイン' }).click();
  };
  const memberCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ja-JP' });
  const mp = await memberCtx.newPage();
  await login(mp, MEMBER);
  await mp.getByRole('heading', { name: '期限が近い予定' }).waitFor();
  await mp.goto(`${appUrl}#/settings`);
  await mp.getByRole('heading', { name: 'ユーザー', exact: true }).waitFor();
  const memberSettings = await mp.locator('#view').innerText();
  assert.ok(memberSettings.includes('CSV の取り込みは管理者だけが行えます。'));
  assert.ok(memberSettings.includes('ログイン中: 山田 花子（一般）'));
  assert.equal(await mp.getByRole('link', { name: '＋ ユーザーを追加' }).count(), 0);
  assert.equal(await mp.getByRole('heading', { name: 'ショートカット' }).count(), 0);
  assert.equal(await mp.getByRole('button', { name: '取り込む' }).count(), 0);
  await mp.getByRole('link', { name: '山田 太郎' }).click();
  await mp.getByText('ユーザーの変更は管理者だけが行えます。').waitFor();
  await memberCtx.close();

  step('a logged-in user who is not in the user master gets no data');
  const strangerCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ja-JP' });
  const sp = await strangerCtx.newPage();
  await login(sp, STRANGER);
  await sp.getByText('このアカウントは利用者として登録されていません').waitFor();
  assert.equal(await sp.locator('#nav').isHidden(), true);
  await strangerCtx.close();

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
