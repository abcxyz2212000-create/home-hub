// Yearly reminder (1 December): the ratio of next year's budget comes from the wage statistics
// (厚生労働省 賃金構造基本統計調査, Y-2), entered by hand on the budget screen. This tells the
// administrators what to look up: each person's sex and age group. Runs on GitHub Actions
// (.github/workflows/wage.yml), also by hand.
//
// Environment variables:
//   SUPABASE_SERVICE_ROLE_KEY  (secret) Supabase secret key / service_role key
//   VAPID_PRIVATE_KEY          (secret) to send the notification
//   SUPABASE_URL               optional, defaults to web/js/config.js
//   BUDGET_YEAR                optional, defaults to next year (Japan time)
//
// Logs of a public repository are public: names and ages are never printed.
import { CONFIG } from '../web/js/config.js';
import { todayJST } from '../web/js/events.js';
import { participantIds } from '../web/js/shared.js';
import { surveyYearFor, reiwa, lookups, lookupText } from '../web/js/wage.js';
import { loadVapidKeys, sendPush } from './webpush.mjs';

function env(name, required = true) {
  const v = (process.env[name] || '').trim();
  if (required && !v) throw new Error(`missing environment variable ${name}`);
  return v;
}

async function select(baseUrl, key, table, query = '') {
  const headers = { apikey: key };
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(`${baseUrl}/rest/v1/${table}?select=*${query}`, { headers });
  if (!res.ok) throw new Error(`Supabase GET ${table} failed: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

// The text of the reminder (Japanese), from the people who put money in.
export function reminderText(budgetYear, people) {
  const survey = surveyYearFor(budgetYear);
  const { items, problems } = lookups(people, budgetYear);
  const nick = (id) => (people.find((m) => m.id === id) || {}).nickname || '';
  const what = items.map((it) => `${nick(it.member_id)} ${lookupText(survey, it).replace(`${reiwa(survey)} `, '')}`).join('・');
  return {
    title: '来年の負担率の確認',
    body: `${budgetYear}年の予算の負担率を決めてください。${reiwa(survey)}の賃金統計で${what ? ` ${what} ` : ''}の賃金を見て、予算の編集画面に入れます。${problems.join('')}`,
    url: `#/budget/${budgetYear}`,
    tag: 'ratio-reminder',
  };
}

async function main() {
  const baseUrl = env('SUPABASE_URL', false) || CONFIG.supabaseUrl;
  if (!/^https:\/\/[^/]+$/.test(baseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(baseUrl)) throw new Error('Supabase URL is not configured (web/js/config.js)');
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  const yearText = env('BUDGET_YEAR', false);
  const budgetYear = yearText ? Number(yearText) : Number(todayJST().slice(0, 4)) + 1;
  if (!Number.isInteger(budgetYear) || budgetYear < 2020 || budgetYear > 2100) throw new Error('BUDGET_YEAR must be a year');
  const [members, rules, entries, subscriptions] = await Promise.all([
    select(baseUrl, key, 'members', '&active=eq.true'),
    select(baseUrl, key, 'shared_rules'),
    select(baseUrl, key, 'shared_entries'),
    select(baseUrl, key, 'push_subscriptions'),
  ]);
  const ids = participantIds(rules, entries);
  const payload = reminderText(budgetYear, members.filter((m) => ids.includes(m.id)));
  const vapid = loadVapidKeys(env('VAPID_PRIVATE_KEY'));
  const repo = env('GITHUB_REPOSITORY', false);
  const subject = repo ? `https://${repo.split('/')[0].toLowerCase()}.github.io/${repo.split('/')[1]}/` : 'mailto:noreply@example.com';
  const admins = new Set(members.filter((m) => m.role === 'admin').map((m) => m.id));
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
  console.log(`Budget ${budgetYear}: reminder delivered to ${delivered} administrator device(s).`);
  if (delivered === 0) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
}
