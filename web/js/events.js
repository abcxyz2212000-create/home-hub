// Deadline events and fixed-cost calculation.
// Pure functions without DOM access: shared by the web app and scripts/notify.mjs.
// Dates are 'YYYY-MM-DD' strings in Japan time; "day numbers" are days since 1970-01-01.

export const EVENT_TYPES = {
  card_expiry: { label: 'カード有効期限', ledger: 'cards', defaults: [30], purpose: '新カードの登録先を更新しましょう' },
  annual_fee: { label: '年会費の発生月', ledger: 'cards', defaults: [30], purpose: '継続か解約かを判断しましょう' },
  contract_renewal: { label: '契約の自動更新日', ledger: 'contracts', defaults: [30, 7], purpose: '継続か解約かを判断しましょう' },
  warranty: { label: '保証期限', ledger: 'items', defaults: [30], purpose: '不具合があれば期間内に修理を依頼しましょう' },
};

// Upcoming list on the home screen: from 30 days ago to 60 days ahead.
export const UPCOMING_PAST_DAYS = 30;
export const UPCOMING_AHEAD_DAYS = 60;

const DAY_MS = 86400000;
const JST_OFFSET_MS = 9 * 3600000;

export function toDayNumber(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = Date.UTC(y, mo - 1, d);
  const check = new Date(t);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return t / DAY_MS;
}

export function fromDayNumber(n) {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

export function todayJST(now = new Date()) {
  return fromDayNumber(Math.floor((now.getTime() + JST_OFFSET_MS) / DAY_MS));
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// 'YYYY-MM' -> last day of that month (cards are valid until the end of the month).
export function cardExpiryDate(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(ym || '');
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return `${y}-${pad2(mo)}-${pad2(last)}`;
}

// Next first-day-of-month for the annual fee month (1-12), today or later.
export function nextAnnualFeeDate(month, today) {
  const mo = Number(month);
  if (!Number.isInteger(mo) || mo < 1 || mo > 12) return null;
  const y = Number(today.slice(0, 4));
  const thisYear = `${y}-${pad2(mo)}-01`;
  return toDayNumber(thisYear) >= toDayNumber(today) ? thisYear : `${y + 1}-${pad2(mo)}-01`;
}

// Notification timing (days before) for one record and event type.
export function resolveOffsets(record, type) {
  const override = record && record.notify_days ? record.notify_days[type] : undefined;
  const list = Array.isArray(override) ? override : EVENT_TYPES[type].defaults;
  return [...new Set(list.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 365))].sort((a, b) => b - a);
}

// All deadline events of active records. data: { cards, contracts, items }.
export function collectEvents(data, today) {
  const events = [];
  const todayN = toDayNumber(today);
  const push = (type, record, date) => {
    const n = toDayNumber(date);
    if (n === null) return;
    events.push({
      type,
      label: EVENT_TYPES[type].label,
      ledger: EVENT_TYPES[type].ledger,
      id: record.id,
      name: record.name,
      date,
      daysLeft: n - todayN,
      offsets: resolveOffsets(record, type),
    });
  };
  for (const c of data.cards || []) {
    if (c.status === 'closed') continue;
    if (c.expiry_ym) push('card_expiry', c, cardExpiryDate(c.expiry_ym));
    if (c.annual_fee_month && c.annual_fee !== 0) push('annual_fee', c, nextAnnualFeeDate(c.annual_fee_month, today));
  }
  for (const k of data.contracts || []) {
    if (k.status === 'closed') continue;
    if (k.auto_renew && k.renewal_date) push('contract_renewal', k, k.renewal_date);
  }
  for (const it of data.items || []) {
    if (it.status === 'closed') continue;
    if (it.warranty_until) push('warranty', it, it.warranty_until);
  }
  return events.sort((a, b) => a.daysLeft - b.daysLeft || a.name.localeCompare(b.name, 'ja'));
}

export function upcomingEvents(events) {
  return events.filter((e) => e.daysLeft >= -UPCOMING_PAST_DAYS && e.daysLeft <= Math.max(UPCOMING_AHEAD_DAYS, ...e.offsets));
}

// Notifications that should be sent today. Each event is notified once per stage
// (stage = the smallest configured offset that has been reached). A missed day is
// caught up on the next run because the check is "reached", not "exactly today".
export function dueNotifications(events) {
  const due = [];
  for (const e of events) {
    if (e.daysLeft < 0) continue;
    const reached = e.offsets.filter((o) => e.daysLeft <= o);
    if (reached.length === 0) continue;
    const stage = Math.min(...reached);
    due.push({ event: e, stage, key: `${e.type}:${e.id}:${e.date}:${stage}` });
  }
  return due;
}

export function notificationText(e) {
  const when = e.daysLeft === 0 ? '今日' : `あと${e.daysLeft}日`;
  return {
    title: `${e.label}: ${e.name}`,
    body: `${when}（${e.date}）。${EVENT_TYPES[e.type].purpose}`,
  };
}

// Monthly cost of one contract in yen (yearly contracts are divided by 12).
export function monthlyCost(contract) {
  if (!contract || contract.status === 'closed') return 0;
  const amount = Number(contract.amount);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return contract.cycle === 'yearly' ? amount / 12 : amount;
}

export function monthlyTotal(contracts) {
  return Math.round((contracts || []).reduce((sum, c) => sum + monthlyCost(c), 0));
}
