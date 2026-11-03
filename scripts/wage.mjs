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

async function fromTable(statsDataId, surveyYear, appId, opts = {}) {
  const meta = await estat('getMetaInfo', { statsDataId }, appId);
  const { fixed, usedYear } = chooseClasses(metaClasses(meta), surveyYear, opts);
  const data = await estat('getStatsData', { statsDataId, metaGetFlg: 'Y', cntGetFlg: 'N', ...narrowParams(fixed) }, appId);
  return { rows: parseEstat(data, usedYear), usedYear };
}

const text = (v) => (v && typeof v === 'object' ? v.$ || '' : String(v || ''));

// Tables of one survey year that may hold the wages by sex and age group (best first).
export function candidateTables(listJson) {
  const data = listJson && listJson.GET_STATS_LIST;
  if (!data || Number(data.RESULT && data.RESULT.STATUS) !== 0) return [];
  const tables = [].concat((data.DATALIST_INF && data.DATALIST_INF.TABLE_INF) || []);
  const score = (t) => {
    const all = `${text(t.STATISTICS_NAME)} ${text(t.TITLE)} ${text(t.TITLE_SPEC && t.TITLE_SPEC.TABLE_NAME)}`;
    if (!/年齢/.test(all) || /短時間|都道府県|職種|学歴別|勤続|経験/.test(all)) return -1;
    let n = 0;
    if (/一般労働者/.test(all)) n += 4;
    if (/産業計/.test(all)) n += 2;
    if (/企業規模/.test(all)) n += 1;
    if (/所定内給与額/.test(all)) n += 1;
    return n;
  };
  return tables.map((t) => ({ id: t['@id'], title: text(t.TITLE).slice(0, 80), name: text(t.STATISTICS_NAME).slice(0, 80), s: score(t) }))
    .filter((t) => t.s >= 0).sort((a, b) => b.s - a.s);
}

// Wage table of one survey year: { rows: [{ sex, ageClass, value }], usedYear, source: { id, title }, notes }.
// 1. the database of all years, 2. the year's own tables, 3. the latest earlier year of the database
// (the database is updated late; the year used is kept with the proposal and shown).
export async function fetchWages(surveyYear, appId, statsDataId = ESTAT_STATS_DATA_ID) {
  const notes = [];
  const DB = { id: statsDataId, title: '一般_都道府県別_年齢階級別DB' };
  try {
    return { ...(await fromTable(statsDataId, surveyYear, appId)), source: DB, notes };
  } catch (e) {
    if (/HTTP|status/.test(e.message)) throw e;
    notes.push(`DB: ${e.message}`);
  }
  const list = await estat('getStatsList', { statsCode: '00450091', surveyYears: String(surveyYear), searchWord: '年齢階級' }, appId);
  const found = [].concat((list && list.GET_STATS_LIST && list.GET_STATS_LIST.DATALIST_INF && list.GET_STATS_LIST.DATALIST_INF.TABLE_INF) || []);
  const cands = candidateTables(list).slice(0, 6);
  notes.push(`search: ${found.length} table(s), ${cands.length} candidate(s)`);
  for (const t of cands) {
    try {
      return { ...(await fromTable(t.id, surveyYear, appId)), source: { id: t.id, title: `${t.name} ${t.title}`.trim() }, notes };
    } catch (e) {
      notes.push(`${t.id}: ${e.message}`);
    }
  }
  const earlier = await fromTable(statsDataId, surveyYear, appId, { orEarlier: true });
  notes.push(`used ${earlier.usedYear} instead of ${surveyYear}`);
  return { ...earlier, source: DB, notes };
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
    const { rows, source, usedYear, notes } = await fetchWages(surveyYear, env('ESTAT_APP_ID'));
    proposal = { ...buildProposal({ budgetYear, members: people, table: rows, usedYear }), source, notes: notes.join(' / ').slice(0, 1000) };
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
