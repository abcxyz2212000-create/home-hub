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

export function importAlert(missing) {
  return { title: '明細の取り込み', body: `今月の${missing.join('・')}がまだです。取り込んでください。` };
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
  return { title: '確認待ちの変更', body: `予算・負担率・入金や立替の記録の変更が${count}件、まだ確認されていません。お知らせで内容を見て「確認しました」を押してください。` };
}
