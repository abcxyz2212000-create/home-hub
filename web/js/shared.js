// Shared account deposits (共用口座の入金管理). Pure functions shared by the app and the daily job.
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
  return rule.start_ym <= ym && (!rule.end_ym || ym <= rule.end_ym)
    && (!rule.month_of_year || Number(ym.slice(5)) === rule.month_of_year);
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

// ---------------------------------------------------------------- contracts paid from a personal account
//
// A contract marked "shared cost" (共通の費用) and paid from a personal account is deducted from the
// account holder's monthly amount. The app keeps one recurring rule per contract (contract_id) so
// that the history stays correct when the contract changes.

// The deduction a contract implies now: { target: { member_id, label, amount, month_of_year } } or
// { target: null, reason } (reason is shown to the user, in Japanese).
// ctx: { accounts, cards, sharedAccountId }
export function contractDeduction(contract, ctx) {
  if (!contract.shared_cost) return { target: null, reason: null };
  if (contract.status === 'closed') return { target: null, reason: '解約済みのため差し引きません。' };
  if (!(contract.amount > 0)) return { target: null, reason: '金額が未入力のため差し引けません。' };
  const card = contract.pay_card_id ? ctx.cards.find((c) => c.id === contract.pay_card_id) : null;
  const accountId = card ? card.debit_account_id : contract.pay_account_id;
  const account = accountId ? ctx.accounts.find((a) => a.id === accountId) : null;
  if (!account) return { target: null, reason: card ? 'カードの引き落とし口座が未設定のため差し引けません。' : '支払元の口座が未設定のため差し引けません。' };
  if (account.id === ctx.sharedAccountId) return { target: null, reason: '共用口座から払うため、差し引きはありません。' };
  if (!account.holder_id) return { target: null, reason: `支払元の口座「${account.name}」に名義人がないため差し引けません。` };
  let month = null;
  if (contract.cycle === 'yearly') {
    if (!contract.renewal_date) return { target: null, reason: '年払いは、払う月を決めるために更新日を入力してください。' };
    month = Number(contract.renewal_date.slice(5, 7));
  }
  return { target: { member_id: account.holder_id, label: contract.name.slice(0, 50), amount: -contract.amount, month_of_year: month } };
}

// What to change in the rules linked to one contract so that from month `ym` on they match `target`
// (null = no deduction). Past months are never changed: rules are ended at the previous month, and
// only rules that start this month or later are removed.
// Returns { end: [{ id, end_ym }], remove: [id], update: [{ id, label }], create: [rule] }.
export function planRuleSync(contractId, target, rules, ym) {
  const plan = { end: [], remove: [], update: [], create: [] };
  const active = rules.filter((r) => r.contract_id === contractId && (!r.end_ym || r.end_ym >= ym))
    .sort((a, b) => b.start_ym.localeCompare(a.start_ym));
  const same = (r) => target && r.member_id === target.member_id && r.amount === target.amount
    && (r.month_of_year || null) === (target.month_of_year || null);
  const keep = active.find(same);
  for (const r of active) {
    if (r === keep) continue;
    if (r.start_ym >= ym) plan.remove.push(r.id);
    else plan.end.push({ id: r.id, end_ym: ymAdd(ym, -1) });
  }
  if (keep) {
    if (keep.end_ym) plan.end.push({ id: keep.id, end_ym: null });
    if (keep.label !== target.label) plan.update.push({ id: keep.id, label: target.label });
  } else if (target) {
    plan.create.push({ ...target, contract_id: contractId, start_ym: ym });
  }
  return plan;
}

export function ruleSchedule(rule) {
  const period = `${ymLabel(rule.start_ym)}〜${rule.end_ym ? ymLabel(rule.end_ym) : ''}`;
  return rule.month_of_year ? `毎年${rule.month_of_year}月・${period}` : period;
}
