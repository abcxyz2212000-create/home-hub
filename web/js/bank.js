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

// Monthly import reminder: from `day` of the month, until both imports were done this month.
// importedAt: { mf, bank } ISO timestamps (or null). Returns the missing kinds, e.g. ['マネーフォワードの明細'].
export const REMIND_DAY = 5;
export function missingImports(today, importedAt, day = REMIND_DAY) {
  if (Number(today.slice(8, 10)) < day) return [];
  const monthStart = `${today.slice(0, 7)}-01`;
  const done = (at) => Boolean(at) && toJstDate(at) >= monthStart;
  return [
    done(importedAt.mf) ? null : 'マネーフォワードの明細',
    done(importedAt.bank) ? null : '銀行の残高',
  ].filter(Boolean);
}

function toJstDate(iso) {
  return new Date(new Date(iso).getTime() + 9 * 3600000).toISOString().slice(0, 10);
}

export const DEFAULT_LOW_BALANCE = 100000;
