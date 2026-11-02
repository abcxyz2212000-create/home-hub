// Daily deadline check + Web Push. Runs on GitHub Actions (.github/workflows/notify.yml).
//
// Environment variables:
//   SUPABASE_SERVICE_ROLE_KEY  (secret) Supabase secret key / service_role key
//   VAPID_PRIVATE_KEY          (secret) created on the app's settings screen
//   NOTIFY_TEST=1              send a test notification to every device instead of the daily check
//   SUPABASE_URL               optional, defaults to web/js/config.js
//   VAPID_SUBJECT              optional, defaults to the GitHub Pages URL of this repository
//   NOTIFY_DATE                optional YYYY-MM-DD, overrides today (tests only)
//   NOTIFY_HOUR                optional 0-23, overrides the current hour in Japan (tests only)
//
// Runs every hour. Each person gets the day's notifications once, at their own hour (ユーザーマスターの
// notify_hour, default 8) or at the first run after it when GitHub starts a run late.
import { CONFIG } from '../web/js/config.js';
import { collectEvents, dueNotifications, notificationText, todayJST } from '../web/js/events.js';
import { dueFor } from '../web/js/chores.js';
import { participantIds, statement } from '../web/js/shared.js';
import { missingImports, latestBalance, DEFAULT_LOW_BALANCE } from '../web/js/bank.js';
import { loadVapidKeys, sendPush } from './webpush.mjs';

const LOG_RETENTION_DAYS = 400;
const DEFAULT_HOUR = 8;
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

  const [settingRows, subscriptions] = await Promise.all([
    db.select('settings'),
    db.select('push_subscriptions'),
  ]);
  const settings = Object.fromEntries(settingRows.map((r) => [r.key, r.value]));
  const storedPublic = settings.vapid_public_key;
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
  const hourText = env('NOTIFY_HOUR', false);
  const hour = hourText ? Number(hourText) : Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tokyo', hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error('NOTIFY_HOUR must be 0-23');
  const [cards, contracts, items, log, chores, members] = await Promise.all([
    db.select('cards', '&status=eq.active'),
    db.select('contracts', '&status=eq.active'),
    db.select('items', '&status=eq.active'),
    db.select('notification_log'),
    db.select('chores', '&status=eq.active'),
    db.select('members', '&active=eq.true'),
  ]);
  const sent = new Set(log.map((l) => l.key));
  const mark = async (key) => {
    await db.insert('notification_log', [{ key }]);
    sent.add(key);
  };
  const due = dueNotifications(collectEvents({ cards, contracts, items }, today));

  // devices grouped by person ('none' = registered before the user master); each person has an hour
  const groups = new Map();
  for (const sub of subscriptions) {
    const g = sub.member_id && members.some((m) => m.id === sub.member_id) ? sub.member_id : 'none';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(sub);
  }
  const hourOf = (g) => {
    const m = members.find((x) => x.id === g);
    return m && Number.isInteger(m.notify_hour) ? m.notify_hour : DEFAULT_HOUR;
  };
  const ready = [...groups].filter(([g]) => hourOf(g) <= hour && !sent.has(`daily:${today}:${g}`));
  console.log(`${today} ${hour}h: ${due.length} deadline notification(s) due, ${ready.length}/${groups.size} person(s) to notify now.`);

  // the shared account's balance and this month's imports (2026-11-01)
  const sharedId = settings.shared_account_id;
  const balances = sharedId ? await db.select('account_balances', `&account_id=eq.${encodeURIComponent(sharedId)}&order=date.desc&limit=1`) : [];
  const lastBalance = latestBalance(balances);
  const threshold = Number.isFinite(Number(settings.low_balance_threshold)) && settings.low_balance_threshold !== null ? Number(settings.low_balance_threshold) : DEFAULT_LOW_BALANCE;
  const missing = sharedId ? missingImports(today, { mf: settings.mf_imported_at, bank: settings.bank_imported_at }) : [];
  const yenText = (n) => `${n < 0 ? '−' : ''}${Math.abs(Math.round(n)).toLocaleString('ja-JP')}円`;

  let shared = null;
  for (const [g, devices] of ready) {
    const failuresBefore = failures;
    // deadlines (same for everyone; the old household-wide key counts as already sent)
    for (const d of due) {
      const key = `${d.key}:${g}`;
      if (sent.has(d.key) || sent.has(key)) continue;
      const delivered = await sendTo(devices, { ...notificationText(d.event), url: `#/view/${d.event.ledger}/${d.event.id}`, tag: d.key });
      if (delivered > 0) await mark(key);
      console.log(`- ${d.event.type} ${d.event.date} (stage ${d.stage}d): delivered to ${delivered} device(s)`);
    }
    // low balance: everyone, once per balance date. Amounts never go to the log.
    if (lastBalance && lastBalance.balance < threshold) {
      const key = `lowbal:${lastBalance.date}:${g}`;
      if (!sent.has(key)) {
        const delivered = await sendTo(devices, { title: '共用口座の残高が少なくなっています', body: `${yenText(lastBalance.balance)}（${lastBalance.date.slice(5).replace('-', '/')}時点）`, url: '#/flow/ext', tag: 'low-balance' });
        if (delivered > 0) await mark(key);
        console.log(`- low balance: delivered to ${delivered} device(s)`);
      }
    }
    // monthly imports not done: the person who imports, every day until done
    if (missing.length && g === settings.import_reminder_member) {
      const key = `import:${today}:${g}`;
      if (!sent.has(key)) {
        const delivered = await sendTo(devices, { title: '今月の取り込みがまだです', body: missing.join('・'), url: '#/flow/ext', tag: 'imports' });
        if (delivered > 0) await mark(key);
        console.log(`- import reminder: delivered to ${delivered} device(s)`);
      }
    }
    if (g === 'none') {
      if (failures === failuresBefore) await mark(`daily:${today}:${g}`);
      continue;
    }
    // today's chores of this person. Names never go to the log.
    const list = dueFor(chores, today, g);
    const choreKey = `chores:${today}:${g}`;
    if (list.length > 0 && !sent.has(choreKey)) {
      const names = list.map((c) => c.name);
      const body = names.slice(0, 3).join('、') + (names.length > 3 ? ` ほか${names.length - 3}件` : '');
      const delivered = await sendTo(devices, { title: `今日の家事（${list.length}件）`, body, url: '#/chores', tag: choreKey });
      if (delivered > 0) await mark(choreKey);
      console.log(`- chores: ${list.length} task(s) for a member, delivered to ${delivered} device(s)`);
    }
    // shared account: from the 25th, once a month. Amounts and names never go to the log.
    if (Number(today.slice(8, 10)) >= SHARED_REMIND_DAY) {
      if (!shared) {
        const [rules, entries] = await Promise.all([db.select('shared_rules'), db.select('shared_entries')]);
        shared = { rules, entries, ids: participantIds(rules, entries) };
      }
      const ym = today.slice(0, 7);
      const key = `shared:${ym}:${g}`;
      if (shared.ids.includes(g) && !sent.has(key)) {
        const yen = (n) => `${n < 0 ? '−' : ''}${Math.abs(Math.round(n)).toLocaleString('ja-JP')}円`;
        const st = statement(shared.rules, shared.entries, g, ym);
        const delivered = await sendTo(devices, {
          title: `共用口座への入金（${Number(ym.slice(5))}月）`,
          body: `今月 ${yen(st.charges)}／未入金の残高 ${yen(st.balance)}`,
          url: `#/flow/member/${ym}`,
          tag: key,
        });
        if (delivered > 0) await mark(key);
        console.log(`- shared account reminder for a member: delivered to ${delivered} device(s)`);
      }
    }
    // done for today (if a push failed, the next hourly run tries again)
    if (failures === failuresBefore) await mark(`daily:${today}:${g}`);
  }

  const cutoff = new Date(Date.now() - LOG_RETENTION_DAYS * 86400000).toISOString();
  await db.remove('notification_log', `sent_at=lt.${encodeURIComponent(cutoff)}`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
