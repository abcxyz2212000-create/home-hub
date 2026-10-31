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
    mock.db.items.push({ id: 'i1', name: '洗濯機', status: 'active', warranty_until: in7, notify_days: { warranty: [] } });

    const env = { ...process.env, SUPABASE_URL: apiUrl, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, VAPID_PRIVATE_KEY: b64urlEncode(vapid.getPrivateKey()), GITHUB_REPOSITORY: 'Owner/home-hub' };
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
    assert.deepEqual(mock.db.push_subscriptions.map((s) => s.id), ['dev1']);
    assert.equal(mock.db.notification_log.length, 1);

    await run('node', [SCRIPT], { env });
    assert.equal(mock.pushes.filter((p) => p.id === 'dev1').length, 1, 'no duplicate on the second run');

    const t = await run('node', [SCRIPT], { env: { ...env, NOTIFY_TEST: '1' } });
    assert.match(t.stdout, /delivered to 1\/1/);
    assert.equal(decrypt(mock.pushes.at(-1).body, ua, auth).title, 'テスト通知');

    // wrong key is rejected
    const other = crypto.createECDH('prime256v1');
    other.generateKeys();
    await assert.rejects(run('node', [SCRIPT], { env: { ...env, VAPID_PRIVATE_KEY: b64urlEncode(other.getPrivateKey()) } }), /does not match/);
  } finally {
    await mock.stop();
  }
});
