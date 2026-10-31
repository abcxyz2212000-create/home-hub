// Web Push sender using only Node.js built-ins.
// Implements VAPID (RFC 8292) and "aes128gcm" message encryption (RFC 8188 / RFC 8291).
import crypto from 'node:crypto';

export function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64url');
}

export function b64urlDecode(str) {
  return Buffer.from(str, 'base64url');
}

// VAPID private key = base64url of the 32-byte P-256 scalar (as generated in the app's settings screen).
export function loadVapidKeys(privateKeyB64) {
  const d = b64urlDecode(privateKeyB64.trim());
  if (d.length !== 32) throw new Error('VAPID_PRIVATE_KEY must be 32 bytes (base64url)');
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(d);
  const publicKey = ecdh.getPublicKey(); // 65 bytes, uncompressed
  const key = crypto.createPrivateKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', d: b64urlEncode(d), x: b64urlEncode(publicKey.subarray(1, 33)), y: b64urlEncode(publicKey.subarray(33, 65)) },
  });
  return { key, publicKey: b64urlEncode(publicKey) };
}

export function vapidAuthorization(endpoint, vapid, subject, now = Date.now()) {
  const aud = new URL(endpoint).origin;
  const header = b64urlEncode(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64urlEncode(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }));
  const input = `${header}.${claims}`;
  const signature = crypto.sign('sha256', Buffer.from(input), { key: vapid.key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${input}.${b64urlEncode(signature)}, k=${vapid.publicKey}`;
}

// Encrypt a payload for one subscription. `ephemeral` and `salt` are injectable for tests.
export function encryptPayload(payload, p256dhB64, authB64, { ephemeralPrivateKey, salt } = {}) {
  const uaPublic = b64urlDecode(p256dhB64);
  const authSecret = b64urlDecode(authB64);
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error('invalid subscription keys');
  const ecdh = crypto.createECDH('prime256v1');
  if (ephemeralPrivateKey) ecdh.setPrivateKey(ephemeralPrivateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(uaPublic);
  const saltBytes = salt || crypto.randomBytes(16);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', sharedSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, saltBytes, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, saltBytes, Buffer.from('Content-Encoding: nonce\0'), 12));

  const plaintext = Buffer.concat([Buffer.from(payload), Buffer.from([2])]); // 0x02 = last record, no padding
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(21);
  saltBytes.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, ciphertext]);
}

// Returns the HTTP status code of the push service.
export async function sendPush(subscription, payload, vapid, subject, fetchImpl = fetch) {
  const body = encryptPayload(JSON.stringify(payload), subscription.p256dh, subscription.auth);
  const res = await fetchImpl(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: vapidAuthorization(subscription.endpoint, vapid, subject),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400',
      Urgency: 'normal',
    },
    body,
  });
  return res.status;
}
