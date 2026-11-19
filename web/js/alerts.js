// Wording of alerts, shared by the app screen and the push notifications (2026-11-03).
// The title is fixed for each kind; names, amounts, dates and what to do go in the body.

export function yenText(n) {
  return `${n < 0 ? '−' : ''}${Math.abs(Math.round(n)).toLocaleString('ja-JP')}円`;
}

// 100000 -> 10万円, 105000 -> 105,000円
export function roundYenText(n) {
  return n > 0 && n % 10000 === 0 ? `${(n / 10000).toLocaleString('ja-JP')}万円` : yenText(n);
}

// 'YYYY-MM-DD' -> 'M/D' in the same year as today, 'YYYY/M/D' otherwise
export function shortDate(iso, today) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return String(iso || '');
  const md = `${Number(m[2])}/${Number(m[3])}`;
  return today && today.slice(0, 4) === m[1] ? md : `${m[1]}/${md}`;
}

export function lowBalanceAlert(last, threshold, today) {
  return {
    title: '共用口座の残高不足',
    body: `残高 ${yenText(last.balance)}（${shortDate(last.date, today)}時点）。目安の${roundYenText(threshold)}を下回っています。`,
  };
}

// missing: from missingImports(); today: YYYY-MM-DD (Japan time)
export function importAlert(missing, today) {
  const month = Number(today.slice(5, 7)) === 1 ? 12 : Number(today.slice(5, 7)) - 1;
  const when = (k) => (k.last ? shortDate(k.last, today) : 'なし');
  const last = missing.length === 1
    ? `前回の取り込み ${when(missing[0])}`
    : `前回の取り込み：${missing.map((k) => `${k.short} ${when(k)}`).join('、')}`;
  return { title: '明細の取り込み', body: `${month}月分の${missing.map((k) => k.label).join('・')}がまだ取り込まれていません（${last}）。` };
}

export function choresAlert(names) {
  const shown = names.slice(0, 3).join('、') + (names.length > 3 ? ` ほか${names.length - 3}件` : '');
  return { title: '今日の家事', body: `${names.length}件：${shown}` };
}

// c: contribution(st)
export function householdAlert(ym, c) {
  return {
    title: '今月の家計費',
    body: `${Number(ym.slice(5))}月は残り ${yenText(c.remaining)}（今月分 ${yenText(c.burden)}・支払済 ${yenText(c.done)}）。`,
  };
}

// Changes of the budget, the ratios or the records that the person has not confirmed (every day until they do).
export function confirmAlert(count) {
  return { title: '承認・確認待ち', body: `あなたの返事を待っているものが${count}件あります。「承認・確認」で内容を見て返事をしてください。` };
}

// The daily question of a chore done for its price (one tap: はい / いいえ).
export function choreAskAlert(name) {
  return { title: '今日の家事', body: `今日「${name}」をやりますか？押して「はい」か「いいえ」を選んでください。` };
}

// The monthly / yearly report is ready (period 'YYYY-MM' or 'YYYY'; partial: the imports were not done).
export function reportAlert(period, partial) {
  const isYear = period.length === 4;
  const what = isYear ? `${Number(period)}年` : `${Number(period.slice(5))}月`;
  return {
    title: isYear ? '年間レポート' : '月間レポート',
    body: `${what}のレポートができました。家計費と各人の負担・支払いを確認してください。${partial ? '（明細の取り込みがまだなので、数字は途中です）' : ''}`,
  };
}

