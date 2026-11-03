// Yearly: the ratio of the people for next year's budget from the wage statistics (e-Stat API).
// Runs on GitHub Actions (.github/workflows/wage.yml), every 1 December and by hand.
//
// Environment variables:
//   SUPABASE_SERVICE_ROLE_KEY  (secret) Supabase secret key / service_role key
//   ESTAT_APP_ID               (secret) e-Stat application ID
//   VAPID_PRIVATE_KEY          (secret, optional) to notify the administrators
//   SUPABASE_URL               optional, defaults to web/js/config.js
//   BUDGET_YEAR                optional, defaults to next year (Japan time)
//
// The result goes to the setting `ratio_proposal`; an administrator adopts it on the budget screen.
// Logs of a public repository are public: names, ages and values are never printed, nor the app ID.
import { CONFIG } from '../web/js/config.js';
import { todayJST } from '../web/js/events.js';
import { participantIds } from '../web/js/shared.js';
import { percents } from '../web/js/budget.js';
import { ESTAT_STATS_DATA_ID, surveyYearFor, metaClasses, chooseClasses, narrowParams, parseEstat, buildProposal } from '../web/js/wage.js';
import { loadVapidKeys, sendPush } from './webpush.mjs';

const ESTAT_API = 'https://api.e-stat.go.jp/rest/3.0/app/json';

function env(name, required = true) {
  const v = (process.env[name] || '').trim();
  if (required && !v) throw new Error(`missing environment variable ${name}`);
  return v;
}

function createClient(baseUrl, key) {
  const headers = { apikey: key, 'Content-Type': 'application/json' };
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;
  const call = async (method, path, body, prefer) => {
    const res = await fetch(`${baseUrl}/rest/v1/${path}`, {
      method,
      headers: method === 'GET' ? headers : { ...headers, Prefer: prefer || 'return=minimal' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Supabase ${method} ${path.split('?')[0]} failed: HTTP ${res.status} ${await res.text()}`);
    return method === 'GET' ? res.json() : null;
  };
  return {
    select: (table, query = '') => call('GET', `${table}?select=*${query}`),
    upsert: (table, rows, onConflict) => call('POST', `${table}?on_conflict=${onConflict}`, rows, 'resolution=merge-duplicates,return=minimal'),
    remove: (table, query) => call('DELETE', `${table}?${query}`),
  };
}

async function estat(method, params, appId) {
  const q = new URLSearchParams({ appId, lang: 'J', ...params });
  const res = await fetch(`${ESTAT_API}/${method}?${q}`);
  if (!res.ok) throw new Error(`e-Stat ${method} failed: HTTP ${res.status}`); // the URL holds the app ID: not printed
  return res.json();
}

// Wage table of one survey year: [{ sex, ageClass, value }].
export async function fetchWages(surveyYear, appId, statsDataId = ESTAT_STATS_DATA_ID) {
  const meta = await estat('getMetaInfo', { statsDataId }, appId);
  const { fixed } = chooseClasses(metaClasses(meta), surveyYear);
  const data = await estat('getStatsData', { statsDataId, metaGetFlg: 'Y', cntGetFlg: 'N', ...narrowParams(fixed) }, appId);
  return parseEstat(data, surveyYear);
}

async function main() {
  const baseUrl = env('SUPABASE_URL', false) || CONFIG.supabaseUrl;
  if (!/^https:\/\/[^/]+$/.test(baseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(baseUrl)) throw new Error('Supabase URL is not configured (web/js/config.js)');
  const db = createClient(baseUrl, env('SUPABASE_SERVICE_ROLE_KEY'));
  const yearText = env('BUDGET_YEAR', false);
  const budgetYear = yearText ? Number(yearText) : Number(todayJST().slice(0, 4)) + 1;
  if (!Number.isInteger(budgetYear) || budgetYear < 2020 || budgetYear > 2100) throw new Error('BUDGET_YEAR must be a year');
  const surveyYear = surveyYearFor(budgetYear);

  const [members, rules, entries, subscriptions] = await Promise.all([
    db.select('members', '&active=eq.true'),
    db.select('shared_rules'),
    db.select('shared_entries'),
    db.select('push_subscriptions'),
  ]);
  const ids = participantIds(rules, entries);
  const people = members.filter((m) => ids.includes(m.id));

  let proposal;
  try {
    const table = await fetchWages(surveyYear, env('ESTAT_APP_ID'));
    proposal = buildProposal({ budgetYear, members: people, table });
  } catch (e) {
    proposal = buildProposal({ budgetYear, members: people, error: e.message });
  }
  await db.upsert('settings', [{ key: 'ratio_proposal', value: proposal }], 'key');
  console.log(proposal.error
    ? `Budget ${budgetYear} (survey ${surveyYear}): no proposal: ${proposal.error}`
    : `Budget ${budgetYear} (survey ${surveyYear}): proposal saved for ${proposal.values.length} people.`);

  // tell the administrators (if notifications are set up)
  const vapidKey = env('VAPID_PRIVATE_KEY', false);
  if (!vapidKey) return;
  const vapid = loadVapidKeys(vapidKey);
  const repo = env('GITHUB_REPOSITORY', false);
  const subject = repo ? `https://${repo.split('/')[0].toLowerCase()}.github.io/${repo.split('/')[1]}/` : 'mailto:noreply@example.com';
  const admins = new Set(members.filter((m) => m.role === 'admin').map((m) => m.id));
  const nick = (id) => (members.find((m) => m.id === id) || {}).nickname || '';
  let payload;
  if (proposal.error) {
    payload = { title: '負担率の自動取得', body: `${budgetYear}年の負担率を賃金統計から取れませんでした。予算の編集画面で手で入れてください。`, url: `#/budget/${budgetYear}`, tag: 'ratio-proposal' };
  } else {
    const pc = percents(Object.fromEntries(proposal.values.map((v) => [v.member_id, v.value])), proposal.values.map((v) => v.member_id));
    payload = { title: '来年の負担率の案', body: `${budgetYear}年は ${proposal.values.map((v) => `${nick(v.member_id)} ${pc.get(v.member_id)}%`).join('・')} です。予算の編集画面で確定してください。`, url: `#/budget/${budgetYear}`, tag: 'ratio-proposal' };
  }
  let delivered = 0;
  for (const sub of subscriptions.filter((s) => admins.has(s.member_id))) {
    try {
      const status = await sendPush(sub, payload, vapid, subject);
      if (status >= 200 && status < 300) delivered += 1;
      else console.error(`Push to ${sub.id} failed: HTTP ${status}`);
    } catch (e) {
      console.error(`Push to ${sub.id} failed: ${e.message}`);
    }
  }
  console.log(`Notified ${delivered} administrator device(s).`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
}
