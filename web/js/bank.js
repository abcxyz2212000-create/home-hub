// Bank statement CSV (楽天銀行 取引明細: 取引日, 入出金(円), 取引後残高(円), 入出金内容) -> the balance at the end
// of each day. Only balances are kept: the lines themselves come from MoneyForward. Pure functions.

export const BANK_HEADERS = ['取引日', '入出金(円)', '取引後残高(円)'];
const MAX_ROWS = 10000;

// rows: parsed CSV (first row = header). Returns { balances: [{ date, balance }], errors }.
export function parseBankRows(rows) {
  const header = (rows[0] || []).map((h) => String(h).trim().replace(/（/g, '(').replace(/）/g, ')'));
  const col = Object.fromEntries(BANK_HEADERS.map((h) => [h, header.indexOf(h)]));
  const missing = BANK_HEADERS.filter((h) => col[h] < 0);
  if (missing.length) return { balances: [], errors: [`銀行の取引明細のCSVではないようです（見つからない列: ${missing.join('、')}）。`] };
  const body = rows.slice(1).filter((r) => r.some((c) => String(c).trim() !== ''));
  if (body.length > MAX_ROWS) return { balances: [], errors: [`行が多すぎます（${MAX_ROWS}行まで）。`] };
  const errors = [];
  const byDate = new Map(); // the last line of a day wins (the file lists lines in order)
  body.forEach((r, i) => {
    const line = i + 2;
    const d = /^(\d{4})[/-]?(\d{2})[/-]?(\d{2})$/.exec(String(r[col['取引日']] ?? '').trim());
    const balance = Number(String(r[col['取引後残高(円)']] ?? '').replace(/[,，\s]/g, ''));
    if (!d) errors.push(`${line}行目: 取引日を読めません。`);
    else if (!Number.isInteger(balance) || Math.abs(balance) > 10000000000) errors.push(`${line}行目: 取引後残高を読めません。`);
    else byDate.set(`${d[1]}-${d[2]}-${d[3]}`, balance);
  });
  const balances = [...byDate].map(([date, balance]) => ({ date, balance })).sort((a, b) => a.date.localeCompare(b.date));
  return { balances, errors };
}

// Balance at the end of each month (the last known day of the month): [{ ym, balance, date }].
export function monthEndBalances(balances) {
  const out = new Map();
  for (const b of [...balances].sort((x, y) => x.date.localeCompare(y.date))) out.set(b.date.slice(0, 7), { ym: b.date.slice(0, 7), balance: b.balance, date: b.date });
  return [...out.values()];
}

export function latestBalance(balances) {
  return balances.length ? [...balances].sort((a, b) => b.date.localeCompare(a.date))[0] : null;
}

// Monthly import reminder (2026-11-08): from `day` of the month, until both imports were done this month.
// An import after the end of a month brings all of that month, so "done this month" means last month is in.
// importedAt: { mf, bank } ISO timestamps (or null), as given by lastImports(). Returns the missing kinds:
// [{ key: 'mf' | 'bank', label, last }] with `last` the date (Japan time) of the previous import, or null.
export const REMIND_DAY = 5;
const IMPORT_KINDS = [
  { key: 'mf', label: 'マネーフォワードの明細', short: 'マネーフォワード' },
  { key: 'bank', label: '銀行の残高', short: '銀行' },
];
export function missingImports(today, importedAt, day = REMIND_DAY) {
  if (Number(today.slice(8, 10)) < day) return [];
  const monthStart = `${today.slice(0, 7)}-01`;
  return IMPORT_KINDS
    .map((k) => ({ ...k, last: importedAt[k.key] ? toJstDate(importedAt[k.key]) : null }))
    .filter((k) => !k.last || k.last < monthStart);
}

// The report of last month (2026-11-19): ready when both imports were done this month (an import after a
// month's end brings all of it), or anyway from `day` with the numbers marked as not final.
// Returns [] (not yet) or [{ period: 'YYYY-MM', partial }], in January also { period: 'YYYY', partial }.
export const REPORT_LATEST_DAY = 10;
export function reportsDue(today, importedAt, day = REPORT_LATEST_DAY) {
  const monthStart = `${today.slice(0, 7)}-01`;
  const done = (at) => Boolean(at) && toJstDate(at) >= monthStart;
  const complete = done(importedAt.mf) && done(importedAt.bank);
  if (!complete && Number(today.slice(8, 10)) < day) return [];
  const [y, m] = today.slice(0, 7).split('-').map(Number);
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  const out = [{ period: prev, partial: !complete }];
  if (m === 1) out.push({ period: String(y - 1), partial: !complete });
  return out;
}

// The last import of each kind: the later of the time saved by the import screen and the newest row
// (its created_at), so an import still counts when saving that time failed.
// settings: { mf_imported_at, bank_imported_at }; newest: { mf, bank } created_at of the newest rows.
export function lastImports(settings, newest) {
  return {
    mf: latestTime(settings.mf_imported_at, newest.mf),
    bank: latestTime(settings.bank_imported_at, newest.bank),
  };
}

function latestTime(...values) {
  const ok = values.filter((v) => typeof v === 'string' && Number.isFinite(Date.parse(v)));
  return ok.length ? ok.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a)) : null;
}

function toJstDate(iso) {
  return new Date(Date.parse(iso) + 9 * 3600000).toISOString().slice(0, 10);
}

export const DEFAULT_LOW_BALANCE = 100000;
