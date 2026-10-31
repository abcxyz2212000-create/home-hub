// Web Push subscription on this device and VAPID key generation.
import { upsertRows, deleteWhere } from './supabase.js';

function b64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(str) {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

// New P-256 key pair. The public key is stored in the app settings,
// the private key is shown once and saved by the user as a GitHub secret.
export async function generateVapidKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const x = fromB64url(jwk.x);
  const y = fromB64url(jwk.y);
  const pub = new Uint8Array(65);
  pub[0] = 4;
  pub.set(x, 1);
  pub.set(y, 33);
  return { publicKey: b64url(pub), privateKey: jwk.d };
}

async function registration() {
  return navigator.serviceWorker.ready;
}

export async function currentSubscription() {
  if (!pushSupported()) return null;
  const reg = await registration();
  return reg.pushManager.getSubscription();
}

function sameKey(sub, publicKey) {
  const k = sub.options && sub.options.applicationServerKey;
  return !k || b64url(k) === publicKey;
}

// Returns 'subscribed' or 'denied'.
export async function subscribe(publicKey, deviceLabel, memberId) {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'denied';
  const reg = await registration();
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub, publicKey)) {
    await sub.unsubscribe();
    sub = null;
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64url(publicKey) });
  const json = sub.toJSON();
  await upsertRows(
    'push_subscriptions',
    [{ endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth, device_label: deviceLabel || null, member_id: memberId || null }],
    'endpoint',
  );
  return 'subscribed';
}

export async function unsubscribe() {
  const sub = await currentSubscription();
  if (!sub) return;
  await deleteWhere('push_subscriptions', 'endpoint', sub.endpoint);
  await sub.unsubscribe();
}
