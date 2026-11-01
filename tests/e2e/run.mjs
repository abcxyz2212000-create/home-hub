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
import { ymAdd, ymLabel } from '../../web/js/shared.js';

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
  await fill('支店', 'さくら支店');
  await page.getByLabel('種別', { exact: true }).selectOption('普通');
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
  await page.getByLabel('種別', { exact: true }).selectOption('クレジット');
  await page.getByLabel('ブランド', { exact: true }).selectOption('JCB');
  await page.getByLabel('有効期限（年月）', { exact: true }).fill(todayJST().slice(0, 7));
  await page.getByLabel('引き落とし口座', { exact: true }).selectOption({ label: '生活費口座（さくら支店・普通・下4桁 1234）' }); // accounts are told apart by branch, kind and last 4 digits
  await fill('年会費（円）', '1100');
  await fill('年会費の発生月', '12');
  await fill('通知: カード有効期限（何日前）', '60 30');
  await save();
  await page.getByRole('heading', { name: 'メインカード' }).waitFor();
  assert.deepEqual(mock.db.cards[0].notify_days, { card_expiry: [60, 30] });
  assert.equal(mock.db.cards[0].kind, 'クレジット');

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
  await page.getByLabel('支払方法', { exact: true }).selectOption({ label: '生活費口座（さくら支店・普通・下4桁 1234）' });
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
  await fill('本名 *', '山田 太郎');
  await save();
  await page.getByRole('heading', { name: '設定', exact: true }).waitFor();
  await page.getByRole('link', { name: '＋ ユーザーを追加' }).click();
  await fill('本名 *', '山田 花子');
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
  await page.getByRole('heading', { name: '口座 → カード → 支払先（月額）' }).waitFor();
  const flowSvg = page.getByRole('img', { name: 'お金の流れ（月額）' });
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
  assert.match(face, /クレジット · JCB/);
  assert.match(face, /●●●● ●●●● ●●●● ●●●●|●●●● ●●●● ●●●● \d{4}/);
  assert.match(face, /引き落とし: 生活費口座/);
  assert.match(face, /年会費 1,100円（12月）/);
  assert.match(face, /期限まで\d+日/, 'expiring card is flagged');

  step('nickname: shown on screens, legal name kept for the holder');
  await page.goto(`${appUrl}#/member/${hanako.id}`);
  await fill('ニックネーム', 'はなこ');
  await save();
  await page.getByRole('heading', { name: '設定', exact: true }).waitFor();
  assert.equal(mock.db.members.find((m) => m.id === hanako.id).nickname, 'はなこ');
  assert.match(await page.locator('.member-list').innerText(), /はなこ（山田 花子）/);
  await page.goto(`${appUrl}#/view/accounts/${salary.id}`);
  await page.reload();
  await page.getByRole('heading', { name: '給与口座' }).waitFor();
  assert.match(await page.locator('#view').innerText(), /名義人\n山田 花子/, 'holder keeps the legal name');

  step('chores: choose days (times follow), workload and today');
  const dow = new Date(`${todayJST()}T00:00:00Z`).getUTCDay();
  await page.goto(`${appUrl}#/chore-edit/new`);
  await fill('タスク名 *', 'ゴミ出し');
  await page.getByLabel('カテゴリ', { exact: true }).selectOption('住');
  await page.locator('.day-picker .day').nth(dow).click();
  await page.locator('.day-picker .day').nth((dow + 3) % 7).click();
  assert.equal(await page.getByLabel('回数（サイクルあたり）', { exact: true }).inputValue(), '2');
  assert.equal(await page.getByLabel('回数（サイクルあたり）', { exact: true }).isDisabled(), true);
  await fill('1回の時間（分）', '5');
  await fill('調整係数', '1.1');
  await page.getByLabel('担当', { exact: true }).selectOption({ label: 'はなこ' });
  assert.match(await page.locator('.preview').innerText(), /0\.67時間\/月・733点\/月/);
  await save();
  await page.getByRole('heading', { name: 'ゴミ出し' }).waitFor();
  const gomi = mock.db.chores.find((c) => c.name === 'ゴミ出し');
  assert.deepEqual([gomi.cycle, gomi.schedule, gomi.times, gomi.minutes, gomi.adjust, gomi.assignee_type, gomi.assignee_id],
    ['week', [dow, (dow + 3) % 7].sort((a, b) => a - b), 2, 5, 1.1, 'member', hanako.id]);
  assert.match(await page.locator('#view').innerText(), /733点/);
  await page.goto(`${appUrl}#/chore-edit/new`);
  await fill('タスク名 *', '各種支払い');
  await page.getByLabel('サイクル *', { exact: true }).selectOption({ label: '随時' });
  await save();
  await page.getByText('随時の家事は、点数/月を入力してください。').waitFor();
  await fill('点数/月（随時のみ）', '300');
  await page.getByLabel('担当', { exact: true }).selectOption({ label: '全員（等分）' });
  await save();
  await page.getByRole('heading', { name: '各種支払い' }).waitFor();
  await page.getByRole('link', { name: '家事' }).first().click();
  await page.getByRole('img', { name: '担当ごとの月の負担（調整後の点数）' }).waitFor();
  const choresText = await page.locator('#view').innerText();
  assert.match(choresText, /今日の家事[\s\S]*ゴミ出し/);
  assert.match(choresText, /合計\s+1,033点/, 'only はなこ has chores, so the "all" chore is hers: 733 + 300');
  mock.db.chores.push({ id: 'ch-taro', name: '風呂掃除', status: 'active', cycle: 'month', schedule: [], times: 1, minutes: 60, adjust: 1,
    assignee_type: 'member', assignee_id: taro.id, category: '住', created_at: now, updated_at: now });
  await page.reload();
  await page.getByRole('img', { name: '担当ごとの月の負担（調整後の点数）' }).waitFor();
  const split = await page.locator('table').innerText();
  assert.match(split, /合計\s+883点\s+1,150点|合計\s+1,150点\s+883点/, 'はなこ 733+150, 太郎 1000+150');
  assert.match(await page.locator('.balance').innerText(), /山田 太郎 が はなこ より 267点 多い/);
  await page.goto(appUrl);
  await page.locator('.dash-head').waitFor();
  assert.match(await page.locator('#view').innerText(), /今日の家事\n[\s\S]*ゴミ出し/);

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
  await page.getByLabel('取り込む台帳', { exact: true }).selectOption({ label: 'カード' });
  await page.getByLabel(/CSVファイル/).setInputFiles(csv('カード名,引き落とし口座,有効期限（年月）\r\nサブカード,存在しない口座,2027/5/1\r\n'));
  await page.getByRole('button', { name: '取り込む' }).click();
  await page.getByText('エラーがあるため取り込みませんでした。').waitFor();
  await page.getByText(/2行目: 引き落とし口座「存在しない口座」/).waitFor();
  await page.getByLabel(/CSVファイル/).setInputFiles(csv('カード名,種別,引き落とし口座,有効期限（年月）,家族カードあり\r\nサブカード,デビット,生活費口座,2027/5/1,はい\r\n'));
  await page.getByRole('button', { name: '取り込む' }).click();
  await page.getByText('取り込みました（追加 1件、更新 0件）。').waitFor();
  const sub = mock.db.cards.find((c) => c.name === 'サブカード');
  assert.equal(sub.expiry_ym, '2027-05');
  assert.equal(sub.family_card, true);
  assert.equal(sub.kind, 'デビット');
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

  step('shared account: recurring rules, a charge and a deposit -> balance and carry-over');
  const ymNow = todayJST().slice(0, 7);
  const ymPrev = ymAdd(ymNow, -1);
  await page.goto(`${appUrl}#/shared`);
  await page.getByRole('link', { name: '＋ 定例項目を追加' }).click();
  await page.getByLabel('人', { exact: true }).selectOption({ label: 'はなこ' });
  await fill('費目 *', '基本');
  await fill('金額（円/月） *', '70000');
  await fill('開始月 *', ymPrev);
  await save();
  await page.getByRole('heading', { name: '定例項目' }).waitFor();
  await page.getByRole('link', { name: '＋ 追加' }).click();
  await page.getByLabel('人', { exact: true }).selectOption({ label: 'はなこ' });
  await fill('費目 *', 'dアニ');
  await fill('金額（円/月） *', '▲500');
  await fill('開始月 *', ymPrev);
  await fill('終了月', ymAdd(ymPrev, -1));
  await save();
  await page.getByText('終了月は開始月以降にしてください。').waitFor();
  await fill('終了月', '');
  await save();
  await page.getByRole('heading', { name: '定例項目' }).waitFor();
  assert.deepEqual(mock.db.shared_rules.map((r) => [r.label, r.amount, r.start_ym, r.end_ym, r.member_id]),
    [['基本', 70000, ymPrev, null, hanako.id], ['dアニ', -500, ymPrev, null, hanako.id]]);
  await page.getByRole('link', { name: '入金を記録' }).click();
  await fill('入金額（円） *', '100,000');
  await save();
  await page.locator('.shared-card').waitFor();
  await page.getByRole('link', { name: '＋ 臨時の費目を追加' }).click();
  await page.getByLabel('人', { exact: true }).selectOption({ label: 'はなこ' });
  await fill('費目 *', '管理費');
  await fill('金額（円） *', '-3000');
  await save();
  await page.locator('.shared-card').waitFor();
  const card = await page.locator('.shared-card').innerText();
  assert.match(card, /当月分\s+66,500円/);
  assert.match(card, /入金済み\s+100,000円/);
  assert.match(card, /未入金の残高\s+36,000円/, '69,500 carried + 66,500 - 100,000');
  const monthSheet = await page.locator('.shared-table').innerText();
  assert.match(monthSheet, /前月繰越\s+69,500円/);
  assert.match(monthSheet, /管理費\s+−3,000円/);
  assert.match(monthSheet, /当月分（小計）\s+66,500円/);
  assert.match(monthSheet, /定例（毎月）\s+基本\s+70,000円\s+dアニ\s+−500円\s+臨時（この月だけ）\s+管理費\s+−3,000円/);
  assert.match(await page.locator('.month-label').innerText(), new RegExp(`${ymLabel(ymNow)}\\s*今月`));
  assert.match(monthSheet, /合計\s+136,000円/);
  await page.getByRole('img', { name: '人ごとの未入金の残高の推移' }).waitFor();
  await page.screenshot({ path: join(OUT, 'shared.png'), fullPage: true });
  await page.getByRole('link', { name: '前の月' }).click();
  await page.getByRole('heading', { name: ymLabel(ymPrev), exact: true }).waitFor();
  assert.match(await page.locator('.shared-card').innerText(), /未入金の残高\s+69,500円/);
  step('one money page: people -> shared account -> cards -> payees, and the balance of the shared account');
  await page.getByRole('link', { name: 'お金の流れ', exact: true }).first().click();
  await page.getByRole('heading', { name: '口座 → カード → 支払先（月額）' }).waitFor();
  assert.match(await page.locator('#view').innerText(), /共通口座にする口座を選ぶと/);
  await page.goto(`${appUrl}#/settings`);
  await page.getByLabel('共通口座にする口座').selectOption({ label: '生活費口座（さくら支店・普通・下4桁 1234）' });
  await page.getByRole('button', { name: '共通口座にする' }).click();
  await page.getByText('共通口座を設定しました。').waitFor();
  await page.getByText('今の設定: 生活費口座（さくら支店・普通・下4桁 1234）。', { exact: false }).waitFor();
  assert.equal(mock.db.settings.find((x) => x.key === 'shared_account_id').value, mock.db.accounts.find((a) => a.name === '生活費口座').id);
  await page.goto(`${appUrl}#/flow`);
  await page.getByRole('heading', { name: 'はなこ → 口座 → カード → 支払先（月額）' }).waitFor();
  const money = await page.locator('#view').innerText();
  assert.match(money, /共通口座の収支（生活費口座・月額）/);
  assert.match(money, /入る額\s*66,500円/);
  assert.match(money, /出る額\s*7,000円/);
  assert.match(money, /差（余裕）\s*59,500円/);
  const flow4 = await page.getByRole('img', { name: 'お金の流れ（月額）' }).textContent();
  for (const t of ['はなこ', '生活費口座（共通）', '入 66,500円 / 出 7,000円', 'メインカード', '火災保険']) assert.ok(flow4.includes(t), `4-column flow shows ${t}`);
  assert.match(money, /共通口座への入金状況/);
  await page.screenshot({ path: join(OUT, 'money.png'), fullPage: true });

  step('a contract paid from a personal account (共通の費用) takes over the manual rule and keeps its history');
  await page.goto(`${appUrl}#/edit/accounts/new`);
  await fill('名称 *', 'はなこの口座');
  await page.getByLabel('名義人', { exact: true }).selectOption({ label: '山田 花子（はなこ）' });
  await save();
  await page.getByRole('heading', { name: 'はなこの口座' }).waitFor();
  await page.goto(`${appUrl}#/edit/contracts/new`);
  await fill('契約名 *', 'dアニ');
  await fill('金額（円）', '500');
  await page.getByLabel('周期', { exact: true }).selectOption({ label: '月払い' });
  await page.getByLabel('支払方法', { exact: true }).selectOption({ label: 'はなこの口座' });
  assert.equal(await page.getByLabel('既存の定例項目に引き継ぐ').isVisible(), false, 'shown only for shared costs');
  await page.getByLabel('共通の費用', { exact: true }).check();
  await page.getByText('→ はなこの当月分から毎月 500円を差し引きます。').waitFor();
  const dRule = mock.db.shared_rules.find((x) => x.label === 'dアニ');
  await page.getByLabel('既存の定例項目に引き継ぐ').selectOption(dRule.id);
  await save();
  await page.getByRole('heading', { name: '共通口座への入金との関係' }).waitFor();
  const dContract = mock.db.contracts.find((c) => c.name === 'dアニ');
  assert.equal(dContract.shared_cost, true);
  assert.deepEqual(mock.db.shared_rules.filter((x) => x.label === 'dアニ').map((x) => [x.id, x.contract_id, x.amount, x.start_ym, x.end_ym]),
    [[dRule.id, dContract.id, -500, ymPrev, null]], 'taken over, not added twice');
  // the price goes up: last month keeps -500, this month uses -550
  await page.goto(`${appUrl}#/edit/contracts/${dContract.id}`);
  await fill('金額（円）', '550');
  await save();
  await page.getByRole('heading', { name: '共通口座への入金との関係' }).waitFor();
  assert.deepEqual(mock.db.shared_rules.filter((x) => x.contract_id === dContract.id).map((x) => [x.amount, x.start_ym, x.end_ym]).sort(),
    [[-500, ymPrev, ymPrev], [-550, ymNow, null]].sort());
  await page.goto(`${appUrl}#/shared/${ymNow}`);
  assert.match(await page.locator('.shared-card').innerText(), /当月分\s+66,450円/, '70,000 - 550 - 3,000');
  await page.goto(`${appUrl}#/shared/${ymPrev}`);
  await page.getByRole('heading', { name: ymLabel(ymPrev), exact: true }).waitFor();
  assert.match(await page.locator('.shared-card').innerText(), /当月分\s+69,500円/, 'last month unchanged');
  const linkedRule = mock.db.shared_rules.find((x) => x.contract_id === dContract.id && !x.end_ym);
  await page.goto(`${appUrl}#/shared-rule/${linkedRule.id}`);
  await page.getByRole('link', { name: '契約「dアニ」を開く' }).waitFor();

  step('MoneyForward CSV (Shift_JIS): shared account + its cards only, plan vs actual, link and remember a keyword');
  const salaryAcc = mock.db.accounts.find((x) => x.name === '生活費口座');
  const mainCard = mock.db.cards.find((x) => x.name === 'メインカード');
  const net = mock.db.contracts.find((x) => x.name === 'インターネット');
  await page.goto(`${appUrl}#/edit/accounts/${salaryAcc.id}`);
  await fill('マネーフォワードでの名前', '共用口座');
  await save();
  await page.getByRole('heading', { name: '生活費口座', exact: true }).waitFor();
  await page.goto(`${appUrl}#/edit/cards/${mainCard.id}`);
  await fill('マネーフォワードでの名前', 'カードA');
  await save();
  await page.getByRole('heading', { name: 'メインカード', exact: true }).waitFor();
  await page.goto(`${appUrl}#/edit/contracts/${net.id}`);
  await fill('明細の照合キーワード', 'ネット回線');
  await save();
  await page.getByRole('heading', { name: 'インターネット', exact: true }).waitFor();
  await page.goto(`${appUrl}#/edit/contracts/new`);
  await fill('契約名 *', '電気代');
  await fill('金額（円）', '8000');
  await page.getByLabel('周期', { exact: true }).selectOption({ label: '月払い' });
  await page.getByLabel('支払方法', { exact: true }).selectOption({ label: 'メインカード' });
  await save();
  await page.getByRole('heading', { name: '電気代', exact: true }).waitFor();
  const d = `${ymNow.replace('-', '/')}/05`;
  const mfCsv = [
    '"計算対象","日付","内容","金額（円）","保有金融機関","大項目","中項目","メモ","振替","ID"',
    `"1","${d}","ネット回線１０月分","-5000","共用口座","通信費","インターネット","","0","mf-a"`,
    `"1","${d}","サンプル電力　１０月１２３","-8000","カードＡ","水道・光熱費","電気代","","0","mf-b"`,
    `"1","${d}","スーパーマーケット","-3000","カードA","食費","食料品","","0","mf-c"`,
    `"0","${d}","(カ)カードエー","-11000","共用口座","現金・カード","カード引き落とし","","1","mf-d"`,
    `"1","${d}","コンビニ","-500","個人の銀行","食費","食費","","0","mf-e"`,
    `"1","${d}","家賃","-80000","なし","住宅","家賃・地代","済","0","mf-f"`,
  ].join('\n') + '\n';
  const sjis = execFileSync('python3', ['-I', '-c', 'import sys; sys.stdout.buffer.write(sys.stdin.read().encode("cp932"))'], { input: mfCsv });
  const mfFile = { name: 'mf.csv', mimeType: 'text/csv', buffer: sjis };
  await page.goto(`${appUrl}#/shared/${ymNow}`);
  await page.getByRole('heading', { name: '共通口座の明細（実績）' }).waitFor();
  await page.getByLabel('マネーフォワードの CSV ファイル').setInputFiles(mfFile);
  await page.getByText('追加 4件（うち契約に自動でひも付け 1件）、更新 0件、対象外 2件').waitFor();
  const importStatus = await page.locator('.import-status').innerText();
  assert.match(importStatus, /対象外の金融機関: 個人の銀行。/);
  assert.match(importStatus, /手入力の立替の記録（保有金融機関が「なし」）1件は取り込みません/);
  assert.doesNotMatch(importStatus, /対象外の金融機関:[^。]*なし/, '"なし" is not offered as a name to register');
  await page.getByRole('button', { name: '取り込む' }).click();
  await page.getByText('取り込みました（追加 4件、更新 0件）。').waitFor();
  assert.equal(mock.db.transactions.length, 4);
  assert.equal(mock.db.transactions.find((t) => t.mf_id === 'mf-a').contract_id, net.id);
  assert.equal(mock.db.transactions.find((t) => t.mf_id === 'mf-b').card_id, mainCard.id);
  await page.getByText('契約ごとの予定と実績').waitFor();
  const actual = await page.locator('#view').innerText();
  assert.match(actual, /出金（実績）\s*16,000円/, 'card lines counted, the card payment (transfer) is not');
  assert.match(actual, /インターネット\s+5,000円\s+5,000円\s+一致/);
  assert.match(actual, /電気代\s+8,000円\s+—\s+未確認/);
  assert.match(actual, /契約にない明細（2件）/);
  await page.getByRole('link', { name: /サンプル電力/ }).click();
  await page.getByLabel('契約にひも付ける').selectOption({ label: '電気代' });
  await page.getByLabel('キーワード（明細の内容に含まれる語）').fill('サンプル電力');
  await page.getByRole('button', { name: '保存' }).click();
  await page.getByText('契約ごとの予定と実績').waitFor();
  const elec = mock.db.contracts.find((x) => x.name === '電気代');
  assert.equal(elec.match_keywords, 'サンプル電力');
  assert.equal(mock.db.transactions.find((t) => t.mf_id === 'mf-b').contract_id, elec.id);
  assert.match(await page.locator('#view').innerText(), /電気代\s+8,000円\s+8,000円\s+一致/);
  // importing the same file again updates, keeps the manual link and adds nothing
  await page.getByLabel('マネーフォワードの CSV ファイル').setInputFiles(mfFile);
  await page.getByText('追加 0件（うち契約に自動でひも付け 0件）、更新 4件、対象外 2件').waitFor();
  await page.getByRole('button', { name: '取り込む' }).click();
  await page.getByText('取り込みました（追加 0件、更新 4件）。').waitFor();
  assert.equal(mock.db.transactions.length, 4);
  assert.equal(mock.db.transactions.find((t) => t.mf_id === 'mf-b').contract_id, elec.id);
  await page.screenshot({ path: join(OUT, 'actual.png'), fullPage: true });

  step('personal lines: mark as one person\'s, keep one under review, settle into a one-off charge');
  await page.getByRole('link', { name: /スーパーマーケット/ }).click();
  await page.getByLabel('負担', { exact: true }).selectOption({ label: 'はなこの個人負担' });
  await page.getByRole('button', { name: '保存' }).click();
  await page.getByRole('heading', { name: '個人負担の精算' }).waitFor();
  assert.equal(mock.db.transactions.find((t) => t.mf_id === 'mf-c').personal_member_id, hanako.id);
  await page.getByText('はなこ：精算待ち 1件・3,000円').waitFor();
  assert.match(await page.locator('#view').innerText(), /出金（実績）\s*13,000円/, 'the personal line is no longer a shared cost');
  await page.goto(`${appUrl}#/tx/${mock.db.transactions.find((t) => t.mf_id === 'mf-a').id}`); // linked lines are folded away
  await page.getByLabel('負担', { exact: true }).selectOption({ label: '確認中（誰の負担か確かめる）' });
  await page.getByRole('button', { name: '保存' }).click();
  await page.getByText('確認中（1件）').waitFor();
  assert.equal(mock.db.transactions.find((t) => t.mf_id === 'mf-a').needs_review, true);
  const entriesBefore = mock.db.shared_entries.length;
  await page.getByRole('button', { name: '精算する' }).click();
  await page.getByText('個人負担の精算（1件）を追加しました。').waitFor();
  const settle = mock.db.shared_entries.at(-1);
  assert.equal(mock.db.shared_entries.length, entriesBefore + 1);
  assert.deepEqual([settle.member_id, settle.ym, settle.kind, settle.amount], [hanako.id, ymNow, 'charge', 3000]);
  assert.match(settle.memo, /スーパーマーケット 3,000円/);
  assert.equal(mock.db.transactions.find((t) => t.mf_id === 'mf-c').settled_entry_id, settle.id);
  await page.goto(`${appUrl}#/tx/${mock.db.transactions.find((t) => t.mf_id === 'mf-c').id}`);
  await page.getByText('精算済みです。').waitFor();
  assert.equal(await page.getByLabel('負担', { exact: true }).isDisabled(), true, 'settled lines cannot be changed');
  await page.goto(`${appUrl}#/shared-entry/${settle.id}`);
  await page.getByRole('button', { name: '削除' }).click();
  await page.locator('.shared-card').first().waitFor();
  assert.equal(mock.db.transactions.find((t) => t.mf_id === 'mf-c').settled_entry_id, null, 'deleting the charge puts the line back');
  await page.goto(`${appUrl}#/shared/${ymNow}`);
  await page.getByText('はなこ：精算待ち 1件・3,000円').waitFor();
  await page.goto(`${appUrl}#/settings`);
  await page.getByRole('heading', { name: '設定', exact: true }).waitFor();

  step('full backup ZIP');
  const [zipDl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '全データを書き出す（ZIP）' }).click()]);
  const zipPath = join(OUT, 'backup.zip');
  writeFileSync(zipPath, readFileSync(await zipDl.path()));
  const listing = execFileSync('python3', ['-I', '-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print("\\n".join(z.namelist()))', zipPath]).toString();
  for (const name of ['口座.csv', 'カード.csv', '契約・固定費.csv', '書類・家電.csv', 'ポイントカード・会員情報.csv', '写真一覧.csv', '共通口座_定例項目.csv', '共通口座_臨時の費目と入金.csv', '共通口座_明細（マネーフォワード）.csv']) assert.ok(listing.includes(name), name);
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
  assert.ok(memberSettings.includes('ログイン中: はなこ（一般）'), 'the nickname is shown');
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
