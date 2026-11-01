// Contract amounts by period (金額の履歴). contracts.price_history: [{ amount, from, to }] with months
// 'YYYY-MM' (from null = since the beginning, to null = still current). An empty history means the
// contract's current amount applies to every month (contracts registered before 2026-11-01).
import { ymAdd } from './shared.js';

export function sortedHistory(history) {
  return [...(Array.isArray(history) ? history : [])].sort((a, b) => String(a.from || '').localeCompare(String(b.from || '')));
}

// Amount of the contract in month ym (0 when no period covers it).
export function priceAt(contract, ym) {
  const h = sortedHistory(contract.price_history);
  if (h.length === 0) return contract.amount || 0;
  const hit = h.find((p) => (!p.from || p.from <= ym) && (!p.to || ym <= p.to));
  return hit ? hit.amount : 0;
}

// New history after changing the amount from month `from` on: the period running then ends the month
// before, later periods are dropped, and the new amount runs open-ended.
export function applyPriceChange(history, currentAmount, newAmount, from) {
  let h = sortedHistory(history);
  if (h.length === 0) h = currentAmount ? [{ amount: currentAmount, from: null, to: null }] : [];
  const before = ymAdd(from, -1);
  h = h.filter((p) => !p.from || p.from < from)
    .map((p) => (!p.to || p.to >= from ? { ...p, to: before } : p));
  h.push({ amount: newAmount, from, to: null });
  return h;
}

export function periodText(p) {
  const f = (ym) => `${ym.slice(0, 4)}年${Number(ym.slice(5))}月`;
  return `${p.from ? f(p.from) : '最初'}〜${p.to ? f(p.to) : ''}`;
}
