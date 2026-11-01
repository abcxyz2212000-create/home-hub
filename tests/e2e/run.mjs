// End-to-end check in a real Chromium against tests/mock-supabase.mjs.
// Usage: node tests/e2e/run.mjs   (needs Playwright + Chromium installed globally; not part of `npm test`)
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
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
// serviceWorkers: 'block' so that page.route() also sees requests (a controlled page bypasses it)
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true, locale: 'ja-JP', serviceWorkers: 'block' });
// site icons of the shortcuts are loaded from the sites themselves: whether they load here depends on the
// network, so their load errors are not counted.
const isSiteIcon = (m) => /\/favicon\.ico$/.test((m.location() || {}).url || '');
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' && !isSiteIcon(m)) errors.push(`console: ${m.text()}`); });
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
  assert.deepEqual((await page.locator('.shortcut-label').allInnerTexts()), ['マネーフォワード ME', 'Amazon', 'Google パスワードマネージャー'], '注文履歴 removed');
  // each tile shows the site icon, or the first letter when the icon cannot be loaded
  assert.equal(await page.locator('.shortcut-icon').count(), 3);
  assert.equal(await page.locator('.shortcut-icon:not(:has(img)):not(:has(.shortcut-letter))').count(), 0);

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

  step('ledgers: every ledger with its records at a glance');
  await page.goto(`${appUrl}#/ledgers`);
  await page.locator('#ledger-contracts').waitFor();
  const digest = await page.locator('#ledger-contracts').innerText();
  for (const t of ['契約・固定費', '火災保険', 'インターネット']) assert.ok(digest.includes(t), `digest shows ${t}`);
  await page.locator('#ledger-contracts').getByRole('link', { name: /火災保険/ }).click();
  await page.getByRole('heading', { name: '火災保険' }).waitFor();

  step('home: my deposits, today\'s chores, deadlines, shortcuts (nothing else)');
  await page.goto(appUrl);
  await page.getByRole('img', { name: /今日から60日先までの期限/ }).waitFor();
  assert.match(await page.locator('.page-head h1').innerText(), /\d+月\d+日（.）/);
  assert.equal(await page.locator('.kpis').count(), 0, 'no summary numbers');
  assert.equal(await page.getByRole('img', { name: /お金の流れ|固定費/ }).count(), 0, 'no money charts on the home screen');
  const home = await page.locator('#view').innerText();
  assert.match(home, /あと7日[\s\S]*火災保険/);
  assert.match(home, /メインカード\nカード有効期限/);
  assert.ok(await page.getByRole('link', { name: 'みどり銀行' }).isVisible());
  await page.screenshot({ path: join(OUT, 'home.png'), fullPage: true });

  step('user master: an administrator adds members; holder is chosen from them');
  await page.goto(`${appUrl}#/settings/users`);
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
  await page.goto(`${appUrl}#/flow/flow`);
  await page.getByRole('heading', { name: '口座 → カード → 支払先（月額）' }).waitFor();
  const flowBox = page.getByRole('img', { name: 'お金の流れ（月額）' });
  const flowText = await flowBox.evaluate((el) => [...el.querySelectorAll('text')].map((t) => t.textContent));
  for (const t of ['外部（支払先）', 'メインカード', 'カードの引き落とし 2,000円', '火災保険 2,000円', '5,000円']) assert.ok(flowText.includes(t), `flow shows ${t}`);
  assert.equal(new Set(flowText).size, flowText.length, 'every box once');
  assert.match(await page.locator('table').innerText(), /生活費口座\s+7,000円/);
  await flowBox.locator('a', { hasText: 'メインカード' }).click();
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
  await page.getByRole('link', { name: '今日', exact: true }).click();
  assert.match(await page.locator('#view').innerText(), /今日の家事[\s\S]*ゴミ出し/);
  await page.getByRole('link', { name: '負担の割合', exact: true }).click();
  await page.getByRole('img', { name: '担当ごとの月の負担（調整後の点数）' }).waitFor();
  assert.match(await page.locator('#view').innerText(), /合計\s+1,033点/, 'only はなこ has chores, so the "all" chore is hers: 733 + 300');
  mock.db.chores.push({ id: 'ch-taro', name: '風呂掃除', status: 'active', cycle: 'month', schedule: [], times: 1, minutes: 60, adjust: 1,
    assignee_type: 'member', assignee_id: taro.id, category: '住', created_at: now, updated_at: now });
  await page.reload();
  await page.getByRole('img', { name: '担当ごとの月の負担（調整後の点数）' }).waitFor();
  const split = await page.locator('table').innerText();
  assert.match(split, /合計\s+883点\s+1,150点|合計\s+1,150点\s+883点/, 'はなこ 733+150, 太郎 1000+150');
  assert.match(await page.locator('.balance').innerText(), /山田 太郎 が はなこ より 267点 多い/);
  await page.goto(appUrl);
  await page.locator('.page-head').first().waitFor();
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
  await page.goto(`${appUrl}#/settings/account`);
  await page.getByRole('button', { name: '通知の鍵を作成' }).click();
  await page.getByText('鍵を作成しました').waitFor();
  const secret = await page.getByLabel('秘密の値', { exact: true }).inputValue();
  assert.equal(Buffer.from(secret, 'base64url').length, 32);
  assert.equal(Buffer.from(mock.db.settings.find((s) => s.key === 'vapid_public_key').value, 'base64url').length, 65);
  await page.getByRole('link', { name: 'データ', exact: true }).click();
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
  await page.goto(`${appUrl}#/settings/data`);
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
  await page.getByRole('link', { name: '＋ 入金（管理者）' }).click();
  await page.getByLabel('人', { exact: true }).selectOption({ label: 'はなこ' });
  await fill('入金額（円） *', '100,000');
  await save();
  await page.locator('.shared-card').waitFor();
  await page.getByRole('link', { name: '＋ 臨時の費目（管理者）' }).click();
  await page.getByLabel('人', { exact: true }).selectOption({ label: 'はなこ' });
  await page.getByLabel('費目', { exact: true }).selectOption('管理費'); // from the list of 費目
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
  await page.getByRole('link', { name: 'お金', exact: true }).first().click();
  await page.getByRole('heading', { name: 'お金', exact: true }).waitFor();
  await page.getByRole('link', { name: '流れ図', exact: true }).click();
  await page.getByRole('heading', { name: '口座 → カード → 支払先（月額）' }).waitFor();
  assert.match(await page.locator('#view').innerText(), /共用口座にする口座を選ぶと/);
  await page.goto(`${appUrl}#/settings/other`);
  await page.getByLabel('共用口座にする口座').selectOption({ label: '生活費口座（さくら支店・普通・下4桁 1234）' });
  await page.getByRole('button', { name: '共用口座にする' }).click();
  await page.getByText('共用口座を設定しました。').waitFor();
  await page.getByText('今の設定: 生活費口座（さくら支店・普通・下4桁 1234）').waitFor();
  assert.equal(mock.db.settings.find((x) => x.key === 'shared_account_id').value, mock.db.accounts.find((a) => a.name === '生活費口座').id);
  await page.goto(`${appUrl}#/flow/flow/${ymNow}`);
  await page.getByRole('heading', { name: 'はなこ → 口座 → カード → 支払先（月額）' }).waitFor();
  const money = await page.locator('#view').innerText();
  assert.match(money, /共用口座の収支（生活費口座・月額）/);
  assert.match(money, /入る額\s*66,500円/);
  assert.match(money, /出る額\s*7,000円/);
  assert.match(money, /差（余裕）\s*59,500円/);
  const flow4 = await page.getByRole('img', { name: 'お金の流れ（月額）' }).evaluate((el) => [...el.querySelectorAll('text')].map((t) => t.textContent));
  for (const t of ['給与口座（はなこ）', '当月分 66,500円', '生活費口座（共用）', '外部（支払先）', 'メインカード']) assert.ok(flow4.includes(t), `flow shows ${t}`);
  assert.equal(flow4.filter((t) => t === '外部（支払先）').length, 1, 'one box for everything outside');
  await page.getByRole('link', { name: '年間' }).click();
  await page.getByRole('heading', { name: 'はなこ → 口座 → カード → 支払先（年額）' }).waitFor();
  assert.match(await page.locator('#view').innerText(), /口座ごとの引き落とし（年額）/);
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
  assert.equal(await page.getByLabel('既存の定例項目に引き継ぐ', { exact: true }).isVisible(), false, 'shown only for shared costs');
  await page.getByLabel('共通の費用', { exact: true }).check();
  await page.getByText('→ はなこの当月分から毎月 500円を差し引きます。').waitFor();
  const dRule = mock.db.shared_rules.find((x) => x.label === 'dアニ');
  await page.getByLabel('既存の定例項目に引き継ぐ', { exact: true }).selectOption(dRule.id);
  await save();
  await page.getByRole('heading', { name: '共用口座への入金との関係' }).waitFor();
  const dContract = mock.db.contracts.find((c) => c.name === 'dアニ');
  assert.equal(dContract.shared_cost, true);
  assert.deepEqual(mock.db.shared_rules.filter((x) => x.label === 'dアニ').map((x) => [x.id, x.contract_id, x.amount, x.start_ym, x.end_ym]),
    [[dRule.id, dContract.id, -500, ymPrev, null]], 'taken over, not added twice');
  // the price goes up: last month keeps -500, this month uses -550
  await page.goto(`${appUrl}#/edit/contracts/${dContract.id}`);
  await fill('金額（円）', '550');
  await save();
  await page.getByRole('heading', { name: '共用口座への入金との関係' }).waitFor();
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
  await page.goto(`${appUrl}#/member/${hanako.id}`);
  await fill('振込名義', 'ツツイ ハナコ、タテイシ ハナコ');
  await save();
  await page.getByRole('heading', { name: '設定', exact: true }).waitFor();
  const d = `${ymNow.replace('-', '/')}/05`;
  const mfCsv = [
    '"計算対象","日付","内容","金額（円）","保有金融機関","大項目","中項目","メモ","振替","ID"',
    `"1","${d}","ネット回線１０月分","-5000","共用口座","通信費","インターネット","","0","mf-a"`,
    `"1","${d}","サンプル電力　１０月１２３","-8000","カードＡ","水道・光熱費","電気代","","0","mf-b"`,
    `"1","${d}","スーパーマーケット","-3000","カードA","食費","食料品","","0","mf-c"`,
    `"0","${d}","(カ)カードエー","-11000","共用口座","現金・カード","カード引き落とし","","1","mf-d"`,
    `"1","${d}","コンビニ","-500","個人の銀行","食費","食費","","0","mf-e"`,
    `"1","${d}","家賃","-80000","なし","住宅","家賃・地代","済","0","mf-f"`,
    `"1","${d}","ﾀﾃｲｼ ﾊﾅｺ","50000","共用口座","収入","計算対象外","","0","mf-g"`,
  ].join('\n') + '\n';
  const sjis = execFileSync('python3', ['-I', '-c', 'import sys; sys.stdout.buffer.write(sys.stdin.read().encode("cp932"))'], { input: mfCsv });
  const mfFile = { name: 'mf.csv', mimeType: 'text/csv', buffer: sjis };
  await page.goto(`${appUrl}#/flow/ext/${ymNow}`);
  await page.getByRole('heading', { name: '共用口座の明細（実績）' }).waitFor();
  await page.waitForLoadState('networkidle'); // the month's lines are loaded (the page redraws once)
  await page.getByLabel('マネーフォワードの CSV ファイル').setInputFiles(mfFile);
  await page.getByText('追加 5件（うち契約に自動でひも付け 1件）、更新 0件、対象外 2件').waitFor();
  const importStatus = await page.locator('.mf-import:not(.bank-import) .import-status').innerText();
  assert.match(importStatus, /入金として記録: 1件（はなこ 1件）/);
  assert.match(importStatus, /対象外の金融機関: 個人の銀行\s*\?/);
  assert.match(importStatus, /手入力の記録 1件は対象外/);
  assert.doesNotMatch(importStatus, /対象外の金融機関:[^\n?]*なし/, '"なし" is not offered as a name to register');
  await page.getByRole('button', { name: '取り込む' }).click();
  await page.getByText('取り込みました（追加 5件、更新 0件、個人との入出金の記録 1件）。').waitFor();
  assert.equal(mock.db.transactions.length, 5);
  const autoDeposit = mock.db.shared_entries.find((e) => e.kind === 'deposit' && e.amount === 50000);
  assert.deepEqual([autoDeposit.member_id, autoDeposit.ym, autoDeposit.label], [hanako.id, ymNow, '入金']);
  assert.equal(mock.db.transactions.find((t) => t.mf_id === 'mf-g').deposit_entry_id, autoDeposit.id);
  assert.equal(mock.db.transactions.find((t) => t.mf_id === 'mf-a').contract_id, net.id);
  assert.equal(mock.db.transactions.find((t) => t.mf_id === 'mf-b').card_id, mainCard.id);
  await page.getByText('固定費の予定と実績').waitFor();
  const actual = await page.locator('#view').innerText();
  assert.match(actual, /出金\s*16,000円/, 'card lines counted, the card payment (transfer) is not');
  assert.match(actual, /入金\s*50,000円/, 'money from a member is income of the shared account too');
  assert.match(actual, /はなこ\s*から\s*50,000円/, 'shown per person');
  assert.match(actual, /個人との入出金（1件/);
  assert.match(actual, /インターネット\s+5,000円\s+5,000円\s+一致/);
  assert.match(actual, /電気代\s+8,000円\s+—\s+未確認/);
  assert.match(actual, /変動費の明細（2件）/);
  await page.getByRole('link', { name: /サンプル電力/ }).click();
  await page.getByLabel('契約にひも付ける').selectOption({ label: '電気代' });
  await page.getByLabel('キーワード（明細の内容に含まれる語）').fill('サンプル電力');
  await page.getByRole('button', { name: '保存' }).click();
  await page.getByText('固定費の予定と実績').waitFor();
  const elec = mock.db.contracts.find((x) => x.name === '電気代');
  assert.equal(elec.match_keywords, 'サンプル電力');
  assert.equal(mock.db.transactions.find((t) => t.mf_id === 'mf-b').contract_id, elec.id);
  assert.match(await page.locator('#view').innerText(), /電気代\s+8,000円\s+8,000円\s+一致/);
  // importing the same file again updates, keeps the manual link and adds nothing
  await page.waitForLoadState('networkidle'); // the month's lines are loaded (the page redraws once)
  await page.getByLabel('マネーフォワードの CSV ファイル').setInputFiles(mfFile);
  await page.getByText('追加 0件（うち契約に自動でひも付け 0件）、更新 5件、対象外 2件').waitFor();
  await page.getByRole('button', { name: '取り込む' }).click();
  await page.getByText('取り込みました（追加 0件、更新 5件）。').waitFor();
  assert.equal(mock.db.transactions.length, 5);
  assert.equal(mock.db.shared_entries.filter((e) => e.amount === 50000 && e.kind === 'deposit').length, 1, 'importing again does not record the deposit twice');
  assert.equal(mock.db.transactions.find((t) => t.mf_id === 'mf-b').contract_id, elec.id);
  await page.screenshot({ path: join(OUT, 'actual.png'), fullPage: true });

  step('personal lines: mark as one person\'s, keep one under review, settle into a one-off charge');
  await page.getByRole('link', { name: /スーパーマーケット/ }).click();
  await page.getByLabel('負担', { exact: true }).selectOption({ label: 'はなこ負担' });
  await page.getByRole('button', { name: '保存' }).click();
  await page.getByText('固定費の予定と実績').waitFor();
  assert.equal(mock.db.transactions.find((t) => t.mf_id === 'mf-c').personal_member_id, hanako.id);
  const afterPersonal = await page.locator('#view').innerText();
  assert.match(afterPersonal, /出金\s*16,000円/, 'money that left the shared account, whoever carries it');
  assert.match(afterPersonal, /はなこ\s*負担（精算待ち・済み）\s*3,000円/);
  await page.goto(`${appUrl}#/flow/member/${ymNow}`);
  await page.locator('h3', { hasText: 'はなこ 精算待ち 1件・3,000円' }).waitFor();
  await page.goto(`${appUrl}#/tx/${mock.db.transactions.find((t) => t.mf_id === 'mf-a').id}`); // linked lines are folded away
  await page.getByLabel('負担', { exact: true }).selectOption({ label: '確認中' });
  await page.getByRole('button', { name: '保存' }).click();
  await page.getByText('固定費の予定と実績').waitFor();
  await page.goto(`${appUrl}#/flow/member/${ymNow}`);
  await page.getByText('確認中（1件）').waitFor();
  const review = page.locator('.review-item').first();
  for (const name of ['共通', 'はなこ負担', '対象外（数えない）']) assert.equal(await review.getByRole('button', { name, exact: true }).count(), 1, `${name} can be chosen right there`);
  assert.match(await review.getByRole('button', { name: '対象外（数えない）' }).getAttribute('title'), /なかったことに/, 'the meaning is shown as a tooltip');
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
  await page.locator('.tag', { hasText: '精算済み' }).waitFor();
  assert.equal(await page.getByLabel('負担', { exact: true }).isDisabled(), true, 'settled lines cannot be changed');
  await page.goto(`${appUrl}#/shared-entry/${settle.id}`);
  await page.getByRole('button', { name: '削除' }).click();
  await page.locator('.shared-card').first().waitFor();
  assert.equal(mock.db.transactions.find((t) => t.mf_id === 'mf-c').settled_entry_id, null, 'deleting the charge puts the line back');
  await page.goto(`${appUrl}#/shared/${ymNow}`);
  await page.locator('h3', { hasText: 'はなこ 精算待ち 1件・3,000円' }).waitFor();

  step('money tabs: year views, a payout to a member becomes their one-off charge');
  const payCsv = [
    '"計算対象","日付","内容","金額（円）","保有金融機関","大項目","中項目","メモ","振替","ID"',
    `"1","${d}","ﾂﾂｲ ﾊﾅｺ","-20000","共用口座","未分類","未分類","","0","mf-h"`,
    `"1","${d}","サンプル駐車場(依頼人名:ツツイ ハナコ)","-9000","共用口座","住宅","駐車場","","0","mf-i"`,
  ].join('\n') + '\n';
  await page.goto(`${appUrl}#/flow/ext/${ymNow}`);
  await page.getByRole('heading', { name: '共用口座の明細（実績）' }).waitFor();
  await page.waitForLoadState('networkidle'); // the month's lines are loaded (the page redraws once)
  await page.getByLabel('マネーフォワードの CSV ファイル').setInputFiles({ name: 'pay.csv', mimeType: 'text/csv', buffer: Buffer.from(payCsv) });
  await page.getByText(/共用口座からの受け取りとして記録: 1件（はなこ 1件）/).waitFor();
  await page.getByRole('button', { name: '取り込む' }).click();
  await page.getByText('取り込みました（追加 2件、更新 0件、個人との入出金の記録 1件）。').waitFor();
  const payout = mock.db.shared_entries.find((e) => e.label === '共用口座からの受け取り');
  assert.deepEqual([payout.member_id, payout.ym, payout.kind, payout.amount], [hanako.id, ymNow, 'charge', 20000]);
  assert.equal(mock.db.transactions.find((t) => t.mf_id === 'mf-i').deposit_entry_id ?? null, null, 'the sender name (依頼人名) is not a payee');
  await page.getByRole('link', { name: '年間' }).click();
  await page.getByRole('heading', { name: `共用口座の明細（${Number(ymNow.slice(0, 4))}年）` }).waitFor();
  await page.locator('.year-table').waitFor(); // the year's lines are loaded
  const extYear = await page.locator('#view').innerText();
  assert.match(extYear, /出金\s*45,000円/, '5,000 + 8,000 + 3,000 (personal) + 9,000 + 20,000 (to a member)');
  assert.match(extYear, /入金\s*50,000円/);
  await page.getByRole('link', { name: '個人の入金・立替' }).click();
  await page.locator('.shared-card').first().waitFor();
  assert.match(await page.locator('.shared-table').innerText(), /共用口座からの受け取り\s+20,000円/);
  await page.getByText('個人の口座から払っている共通の費用').waitFor();
  assert.match(await page.locator('#view').innerText(), /dアニ\s+はなこ\s+毎月\s+550円/);
  await page.getByRole('link', { name: '年間' }).click();
  await page.getByRole('heading', { name: `はなこ（${Number(ymNow.slice(0, 4))}年）` }).waitFor();
  assert.match(await page.locator('.member-year').innerText(), /当月分の合計/);
  await page.screenshot({ path: join(OUT, 'money-year.png'), fullPage: true });
  await page.getByRole('link', { name: '共用口座の入出金' }).click();
  await page.getByRole('heading', { name: `共用口座の明細（${Number(ymNow.slice(0, 4))}年）` }).waitFor(); // each tab keeps its own period

  step('bank statement CSV: balances by day, the latest balance, a low balance alert');
  await page.goto(`${appUrl}#/flow/ext/${ymNow}`);
  await page.getByRole('heading', { name: /^残高/ }).waitFor();
  const bankCsv = ['取引日,入出金(円),取引後残高(円),入出金内容', `${ymPrev.replace('-', '')}10,-30000,180000,カード`, `${ymNow.replace('-', '')}03,-150000,30000,カード`, `${ymNow.replace('-', '')}03,-3870,26130,駐車場`].join('\r\n') + '\r\n';
  const bankSjis = execFileSync('python3', ['-I', '-c', 'import sys; sys.stdout.buffer.write(sys.stdin.read().encode("cp932"))'], { input: bankCsv });
  await page.getByLabel('銀行の取引明細の CSV ファイル').setInputFiles({ name: 'bank.csv', mimeType: 'text/csv', buffer: bankSjis });
  await page.getByText(/2日分の残高（最新 26,130円）/).waitFor();
  await page.getByRole('button', { name: '取り込む' }).first().click();
  await page.getByText('残高を取り込みました（2日分）。').waitFor();
  assert.deepEqual(mock.db.account_balances.map((b) => [b.date, b.balance]).sort(), [[`${ymPrev}-10`, 180000], [`${ymNow}-03`, 26130]]);
  assert.ok(mock.db.settings.some((x) => x.key === 'bank_imported_at'));
  const balanceText = await page.locator('#view').innerText();
  assert.match(balanceText, /3時点\s*26,130円/);
  assert.match(balanceText, /共用口座の残高が少なくなっています: 26,130円/, 'below the default 100,000円');
  await page.getByLabel('銀行の取引明細の CSV ファイル').setInputFiles({ name: 'bank.csv', mimeType: 'text/csv', buffer: bankSjis });
  await page.getByText(/2日分の残高/).waitFor();
  await page.getByRole('button', { name: '取り込む' }).first().click();
  await page.getByText('残高を取り込みました（2日分）。').waitFor();
  assert.equal(mock.db.account_balances.length, 2, 'importing again does not duplicate');

  step('contract amount by period: a new amount from this month, the old one kept for past months');
  await page.goto(`${appUrl}#/edit/contracts/${net.id}`);
  assert.equal(await page.getByLabel('新しい金額の適用開始月', { exact: true }).isVisible(), false, 'asked only when the amount changes');
  await fill('金額（円）', '5500');
  await page.getByLabel('新しい金額の適用開始月', { exact: true }).fill(ymNow);
  await save();
  await page.getByRole('heading', { name: '金額の履歴' }).waitFor();
  const netNow = mock.db.contracts.find((c) => c.id === net.id);
  assert.deepEqual(netNow.price_history, [{ amount: 5000, from: null, to: ymPrev }, { amount: 5500, from: ymNow, to: null }]);
  assert.match(await page.locator('#view').innerText(), new RegExp(`${ymLabel(ymNow)}〜（今）\\s+5,500円`));
  await page.goto(`${appUrl}#/flow/ext/${ymNow}`);
  await page.getByText('固定費の予定と実績').waitFor();
  assert.match(await page.locator('#view').innerText(), /インターネット\s+5,500円\s+5,000円\s+差 −500円/);
  await page.goto(`${appUrl}#/settings/data`);
  await page.getByRole('heading', { name: '設定', exact: true }).waitFor();

  step('full backup ZIP');
  const [zipDl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '全データを書き出す（ZIP）' }).click()]);
  const zipPath = join(OUT, 'backup.zip');
  writeFileSync(zipPath, readFileSync(await zipDl.path()));
  const listing = execFileSync('python3', ['-I', '-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print("\\n".join(z.namelist()))', zipPath]).toString();
  for (const name of ['口座.csv', 'カード.csv', '契約・固定費.csv', '書類・家電.csv', 'ポイントカード・会員情報.csv', '写真一覧.csv', '共用口座_定例項目.csv', '共用口座_臨時の費目と入金.csv', '共用口座_明細（マネーフォワード）.csv']) assert.ok(listing.includes(name), name);
  assert.match(listing, /photos\/.+\.jpg/);
  const accountsCsv = execFileSync('python3', ['-I', '-c', 'import sys,zipfile; print(zipfile.ZipFile(sys.argv[1]).read("口座.csv").decode("utf-8-sig"))', zipPath]).toString();
  assert.match(accountsCsv, /7654321/, 'backup keeps the full account number');
  await page.getByText(/バックアップを書き出しました/).waitFor(); // the time is saved after the download
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
    await p.goto('about:blank'); // never type into the previous page while the app is loading
    await p.goto(appUrl);
    await p.getByLabel('メールアドレス', { exact: true }).fill(user.email);
    await p.getByLabel('パスワード', { exact: true }).fill(user.password);
    await p.getByRole('button', { name: 'ログイン' }).click();
  };
  const memberCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ja-JP', serviceWorkers: 'block' });
  const mp = await memberCtx.newPage();
  mock.db.members.find((m) => m.id === hanako.id).gender = 'female'; // set in the user master
  await login(mp, MEMBER);
  await mp.getByRole('heading', { name: '期限が近い予定' }).waitFor();
  assert.ok(await mp.evaluate(() => document.documentElement.classList.contains('theme-female')), 'the signed-in person\'s color is the accent');
  await mp.goto(`${appUrl}#/settings/account`);
  await mp.getByText('ログイン中: はなこ（一般）').waitFor(); // the nickname is shown
  await mp.getByLabel('通知の時刻（自分の端末すべて）').selectOption('21');
  await mp.getByText('通知の時刻を21時にしました。').waitFor();
  assert.equal(mock.db.members.find((m) => m.id === hanako.id).notify_hour, 21, 'each person sets their own hour');
  await mp.getByRole('link', { name: 'データ', exact: true }).click();
  await mp.getByRole('heading', { name: /バックアップ/ }).waitFor();
  assert.equal(await mp.getByRole('button', { name: '取り込む' }).count(), 0);
  assert.equal(await mp.getByRole('heading', { name: /^取り込み/ }).count(), 0);
  assert.equal(await mp.getByRole('link', { name: 'その他', exact: true }).count(), 0, 'shared account and shortcut settings are for administrators');
  await mp.getByRole('link', { name: 'ユーザー', exact: true }).click();
  await mp.getByRole('heading', { name: 'ユーザー', exact: true }).waitFor();
  assert.equal(await mp.getByRole('link', { name: '＋ ユーザーを追加' }).count(), 0);
  await mp.getByRole('link', { name: '山田 太郎' }).click();
  await mp.getByText('管理者だけが変更できます').waitFor();

  step('a regular member records only their own 立替 (deposits come from the statement)');
  await mp.goto(`${appUrl}#/`);
  await mp.getByRole('link', { name: '立替を記録' }).click(); // from the home screen
  await mp.getByText('人: はなこ').waitFor();
  assert.equal(await mp.getByLabel('人', { exact: true }).count(), 0, 'the person cannot be changed');
  assert.equal(await mp.getByLabel('日付 *').inputValue(), todayJST(), 'by date, today by default');
  const advDay = `${ymPrev}-15`;
  await mp.getByLabel('日付 *').fill(advDay);
  await mp.getByLabel('立て替えた額（円） *').fill('1,200');
  await mp.getByLabel('費目', { exact: true }).selectOption('立替（日用品）');
  await mp.locator('#attach-entry').setInputFiles([1, 2, 3, 4].map((i) => ({ name: `r${i}.png`, mimeType: 'image/png', buffer: pngBytes(800, 600) })));
  await mp.getByText('画像は3枚までです。').waitFor();
  assert.equal(await mp.locator('.attach-box figure').count(), 3);
  await mp.getByRole('button', { name: '保存' }).click();
  await mp.locator('.shared-card').first().waitFor();
  const adv = mock.db.shared_entries.find((e) => e.label === '立替（日用品）');
  assert.equal(await mp.locator('.shared-card.person-female').count(), 1, 'her card in her color');
  assert.deepEqual([adv.member_id, adv.kind, adv.amount, adv.paid_on, adv.ym], [hanako.id, 'charge', -1200, advDay, ymPrev], 'the month comes from the date');
  assert.equal(mock.db.shared_attachments.filter((a) => a.entry_id === adv.id).length, 3);
  assert.ok(mock.db.shared_attachments.every((a) => a.path.startsWith(`receipts/${adv.id}/`)));
  assert.match(await mp.locator('#view').innerText(), new RegExp(`はなこ\\s*立替（日用品）\\s*添付あり\\s*${Number(ymPrev.slice(0, 4))}/${Number(ymPrev.slice(5))}/15`));
  await mp.goto(`${appUrl}#/flow/member/${ymNow}`);
  await mp.locator('.shared-card').first().waitFor();
  assert.equal(await mp.getByRole('link', { name: '立替を記録' }).count(), 1, 'only on their own card');
  for (const name of ['＋ 入金（管理者）', '＋ 臨時の費目（管理者）', '入金を記録', '＋ 追加']) assert.equal(await mp.getByRole('link', { name }).count(), 0, name);
  await mp.goto(`${appUrl}#/shared-entry/${adv.id}`);
  assert.equal(await mp.getByLabel('立て替えた額（円） *').inputValue(), '1200', 'shown as a plus amount');
  await mp.getByRole('button', { name: '削除' }).first().click(); // one of the receipts
  await mp.waitForFunction(() => document.querySelectorAll('.attach-box figure').length === 2);
  assert.equal(mock.db.shared_attachments.length, 2);

  step('OCR (bundled Tesseract.js, inside the browser): a transfer screen -> amount and date to check');
  await mp.goto(`${appUrl}#/deposit-report/new/${hanako.id}`);
  const screen = await mp.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 1100;
    c.height = 520;
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#000';
    g.font = '56px sans-serif';
    ['振込が完了しました', '受付日 2026年10月25日', '振込金額 80,000円', '手数料 0円'].forEach((t, i) => g.fillText(t, 40, 100 + i * 110));
    return c.toDataURL('image/png').split(',')[1];
  });
  await mp.locator('#attach-report').setInputFiles({ name: 'screen.png', mimeType: 'image/png', buffer: Buffer.from(screen, 'base64') });
  await mp.getByRole('button', { name: '画像から読む（OCR）' }).click();
  await mp.getByText(/読み取った値を入れました|読み取れませんでした/).waitFor({ timeout: 120000 });
  assert.equal(await mp.getByLabel('入金した額（円） *').inputValue(), '80000', 'amount read from the image');
  assert.equal(await mp.getByLabel('振込日 *').inputValue(), '2026-10-25', 'date read from the image');
  assert.equal(mock.db.deposit_reports.length, 0, 'nothing is saved by reading');

  step('deposit report: kept for reference, compared with the deposits from the statement');
  await mp.goto(`${appUrl}#/flow/member/${ymNow}`);
  await mp.getByRole('link', { name: '入金を報告' }).click();
  await mp.getByLabel('入金した額（円） *').fill('60,000');
  await mp.locator('#attach-report').setInputFiles({ name: 'done.png', mimeType: 'image/png', buffer: pngBytes(600, 1200) });
  await mp.getByRole('button', { name: '保存' }).click();
  await mp.getByText('入金を報告しました。').waitFor();
  const report = mock.db.deposit_reports[0];
  assert.deepEqual([report.member_id, report.amount, report.paid_on], [hanako.id, 60000, todayJST()]);
  assert.equal(mock.db.shared_attachments.filter((a) => a.report_id === report.id).length, 1);
  const reportCard = await mp.locator('section', { hasText: `入金報告（${ymLabel(ymNow)}）` }).innerText();
  assert.match(reportCard, /はなこ\s+60,000円\s+150,000円\s+90,000円/, 'reports next to the deposits from the statement');
  assert.equal(mock.db.shared_entries.filter((e) => e.kind === 'deposit' && e.ym === ymNow).length, 2, 'a report is not a deposit record');
  const otherEntry = mock.db.shared_entries.find((e) => e.kind === 'deposit');
  await mp.goto(`${appUrl}#/shared-entry/${otherEntry.id}`);
  await mp.locator('.meta', { hasText: '明細から自動で記録' }).waitFor();
  assert.equal(await mp.getByRole('button', { name: '保存' }).count(), 0, 'read only');
  await mp.goto(`${appUrl}#/shared-entry/new/deposit:${hanako.id}:${ymNow}`);
  await mp.getByLabel('立て替えた額（円） *').waitFor(); // a deposit cannot be recorded by hand
  const manualRule = mock.db.shared_rules.find((r) => !r.contract_id);
  await mp.goto(`${appUrl}#/shared-rule/${manualRule.id}`);
  await mp.getByText('管理者だけが変更できます').waitFor();

  step('password: change it in the settings, forgot -> e-mail link -> set a new one');
  await mp.goto(`${appUrl}#/settings/account`);
  await mp.getByRole('link', { name: 'パスワードを変更' }).click();
  await mp.getByLabel('今のパスワード').fill('wrong-password');
  await mp.getByLabel('新しいパスワード', { exact: true }).fill('short');
  await mp.getByLabel('新しいパスワード（確認）').fill('short');
  await mp.getByRole('button', { name: 'パスワードを変更' }).click();
  await mp.getByText('新しいパスワードは8文字以上にしてください。').waitFor();
  await mp.getByLabel('新しいパスワード', { exact: true }).fill('new-member-pass-1');
  await mp.getByLabel('新しいパスワード（確認）').fill('new-member-pass-2');
  await mp.getByRole('button', { name: 'パスワードを変更' }).click();
  await mp.getByText('確認用のパスワードが一致しません。').waitFor();
  await mp.getByLabel('新しいパスワード（確認）').fill('new-member-pass-1');
  await mp.getByRole('button', { name: 'パスワードを変更' }).click();
  await mp.getByText('今のパスワードが違います。').waitFor();
  assert.equal(mock.passwords.get(MEMBER.email), MEMBER.password, 'not changed without the current password');
  await mp.getByLabel('今のパスワード').fill(MEMBER.password);
  await mp.getByRole('button', { name: 'パスワードを変更' }).click();
  await mp.getByText('パスワードを変更しました。').waitFor();
  assert.equal(mock.passwords.get(MEMBER.email), 'new-member-pass-1');
  await mp.getByRole('button', { name: 'ログアウト', exact: true }).click();
  await mp.getByRole('button', { name: 'ログイン' }).waitFor(); // signed out before the next page load
  await login(mp, { email: MEMBER.email, password: MEMBER.password });
  await mp.getByText('メールアドレスまたはパスワードが違います。').waitFor();
  await mp.getByText('パスワードを忘れた場合').click();
  await mp.waitForFunction(() => document.getElementById('reset-email').value !== '');
  assert.equal(await mp.getByLabel('再設定するメールアドレス').inputValue(), MEMBER.email, 'filled from the login form');
  await mp.getByRole('button', { name: '再設定のメールを送る' }).click();
  await mp.getByText(/再設定のメールを送りました/).waitFor();
  assert.deepEqual(mock.recoveries.at(-1), { email: MEMBER.email, redirect_to: appUrl });
  // the link in the e-mail: an expired one, then a valid one
  await mp.goto(`${appUrl}#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired`);
  await mp.getByText(/メールのリンクの有効期限が切れているか/).waitFor();
  assert.ok(!mp.url().includes('error'), 'the error is removed from the address');
  const tk = mock.linkTokens(MEMBER);
  await mp.goto(`${appUrl}#access_token=${tk.access_token}&expires_at=0&expires_in=3600&refresh_token=${tk.refresh_token}&token_type=bearer&type=recovery`);
  await mp.getByRole('heading', { name: 'パスワードの設定' }).waitFor();
  assert.ok(!mp.url().includes('access_token'), 'tokens are removed from the address');
  assert.equal(await mp.getByLabel('今のパスワード').count(), 0, 'not asked after an e-mail link');
  await mp.getByLabel('新しいパスワード', { exact: true }).fill('reset-member-pass');
  await mp.getByLabel('新しいパスワード（確認）').fill('reset-member-pass');
  await mp.getByRole('button', { name: 'パスワードを変更' }).click();
  await mp.getByText('パスワードを変更しました。').waitFor();
  await mp.getByRole('heading', { name: '期限が近い予定' }).waitFor();
  assert.equal(mock.passwords.get(MEMBER.email), 'reset-member-pass');
  await memberCtx.close();

  step('a logged-in user who is not in the user master gets no data');
  const strangerCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ja-JP', serviceWorkers: 'block' });
  const sp = await strangerCtx.newPage();
  await login(sp, STRANGER);
  await sp.getByText('このアカウントは利用者として登録されていません').waitFor();
  assert.equal(await sp.locator('#nav').isHidden(), true);
  await strangerCtx.close();

  step('layout audit: every main page at phone width (full page + scrolled, to check the fixed page head)');
  mkdirSync(join(OUT, 'audit'), { recursive: true });
  const yearNow = ymNow.slice(0, 4);
  const auditRoutes = [
    ['home', '#/'], ['ledgers', '#/ledgers'], ['list-accounts', '#/list/accounts'], [`view-account`, `#/view/accounts/${mock.db.accounts[0].id}`],
    ['edit-contract', '#/edit/contracts/new'], ['chores-today', '#/chores/today'], ['chores-load', '#/chores/load'], ['chores-list', '#/chores/list'],
    ['money-member-month', `#/flow/member/${ymNow}`], ['money-member-year', `#/flow/member/${yearNow}`], ['money-ext-month', `#/flow/ext/${ymNow}`],
    ['money-ext-year', `#/flow/ext/${yearNow}`], ['money-flow-month', `#/flow/flow/${ymNow}`], ['money-flow-year', `#/flow/flow/${yearNow}`],
    ['advance-new', `#/shared-entry/new/advance:${hanako.id}:${ymNow}`], ['report-new', `#/deposit-report/new/${hanako.id}`],
    ['settings-account', '#/settings/account'], ['settings-users', '#/settings/users'], ['settings-data', '#/settings/data'], ['settings-other', '#/settings/other'],
  ];
  for (const [name, route] of auditRoutes) {
    await page.goto(`${appUrl}${route}`);
    await page.locator('.page-head').first().waitFor();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(OUT, 'audit', `${name}.png`), fullPage: true });
    await page.evaluate(() => window.scrollTo(0, 700));
    await page.waitForTimeout(150);
    const headTop = await page.locator('.page-head').first().evaluate((el) => Math.round(el.getBoundingClientRect().top));
    const barH = await page.locator('.app-header').evaluate((el) => Math.round(el.getBoundingClientRect().height));
    if (await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight + 700)) {
      assert.equal(headTop, barH, `${name}: the page head stays right below the app bar`);
      await page.screenshot({ path: join(OUT, 'audit', `${name}-scrolled.png`) });
    }
    // nothing wider than the screen
    const overflow = await page.evaluate(() => [...document.querySelectorAll('#view *')].filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1 && !el.closest('.table-wrap, .tabs, svg')).map((el) => el.className || el.tagName).slice(0, 5));
    assert.deepEqual(overflow, [], `${name}: no element sticks out of the screen`);
  }

  step('logout');
  await page.goto(`${appUrl}#/settings/account`);
  await page.getByRole('button', { name: 'ログアウト', exact: true }).click();
  await page.getByRole('button', { name: 'ログイン' }).waitFor();

  step('desktop layout + dark mode screenshot');
  const desk = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark', serviceWorkers: 'block' });
  await desk.goto(appUrl);
  await desk.getByLabel('メールアドレス', { exact: true }).fill(OWNER.email);
  await desk.getByLabel('パスワード', { exact: true }).fill(OWNER.password);
  await desk.getByRole('button', { name: 'ログイン' }).click();
  await desk.locator('.page-head').first().waitFor();
  await desk.goto(`${appUrl}#/settings/data`);
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
