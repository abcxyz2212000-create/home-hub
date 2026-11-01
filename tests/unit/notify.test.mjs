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

    const env = { ...process.env, SUPABASE_URL: apiUrl, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, VAPID_PRIVATE_KEY: b64urlEncode(privateKey32(vapid)), GITHUB_REPOSITORY: 'Owner/home-hub' };
    const first = await run('node', [SCRIPT], { env });
    assert.match(first.stdout, /1 notification\(s\) due/);
    assert.doesNotMatch(first.stdout + first.stderr, /火災保険/); // names never appear in public logs

    const delivered = mock.pushes.filter((p) => p.id === 'dev1');
    assert.equal(delivered.length, 1);
    assert.match(delivered[0].headers.authorization, /^vapid t=.+, k=/);
    assert.equal(delivered[0].headers['content-encoding'], 'aes128gcm');
    const payload = decrypt(delivered[0].body, ua, auth);
    assert.equal(payload.title, '契約の自動更新日: 火災保険');
    assert.match(payload.body, /^あと7日/);
    assert.equal(payload.url, '#/view/contracts/k1');
    assert.deepEqual(mock.db.push_subscriptions.map((s) => s.id), ['dev1', 'dev2']);
    const choresPush = mock.pushes.filter((p) => p.id === 'dev2').map((p) => decrypt(p.body, ua, auth)).find((p) => p.title.startsWith('今日の家事'));
    assert.equal(choresPush.title, '今日の家事（2件）');
    assert.equal(choresPush.body, 'ゴミ出し、郵便物回収');
    assert.equal(choresPush.url, '#/chores');
    assert.ok(!mock.pushes.filter((p) => p.id === 'dev1').map((p) => decrypt(p.body, ua, auth)).some((p) => p.title.startsWith('今日の家事')),
      'a device without a member gets no chore reminder');
    assert.doesNotMatch(first.stdout + first.stderr, /ゴミ出し|郵便物/, 'chore names never appear in public logs');
    assert.equal(mock.db.notification_log.length, 2);

    await run('node', [SCRIPT], { env });
    assert.equal(mock.pushes.filter((p) => p.id === 'dev1').length, 1, 'no duplicate on the second run');
    assert.equal(mock.pushes.filter((p) => p.id === 'dev2').length, 2, 'deadline + chores once each');

    const t = await run('node', [SCRIPT], { env: { ...env, NOTIFY_TEST: '1' } });
    assert.match(t.stdout, /delivered to 2\/2/);
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

    const env = { ...process.env, SUPABASE_URL: apiUrl, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, VAPID_PRIVATE_KEY: b64urlEncode(privateKey32(vapid)), GITHUB_REPOSITORY: 'Owner/home-hub' };
    await run('node', [SCRIPT], { env: { ...env, NOTIFY_DATE: '2026-11-24' } });
    assert.equal(mock.pushes.length, 0, 'nothing before the 25th');

    const r = await run('node', [SCRIPT], { env: { ...env, NOTIFY_DATE: '2026-11-25' } });
    const got = mock.pushes.map((p) => ({ id: p.id, ...decrypt(p.body, ua, auth) }));
    assert.deepEqual(got.map((p) => p.id), ['d-shin']);
    assert.equal(got[0].title, '共用口座への入金（11月）');
    assert.equal(got[0].body, '今月 8,000円／未入金の残高 11,000円');
    assert.equal(got[0].url, '#/shared/2026-11');
    assert.doesNotMatch(r.stdout + r.stderr, /8,000|11,000|しん|基本/, 'amounts and names never appear in public logs');

    await run('node', [SCRIPT], { env: { ...env, NOTIFY_DATE: '2026-11-28' } });
    assert.equal(mock.pushes.length, 1, 'once a month');
    await assert.rejects(run('node', [SCRIPT], { env: { ...env, NOTIFY_DATE: '2026/11/25' } }), /NOTIFY_DATE/);
  } finally {
    await mock.stop();
  }
});
