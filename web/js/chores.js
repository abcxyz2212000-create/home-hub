// Household chores: workload (same formulas as the former spreadsheet) and "due today".
// Pure functions without DOM access: shared by the web app and scripts/notify.mjs.
import { toDayNumber } from './events.js';

export const CATEGORIES = ['衣', '食', '住', '事務'];
export const GROUPS = ['企画', '運用', '保守'];
export const CYCLES = {
  day: { label: '日', perMonth: 30 },
  week: { label: '週', perMonth: 4 },
  month: { label: '月', perMonth: 1 },
  year: { label: '年', perMonth: 1 / 12 },
  adhoc: { label: '随時', perMonth: 0 },
};
export const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
export const POINTS_PER_HOUR = 1000;

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

// Times per cycle: the number of chosen days when a schedule exists, otherwise the entered number.
export function timesPerCycle(c) {
  const schedule = Array.isArray(c.schedule) ? c.schedule : [];
  if (['week', 'month', 'year'].includes(c.cycle) && schedule.length > 0) return schedule.length;
  return num(c.times) || 0;
}

// Hours per month = minutes × times × (day 30 / week 4 / month 1 / year 1/12) ÷ 60. Ad hoc chores have none.
export function monthlyHours(c) {
  if (c.cycle === 'adhoc') return null;
  const cycle = CYCLES[c.cycle];
  if (!cycle) return 0;
  return ((num(c.minutes) || 0) * timesPerCycle(c) * cycle.perMonth) / 60;
}

// Points per month before / after the adjustment factor (ad hoc: the entered points).
export function basePoints(c) {
  if (c.cycle === 'adhoc') return num(c.points_override) || 0;
  return monthlyHours(c) * POINTS_PER_HOUR;
}

export function adjustedPoints(c) {
  return basePoints(c) * (num(c.adjust) || 1);
}

// Who shares an "all" chore: members assigned to at least one active chore, otherwise every active member.
export function choreSharers(chores, members) {
  const active = members.filter((m) => m.active);
  const assigned = new Set(chores.filter((c) => c.status !== 'closed' && c.assignee_type === 'member' && c.assignee_id).map((c) => c.assignee_id));
  const sharers = active.filter((m) => assigned.has(m.id));
  return sharers.length > 0 ? sharers : active;
}

// Workload per member. "all" chores are split equally among the sharers; "tbd" (and chores whose
// assignee is missing) go to a separate bucket.
export function workload(chores, members) {
  const sharers = choreSharers(chores, members);
  const rows = new Map(sharers.map((m) => [m.id, { member: m, hours: 0, points: 0, count: 0, byCategory: {} }]));
  const tbd = { hours: 0, points: 0, count: 0 };
  const add = (row, c, share) => {
    const p = adjustedPoints(c) * share;
    row.points += p;
    row.hours += (monthlyHours(c) || 0) * share;
    row.count += share;
    if (row.byCategory) row.byCategory[c.category || '未分類'] = (row.byCategory[c.category || '未分類'] || 0) + p;
  };
  for (const c of chores) {
    if (c.status === 'closed') continue;
    if (c.assignee_type === 'all' && sharers.length > 0) {
      for (const m of sharers) add(rows.get(m.id), c, 1 / sharers.length);
    } else if (c.assignee_type === 'member' && c.assignee_id) {
      let row = rows.get(c.assignee_id);
      if (!row) {
        const m = members.find((x) => x.id === c.assignee_id);
        if (!m) { add(tbd, c, 1); continue; }
        row = { member: m, hours: 0, points: 0, count: 0, byCategory: {} };
        rows.set(m.id, row);
      }
      add(row, c, 1);
    } else {
      add(tbd, c, 1);
    }
  }
  return { rows: [...rows.values()], tbd };
}

function lastDayOfMonth(iso) {
  const [y, m] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// Is the chore scheduled on this date ('YYYY-MM-DD', Japan time)? Chores without days are never "due".
export function isDueOn(c, iso) {
  if (c.status === 'closed' || toDayNumber(iso) === null) return false;
  const schedule = Array.isArray(c.schedule) ? c.schedule.map(Number) : [];
  const [, month, day] = iso.split('-').map(Number);
  switch (c.cycle) {
    case 'day':
      return true;
    case 'week':
      return schedule.includes(new Date(`${iso}T00:00:00Z`).getUTCDay());
    case 'month': {
      const last = lastDayOfMonth(iso);
      // a day that does not exist this month (e.g. 31 in November) falls on the last day
      return schedule.includes(day) || (day === last && schedule.some((d) => d > last));
    }
    case 'year':
      return day === 1 && schedule.includes(month);
    default:
      return false;
  }
}

// Chores due today for one member: their own chores and the "all" chores.
export function dueFor(chores, iso, memberId) {
  return chores.filter((c) => isDueOn(c, iso) && (c.assignee_type === 'all' || (c.assignee_type === 'member' && c.assignee_id === memberId)));
}

export function scheduleText(c) {
  const schedule = Array.isArray(c.schedule) ? [...c.schedule].map(Number).sort((a, b) => a - b) : [];
  if (c.cycle === 'adhoc') return '随時';
  if (c.cycle === 'day') return `毎日${timesPerCycle(c) > 1 ? ` ${timesPerCycle(c)}回` : ''}`;
  if (schedule.length === 0) return `${CYCLES[c.cycle].label}${timesPerCycle(c)}回（やる日は未設定）`;
  if (c.cycle === 'week') return `毎週 ${schedule.map((d) => WEEKDAYS[d]).join('・')}`;
  if (c.cycle === 'month') return `毎月 ${schedule.map((d) => `${d}日`).join('・')}`;
  return `毎年 ${schedule.map((m) => `${m}月`).join('・')}（1日にお知らせ）`;
}
