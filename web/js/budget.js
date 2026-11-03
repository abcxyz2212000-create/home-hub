// Budget and actual (予実管理, 2026-11-03). Pure functions: shared by the screen and the tests.
//
// A year's budget: a monthly amount for each 費目 (MoneyForward's 大項目), a monthly savings target and
// the ratio of the two people. What each person puts in a month (今月分) is proposed from it:
// (spending budget + savings target) × the person's share.
// The actual spending of a month is the household's: the shared account's statement (by 大項目) and
// what people paid for the household from their own money (立替, by the 大項目 chosen for its label).
import { transferMember } from './mf.js';
import { statement, contribution } from './shared.js';

// MoneyForward's 大項目 for spending, in its own order.
export const MF_CATEGORIES = ['食費', '日用品', '趣味・娯楽', '交際費', '交通費', '衣服・美容', '健康・医療', '自動車', '教養・教育',
  '特別な支出', '現金・カード', '水道・光熱費', '通信費', '住宅', '税・社会保障', '保険', 'その他', '未分類'];

// The 大項目 a contract's 種類 most likely belongs to (used until a label is given its own).
export const CONTRACT_KIND_CATEGORY = { 光熱: '水道・光熱費', 通信: '通信費', 保険: '保険', サブスク: '趣味・娯楽', 住居: '住宅', 車: '自動車', 教育: '教養・教育', その他: 'その他' };

export const MAX_BUDGET = 100000000;

// Shares of the people: ratio { memberId: weight } -> Map(memberId -> fraction). People without a weight
// get none; with no weights at all, everyone gets the same.
export function shares(ratio, memberIds) {
  const w = memberIds.map((id) => {
    const v = Number(ratio && ratio[id]);
    return [id, Number.isFinite(v) && v > 0 ? v : 0];
  });
  const total = w.reduce((n, [, v]) => n + v, 0);
  if (total <= 0) return new Map(memberIds.map((id) => [id, memberIds.length ? 1 / memberIds.length : 0]));
  return new Map(w.map(([id, v]) => [id, v / total]));
}

// Whole percentages that add up to 100 (largest remainder): 294.6 : 258.1 -> 53 : 47.
export function percents(ratio, memberIds) {
  const s = shares(ratio, memberIds);
  const raw = memberIds.map((id) => ({ id, v: s.get(id) * 100 }));
  const out = new Map(raw.map((r) => [r.id, Math.floor(r.v)]));
  let rest = 100 - [...out.values()].reduce((n, v) => n + v, 0);
  if (memberIds.length === 0) return out;
  for (const r of [...raw].sort((a, b) => (b.v - Math.floor(b.v)) - (a.v - Math.floor(a.v)))) {
    if (rest <= 0) break;
    out.set(r.id, out.get(r.id) + 1);
    rest -= 1;
  }
  return out;
}

export function budgetTotal(rows) {
  return rows.reduce((n, r) => n + (Number(r.monthly) || 0), 0);
}

// Monthly income of the year (what the two put in together). Set as income_monthly; years saved before
// it existed have spending + savings target.
export function incomeOf(rows, year) {
  const v = year ? Number(year.income_monthly) : NaN;
  if (year && year.income_monthly !== null && year.income_monthly !== undefined && Number.isFinite(v)) return v;
  return budgetTotal(rows) + (Number(year && year.savings_monthly) || 0);
}

// 今月分 of each person: income x share. Savings = income - spending budget (a result, not set).
// { spending, savings, total (= income), perMember: Map(id -> yen) }. Amounts are rounded to 100円; the
// rounding difference goes to the person with the largest share.
export function proposal(rows, year, memberIds) {
  const spending = budgetTotal(rows);
  const total = incomeOf(rows, year);
  const savings = total - spending;
  const s = shares(year && year.ratio, memberIds);
  const perMember = new Map(memberIds.map((id) => [id, Math.round((total * s.get(id)) / 100) * 100]));
  const diff = total - [...perMember.values()].reduce((n, v) => n + v, 0);
  if (diff !== 0 && memberIds.length) {
    const top = [...memberIds].sort((a, b) => s.get(b) - s.get(a))[0];
    perMember.set(top, perMember.get(top) + diff);
  }
  return { spending, savings, total, perMember };
}

// The rule that holds a person's base amount in month ym: a positive recurring rule not tied to a
// contract (基本 first, otherwise the largest). null if there is none.
export function baseRule(rules, memberId, ym) {
  const list = rules.filter((r) => r.member_id === memberId && !r.contract_id && r.amount > 0 && !r.month_of_year
    && r.start_ym <= ym && (!r.end_ym || r.end_ym >= ym));
  return list.find((r) => r.label === '基本') || list.sort((a, b) => b.amount - a.amount)[0] || null;
}

// How to change a person's base amount from month `from` on without touching past months:
// { end: { id, end_ym } | null, update: { id, amount } | null, create: rule | null }.
// A later base rule (a later year's budget) is kept: the new rule ends the month before it.
export function planBaseChange(rules, memberId, from, amount, prevYM) {
  const r = baseRule(rules, memberId, from);
  if (r && r.amount === amount) return { end: null, update: null, create: null };
  if (r && r.start_ym >= from) return { end: null, update: { id: r.id, amount }, create: null };
  const later = rules.filter((x) => x.member_id === memberId && !x.contract_id && x.amount > 0 && !x.month_of_year && x.start_ym > from)
    .sort((a, b) => a.start_ym.localeCompare(b.start_ym))[0];
  const endBefore = later ? monthBefore(later.start_ym) : null;
  const create = { member_id: memberId, label: r ? r.label : '基本', amount, start_ym: from, end_ym: endBefore || (r ? r.end_ym || null : null) };
  return { end: r ? { id: r.id, end_ym: prevYM } : null, update: null, create };
}

function monthBefore(ym) {
  const [y, m] = ym.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

// First month the budget of `year` changes the base amounts when saved in month `current`: base amounts
// change only at the start of a year, so a coming year's budget applies from its January and the
// budget of this year or a past year changes nothing (null).
export function applyFrom(year, current) {
  return Number(year) > Number(current.slice(0, 4)) ? `${year}-01` : null;
}

// 大項目 of one 立替 line (an item of a statement). mapping (setting budget_category_of):
// 'contract:<id>' -> 大項目 for 立替 from a contract, '<費目>' -> 大項目 for the others.
// A contract without its own falls back to its 費目 label, then to its 種類.
export function advanceCategory(item, mapping, contracts) {
  const m = mapping || {};
  const contractId = item.rule && item.rule.contract_id;
  if (contractId && m[`contract:${contractId}`]) return m[`contract:${contractId}`];
  if (m[item.label]) return m[item.label];
  const c = contractId ? contracts.find((x) => x.id === contractId) : null;
  if (c && CONTRACT_KIND_CATEGORY[c.category]) return CONTRACT_KIND_CATEGORY[c.category];
  return '未分類';
}

// Actual of one month. txs: the shared account's lines of the month; shared: { rules, entries };
// memberIds: the people who put money in; mapping: { label: 大項目 }.
// Returns { spending: Map(大項目 -> yen), fromAccount, fromAdvance, spendingTotal, income, advances: [{ member_id, label, category, amount }] }.
export function monthActual({ txs, shared, members, memberIds, mapping, contracts, ym }) {
  const spending = new Map();
  const add = (k, v) => spending.set(k, (spending.get(k) || 0) + v);
  let fromAccount = 0;
  for (const t of txs || []) {
    if (!t.counted || t.transfer) continue;
    if (t.deposit_entry_id || transferMember(t, members)) continue; // money of the people, not spending
    if (t.personal_member_id) continue; // one person's own purchase, settled separately
    if (t.category === '収入') continue; // interest and other income: not spending (as in the former spreadsheet)
    const v = -t.amount; // refunds lower the spending of their 大項目
    add(t.category || '未分類', v);
    fromAccount += v;
  }
  let fromAdvance = 0;
  let income = 0;
  const advances = [];
  for (const id of memberIds) {
    const c = contribution(statement(shared.rules, shared.entries, id, ym));
    income += c.done;
    for (const it of [...c.regular, ...c.temp]) {
      const category = advanceCategory(it, mapping, contracts);
      add(category, -it.amount);
      fromAdvance += -it.amount;
      advances.push({ member_id: id, label: it.label, category, amount: -it.amount });
    }
  }
  return { spending, fromAccount, fromAdvance, spendingTotal: fromAccount + fromAdvance, income, advances };
}

// Rows of the budget table: every 大項目 with a budget or an actual, in MoneyForward's order.
// Returns [{ category, budget, actual, diff (actual - budget), memo }].
export function compareRows(budgetRows, actualMap, months = 1) {
  const byCat = new Map(budgetRows.map((r) => [r.category, r]));
  const cats = [...new Set([...budgetRows.map((r) => r.category), ...actualMap.keys()])];
  const order = (c) => (MF_CATEGORIES.includes(c) ? MF_CATEGORIES.indexOf(c) : MF_CATEGORIES.length);
  return cats.sort((a, b) => order(a) - order(b) || a.localeCompare(b, 'ja')).map((category) => {
    const r = byCat.get(category);
    const budget = (r ? Number(r.monthly) || 0 : 0) * months;
    const actual = actualMap.get(category) || 0;
    return { category, budget, actual, diff: actual - budget, memo: r ? r.memo || '' : '' };
  }).filter((r) => r.budget !== 0 || r.actual !== 0);
}

// ---------------------------------------------------------------- per-category ratios (2026-11-03)
//
// A year can give some 費目 a ratio of their own (e.g. 電気代 70:30 because one person uses more). The
// shared account pays such a line as usual; each person's 今月分 is then corrected by
// line × (the category's ratio − the year's ratio), so the two corrections add up to 0.
// A row of budget_years.category_ratios: { category, subcategory|null, ratio: { memberId: percent }, from: 'YYYY-MM' }.
// Rows apply from their month `from` on, so setting one never changes past months.

const YM_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

// The row of a year that covers one statement line in month ym: a row for its 小項目 first, then one
// for its whole 大項目. null if none.
export function categoryRatioFor(rows, line, ym) {
  const live = (rows || []).filter((r) => r && r.category === line.category && (!r.from || r.from <= ym));
  return live.find((r) => r.subcategory && r.subcategory === line.subcategory) || live.find((r) => !r.subcategory) || null;
}

// What a category row is called on the screens: its 小項目, otherwise its 大項目.
export function categoryRatioName(row) {
  return row.subcategory || row.category;
}

// Check the rows typed in the budget editor. Returns an error in Japanese, or null.
export function categoryRatiosError(rows, memberIds) {
  const seen = new Set();
  for (const r of rows) {
    if (!MF_CATEGORIES.includes(r.category)) return '費目ごとの負担率：大項目を選んでください。';
    if (r.subcategory && String(r.subcategory).length > 50) return '費目ごとの負担率：小項目は50文字以内で入力してください。';
    const key = `${r.category}/${r.subcategory || ''}`;
    if (seen.has(key)) return `費目ごとの負担率：「${categoryRatioName(r)}」が2回あります。`;
    seen.add(key);
    const v = memberIds.map((id) => Number(r.ratio && r.ratio[id]));
    if (v.some((x) => !Number.isInteger(x) || x < 0 || x > 100)) return `費目ごとの負担率：「${categoryRatioName(r)}」の率は0〜100の整数で入力してください。`;
    if (v.reduce((n, x) => n + x, 0) !== 100) return `費目ごとの負担率：「${categoryRatioName(r)}」の率は合計100にしてください。`;
    if (r.from && !YM_RE.test(r.from)) return '費目ごとの負担率：開始月が正しくありません。';
  }
  return null;
}

// The corrections of every month as entries of kind 'adjust' (not stored: worked out from the lines).
// txs: statement lines ({ date, amount, category, subcategory, counted, transfer, ... });
// years: budget_years rows. Returns [{ member_id, ym, kind: 'adjust', label, amount, virtual: true }].
export function categoryAdjustments({ txs, years, members, memberIds }) {
  const byYear = new Map((years || []).map((y) => [String(y.year), y]));
  const sums = new Map(); // `${ym}|${name}` -> { ym, name, raw: Map(id -> yen) }
  for (const t of txs || []) {
    if (!t.counted || t.transfer || t.deposit_entry_id || t.personal_member_id || t.category === '収入') continue;
    if (transferMember(t, members || [])) continue;
    const ym = String(t.date).slice(0, 7);
    const year = byYear.get(ym.slice(0, 4));
    if (!year || !Array.isArray(year.category_ratios) || year.category_ratios.length === 0) continue;
    const row = categoryRatioFor(year.category_ratios, t, ym);
    if (!row) continue;
    const common = percents(year.ratio, memberIds);
    const name = categoryRatioName(row);
    const key = `${ym}|${name}`;
    if (!sums.has(key)) sums.set(key, { ym, name, raw: new Map(memberIds.map((id) => [id, 0])) });
    const s = sums.get(key);
    for (const id of memberIds) s.raw.set(id, s.raw.get(id) + (-t.amount * ((Number(row.ratio[id]) || 0) - common.get(id))) / 100);
  }
  const out = [];
  for (const { ym, name, raw } of sums.values()) {
    const amounts = new Map(memberIds.map((id) => [id, Math.round(raw.get(id))]));
    const diff = -[...amounts.values()].reduce((n, v) => n + v, 0); // keep the sum at 0
    if (diff !== 0 && memberIds.length) {
      const top = [...memberIds].sort((a, b) => Math.abs(raw.get(b)) - Math.abs(raw.get(a)))[0];
      amounts.set(top, amounts.get(top) + diff);
    }
    for (const id of memberIds) {
      if (amounts.get(id) !== 0) out.push({ member_id: id, ym, kind: 'adjust', label: `費目ごとの調整（${name}）`.slice(0, 50), amount: amounts.get(id), virtual: true });
    }
  }
  return out.sort((a, b) => a.ym.localeCompare(b.ym));
}

// The first month any per-category ratio applies (to know which statement lines to load), or null.
export function categoryRatiosStart(years) {
  const froms = [];
  for (const y of years || []) {
    for (const r of Array.isArray(y.category_ratios) ? y.category_ratios : []) froms.push(r.from && r.from > `${y.year}-01` ? r.from : `${y.year}-01`);
  }
  return froms.length ? froms.sort()[0] : null;
}

// The 大項目 that have a per-category ratio in any year (to load only their statement lines).
export function categoryRatioCategories(years) {
  const out = new Set();
  for (const y of years || []) for (const r of Array.isArray(y.category_ratios) ? y.category_ratios : []) if (r && r.category) out.add(r.category);
  return [...out];
}

// PostgREST filter for the statement lines needed for the corrections, or null when there are none.
export function categoryRatioQuery(years) {
  const start = categoryRatiosStart(years);
  const cats = categoryRatioCategories(years);
  if (!start || cats.length === 0) return null;
  return `date=gte.${start}-01&category=in.(${cats.map((c) => `"${encodeURIComponent(c)}"`).join(',')})`;
}
