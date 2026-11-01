// Daily deadline check + Web Push. Runs on GitHub Actions (.github/workflows/notify.yml).
//
// Environment variables:
//   SUPABASE_SERVICE_ROLE_KEY  (secret) Supabase secret key / service_role key
//   VAPID_PRIVATE_KEY          (secret) created on the app's settings screen
//   NOTIFY_TEST=1              send a test notification to every device instead of the daily check
//   SUPABASE_URL               optional, defaults to web/js/config.js
//   VAPID_SUBJECT              optional, defaults to the GitHub Pages URL of this repository
//   NOTIFY_DATE                optional YYYY-MM-DD, overrides today (tests only)
import { CONFIG } from '../web/js/config.js';
import { collectEvents, dueNotifications, notificationText, todayJST } from '../web/js/events.js';
import { dueFor } from '../web/js/chores.js';
import { participantIds, statement } from '../web/js/shared.js';
import { loadVapidKeys, sendPush } from './webpush.mjs';

const LOG_RETENTION_DAYS = 400;
const SHARED_REMIND_DAY = 25; // monthly shared account reminder from this day of the month (sent once per month)

function env(name, required = true) {
  const v = (process.env[name] || '').trim();
  if (required && !v) throw new Error(`missing environment variable ${name}`);
  return v;
}

function subjectUrl() {
  const explicit = env('VAPID_SUBJECT', false);
  if (explicit) return explicit;
  const repo = env('GITHUB_REPOSITORY', false); // owner/name, set by GitHub Actions
  if (repo) {
    const [owner, name] = repo.split('/');
    return `https://${owner.toLowerCase()}.github.io/${name}/`;
  }
  return 'mailto:noreply@example.com';
}

function createClient(baseUrl, key) {
  const headers = { apikey: key, 'Content-Type': 'application/json' };
  // Legacy service_role keys are JWTs and also go in Authorization; new secret keys (sb_secret_...) only in apikey.
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;
  const call = async (method, path, body) => {
    const res = await fetch(`${baseUrl}/rest/v1/${path}`, {
      method,
      headers: method === 'GET' ? headers : { ...headers, Prefer: 'return=minimal' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Supabase ${method} ${path.split('?')[0]} failed: HTTP ${res.status} ${await res.text()}`);
    return method === 'GET' ? res.json() : null;
  };
  return {
    select: (table, query = '') => call('GET', `${table}?select=*${query}`),
    insert: (table, rows) => call('POST', table, rows),
    remove: (table, query) => call('DELETE', `${table}?${query}`),
  };
}

async function main() {
  const baseUrl = env('SUPABASE_URL', false) || CONFIG.supabaseUrl;
  if (!/^https:\/\/[^/]+$/.test(baseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(baseUrl)) throw new Error('Supabase URL is not configured (web/js/config.js)');
  const db = createClient(baseUrl, env('SUPABASE_SERVICE_ROLE_KEY'));
  const vapid = loadVapidKeys(env('VAPID_PRIVATE_KEY'));
  const subject = subjectUrl();

  const [settings, subscriptions] = await Promise.all([
    db.select('settings', '&key=eq.vapid_public_key'),
    db.select('push_subscriptions'),
  ]);
  const storedPublic = settings[0] && settings[0].value;
  if (storedPublic && storedPublic !== vapid.publicKey) {
    throw new Error('VAPID_PRIVATE_KEY does not match the public key saved in the app. Re-register the secret.');
  }
  if (subscriptions.length === 0) console.warn('No device has subscribed to notifications.');

  let failures = 0;
  const sendTo = async (targets, payload) => {
    let delivered = 0;
    for (const sub of targets) {
      try {
        const status = await sendPush(sub, payload, vapid, subject);
        if (status >= 200 && status < 300) delivered += 1;
        else if (status === 404 || status === 410) {
          console.log(`Subscription ${sub.id} expired (HTTP ${status}); removing it.`);
          await db.remove('push_subscriptions', `id=eq.${sub.id}`);
        } else {
          failures += 1;
          console.error(`Push to ${sub.id} (${sub.device_label || 'device'}) failed: HTTP ${status}`);
        }
      } catch (e) {
        failures += 1;
        console.error(`Push to ${sub.id} failed: ${e.message}`);
      }
    }
    return delivered;
  };
  const sendToAll = (payload) => sendTo(subscriptions, payload);

  if (env('NOTIFY_TEST', false) === '1') {
    const delivered = await sendToAll({ title: 'テスト通知', body: '家の管理ハブからの通知は正しく届いています。', url: '#/', tag: 'test' });
    console.log(`Test notification delivered to ${delivered}/${subscriptions.length} device(s).`);
    if (failures > 0 || delivered === 0) process.exitCode = 1;
    return;
  }

  const today = env('NOTIFY_DATE', false) || todayJST();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error('NOTIFY_DATE must be YYYY-MM-DD');
  const [cards, contracts, items, log] = await Promise.all([
    db.select('cards', '&status=eq.active'),
    db.select('contracts', '&status=eq.active'),
    db.select('items', '&status=eq.active'),
    db.select('notification_log'),
  ]);
  const sent = new Set(log.map((l) => l.key));
  const due = dueNotifications(collectEvents({ cards, contracts, items }, today)).filter((d) => !sent.has(d.key));
  console.log(`${today}: ${due.length} notification(s) due, ${subscriptions.length} device(s).`);

  for (const d of due) {
    const text = notificationText(d.event);
    const delivered = await sendToAll({ ...text, url: `#/view/${d.event.ledger}/${d.event.id}`, tag: d.key });
    if (delivered > 0) await db.insert('notification_log', [{ key: d.key }]);
    console.log(`- ${d.event.type} ${d.event.date} (stage ${d.stage}d): delivered to ${delivered} device(s)`);
  }

  // Today's chores: one summary per member, sent only to that member's devices (devices registered
  // before the user master have no member and get no chore reminders). Names never go to the log.
  const [chores, members] = await Promise.all([
    db.select('chores', '&status=eq.active'),
    db.select('members', '&active=eq.true'),
  ]);
  const devicesByMember = new Map();
  for (const sub of subscriptions) {
    if (!sub.member_id || !members.some((m) => m.id === sub.member_id)) continue;
    if (!devicesByMember.has(sub.member_id)) devicesByMember.set(sub.member_id, []);
    devicesByMember.get(sub.member_id).push(sub);
  }
  for (const [memberId, devices] of devicesByMember) {
    const list = dueFor(chores, today, memberId);
    const key = `chores:${today}:${memberId}`;
    if (list.length === 0 || sent.has(key)) continue;
    const names = list.map((c) => c.name);
    const body = names.slice(0, 3).join('、') + (names.length > 3 ? ` ほか${names.length - 3}件` : '');
    const delivered = await sendTo(devices, { title: `今日の家事（${list.length}件）`, body, url: '#/chores', tag: key });
    if (delivered > 0) await db.insert('notification_log', [{ key }]);
    console.log(`- chores: ${list.length} task(s) for a member, delivered to ${delivered} device(s)`);
  }

  // Shared account: from the 25th, once a month, the amount for this month and the unpaid balance
  // go to each participant's own devices. Amounts and names never go to the log.
  if (Number(today.slice(8, 10)) >= SHARED_REMIND_DAY) {
    const [rules, entries] = await Promise.all([db.select('shared_rules'), db.select('shared_entries')]);
    const ym = today.slice(0, 7);
    const yen = (n) => `${n < 0 ? '−' : ''}${Math.abs(Math.round(n)).toLocaleString('ja-JP')}円`;
    for (const memberId of participantIds(rules, entries)) {
      const devices = devicesByMember.get(memberId) || [];
      const key = `shared:${ym}:${memberId}`;
      if (devices.length === 0 || sent.has(key)) continue;
      const st = statement(rules, entries, memberId, ym);
      const delivered = await sendTo(devices, {
        title: `共通口座への入金（${Number(ym.slice(5))}月）`,
        body: `今月 ${yen(st.charges)}／未入金の残高 ${yen(st.balance)}`,
        url: `#/shared/${ym}`,
        tag: key,
      });
      if (delivered > 0) await db.insert('notification_log', [{ key }]);
      console.log(`- shared account reminder for a member: delivered to ${delivered} device(s)`);
    }
  }

  const cutoff = new Date(Date.now() - LOG_RETENTION_DAYS * 86400000).toISOString();
  await db.remove('notification_log', `sent_at=lt.${encodeURIComponent(cutoff)}`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
