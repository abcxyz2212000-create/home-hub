// MoneyForward ME CSV (入出金 / 家計簿データ) -> transactions of the shared account.
// Pure functions shared by the app and the tests. User-facing messages are in Japanese.

import { priceAt } from './prices.js';

export const MF_HEADERS = ['計算対象', '日付', '内容', '金額（円）', '保有金融機関', '大項目', '中項目', 'メモ', '振替', 'ID'];
export const MAX_MF_ROWS = 5000;

const DATE_RE = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/;

// rows: parsed CSV (first row = header). Returns { items, errors }.
export function parseMfRows(rows) {
  const errors = [];
  const items = [];
  const header = (rows[0] || []).map((h) => String(h).trim());
  const col = Object.fromEntries(MF_HEADERS.map((h) => [h, header.indexOf(h)]));
  const missing = MF_HEADERS.filter((h) => col[h] < 0);
  if (missing.length) return { items, errors: [`マネーフォワードの入出金のCSVではないようです（見つからない列: ${missing.join('、')}）。`] };
  const body = rows.slice(1).filter((r) => r.some((c) => String(c).trim() !== ''));
  if (body.length > MAX_MF_ROWS) return { items, errors: [`行が多すぎます（${MAX_MF_ROWS}行まで）。期間を分けて書き出してください。`] };
  const seen = new Set();
  body.forEach((r, i) => {
    const line = i + 2;
    const get = (h) => String(r[col[h]] ?? '').trim();
    const d = DATE_RE.exec(get('日付'));
    const amount = Number(get('金額（円）').replace(/,/g, ''));
    const id = get('ID');
    if (!d) errors.push(`${line}行目: 日付「${get('日付')}」を読めません。`);
    else if (!Number.isInteger(amount) || Math.abs(amount) > 1000000000) errors.push(`${line}行目: 金額「${get('金額（円）')}」を読めません。`);
    else if (!id || id.length > 100) errors.push(`${line}行目: ID がありません。`);
    else if (seen.has(id)) errors.push(`${line}行目: 同じ ID の行がファイル内に2回あります。`);
    else {
      seen.add(id);
      items.push({
        mf_id: id,
        date: `${d[1]}-${d[2].padStart(2, '0')}-${d[3].padStart(2, '0')}`,
        description: get('内容').slice(0, 500),
        amount,
        institution: get('保有金融機関').slice(0, 100),
        category: get('大項目').slice(0, 50) || null,
        subcategory: get('中項目').slice(0, 50) || null,
        memo: get('メモ').slice(0, 1000) || null,
        counted: get('計算対象') !== '0',
        transfer: get('振替') === '1',
      });
    }
  });
  return { items, errors };
}

// Rows typed in by hand in MoneyForward without a wallet have "なし" as 保有金融機関. In this
// household they record costs someone paid personally (立替), which are managed in the shared
// account ledger instead, so they are never imported (decided 2026-11-01).
export const MF_MANUAL_INSTITUTION = 'なし';

// Keep only the shared account and the cards paid from it (matched by their MoneyForward name).
// ctx: { accounts, cards, sharedAccountId }.
// Returns { inScope, skipped (other institutions), manual (hand-typed rows), unknown: [institution names] }.
export function classifyMf(items, ctx) {
  const norm = (s) => normalizeText(s);
  const shared = ctx.accounts.find((a) => a.id === ctx.sharedAccountId);
  const byName = new Map();
  if (shared && shared.mf_name) byName.set(norm(shared.mf_name), { account_id: shared.id, card_id: null });
  for (const c of ctx.cards) {
    if (c.mf_name && c.debit_account_id && c.debit_account_id === ctx.sharedAccountId) byName.set(norm(c.mf_name), { account_id: null, card_id: c.id });
  }
  const known = new Set([...ctx.accounts, ...ctx.cards].filter((x) => x.mf_name).map((x) => norm(x.mf_name)));
  const inScope = [];
  const unknown = new Set();
  let skipped = 0;
  let manual = 0;
  for (const it of items) {
    if (norm(it.institution) === norm(MF_MANUAL_INSTITUTION) || norm(it.institution) === '') {
      manual += 1;
      continue;
    }
    const hit = byName.get(norm(it.institution));
    if (hit) inScope.push({ ...it, ...hit });
    else {
      skipped += 1;
      if (!known.has(norm(it.institution))) unknown.add(it.institution);
    }
  }
  return { inScope, skipped, manual, unknown: [...unknown] };
}

// Full-width -> half-width, lower case, no spaces: ＪＣＢ / jcb / "中部 電力" all match.
export function normalizeText(s) {
  return String(s ?? '').normalize('NFKC').toLowerCase().replace(/[\s　]+/g, '');
}

export function keywordsOf(contract) {
  return String(contract.match_keywords || '').split(/[,、，\n]+/).map((k) => normalizeText(k)).filter((k) => k.length >= 2);
}

// The contract whose keyword appears in the description (the longest keyword wins). null if none.
export function matchContract(description, contracts) {
  const text = normalizeText(description);
  let best = null;
  let bestLen = 0;
  for (const c of contracts) {
    for (const k of keywordsOf(c)) {
      if (k.length > bestLen && text.includes(k)) {
        best = c.id;
        bestLen = k.length;
      }
    }
  }
  return best;
}

// Totals of one month. Only counted, non-transfer rows are added up.
// txs: transactions of the month. Returns { inflow, outflow, byContract: Map(id -> actual outflow),
// byCategory: Map(大項目 -> outflow), unlinked: [tx], excluded: [tx], personal: [tx] (個人負担, not added up),
// review: [tx] (確認中; still added up as shared until decided) }.
export function summarizeMonth(txs, members = []) {
  const out = { inflow: 0, outflow: 0, byContract: new Map(), byCategory: new Map(), unlinked: [], excluded: [], personal: [], review: [], memberFlows: [] };
  for (const t of txs) {
    if (!t.counted || t.transfer) {
      out.excluded.push(t);
      continue;
    }
    // money between a member and the shared account is not an outside payment (shown separately)
    if (t.deposit_entry_id || transferMember(t, members)) {
      out.memberFlows.push(t);
      continue;
    }
    // owed by one person (個人負担): not a shared cost, shown and settled separately
    if (t.personal_member_id) {
      out.personal.push(t);
      continue;
    }
    if (t.needs_review) out.review.push(t);
    if (t.amount > 0) {
      out.inflow += t.amount;
      continue;
    }
    const v = -t.amount;
    out.outflow += v;
    if (t.contract_id) out.byContract.set(t.contract_id, (out.byContract.get(t.contract_id) || 0) + v);
    else {
      out.unlinked.push(t);
      const k = t.category || '未分類';
      out.byCategory.set(k, (out.byCategory.get(k) || 0) + v);
    }
  }
  return out;
}

// Planned amount of a contract in a month: monthly = amount, yearly = amount in the renewal month.
export function plannedInMonth(contract, ym) {
  if (contract.status === 'closed') return 0;
  const amount = priceAt(contract, ym);
  if (!(amount > 0)) return 0;
  if (contract.cycle === 'yearly') return contract.renewal_date && contract.renewal_date.slice(5, 7) === ym.slice(5) ? amount : 0;
  return amount;
}

// Total a person owes for statement lines marked as theirs (expenses positive, refunds negative).
export function personalTotal(txs) {
  return txs.reduce((n, t) => n - t.amount, 0);
}

// Text kept in the one-off charge that settles personal lines (at most 2000 characters).
export function settlementMemo(txs) {
  const lines = txs.map((t) => `${t.date.replace(/-/g, '/')} ${t.description.slice(0, 40)} ${(-t.amount).toLocaleString('ja-JP')}円`);
  const text = lines.join('\n');
  return text.length <= 2000 ? text : `${text.slice(0, 1990)}\n…ほか`;
}

// ---------------------------------------------------------------- deposits recognised from the statement
//
// From DEPOSIT_AUTO_FROM on, money paid into the shared account by a member (the line's text contains
// one of the member's 振込名義) is recorded as that member's deposit. Earlier deposits were moved from
// the former spreadsheet and are kept as they are (their months differ from the bank dates).
export const DEPOSIT_AUTO_FROM = '2026-01';

export function transferNamesOf(member) {
  return String(member.transfer_names || '').split(/[,、，\n]+/).map((k) => normalizeText(k)).filter((k) => k.length >= 2);
}

// The part of a bank line that names the other party: "(依頼人名:…)" names the sender (often one of
// us paying a bill from the shared account), so it is left out.
export function payeeText(description) {
  return String(description || '').replace(/[(（]\s*依頼人名[:：].*$/, '');
}

// The member on the other side of a shared-account line (paid in, or paid out to them), or null.
// The longest matching 振込名義 wins.
export function transferMember(tx, members) {
  if (!tx.amount || !tx.account_id || tx.transfer) return null;
  const text = normalizeText(payeeText(tx.description));
  let best = null;
  let bestLen = 0;
  for (const m of members) {
    for (const n of transferNamesOf(m)) {
      if (n.length > bestLen && text.includes(n)) {
        best = m.id;
        bestLen = n.length;
      }
    }
  }
  return best;
}

// Paid into the shared account by a member (kept for callers that only want deposits).
export function depositMember(tx, members) {
  return tx.amount > 0 ? transferMember(tx, members) : null;
}

// Lines that should become records in the shared account ledger: [{ tx, member_id }]
// (paid in -> deposit, paid out to the member -> a one-off charge: they received money).
export function depositCandidates(txs, members, from = DEPOSIT_AUTO_FROM) {
  const out = [];
  for (const tx of txs) {
    if (tx.deposit_entry_id || tx.deposit_ignored || tx.date.slice(0, 7) < from) continue;
    const memberId = transferMember(tx, members);
    if (memberId) out.push({ tx, member_id: memberId });
  }
  return out;
}

export function depositEntryFor({ tx, member_id }) {
  if (tx.amount < 0) {
    return {
      member_id,
      ym: tx.date.slice(0, 7),
      kind: 'charge',
      label: '共用口座からの受け取り',
      amount: -tx.amount,
      memo: `マネーフォワードの明細から自動（${tx.date.replace(/-/g, '/')} ${payeeText(tx.description).slice(0, 60)}）`,
    };
  }
  return {
    member_id,
    ym: tx.date.slice(0, 7),
    kind: 'deposit',
    label: '入金',
    amount: tx.amount,
    memo: `マネーフォワードの明細から自動（${tx.date.replace(/-/g, '/')} ${tx.description.slice(0, 60)}）`,
  };
}
