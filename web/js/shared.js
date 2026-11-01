// Shared account deposits (共通口座の入金管理). Pure functions shared by the app and the daily job.
//
// For each member and month:
//   charges  = recurring rules active in that month + one-off charges (minus = a shared cost the
//              member paid personally)
//   total    = carry (unpaid amount from the previous month) + charges
//   balance  = total - deposits  -> carried over to the next month
// This is the same as the former spreadsheet (前月繰越 → 合計 → 入金).

export const YM_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function ymAdd(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}

export function ymLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return `${y}年${m}月`;
}

export function ruleApplies(rule, ym) {
  return rule.start_ym <= ym && (!rule.end_ym || ym <= rule.end_ym);
}

// Order of rows in a month: positive rules first (基本), then the larger offsets (家賃 before dアニ).
function ruleOrder(a, b) {
  return (b.amount > 0) - (a.amount > 0) || Math.abs(b.amount) - Math.abs(a.amount) || a.label.localeCompare(b.label, 'ja');
}

// Members that take part: anyone with a rule or an entry.
export function participantIds(rules, entries) {
  return [...new Set([...rules.map((r) => r.member_id), ...entries.map((e) => e.member_id)])];
}

// First month with any data (null when nothing is recorded).
export function firstYM(rules, entries) {
  const all = [...rules.map((r) => r.start_ym), ...entries.map((e) => e.ym)].filter((v) => YM_RE.test(v));
  return all.length ? all.sort()[0] : null;
}

function monthParts(rules, entries, memberId, ym) {
  const items = rules.filter((r) => r.member_id === memberId && ruleApplies(r, ym)).sort(ruleOrder)
    .map((r) => ({ label: r.label, amount: r.amount, rule: r }));
  const mine = entries.filter((e) => e.member_id === memberId && e.ym === ym)
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
  for (const e of mine.filter((x) => x.kind === 'charge')) items.push({ label: e.label, amount: e.amount, entry: e });
  const deposits = mine.filter((x) => x.kind === 'deposit');
  return {
    items,
    deposits,
    charges: items.reduce((s, i) => s + i.amount, 0),
    deposit: deposits.reduce((s, d) => s + d.amount, 0),
  };
}

// Month-by-month history of one member from the first recorded month up to `toYM`.
// Returns [{ ym, carry, charges, total, deposit, balance }].
export function history(rules, entries, memberId, toYM) {
  const start = firstYM(rules.filter((r) => r.member_id === memberId), entries.filter((e) => e.member_id === memberId));
  const out = [];
  if (!start || start > toYM) return out;
  let carry = 0;
  for (let ym = start; ym <= toYM; ym = ymAdd(ym, 1)) {
    const p = monthParts(rules, entries, memberId, ym);
    const total = carry + p.charges;
    const balance = total - p.deposit;
    out.push({ ym, carry, charges: p.charges, total, deposit: p.deposit, balance });
    carry = balance;
  }
  return out;
}

// The statement of one member for one month (the column of the former spreadsheet).
export function statement(rules, entries, memberId, ym) {
  const prev = history(rules, entries, memberId, ymAdd(ym, -1));
  const carry = prev.length ? prev[prev.length - 1].balance : 0;
  const p = monthParts(rules, entries, memberId, ym);
  const total = carry + p.charges;
  return { ym, carry, items: p.items, deposits: p.deposits, charges: p.charges, total, deposit: p.deposit, balance: total - p.deposit };
}
