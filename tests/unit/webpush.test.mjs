import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { encryptPayload, loadVapidKeys, vapidAuthorization, b64urlDecode, b64urlEncode } from '../../scripts/webpush.mjs';

// Test vector from RFC 8291 section 5 / appendix A.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  expected: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

test('aes128gcm encryption matches the RFC 8291 example', () => {
  const out = encryptPayload(RFC.plaintext, RFC.uaPublic, RFC.auth, {
    ephemeralPrivateKey: b64urlDecode(RFC.asPrivate),
    salt: b64urlDecode(RFC.salt),
  });
  assert.equal(b64urlEncode(out), RFC.expected);
});

test('VAPID JWT is a valid ES256 signature for the endpoint origin', () => {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const vapid = loadVapidKeys(b64urlEncode(ecdh.getPrivateKey()));
  assert.equal(vapid.publicKey, b64urlEncode(ecdh.getPublicKey()));
  const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', vapid, 'https://example.github.io/home-hub/', 0);
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
  assert.ok(m);
  const claims = JSON.parse(b64urlDecode(m[2]).toString());
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  assert.equal(claims.exp, 12 * 3600);
  const pub = crypto.createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: b64urlEncode(ecdh.getPublicKey().subarray(1, 33)), y: b64urlEncode(ecdh.getPublicKey().subarray(33)) } });
  assert.ok(crypto.verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key: pub, dsaEncoding: 'ieee-p1363' }, b64urlDecode(m[3])));
  assert.equal(m[4], vapid.publicKey);
});

test('rejects malformed keys', () => {
  assert.throws(() => loadVapidKeys('abc'));
  assert.throws(() => encryptPayload('x', 'AAAA', RFC.auth));
});
