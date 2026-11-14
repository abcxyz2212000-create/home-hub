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
// Runs every 10 minutes. Each person gets the day's notifications once, at their own hour (ユーザーマスターの
// notify_hour, default 8) or at the first run after it when GitHub starts a run late. Every notification
// is also kept as an お知らせ (notices), and messages people wrote are pushed once they are due.
import { CONFIG } from '../web/js/config.js';
import { collectEvents, dueNotifications, notificationText, todayJST } from '../web/js/events.js';
import { dueFor } from '../web/js/chores.js';
import { participantIds, statement, contribution } from '../web/js/shared.js';
import { categoryAdjustments, categoryRatioQuery } from '../web/js/budget.js';
import { missingImports, lastImports, latestBalance, DEFAULT_LOW_BALANCE } from '../web/js/bank.js';
import { lowBalanceAlert, importAlert, choresAlert, householdAlert, confirmAlert, choreAskAlert } from '../web/js/alerts.js';
import { loadVapidKeys, sendPush } from './webpush.mjs';

const LOG_RETENTION_DAYS = 400;
const NOTICE_RETENTION_DAYS = 365; // お知らせ are kept for a year
const DEFAULT_HOUR = 8;
const SHARED_REMIND_DAY = 25; // monthly shared account reminder from this day of the month (sent once per month)

// The environment: process.env when run by Node, the values given to run…() when run elsewhere
// (the Supabase Edge Function).
let ENV = typeof process !== 'undefined' && process.env ? process.env : {};
let exitCode = 0;

function env(name, required = true) {
  const v = (ENV[name] || '').trim();
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
    // rows whose unique column already exists are skipped
    insertIgnore: async (table, rows, onConflict) => {
      const res = await fetch(`${baseUrl}/rest/v1/${table}?on_conflict=${onConflict}`, {
        method: 'POST', headers: { ...headers, Prefer: 'return=minimal,resolution=ignore-duplicates' }, body: JSON.stringify(rows),
      });
      if (!res.ok) throw new Error(`Supabase POST ${table} failed: HTTP ${res.status} ${await res.text()}`);
    },
    update: (table, query, values) => call('PATCH', `${table}?${query}`, values),
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
    const delivered = await sendToAll({ title: 'テスト通知', body: 'HouseHubからの通知は正しく届いています。', url: '#/', tag: 'test' });
    console.log(`Test notification delivered to ${delivered}/${subscriptions.length} device(s).`);
    if (failures > 0 || delivered === 0) exitCode = 1;
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
  let missing = [];
  if (sharedId) {
    const [newestTx, newestBalance] = await Promise.all([
      db.select('transactions', '&order=created_at.desc&limit=1'),
      db.select('account_balances', `&account_id=eq.${encodeURIComponent(sharedId)}&order=created_at.desc&limit=1`),
    ]);
    const newest = { mf: newestTx.length ? newestTx[0].created_at : null, bank: newestBalance.length ? newestBalance[0].created_at : null };
    missing = missingImports(today, lastImports(settings, newest));
  }

  // ワークフロー: open requests and who answered them
  const [openRequests, replies] = await Promise.all([
    db.select('workflow_requests', '&status=eq.open'),
    db.select('workflow_replies', ''),
  ]);
  const waitingFor = (g) => openRequests.filter((r) => (r.approvers || []).includes(g) && r.applicant !== g
    && !replies.some((x) => x.request_id === r.id && x.member_id === g));

  let shared = null;
  const sharedData = async () => {
    if (!shared) {
      const [rules, entries, years] = await Promise.all([db.select('shared_rules'), db.select('shared_entries'), db.select('budget_years')]);
      const ids = participantIds(rules, entries);
      // per-category ratios: corrections worked out from the statement lines (not stored)
      const q = categoryRatioQuery(years);
      const txs = q ? await db.select('transactions', `&${q}`) : [];
      const adjust = categoryAdjustments({ txs, years, members, memberIds: ids });
      shared = { rules, entries: [...entries, ...adjust], ids };
    }
    return shared;
  };

  // The day's notifications of one person (g = member id, or 'none' for devices registered before the
  // user master). mark: per-person key in notification_log; notice: one お知らせ per alert.
  const itemsFor = async (g) => {
    const items = [];
    // deadlines (same for everyone; the old household-wide key counts as already sent)
    for (const d of due) {
      items.push({ mark: `${d.key}:${g}`, old: d.key, notice: d.key, to: [], payload: { ...notificationText(d.event, today), url: `#/view/${d.event.ledger}/${d.event.id}`, tag: d.key },
        log: `${d.event.type} ${d.event.date} (stage ${d.stage}d)` });
    }
    // low balance: everyone, once per balance date. Amounts never go to the log.
    if (lastBalance && lastBalance.balance < threshold) {
      items.push({ mark: `lowbal:${lastBalance.date}:${g}`, notice: `lowbal:${lastBalance.date}`, to: [], payload: { ...lowBalanceAlert(lastBalance, threshold, today), url: '#/flow/ext', tag: 'low-balance' }, log: 'low balance' });
    }
    // monthly imports not done: the person who imports, every day until done
    if (missing.length && g === settings.import_reminder_member) {
      items.push({ mark: `import:${today}:${g}`, notice: `import:${today}`, to: [g], payload: { ...importAlert(missing, today), url: '#/flow/ext', tag: 'imports' }, log: 'import reminder' });
    }
    if (g === 'none') return items;
    // requests waiting for this person's answer: a reminder every day until they answer (not kept as an お知らせ)
    const waiting = waitingFor(g);
    if (waiting.length) {
      items.push({ mark: `ack:${today}:${g}`, notice: null, to: [g], payload: { ...confirmAlert(waiting.length), url: '#/workflow', tag: 'confirm' }, log: `waiting requests: ${waiting.length}` });
    }
    // today's chores of this person. Names never go to the log.
    const list = dueFor(chores, today, g);
    if (list.length > 0) {
      items.push({ mark: `chores:${today}:${g}`, notice: `chores:${today}:${g}`, to: [g], payload: { ...choresAlert(list.map((c) => c.name)), url: '#/chores', tag: `chores:${today}:${g}` }, log: `chores: ${list.length} task(s) for a member` });
    }
    // shared account: from the 25th, once a month. Amounts and names never go to the log.
    if (Number(today.slice(8, 10)) >= SHARED_REMIND_DAY) {
      const sh = await sharedData();
      const ym = today.slice(0, 7);
      if (sh.ids.includes(g)) {
        const st = statement(sh.rules, sh.entries, g, ym);
        items.push({ mark: `shared:${ym}:${g}`, notice: `shared:${ym}:${g}`, to: [g], payload: { ...householdAlert(ym, contribution(st)), url: `#/flow/member/${ym}`, tag: `shared:${ym}:${g}` }, log: 'shared account reminder for a member' });
      }
    }
    return items;
  };

  // お知らせ: one row per alert, whether or not the person has a device (a second run adds nothing)
  const record = (it) => !it.notice ? null : db.insertIgnore('notices', [{ kind: 'system', key: it.notice, to_members: it.to, title: it.payload.title, body: it.payload.body || '', url: it.payload.url || null, delivered_at: new Date().toISOString() }], 'key');

  for (const [g, devices] of ready) {
    const failuresBefore = failures;
    for (const it of await itemsFor(g)) {
      if (sent.has(it.mark) || (it.old && sent.has(it.old))) continue;
      await record(it);
      const delivered = await sendTo(devices, it.payload);
      if (delivered > 0) await mark(it.mark);
      console.log(`- ${it.log}: delivered to ${delivered} device(s)`);
    }
    // done for today (if a push failed, the next run tries again)
    if (failures === failuresBefore) await mark(`daily:${today}:${g}`);
  }
  // people without a device: their notifications still go to お知らせ, at their hour
  for (const m of members) {
    // (a separate key: a device registered later that day still gets the day's pushes)
    if (groups.has(m.id) || hourOf(m.id) > hour || sent.has(`notices:${today}:${m.id}`)) continue;
    for (const it of await itemsFor(m.id)) await record(it);
    await mark(`notices:${today}:${m.id}`);
  }

  const nowIso = new Date().toISOString();
  const nickOf = (id) => {
    const m = members.find((x) => x.id === id);
    return m ? (m.nickname || m.name) : null;
  };
  const devicesOf = (ids) => subscriptions.filter((sub) => ids.includes(sub.member_id));
  // ワークフロー: a new request goes to those who answer it (not to who made it); a result to who made it;
  // a cancelled 家事の実施 or 支払い to those who had answered. Titles and names never go to the log.
  for (const r of openRequests.filter((x) => !x.pushed_at)) {
    const to = (r.approvers || []).filter((id) => id !== r.applicant);
    const from = nickOf(r.applicant);
    const delivered = await sendTo(devicesOf(to), { title: r.type_key === 'change' ? '確認待ち' : '承認待ち', body: `${from ? `${from}より：` : ''}${r.title}`.slice(0, 200), url: '#/workflow', tag: `wf:${r.id}` });
    await db.update('workflow_requests', `id=eq.${r.id}`, { pushed_at: nowIso });
    console.log(`- request: delivered to ${delivered} device(s)`);
  }
  const decided = await db.select('workflow_requests', '&status=in.(done,rejected,cancelled)&result_pushed_at=is.null');
  for (const r of decided) {
    const cancelled = r.status === 'cancelled';
    const to = cancelled ? (r.approvers || []) : (r.type_key === 'change' || !r.applicant ? [] : [r.applicant]);
    const label = r.status === 'done' ? '承認されました' : r.status === 'rejected' ? '却下されました' : '取り消されました';
    const delivered = to.length ? await sendTo(devicesOf(to), { title: label, body: r.title.slice(0, 200), url: '#/workflow', tag: `wf:${r.id}` }) : 0;
    await db.update('workflow_requests', `id=eq.${r.id}`, { result_pushed_at: nowIso });
    if (to.length) console.log(`- result: delivered to ${delivered} device(s)`);
  }
  // 問いかけ: at the chosen hour, ask the assignee of a chore done for its price whether they do it today
  const promptChores = (await db.select('chores', '&status=eq.active&prompt_hour=not.is.null&paid_by=not.is.null&assignee_type=eq.member'))
    .filter((c) => c.assignee_id && c.prompt_hour <= hour);
  if (promptChores.length) {
    const answered = await db.select('workflow_requests', `&type_key=eq.chore_done&created_at=gte.${encodeURIComponent(new Date(Date.now() - 2 * 86400000).toISOString())}`);
    for (const c of promptChores) {
      const key = `prompt:${c.id}:${today}`;
      if (sent.has(key)) continue;
      const done = answered.some((r) => r.payload && r.payload.chore_id === c.id && r.payload.date === today
        && (r.status === 'open' || r.status === 'done' || (r.status === 'withdrawn' && r.payload.skip)));
      if (done) continue;
      const delivered = await sendTo(devicesOf([c.assignee_id]), { ...choreAskAlert(c.name), url: `#/chore-ask/${c.id}/${today}`, tag: key });
      await mark(key);
      console.log(`- chore question: delivered to ${delivered} device(s)`);
    }
  }

  // messages (and scheduled ones) that are due: pushed to the devices of their recipients, every run
  const messages = await db.select('notices', `&kind=eq.message&delivered_at=is.null&deliver_at=lte.${encodeURIComponent(nowIso)}`);
  for (const n of messages) {
    const to = n.to_members && n.to_members.length ? n.to_members : members.map((m) => m.id);
    const from = members.find((m) => m.id === n.from_member);
    const devices = subscriptions.filter((sub) => to.includes(sub.member_id));
    const delivered = await sendTo(devices, { title: n.title, body: `${from ? `${from.nickname || from.name}より：` : ''}${n.body}`.slice(0, 200), url: '#/notices', tag: `notice:${n.id}` });
    await db.update('notices', `id=eq.${n.id}`, { delivered_at: nowIso });
    console.log(`- message: delivered to ${delivered} device(s)`);
  }
  const noticeCutoff = new Date(Date.now() - NOTICE_RETENTION_DAYS * 86400000).toISOString();
  await db.remove('notices', `created_at=lt.${encodeURIComponent(noticeCutoff)}&deliver_at=lt.${encodeURIComponent(noticeCutoff)}`);

  const cutoff = new Date(Date.now() - LOG_RETENTION_DAYS * 86400000).toISOString();
  await db.remove('notification_log', `sent_at=lt.${encodeURIComponent(cutoff)}`);
  if (failures > 0) exitCode = 1;
}

// Runs once with the given environment; returns 0 when everything was sent, 1 otherwise.
export async function runNotify(environment) {
  ENV = environment;
  exitCode = 0;
  try {
    await main();
  } catch (e) {
    console.error(e.message);
    exitCode = 1;
  }
  return exitCode;
}

if (typeof Deno === 'undefined' && typeof process !== 'undefined' && process.argv && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e.message);
    exitCode = 1;
  }).finally(() => { process.exitCode = exitCode; });
}
