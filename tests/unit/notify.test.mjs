// Runs scripts/notify.mjs against the mock Supabase + fake push service and decrypts what was sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createMock, SERVICE_KEY } from '../mock-supabase.mjs';
import { b64urlEncode } from '../../scripts/webpush.mjs';
import { todayJST, toDayNumber, fromDayNumber } from '../../web/js/events.js';

// ECDH.getPrivateKey() drops leading zero bytes (about 1 in 256 keys); VAPID keys are always 32 bytes.
function privateKey32(ecdh) {
  const k = ecdh.getPrivateKey();
  return Buffer.concat([Buffer.alloc(32 - k.length), k]);
}

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../../scripts/notify.mjs', import.meta.url));

function decrypt(body, uaEcdh, authSecret) {
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const data = body.subarray(21 + idlen);
  const shared = uaEcdh.computeSecret(asPublic);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), uaEcdh.getPublicKey(), asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, info, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(data.subarray(data.length - 16));
  const plain = Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 2);
  return JSON.parse(plain.subarray(0, -1).toString());
}

test('daily run sends each due notification once and removes expired devices', async () => {
  const mock = createMock();
  const { apiUrl } = await mock.start();
  try {
    const vapid = crypto.createECDH('prime256v1');
    vapid.generateKeys();
    const ua = crypto.createECDH('prime256v1');
    ua.generateKeys();
    const auth = crypto.randomBytes(16);
    const in7 = fromDayNumber(toDayNumber(todayJST()) + 7);
    mock.db.settings.push({ key: 'vapid_public_key', value: b64urlEncode(vapid.getPublicKey()) });
    mock.db.push_subscriptions.push(
      { id: 'dev1', endpoint: `${apiUrl}/push/dev1`, p256dh: b64urlEncode(ua.getPublicKey()), auth: b64urlEncode(auth), device_label: 'Android' },
      { id: 'old', endpoint: `${apiUrl}/push/gone`, p256dh: b64urlEncode(ua.getPublicKey()), auth: b64urlEncode(auth) },
    );
    mock.db.contracts.push({ id: 'k1', name: '火災保険', status: 'active', auto_renew: true, renewal_date: in7, notify_days: {} });
    // chores: a device linked to a member gets one summary of that member's (and everyone's) chores due today
    mock.db.members.push({ id: 'm-shin', name: '佐藤 真一', nickname: 'しん', active: true }, { id: 'm-haru', name: '佐藤 春子', nickname: 'はる', active: true });
    mock.db.push_subscriptions.push({ id: 'dev2', endpoint: `${apiUrl}/push/dev2`, p256dh: b64urlEncode(ua.getPublicKey()), auth: b64urlEncode(auth), member_id: 'm-shin' });
    mock.db.chores.push(
      { id: 'ch1', name: 'ゴミ出し', status: 'active', cycle: 'day', schedule: [], assignee_type: 'member', assignee_id: 'm-shin' },
      { id: 'ch2', name: '郵便物回収', status: 'active', cycle: 'day', schedule: [], assignee_type: 'all' },
      { id: 'ch3', name: '洗面所', status: 'active', cycle: 'day', schedule: [], assignee_type: 'member', assignee_id: 'm-haru' },
      { id: 'ch4', name: '家計簿', status: 'active', cycle: 'week', schedule: [], times: 1, assignee_type: 'member', assignee_id: 'm-shin' },
    );
    mock.db.items.push({ id: 'i1', name: '洗濯機', status: 'active', warranty_until: in7, notify_days: { warranty: [] } });

    const env = { ...process.env, SUPABASE_URL: apiUrl, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, VAPID_PRIVATE_KEY: b64urlEncode(privateKey32(vapid)), GITHUB_REPOSITORY: 'Owner/home-hub', NOTIFY_HOUR: '9' };
    const first = await run('node', [SCRIPT], { env });
    assert.match(first.stdout, /1 deadline notification\(s\) due/);
    assert.doesNotMatch(first.stdout + first.stderr, /火災保険/); // names never appear in public logs

    const delivered = mock.pushes.filter((p) => p.id === 'dev1');
    assert.equal(delivered.length, 1);
    assert.match(delivered[0].headers.authorization, /^vapid t=.+, k=/);
    assert.equal(delivered[0].headers['content-encoding'], 'aes128gcm');
    const payload = decrypt(delivered[0].body, ua, auth);
    assert.equal(payload.title, '契約の自動更新');
    assert.match(payload.body, /^火災保険はあと7日（\d+\/\d+）。続けるか解約するか決めましょう。$/);
    assert.equal(payload.url, '#/view/contracts/k1');
    assert.deepEqual(mock.db.push_subscriptions.map((s) => s.id), ['dev1', 'dev2']);
    const choresPush = mock.pushes.filter((p) => p.id === 'dev2').map((p) => decrypt(p.body, ua, auth)).find((p) => p.title.startsWith('今日の家事'));
    assert.equal(choresPush.title, '今日の家事');
    assert.equal(choresPush.body, '2件：ゴミ出し、郵便物回収');
    assert.equal(choresPush.url, '#/chores');
    assert.ok(!mock.pushes.filter((p) => p.id === 'dev1').map((p) => decrypt(p.body, ua, auth)).some((p) => p.title.startsWith('今日の家事')),
      'a device without a member gets no chore reminder');
    assert.doesNotMatch(first.stdout + first.stderr, /ゴミ出し|郵便物/, 'chore names never appear in public logs');
    assert.equal(mock.db.notification_log.filter((l) => !/^(daily|notices):/.test(l.key)).length, 3, 'deadline to each person/device group + chores');
    // お知らせ: one row per alert (the deadline once for everyone), also for はる who has no device yet
    assert.deepEqual(mock.db.notices.map((n) => [n.kind, n.title, n.to_members.length ? n.to_members.join(',') : '全員']).sort(),
      [['system', '今日の家事', 'm-haru'], ['system', '今日の家事', 'm-shin'], ['system', '契約の自動更新', '全員']].sort());

    await run('node', [SCRIPT], { env });
    assert.equal(mock.pushes.filter((p) => p.id === 'dev1').length, 1, 'no duplicate on the second run');
    assert.equal(mock.pushes.filter((p) => p.id === 'dev2').length, 2, 'deadline + chores once each');

    // each person at their own hour: はる chose 21時, so nothing for her device before then
    mock.db.members.find((m) => m.id === 'm-haru').notify_hour = 21;
    mock.db.push_subscriptions.push({ id: 'dev3', endpoint: `${apiUrl}/push/dev3`, p256dh: b64urlEncode(ua.getPublicKey()), auth: b64urlEncode(auth), member_id: 'm-haru' });
    await run('node', [SCRIPT], { env: { ...env, NOTIFY_HOUR: '20' } });
    assert.equal(mock.pushes.filter((p) => p.id === 'dev3').length, 0, 'not before her hour');
    await run('node', [SCRIPT], { env: { ...env, NOTIFY_HOUR: '22' } }); // a late run still sends
    assert.equal(mock.pushes.filter((p) => p.id === 'dev3').length, 2, 'deadline + her chores at (or after) her hour');
    await run('node', [SCRIPT], { env: { ...env, NOTIFY_HOUR: '23' } });
    assert.equal(mock.pushes.filter((p) => p.id === 'dev3').length, 2, 'once a day');

    assert.equal(mock.db.notices.length, 3, 'no duplicate お知らせ');

    // messages: due ones go to their recipients' devices at any hour, once; scheduled ones wait
    const later = new Date(Date.now() + 86400000).toISOString();
    mock.db.notices.push(
      { id: 'n1', kind: 'message', from_member: 'm-shin', to_members: ['m-haru'], title: '買い物', body: '牛乳おねがい', deliver_at: new Date(Date.now() - 60000).toISOString(), delivered_at: null, created_at: new Date().toISOString() },
      { id: 'n2', kind: 'message', from_member: 'm-shin', to_members: ['m-haru'], title: '予約', body: 'あとで', deliver_at: later, delivered_at: null, created_at: new Date().toISOString() },
    );
    const msgRun = await run('node', [SCRIPT], { env: { ...env, NOTIFY_HOUR: '3' } });
    assert.doesNotMatch(msgRun.stdout + msgRun.stderr, /牛乳|買い物/, 'messages never appear in public logs');
    const toHaru = mock.pushes.filter((p) => p.id === 'dev3').map((p) => decrypt(p.body, ua, auth));
    assert.deepEqual(toHaru.at(-1), { title: '買い物', body: 'しんより：牛乳おねがい', url: '#/notices', tag: 'notice:n1' });
    assert.ok(mock.db.notices.find((n) => n.id === 'n1').delivered_at);
    assert.equal(mock.db.notices.find((n) => n.id === 'n2').delivered_at, null);
    assert.equal(mock.pushes.filter((p) => p.id === 'dev2').length, 2, 'not sent to the sender');
    await run('node', [SCRIPT], { env: { ...env, NOTIFY_HOUR: '3' } });
    assert.equal(mock.pushes.filter((p) => p.id === 'dev3').length, toHaru.length, 'once');

    // ワークフロー: a new request goes to those who answer it; those who have not answered get a reminder
    // once a day at their hour; the result goes to who made it
    const nowIsoT = new Date().toISOString();
    mock.db.workflow_requests.push({ id: 'w1', type_key: 'change', applicant: null, title: '2027年の予算・負担率が変わりました', body: '二人の負担額の合計 月170,210円', approvers: ['m-shin', 'm-haru'], status: 'open', pushed_at: null, result_pushed_at: null, created_at: nowIsoT });
    mock.db.workflow_replies.push({ request_id: 'w1', member_id: 'm-shin', reply: 'acked' });
    const beforeHaru = mock.pushes.filter((p) => p.id === 'dev3').length;
    const changeRun = await run('node', [SCRIPT], { env: { ...env, NOTIFY_HOUR: '3' } });
    assert.doesNotMatch(changeRun.stdout + changeRun.stderr, /170,210|負担額|2027年/, 'requests never appear in public logs');
    const haruNew = decrypt(mock.pushes.filter((p) => p.id === 'dev3').at(-1).body, ua, auth);
    assert.deepEqual([haruNew.title, haruNew.body, haruNew.url], ['確認待ち', '2027年の予算・負担率が変わりました', '#/workflow']);
    assert.ok(mock.db.workflow_requests.find((r) => r.id === 'w1').pushed_at);
    const nextDay = fromDayNumber(toDayNumber(todayJST()) + 1);
    await run('node', [SCRIPT], { env: { ...env, NOTIFY_DATE: nextDay, NOTIFY_HOUR: '22' } });
    const haruNext = mock.pushes.filter((p) => p.id === 'dev3').slice(beforeHaru + 1).map((p) => decrypt(p.body, ua, auth));
    assert.ok(haruNext.some((p) => p.title === '承認・確認待ち' && /1件/.test(p.body)), 'はる has not answered: reminded');
    const shinNext = mock.pushes.filter((p) => p.id === 'dev2').map((p) => decrypt(p.body, ua, auth));
    assert.ok(!shinNext.some((p) => p.title === '承認・確認待ち'), 'しん answered: no reminder');
    mock.db.workflow_requests.push({ id: 'w2', type_key: 'proposal', applicant: 'm-shin', title: '洗濯機を買い替えたい', body: '', approvers: ['m-haru'], status: 'done', pushed_at: nowIsoT, result_pushed_at: null, created_at: nowIsoT });
    await run('node', [SCRIPT], { env: { ...env, NOTIFY_DATE: nextDay, NOTIFY_HOUR: '22' } });
    assert.deepEqual(decrypt(mock.pushes.filter((p) => p.id === 'dev2').at(-1).body, ua, auth).title, '承認されました', 'the result goes to who made it');

    // 問いかけ: at the chore's hour the assignee is asked once a day, unless they already answered
    mock.db.chores.push({ id: 'cook', name: '夕ご飯づくり', status: 'active', cycle: 'day', schedule: [], assignee_type: 'member', assignee_id: 'm-haru', paid_by: 'm-shin', prompt_hour: 17 });
    const beforeAsk = mock.pushes.filter((p) => p.id === 'dev3').length;
    await run('node', [SCRIPT], { env: { ...env, NOTIFY_DATE: nextDay, NOTIFY_HOUR: '16' } });
    assert.equal(mock.pushes.filter((p) => p.id === 'dev3').length, beforeAsk, 'not before the hour');
    await run('node', [SCRIPT], { env: { ...env, NOTIFY_DATE: nextDay, NOTIFY_HOUR: '17' } });
    const ask = decrypt(mock.pushes.filter((p) => p.id === 'dev3').at(-1).body, ua, auth);
    assert.deepEqual([ask.title, ask.url], ['今日の家事', `#/chore-ask/cook/${nextDay}`]);
    assert.match(ask.body, /今日「夕ご飯づくり」をやりますか？/);
    await run('node', [SCRIPT], { env: { ...env, NOTIFY_DATE: nextDay, NOTIFY_HOUR: '18' } });
    assert.equal(mock.pushes.filter((p) => p.id === 'dev3').length, beforeAsk + 1, 'once a day');
    const dayAfter = fromDayNumber(toDayNumber(todayJST()) + 2);
    mock.db.workflow_requests.push({ id: 'w3', type_key: 'chore_done', applicant: 'm-haru', title: 'x', body: '', payload: { chore_id: 'cook', date: dayAfter }, approvers: ['m-shin'], status: 'open', pushed_at: nowIsoT, created_at: nowIsoT });
    const beforeAnswered = mock.pushes.filter((p) => p.id === 'dev3').length;
    await run('node', [SCRIPT], { env: { ...env, NOTIFY_DATE: dayAfter, NOTIFY_HOUR: '17' } });
    assert.ok(!mock.pushes.filter((p) => p.id === 'dev3').slice(beforeAnswered).map((p) => decrypt(p.body, ua, auth)).some((p) => p.title === '今日の家事'), 'already answered that day');

    const t = await run('node', [SCRIPT], { env: { ...env, NOTIFY_TEST: '1' } });
    assert.match(t.stdout, /delivered to 3\/3/);
    assert.equal(decrypt(mock.pushes.at(-1).body, ua, auth).title, 'テスト通知');

    // wrong key is rejected
    const other = crypto.createECDH('prime256v1');
    other.generateKeys();
    await assert.rejects(run('node', [SCRIPT], { env: { ...env, VAPID_PRIVATE_KEY: b64urlEncode(privateKey32(other)) } }), /does not match/);
  } finally {
    await mock.stop();
  }
});

test('shared account reminder: from the 25th, once a month, only to that member', async () => {
  const mock = createMock();
  const { apiUrl } = await mock.start();
  try {
    const vapid = crypto.createECDH('prime256v1');
    vapid.generateKeys();
    const ua = crypto.createECDH('prime256v1');
    ua.generateKeys();
    const auth = crypto.randomBytes(16);
    const dev = (id, memberId) => ({ id, endpoint: `${apiUrl}/push/${id}`, p256dh: b64urlEncode(ua.getPublicKey()), auth: b64urlEncode(auth), member_id: memberId });
    mock.db.settings.push({ key: 'vapid_public_key', value: b64urlEncode(vapid.getPublicKey()) });
    mock.db.members.push({ id: 'm-shin', name: '佐藤 真一', nickname: 'しん', active: true }, { id: 'm-haru', name: '佐藤 春子', nickname: 'はる', active: true });
    mock.db.push_subscriptions.push(dev('d-shin', 'm-shin'), dev('d-haru', 'm-haru'), dev('d-none', null));
    mock.db.shared_rules.push(
      { id: 'r1', member_id: 'm-shin', label: '基本', amount: 90000, start_ym: '2026-10', end_ym: null },
      { id: 'r2', member_id: 'm-shin', label: '家賃', amount: -82000, start_ym: '2026-10', end_ym: null },
    );
    mock.db.shared_entries.push({ id: 'e1', member_id: 'm-shin', ym: '2026-11', kind: 'deposit', label: '入金', amount: 5000 });

    const env = { ...process.env, SUPABASE_URL: apiUrl, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, VAPID_PRIVATE_KEY: b64urlEncode(privateKey32(vapid)), GITHUB_REPOSITORY: 'Owner/home-hub', NOTIFY_HOUR: '8' };
    await run('node', [SCRIPT], { env: { ...env, NOTIFY_DATE: '2026-11-24' } });
    assert.equal(mock.pushes.length, 0, 'nothing before the 25th');

    const r = await run('node', [SCRIPT], { env: { ...env, NOTIFY_DATE: '2026-11-25' } });
    const got = mock.pushes.map((p) => ({ id: p.id, ...decrypt(p.body, ua, auth) }));
    assert.deepEqual(got.map((p) => p.id), ['d-shin']);
    assert.equal(got[0].title, '今月の家計費');
    assert.equal(got[0].body, '11月は残り 11,000円（今月分 90,000円・支払済 87,000円）。');
    assert.equal(got[0].url, '#/flow/member/2026-11');
    assert.doesNotMatch(r.stdout + r.stderr, /8,000|11,000|しん|基本/, 'amounts and names never appear in public logs');

    await run('node', [SCRIPT], { env: { ...env, NOTIFY_DATE: '2026-11-28' } });
    assert.equal(mock.pushes.length, 1, 'once a month');
    await assert.rejects(run('node', [SCRIPT], { env: { ...env, NOTIFY_DATE: '2026/11/25' } }), /NOTIFY_DATE/);
  } finally {
    await mock.stop();
  }
});

test('low balance to everyone once per balance date; monthly import reminder to the person who imports', async () => {
  const mock = createMock();
  const { apiUrl } = await mock.start();
  try {
    const vapid = crypto.createECDH('prime256v1');
    vapid.generateKeys();
    const ua = crypto.createECDH('prime256v1');
    ua.generateKeys();
    const auth = crypto.randomBytes(16);
    const dev = (id, memberId) => ({ id, endpoint: `${apiUrl}/push/${id}`, p256dh: b64urlEncode(ua.getPublicKey()), auth: b64urlEncode(auth), member_id: memberId });
    mock.db.settings.push({ key: 'vapid_public_key', value: b64urlEncode(vapid.getPublicKey()) }, { key: 'shared_account_id', value: 'acc-s' },
      { key: 'import_reminder_member', value: 'm-shin' }, { key: 'mf_imported_at', value: '2026-11-02T00:00:00Z' });
    mock.db.members.push({ id: 'm-shin', name: '佐藤 真一', nickname: 'しん', active: true }, { id: 'm-haru', name: '佐藤 春子', nickname: 'はる', active: true });
    mock.db.push_subscriptions.push(dev('d-shin', 'm-shin'), dev('d-haru', 'm-haru'));
    mock.db.account_balances.push({ id: 'b1', account_id: 'acc-s', date: '2026-10-23', balance: 26130 }, { id: 'b0', account_id: 'acc-s', date: '2026-10-01', balance: 300000 });
    const env = { ...process.env, SUPABASE_URL: apiUrl, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, VAPID_PRIVATE_KEY: b64urlEncode(privateKey32(vapid)), GITHUB_REPOSITORY: 'Owner/home-hub', NOTIFY_HOUR: '9' };
    const r = await run('node', [SCRIPT], { env: { ...env, NOTIFY_DATE: '2026-11-06' } });
    const got = mock.pushes.map((p) => ({ id: p.id, ...decrypt(p.body, ua, auth) }));
    const low = got.filter((p) => p.title === '共用口座の残高不足');
    assert.deepEqual(low.map((p) => p.id).sort(), ['d-haru', 'd-shin'], 'everyone');
    assert.equal(low[0].body, '残高 26,130円（10/23時点）。目安の10万円を下回っています。');
    const imp = got.filter((p) => p.title === '明細の取り込み');
    assert.deepEqual(imp.map((p) => [p.id, p.body]), [['d-shin', '10月分の銀行の残高がまだ取り込まれていません（前回の取り込み なし）。']], 'only the bank balance is missing, only to しん');
    assert.doesNotMatch(r.stdout + r.stderr, /26,130/, 'amounts never appear in public logs');
    await run('node', [SCRIPT], { env: { ...env, NOTIFY_DATE: '2026-11-07' } });
    const after = mock.pushes.map((p) => decrypt(p.body, ua, auth));
    assert.equal(after.filter((p) => p.title === '共用口座の残高不足').length, 2, 'once per balance date');
    assert.equal(after.filter((p) => p.title === '明細の取り込み').length, 2, 'every day until imported');
  } finally {
    await mock.stop();
  }
});

test('the report of last month goes to everyone once, when both imports are in (from the 10th as not final)', async () => {
  const mock = createMock();
  const { apiUrl } = await mock.start();
  try {
    const vapid = crypto.createECDH('prime256v1');
    vapid.generateKeys();
    const ua = crypto.createECDH('prime256v1');
    ua.generateKeys();
    const auth = crypto.randomBytes(16);
    const dev = (id, memberId) => ({ id, endpoint: `${apiUrl}/push/${id}`, p256dh: b64urlEncode(ua.getPublicKey()), auth: b64urlEncode(auth), member_id: memberId });
    mock.db.settings.push({ key: 'vapid_public_key', value: b64urlEncode(vapid.getPublicKey()) }, { key: 'shared_account_id', value: 'acc-s' },
      { key: 'mf_imported_at', value: '2026-11-02T00:00:00Z' });
    mock.db.members.push({ id: 'm-shin', name: '佐藤 真一', nickname: 'しん', active: true }, { id: 'm-haru', name: '佐藤 春子', nickname: 'はる', active: true });
    mock.db.push_subscriptions.push(dev('d-shin', 'm-shin'), dev('d-haru', 'm-haru'));
    const env = { ...process.env, SUPABASE_URL: apiUrl, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, VAPID_PRIVATE_KEY: b64urlEncode(privateKey32(vapid)), GITHUB_REPOSITORY: 'Owner/home-hub', NOTIFY_HOUR: '9' };
    const reports = () => mock.pushes.map((p) => ({ id: p.id, ...decrypt(p.body, ua, auth) })).filter((p) => p.title === '月間レポート');
    await run('node', [SCRIPT], { env: { ...env, NOTIFY_DATE: '2026-11-03' } });
    assert.equal(reports().length, 0, 'the bank balance of October is not in yet');
    mock.db.settings.push({ key: 'bank_imported_at', value: '2026-11-03T05:00:00Z' });
    await run('node', [SCRIPT], { env: { ...env, NOTIFY_DATE: '2026-11-04' } });
    assert.deepEqual(reports().map((p) => [p.id, p.body, p.url]).sort(), [
      ['d-haru', '10月のレポートができました。家計費と各人の負担・支払いを確認してください。', '#/report/2026-10'],
      ['d-shin', '10月のレポートができました。家計費と各人の負担・支払いを確認してください。', '#/report/2026-10'],
    ]);
    assert.ok(mock.db.notices.some((n) => n.key === 'report:2026-10'), 'kept as an お知らせ');
    await run('node', [SCRIPT], { env: { ...env, NOTIFY_DATE: '2026-11-05' } });
    assert.equal(reports().length, 2, 'once');
    // December: nothing imported by the 10th -> sent as not final
    await run('node', [SCRIPT], { env: { ...env, NOTIFY_DATE: '2026-12-10' } });
    assert.match(reports().at(-1).body, /^11月のレポート[\s\S]*数字は途中です/);
  } finally {
    await mock.stop();
  }
});
