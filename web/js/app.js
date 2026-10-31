// 家の管理ハブ: single page app (vanilla JS, hash routing).
import * as db from './supabase.js';
import { AppError } from './supabase.js';
import { LEDGERS, LEDGER_ORDER, optionPairs, optionLabel } from './schema.js';
import { EVENT_TYPES, collectEvents, upcomingEvents, monthlyCost, monthlyTotal, todayJST, toDayNumber } from './events.js';
import {
  parseField, parseTags, validateLinks, parseLinksCell, linksCell, parseNotifyDays, notifyDaysText, findCardNumberLike, safeUrl,
  parseMembers, MAX_MEMBERS, MAX_MEMBER_LENGTH,
} from './validate.js';
import { parseCSV, toCSV, decodeCSVBytes, unescapeFormula } from './csv.js';
import { createZip } from './zip.js';
import { compressImage } from './image.js';
import * as push from './push.js';

const FREE_DB_BYTES = 500 * 1024 * 1024;
const FREE_STORAGE_BYTES = 1024 * 1024 * 1024;
const BACKUP_REMIND_DAYS = 30;
const MAX_PHOTOS_PER_ITEM = 20;
const MAX_IMPORT_ROWS = 2000;
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

const DEFAULT_SHORTCUTS = [
  { label: 'マネーフォワード ME', url: 'https://moneyforward.com/' },
  { label: 'Amazon', url: 'https://www.amazon.co.jp/' },
  { label: 'Amazon 注文履歴', url: 'https://www.amazon.co.jp/gp/css/order-history' },
  { label: 'Google パスワードマネージャー', url: 'https://passwords.google.com/' },
];

const state = {
  loaded: false,
  data: { accounts: [], cards: [], contracts: [], items: [], memberships: [] },
  photos: [],
  settings: {},
};
const photoUrls = new Map();

// ---------------------------------------------------------------- DOM helpers

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'multiple' || k === 'required') el[k] = Boolean(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

function extLink(url, text) {
  const safe = safeUrl(url);
  if (!safe) return h('span', {}, text || url);
  return h('a', { href: safe, target: '_blank', rel: 'noopener noreferrer' }, text || safe);
}

function view() {
  return document.getElementById('view');
}

function setView(title, ...nodes) {
  document.title = title ? `${title} | 家の管理ハブ` : '家の管理ハブ';
  const root = view();
  root.replaceChildren(...nodes.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false));
  window.scrollTo(0, 0);
}

function toast(message, kind = 'info') {
  const box = document.getElementById('toast');
  const item = h('div', { class: `toast toast-${kind}`, role: kind === 'error' ? 'alert' : 'status' }, message);
  box.append(item);
  setTimeout(() => item.remove(), kind === 'error' ? 8000 : 4000);
}

function handleError(e) {
  if (e instanceof AppError) {
    console.error(e.detail || e.message);
    toast(e.message, 'error');
  } else {
    console.error(e);
    toast('予期しないエラーが発生しました。画面を再読み込みしてください。', 'error');
  }
}

// Run an async action with the button disabled; errors become toasts.
async function busy(button, fn) {
  if (button) button.disabled = true;
  try {
    return await fn();
  } catch (e) {
    handleError(e);
    return undefined;
  } finally {
    if (button) button.disabled = false;
  }
}

function yen(n) {
  return `${Math.round(n).toLocaleString('ja-JP')}円`;
}

function formatBytes(n) {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(0, Math.round(n / 1024))} KB`;
}

function download(name, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function byName(a, b) {
  return a.name.localeCompare(b.name, 'ja');
}

// Family names registered on the settings screen (holder drop-down). Empty = free text.
function registeredMembers() {
  const m = state.settings.members;
  return Array.isArray(m) ? m.filter((x) => typeof x === 'string') : [];
}

function find(ledger, id) {
  return state.data[ledger].find((r) => r.id === id) || null;
}

function recordLink(ledger, record) {
  if (!record) return h('span', { class: 'muted' }, '（削除済み）');
  return h('a', { href: `#/view/${ledger}/${record.id}` }, record.name, record.status === 'closed' ? '（解約済み）' : '');
}

// ---------------------------------------------------------------- data loading

async function loadAll() {
  const [accounts, cards, contracts, items, memberships, photos, settings] = await Promise.all([
    db.selectAll('accounts'),
    db.selectAll('cards'),
    db.selectAll('contracts'),
    db.selectAll('items'),
    db.selectAll('memberships'),
    db.selectAll('item_photos', 'created_at.asc'),
    db.selectAll('settings', 'key.asc'),
  ]);
  state.data = { accounts, cards, contracts, items, memberships };
  state.photos = photos;
  state.settings = Object.fromEntries(settings.map((s) => [s.key, s.value]));
  state.loaded = true;
}

async function reloadLedger(ledger) {
  state.data[ledger] = await db.selectAll(ledger);
}

async function saveSetting(key, value) {
  await db.upsertRows('settings', [{ key, value }], 'key');
  state.settings[key] = value;
}

function resetState() {
  state.loaded = false;
  state.data = { accounts: [], cards: [], contracts: [], items: [], memberships: [] };
  state.photos = [];
  state.settings = {};
  for (const url of photoUrls.values()) URL.revokeObjectURL(url);
  photoUrls.clear();
}

// ---------------------------------------------------------------- routing

function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  return { page: parts[0] || 'home', a: parts[1], b: parts[2] };
}

function setNav(page) {
  for (const a of document.querySelectorAll('#nav a')) {
    const target = a.dataset.page;
    const active = target === page || (target === 'ledgers' && ['list', 'view', 'edit'].includes(page));
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

async function render() {
  const nav = document.getElementById('nav');
  if (!db.isConfigured()) {
    nav.hidden = true;
    renderSetupNeeded();
    return;
  }
  if (!db.isSignedIn()) {
    nav.hidden = true;
    renderLogin();
    return;
  }
  nav.hidden = false;
  if (!state.loaded) {
    setView('', h('p', { class: 'muted' }, '読み込み中…'));
    try {
      await loadAll();
    } catch (e) {
      handleError(e);
      if (!db.isSignedIn()) return render();
      setView('エラー', h('section', { class: 'card' }, h('p', {}, 'データを読み込めませんでした。'),
        h('button', { type: 'button', onclick: () => render() }, '再読み込み')));
      return;
    }
  }
  const { page, a, b } = route();
  setNav(page);
  if (page === 'home') renderHome();
  else if (page === 'ledgers') renderLedgers();
  else if (page === 'list' && LEDGERS[a]) renderList(a);
  else if (page === 'view' && LEDGERS[a]) renderView(a, b);
  else if (page === 'edit' && LEDGERS[a]) renderEdit(a, b);
  else if (page === 'settings') renderSettings();
  else location.hash = '#/';
}

// ---------------------------------------------------------------- setup / login

function renderSetupNeeded() {
  setView('初期設定', h('section', { class: 'card' },
    h('h1', {}, '初期設定が必要です'),
    h('p', {}, 'web/js/config.js に Supabase の URL と公開キーを設定してください。'),
    h('p', { class: 'muted' }, '手順は docs/setup.md を参照してください。')));
}

function renderLogin() {
  const email = h('input', { type: 'email', id: 'login-email', autocomplete: 'username', required: true });
  const password = h('input', { type: 'password', id: 'login-password', autocomplete: 'current-password', required: true });
  const error = h('p', { class: 'error', role: 'alert' });
  const submit = h('button', { type: 'submit', class: 'primary' }, 'ログイン');
  const form = h('form', {
    class: 'card login',
    onsubmit: async (ev) => {
      ev.preventDefault();
      error.textContent = '';
      if (!email.value.trim() || !password.value) {
        error.textContent = 'メールアドレスとパスワードを入力してください。';
        return;
      }
      submit.disabled = true;
      try {
        await db.signIn(email.value.trim(), password.value);
        password.value = '';
        resetState();
        location.hash = '#/';
        await render();
      } catch (e) {
        console.error(e.detail || e);
        error.textContent = e instanceof AppError ? e.message : 'ログインに失敗しました。';
      } finally {
        submit.disabled = false;
      }
    },
  },
  h('h1', {}, '家の管理ハブ'),
  h('label', { for: 'login-email' }, 'メールアドレス'), email,
  h('label', { for: 'login-password' }, 'パスワード'), password,
  error, submit,
  h('p', { class: 'muted small' }, '2人で共通のアカウントでログインします。新規登録はできません。'));
  setView('ログイン', form);
}

// ---------------------------------------------------------------- home

function eventBadge(e) {
  if (e.daysLeft < 0) return h('span', { class: 'badge badge-past' }, `${-e.daysLeft}日前に過ぎました`);
  if (e.daysLeft === 0) return h('span', { class: 'badge badge-soon' }, '今日');
  return h('span', { class: `badge ${e.daysLeft <= 7 ? 'badge-soon' : ''}` }, `あと${e.daysLeft}日`);
}

function eventList(events) {
  if (events.length === 0) return h('p', { class: 'muted' }, '近い予定はありません。');
  return h('ul', { class: 'events' }, events.map((e) => h('li', {},
    eventBadge(e),
    h('div', {},
      h('div', {}, h('a', { href: `#/view/${e.ledger}/${e.id}` }, e.name)),
      h('div', { class: 'muted small' }, `${e.label}・${e.date}`)))));
}

function bankShortcuts() {
  return state.data.accounts
    .filter((a) => a.status !== 'closed' && a.links && a.links.length > 0)
    .map((a) => {
      const link = a.links.find((l) => /ログイン/.test(l.label)) || a.links[0];
      return { label: a.institution || a.name, url: link.url };
    })
    .filter((v, i, list) => list.findIndex((x) => x.url === v.url) === i);
}

function backupReminder() {
  const total = LEDGER_ORDER.reduce((n, k) => n + state.data[k].length, 0);
  if (total === 0) return null;
  const last = state.settings.last_backup_at;
  const days = last ? Math.floor((Date.now() - Date.parse(last)) / 86400000) : null;
  if (days !== null && days < BACKUP_REMIND_DAYS) return null;
  return h('section', { class: 'card notice' },
    h('p', {}, days === null ? 'まだバックアップしていません。' : `最後のバックアップから${days}日たっています。`),
    h('a', { href: '#/settings', class: 'button' }, '設定画面でバックアップする'));
}

function renderHome() {
  const today = todayJST();
  const events = upcomingEvents(collectEvents(state.data, today));
  const active = state.data.contracts.filter((c) => c.status !== 'closed' && monthlyCost(c) > 0);
  const byCategory = new Map();
  for (const c of active) byCategory.set(c.category || '未分類', (byCategory.get(c.category || '未分類') || 0) + monthlyCost(c));
  const shortcuts = [...(state.settings.shortcuts || DEFAULT_SHORTCUTS), ...bankShortcuts()];
  const pushHint = h('div');

  setView('ホーム',
    backupReminder(),
    pushHint,
    h('section', { class: 'card' }, h('h2', {}, '期限が近い予定'), eventList(events)),
    h('section', { class: 'card' },
      h('h2', {}, '固定費の月額合計'),
      h('p', { class: 'hero' }, yen(monthlyTotal(state.data.contracts))),
      active.length === 0
        ? h('p', { class: 'muted' }, '金額が入力された契約はまだありません。')
        : h('table', { class: 'table' },
          h('thead', {}, h('tr', {}, h('th', {}, '種類'), h('th', { class: 'num' }, '月額'))),
          h('tbody', {}, [...byCategory.entries()].sort((x, y) => y[1] - x[1]).map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', { class: 'num' }, yen(v)))))),
      h('p', { class: 'muted small' }, '年払いの契約は12で割った月額で計算しています。解約済みは含みません。')),
    h('section', { class: 'card' },
      h('h2', {}, 'ショートカット'),
      h('div', { class: 'shortcuts' }, shortcuts.map((s) => extLink(s.url, s.label))),
      h('p', { class: 'muted small' }, '銀行のリンクは口座台帳の「関連リンク」から表示します。その他は設定画面で変更できます。')));

  push.currentSubscription().then((sub) => {
    if (!sub && push.pushSupported()) {
      pushHint.replaceChildren(h('section', { class: 'card notice' },
        h('p', {}, 'この端末ではまだ通知を受け取る設定をしていません。'),
        h('a', { href: '#/settings', class: 'button' }, '通知を設定する')));
    }
  }).catch((e) => console.error(`push status check failed: ${e.message}`));
}

// ---------------------------------------------------------------- ledgers / list

function renderLedgers() {
  setView('台帳', h('h1', {}, '台帳'), h('div', { class: 'ledger-grid' }, LEDGER_ORDER.map((k) => {
    const rows = state.data[k];
    const active = rows.filter((r) => r.status !== 'closed').length;
    return h('a', { class: 'card ledger-tile', href: `#/list/${k}` },
      h('strong', {}, LEDGERS[k].label),
      h('span', { class: 'muted small' }, `利用中 ${active}件 / 全${rows.length}件`));
  })));
}

function searchText(record) {
  return Object.values(record).flatMap((v) => (Array.isArray(v) ? v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : x)) : [v]))
    .filter((v) => typeof v === 'string').join(' ').toLowerCase();
}

function summaryLine(ledger, r) {
  return LEDGERS[ledger].summary(r).filter(Boolean).join('・');
}

function renderList(ledger) {
  const def = LEDGERS[ledger];
  const q = h('input', { type: 'search', placeholder: '名前・メモ・タグで検索', 'aria-label': '検索' });
  const status = h('select', { 'aria-label': '状態で絞り込み' },
    h('option', { value: 'active' }, '利用中のみ'), h('option', { value: 'all' }, 'すべて'), h('option', { value: 'closed' }, '解約済みのみ'));
  const list = h('div', { class: 'list' });
  const update = () => {
    const words = q.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const rows = state.data[ledger].filter((r) => (status.value === 'all' || (status.value === 'closed') === (r.status === 'closed'))
      && words.every((w) => searchText(r).includes(w)));
    list.replaceChildren(...(rows.length === 0 ? [h('p', { class: 'muted' }, '該当するデータはありません。')] : rows.map((r) => h('a', { class: 'list-item', href: `#/view/${ledger}/${r.id}` },
      h('div', { class: 'list-title' }, r.name, r.status === 'closed' ? h('span', { class: 'badge badge-past' }, '解約済み') : null),
      h('div', { class: 'muted small' }, summaryLine(ledger, r)),
      r.tags && r.tags.length ? h('div', { class: 'tags' }, r.tags.map((t) => h('span', { class: 'tag' }, t))) : null))));
  };
  q.addEventListener('input', update);
  status.addEventListener('change', update);
  update();
  setView(def.label,
    h('div', { class: 'title-row' }, h('h1', {}, def.label), h('a', { class: 'button primary', href: `#/edit/${ledger}/new` }, '＋ 追加')),
    h('div', { class: 'filters' }, q, status),
    list);
}

// ---------------------------------------------------------------- detail view

function paymentNodes(contract) {
  if (contract.pay_card_id) {
    const card = find('cards', contract.pay_card_id);
    const account = card && card.debit_account_id ? find('accounts', card.debit_account_id) : null;
    return ['カード: ', recordLink('cards', card), account ? ['（引き落とし口座: ', recordLink('accounts', account), '）'] : null];
  }
  if (contract.pay_account_id) return ['口座: ', recordLink('accounts', find('accounts', contract.pay_account_id))];
  return null;
}

function fieldValueNodes(field, r) {
  const v = r[field.key];
  switch (field.type) {
    case 'bool': return v ? 'はい' : 'いいえ';
    case 'ref': return v ? recordLink(field.ref, find(field.ref, v)) : null;
    case 'payment': return paymentNodes(r);
    case 'links': return v && v.length ? h('ul', { class: 'links' }, v.map((l) => h('li', {}, extLink(l.url, l.label)))) : null;
    case 'tags': return v && v.length ? h('div', { class: 'tags' }, v.map((t) => h('span', { class: 'tag' }, t))) : null;
    case 'url': return v ? extLink(v) : null;
    case 'int': return v === null || v === undefined ? null : field.key.includes('fee') || field.key === 'amount' ? yen(v) : String(v);
    case 'select':
    case 'status': return v ? optionLabel(field, v) : null;
    case 'day': return v ? (v === 31 ? '末日' : `${v}日`) : null;
    case 'monthnum': return v ? `${v}月` : null;
    default: return v === null || v === undefined || v === '' ? null : String(v);
  }
}

function relationSection(title, ledger, rows) {
  return h('section', { class: 'card' }, h('h2', {}, title),
    rows.length === 0 ? h('p', { class: 'muted' }, 'ありません。') : h('ul', { class: 'links' }, rows.sort(byName).map((r) => h('li', {}, recordLink(ledger, r), h('span', { class: 'muted small' }, ` ${summaryLine(ledger, r)}`)))));
}

function relations(ledger, r) {
  const d = state.data;
  if (ledger === 'accounts') {
    const cards = d.cards.filter((c) => c.debit_account_id === r.id);
    const cardIds = new Set(cards.map((c) => c.id));
    return [
      relationSection('この口座から引き落とされているカード', 'cards', cards),
      relationSection('この口座から直接支払っている契約', 'contracts', d.contracts.filter((c) => c.pay_account_id === r.id)),
      relationSection('上記カード経由で支払っている契約', 'contracts', d.contracts.filter((c) => cardIds.has(c.pay_card_id))),
    ];
  }
  if (ledger === 'cards') {
    return [
      relationSection('このカードで支払っている契約', 'contracts', d.contracts.filter((c) => c.pay_card_id === r.id)),
      relationSection('このカードに紐づくポイントカード・会員情報', 'memberships', d.memberships.filter((m) => m.card_id === r.id)),
    ];
  }
  return [];
}

function referencingCount(ledger, id) {
  const d = state.data;
  if (ledger === 'accounts') return d.cards.filter((c) => c.debit_account_id === id).length + d.contracts.filter((c) => c.pay_account_id === id).length;
  if (ledger === 'cards') return d.contracts.filter((c) => c.pay_card_id === id).length + d.memberships.filter((m) => m.card_id === id).length;
  return 0;
}

async function deleteRecord(ledger, r) {
  const refs = referencingCount(ledger, r.id);
  const photos = state.photos.filter((p) => p.item_id === r.id);
  let msg = `「${r.name}」を削除します。元に戻せません。よろしいですか？`;
  if (refs > 0) msg += `\n\nこのデータは他の${refs}件から参照されています。削除すると、それらの支払方法・紐づけの設定が外れます。解約しただけなら、削除せず状態を「解約済み」にするのがおすすめです。`;
  if (photos.length > 0) msg += `\n\n添付写真${photos.length}枚も削除されます。`;
  if (!window.confirm(msg)) return;
  await db.removePhotos(photos.flatMap((p) => [p.path, p.thumb_path]));
  await db.deleteWhere(ledger, 'id', r.id);
  state.photos = state.photos.filter((p) => p.item_id !== r.id);
  await Promise.all([reloadLedger(ledger), ...(ledger === 'accounts' ? [reloadLedger('cards'), reloadLedger('contracts')] : []),
    ...(ledger === 'cards' ? [reloadLedger('contracts'), reloadLedger('memberships')] : [])]);
  toast('削除しました。');
  location.hash = `#/list/${ledger}`;
}

function renderView(ledger, id) {
  const def = LEDGERS[ledger];
  const r = find(ledger, id);
  if (!r) {
    setView('見つかりません', h('section', { class: 'card' }, h('p', {}, 'データが見つかりません。削除された可能性があります。'), h('a', { href: `#/list/${ledger}` }, `${def.label}の一覧へ`)));
    return;
  }
  const rows = def.fields.filter((f) => f.key !== 'name').map((f) => [f.label, fieldValueNodes(f, r)]).filter(([, v]) => v !== null && !(Array.isArray(v) && v.length === 0));
  const notifyRows = (def.events || []).map((type) => {
    const custom = notifyDaysText(r, type);
    const text = custom === '' ? `${EVENT_TYPES[type].defaults.join('日前・')}日前（初期設定）` : custom === 'なし' ? '通知しない' : `${custom.split(' ').join('日前・')}日前`;
    return [`通知: ${EVENT_TYPES[type].label}`, text];
  });
  const events = collectEvents({ [ledger]: [r] }, todayJST()).filter((e) => e.daysLeft >= -30);
  const delBtn = h('button', { type: 'button', class: 'danger', onclick: (ev) => busy(ev.currentTarget, () => deleteRecord(ledger, r)) }, '削除');

  setView(r.name,
    h('p', {}, h('a', { href: `#/list/${ledger}` }, `← ${def.label}の一覧`)),
    h('div', { class: 'title-row' }, h('h1', {}, r.name), h('a', { class: 'button primary', href: `#/edit/${ledger}/${r.id}` }, '編集')),
    events.length ? h('section', { class: 'card' }, h('h2', {}, '期限'), eventList(events)) : null,
    h('section', { class: 'card' }, h('dl', { class: 'fields' }, [...rows, ...notifyRows].map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]))),
    def.photos ? photoSection(r) : null,
    relations(ledger, r),
    h('div', { class: 'actions' }, delBtn));
}

// ---------------------------------------------------------------- photos

async function photoUrl(path) {
  if (!photoUrls.has(path)) photoUrls.set(path, URL.createObjectURL(await db.downloadPhoto(path)));
  return photoUrls.get(path);
}

function openPhoto(photo) {
  const img = h('img', { alt: '写真', class: 'viewer-img' });
  const close = () => overlay.remove();
  const overlay = h('div', { class: 'viewer', role: 'dialog', 'aria-label': '写真', onclick: close },
    h('button', { type: 'button', class: 'viewer-close', onclick: close }, '閉じる'), img);
  document.body.append(overlay);
  photoUrl(photo.path).then((url) => { img.src = url; }).catch((e) => { close(); handleError(e); });
}

function photoSection(item) {
  const grid = h('div', { class: 'photos' });
  const status = h('p', { class: 'muted small', role: 'status' });
  const input = h('input', { type: 'file', accept: 'image/*', multiple: true, id: 'photo-input', class: 'visually-hidden' });

  const draw = () => {
    const photos = state.photos.filter((p) => p.item_id === item.id);
    grid.replaceChildren(...(photos.length === 0 ? [h('p', { class: 'muted' }, '写真はまだありません。')] : photos.map((p) => {
      const img = h('img', { alt: '添付写真', loading: 'lazy' });
      photoUrl(p.thumb_path).then((url) => { img.src = url; }).catch((e) => console.error(e.detail || e));
      return h('figure', { class: 'photo' },
        h('button', { type: 'button', class: 'photo-open', onclick: () => openPhoto(p), 'aria-label': '写真を拡大' }, img),
        h('button', { type: 'button', class: 'small danger', onclick: (ev) => busy(ev.currentTarget, async () => {
          if (!window.confirm('この写真を削除しますか？')) return;
          await db.removePhotos([p.path, p.thumb_path]);
          await db.deleteWhere('item_photos', 'id', p.id);
          state.photos = state.photos.filter((x) => x.id !== p.id);
          draw();
        }) }, '削除'));
    })));
  };

  input.addEventListener('change', async () => {
    const files = [...input.files];
    input.value = '';
    const current = state.photos.filter((p) => p.item_id === item.id).length;
    if (current + files.length > MAX_PHOTOS_PER_ITEM) {
      toast(`写真は1件につき${MAX_PHOTOS_PER_ITEM}枚までです。`, 'error');
      return;
    }
    let done = 0;
    for (const file of files) {
      status.textContent = `写真を保存しています（${done + 1}/${files.length}）…`;
      let compressed;
      try {
        compressed = await compressImage(file);
      } catch (e) {
        console.error(e.message);
        toast(`「${file.name}」は画像として読み込めませんでした（JPEG・PNG などを選んでください。30MB まで）。`, 'error');
        continue;
      }
      const id = crypto.randomUUID();
      const path = `${item.id}/${id}.jpg`;
      const thumbPath = `${item.id}/${id}_thumb.jpg`;
      try {
        await db.uploadPhoto(path, compressed.photo);
        await db.uploadPhoto(thumbPath, compressed.thumb);
        const [row] = await db.insertRows('item_photos', [{ id, item_id: item.id, path, thumb_path: thumbPath, bytes: compressed.photo.size + compressed.thumb.size }]);
        state.photos.push(row);
        done += 1;
      } catch (e) {
        handleError(e);
        db.removePhotos([path, thumbPath]).catch((err) => console.error(err.detail || err));
      }
    }
    status.textContent = done > 0 ? `${done}枚の写真を保存しました。` : '';
    draw();
  });

  draw();
  return h('section', { class: 'card' },
    h('h2', {}, '写真（保証書・レシート）'),
    h('p', { class: 'notice-text small' }, '⚠ カード番号の全桁・暗証番号などが写り込んでいないか確認してから追加してください。'),
    grid,
    h('label', { for: 'photo-input', class: 'button' }, '写真を追加（撮影・選択）'), input,
    status,
    h('p', { class: 'muted small' }, '写真は縮小・圧縮してから保存します。'));
}

// ---------------------------------------------------------------- edit form

function fieldInput(field, r, ledger) {
  const id = `f-${field.key}`;
  const v = r ? r[field.key] : undefined;
  const wrap = (input, getter, help) => ({
    el: h('div', { class: 'field', 'data-key': field.key },
      field.type === 'bool' ? null : h('label', { for: id }, field.label, field.required ? h('span', { class: 'req' }, ' *') : null),
      input,
      help ? h('p', { class: 'muted small' }, help) : null,
      h('p', { class: 'error small field-error' })),
    get: getter,
  });
  switch (field.type) {
    case 'textarea': {
      const el = h('textarea', { id, rows: 4, maxlength: field.max, value: v || '' });
      return wrap(el, () => el.value);
    }
    case 'select':
    case 'status': {
      const el = h('select', { id },
        field.type === 'status' ? null : h('option', { value: '' }, '（未選択）'),
        optionPairs(field).map(([val, label]) => h('option', { value: val, selected: val === (v ?? (field.type === 'status' ? 'active' : '')) }, label)));
      return wrap(el, () => el.value);
    }
    case 'bool': {
      const el = h('input', { type: 'checkbox', id, checked: Boolean(v) });
      return { el: h('div', { class: 'field checkbox' }, el, h('label', { for: id }, field.label)), get: () => el.checked };
    }
    case 'ref': {
      const rows = [...state.data[field.ref]].sort(byName);
      const el = h('select', { id }, h('option', { value: '' }, '（なし）'),
        rows.map((x) => h('option', { value: x.id, selected: x.id === v }, x.name + (x.status === 'closed' ? '（解約済み）' : ''))));
      return wrap(el, () => el.value || null);
    }
    case 'payment': {
      const cur = r && r.pay_card_id ? `card:${r.pay_card_id}` : r && r.pay_account_id ? `account:${r.pay_account_id}` : '';
      const el = h('select', { id }, h('option', { value: '' }, '（未設定・現金など）'),
        h('optgroup', { label: 'クレジットカード' }, [...state.data.cards].sort(byName).map((c) => h('option', { value: `card:${c.id}`, selected: cur === `card:${c.id}` }, c.name))),
        h('optgroup', { label: '口座（直接引き落とし）' }, [...state.data.accounts].sort(byName).map((a) => h('option', { value: `account:${a.id}`, selected: cur === `account:${a.id}` }, a.name))));
      return wrap(el, () => el.value);
    }
    case 'links': {
      const rowsBox = h('div', { class: 'link-rows' });
      const addRow = (l = { label: '', url: '' }) => {
        const row = h('div', { class: 'link-row' },
          h('input', { type: 'text', placeholder: '名前（例: ログイン）', value: l.label, 'aria-label': 'リンクの名前', maxlength: 50 }),
          h('input', { type: 'url', placeholder: 'https://', value: l.url, 'aria-label': 'URL', inputmode: 'url' }),
          h('button', { type: 'button', class: 'small', onclick: () => row.remove(), 'aria-label': 'このリンクを削除' }, '×'));
        rowsBox.append(row);
      };
      (v && v.length ? v : [{ label: '', url: '' }]).forEach(addRow);
      const add = h('button', { type: 'button', class: 'small', onclick: () => addRow() }, '＋ リンクを追加');
      return {
        el: h('div', { class: 'field', 'data-key': field.key }, h('span', { class: 'label' }, field.label), rowsBox, add, h('p', { class: 'error small field-error' })),
        get: () => [...rowsBox.children].map((row) => { const [a, b] = row.querySelectorAll('input'); return { label: a.value, url: b.value }; }),
      };
    }
    case 'tags': {
      const el = h('input', { type: 'text', id, value: (v || []).join(' '), placeholder: field.placeholder });
      return wrap(el, () => el.value);
    }
    case 'month': {
      const el = h('input', { type: 'month', id, value: v || '' });
      return wrap(el, () => el.value, 'カード券面の「MM/YY」の年月を入力します。');
    }
    case 'date': {
      const el = h('input', { type: 'date', id, value: v || '' });
      return wrap(el, () => el.value);
    }
    case 'int':
    case 'day':
    case 'monthnum': {
      const el = h('input', { type: 'text', inputmode: 'numeric', id, value: v ?? '' });
      const help = field.type === 'day' ? '1〜31（31は末日）' : field.type === 'monthnum' ? '1〜12' : null;
      return wrap(el, () => el.value, help);
    }
    case 'holder': {
      const names = registeredMembers();
      if (names.length === 0) {
        const el = h('input', { type: 'text', id, value: v || '', maxlength: field.max });
        return wrap(el, () => el.value, '設定画面で「家族の名前」を登録すると、一覧から選べます。');
      }
      const outside = v && !names.includes(v);
      const el = h('select', { id }, h('option', { value: '' }, '（未設定）'),
        names.map((n) => h('option', { value: n, selected: n === v }, n)),
        outside ? h('option', { value: v, selected: true }, `${v}（一覧にない）`) : null);
      return wrap(el, () => el.value, outside ? '一覧にない名前です。設定画面の「家族の名前」に追加すると選べます。' : null);
    }
    case 'code': {
      const el = h('input', { type: 'text', inputmode: 'numeric', id, value: v || '', maxlength: field.digits, autocomplete: 'off' });
      return wrap(el, () => el.value, `数字${field.digits}桁（先頭の0も入力します。足りない桁は0で補います）`);
    }
    case 'last4': {
      const el = h('input', { type: 'text', inputmode: 'numeric', id, value: v || '', maxlength: 4, pattern: '[0-9]{4}', autocomplete: 'off' });
      return wrap(el, () => el.value, '下4桁だけを入力します（全桁は保存しません）。');
    }
    default: {
      const type = field.type === 'email' ? 'email' : field.type === 'url' ? 'url' : 'text';
      const el = h('input', { type, id, value: v || '', maxlength: field.max, placeholder: field.placeholder, required: field.required });
      return wrap(el, () => el.value);
    }
  }
}

function notifyInput(type, r) {
  const id = `n-${type}`;
  const el = h('input', { type: 'text', id, value: notifyDaysText(r, type), placeholder: `空欄で初期設定（${EVENT_TYPES[type].defaults.join(' ')}）` });
  return {
    type,
    el: h('div', { class: 'field', 'data-key': `notify_${type}` },
      h('label', { for: id }, `通知: ${EVENT_TYPES[type].label}（何日前）`), el,
      h('p', { class: 'muted small' }, '例: 「30 7」で30日前と7日前。「なし」で通知しない。'),
      h('p', { class: 'error small field-error' })),
    get: () => el.value,
  };
}

// Converts raw form/CSV values into a DB row. Returns { values, errors: [{ key, message }] }.
function buildValues(def, raw, notifyRaw) {
  const values = {};
  const errors = [];
  for (const field of def.fields) {
    const input = raw[field.key];
    if (input === undefined) continue;
    if (field.type === 'links') {
      const res = validateLinks(input);
      if (res.error) errors.push({ key: field.key, message: res.error });
      else values.links = res.value;
    } else if (field.type === 'tags') {
      const res = parseTags(input);
      if (res.error) errors.push({ key: field.key, message: res.error });
      else values.tags = res.value;
    } else if (field.type === 'ref') {
      values[field.key] = input || null;
    } else if (field.type === 'payment') {
      const [kind, id] = String(input || '').split(':');
      values.pay_card_id = kind === 'card' ? id : null;
      values.pay_account_id = kind === 'account' ? id : null;
    } else {
      const res = parseField(field, input);
      if (res.error) errors.push({ key: field.key, message: res.error });
      else values[field.key] = res.value;
    }
  }
  if (notifyRaw) {
    const notify = {};
    for (const [type, text] of Object.entries(notifyRaw)) {
      const res = parseNotifyDays(text, type);
      if (res.error) errors.push({ key: `notify_${type}`, message: res.error });
      else if (res.value !== undefined) notify[type] = res.value;
    }
    values.notify_days = notify;
  }
  return { values, errors };
}

function cardNumberSuspects(values) {
  return Object.values(values).some((v) => (typeof v === 'string' && findCardNumberLike(v))
    || (Array.isArray(v) && v.some((x) => typeof x === 'string' && findCardNumberLike(x))));
}

function renderEdit(ledger, id) {
  const def = LEDGERS[ledger];
  const isNew = id === 'new';
  const r = isNew ? null : find(ledger, id);
  if (!isNew && !r) {
    renderView(ledger, id);
    return;
  }
  const inputs = def.fields.map((f) => ({ field: f, ...fieldInput(f, r, ledger) }));
  const notifyInputs = (def.events || []).map((t) => notifyInput(t, r));
  const summary = h('div', { class: 'error', role: 'alert' });
  const submit = h('button', { type: 'submit', class: 'primary' }, '保存');

  const form = h('form', {
    class: 'card form',
    novalidate: true,
    onsubmit: (ev) => {
      ev.preventDefault();
      busy(submit, async () => {
        for (const p of form.querySelectorAll('.field-error')) p.textContent = '';
        summary.textContent = '';
        const raw = Object.fromEntries(inputs.map((i) => [i.field.key, i.get()]));
        const notifyRaw = Object.fromEntries(notifyInputs.map((n) => [n.type, n.get()]));
        const { values, errors } = buildValues(def, raw, notifyInputs.length ? notifyRaw : null);
        if (errors.length) {
          for (const e of errors) {
            const box = form.querySelector(`[data-key="${e.key}"] .field-error`);
            if (box) box.textContent = e.message;
          }
          summary.textContent = `入力内容を確認してください（${errors.length}件）。`;
          summary.scrollIntoView({ behavior: 'smooth', block: 'center' });
          return;
        }
        if (cardNumberSuspects(values) && !window.confirm('カード番号の全桁と思われる数字が含まれています。カード番号・暗証番号は保存しない方針です。このまま保存しますか？')) return;
        const saved = isNew ? (await db.insertRows(ledger, [values]))[0] : await db.updateRow(ledger, id, values);
        await reloadLedger(ledger);
        toast('保存しました。');
        location.hash = `#/view/${ledger}/${saved.id}`;
      });
    },
  },
  summary,
  inputs.map((i) => i.el),
  notifyInputs.length ? h('fieldset', {}, h('legend', {}, '通知のタイミング'), notifyInputs.map((n) => n.el)) : null,
  def.photos && isNew ? h('p', { class: 'muted small' }, '写真は保存した後の詳細画面から追加できます。') : null,
  h('div', { class: 'actions' },
    h('a', { class: 'button', href: isNew ? `#/list/${ledger}` : `#/view/${ledger}/${id}` }, 'キャンセル'),
    submit));

  setView(isNew ? `${def.label}を追加` : `${r.name}を編集`, h('h1', {}, isNew ? `${def.label}を追加` : `${r.name}を編集`), form);
}

// ---------------------------------------------------------------- CSV

function csvColumns(ledger) {
  const def = LEDGERS[ledger];
  const cols = [{ header: 'ID', kind: 'id' }];
  for (const f of def.fields) {
    if (f.type === 'payment') {
      cols.push({ header: '支払カード', kind: 'payref', ref: 'cards', key: 'pay_card_id' });
      cols.push({ header: '支払口座', kind: 'payref', ref: 'accounts', key: 'pay_account_id' });
    } else {
      cols.push({ header: f.label, kind: 'field', field: f });
    }
  }
  for (const t of def.events || []) cols.push({ header: `通知:${EVENT_TYPES[t].label}（何日前）`, kind: 'notify', type: t });
  return cols;
}

function csvCell(col, r) {
  if (col.kind === 'id') return r.id;
  if (col.kind === 'payref') return r[col.key] ? (find(col.ref, r[col.key]) || {}).name || '' : '';
  if (col.kind === 'notify') return notifyDaysText(r, col.type);
  const f = col.field;
  const v = r[f.key];
  if (v === null || v === undefined) return '';
  if (f.type === 'bool') return v ? 'はい' : 'いいえ';
  if (f.type === 'ref') return (find(f.ref, v) || {}).name || '';
  if (f.type === 'links') return linksCell(v);
  if (f.type === 'tags') return v.join(' ');
  if (f.type === 'select' || f.type === 'status') return optionLabel(f, v);
  return String(v);
}

function ledgerCSV(ledger, includeRows = true) {
  const cols = csvColumns(ledger);
  const rows = includeRows ? [...state.data[ledger]].sort(byName).map((r) => cols.map((c) => csvCell(c, r))) : [];
  return toCSV([cols.map((c) => c.header), ...rows]);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function resolveByName(ledger, name, label) {
  const hits = state.data[ledger].filter((x) => x.name === name);
  if (hits.length === 1) return { value: hits[0].id };
  if (hits.length === 0) return { error: `${label}「${name}」が${LEDGERS[ledger].label}台帳に見つかりません（先に${LEDGERS[ledger].label}を取り込んでください）。` };
  return { error: `${label}「${name}」と同じ名前が${LEDGERS[ledger].label}台帳に複数あるため特定できません。` };
}

// Returns { rows, errors, inserts, updates, suspects }
function prepareImport(ledger, text) {
  const def = LEDGERS[ledger];
  const table = parseCSV(text);
  if (table.length < 2) return { errors: ['データの行がありません（1行目は見出し、2行目からデータです）。'] };
  if (table.length - 1 > MAX_IMPORT_ROWS) return { errors: [`一度に取り込めるのは${MAX_IMPORT_ROWS}行までです。`] };
  const cols = csvColumns(ledger);
  const header = table[0].map((x) => x.trim());
  const index = new Map(header.map((x, i) => [x, i]));
  if (!index.has(def.fields[0].label)) return { errors: [`見出しに「${def.fields[0].label}」がありません。${def.label}のテンプレートを使ってください。`] };
  const unknown = header.filter((x) => x && !cols.some((c) => c.header === x));
  const errors = unknown.length ? [`認識できない見出しは無視します: ${unknown.join('、')}`] : [];
  const fatal = [];
  const rows = [];
  let inserts = 0;
  let updates = 0;
  let suspects = 0;
  const existing = new Set(state.data[ledger].map((r) => r.id));
  const usedIds = new Set();

  table.slice(1).forEach((line, i) => {
    const rowNo = i + 2;
    const cell = (h2) => (index.has(h2) ? unescapeFormula(line[index.get(h2)] ?? '') : undefined);
    const raw = {};
    const notifyRaw = {};
    let hasNotify = false;
    const rowErrors = [];
    let id = null;
    for (const c of cols) {
      const v = cell(c.header);
      if (v === undefined) continue;
      if (c.kind === 'id') {
        if (v.trim() && !UUID_RE.test(v.trim())) rowErrors.push('IDの形式が正しくありません（新しく追加する行は空欄にします）。');
        else id = v.trim() || null;
      } else if (c.kind === 'payref') {
        if (v.trim()) {
          const res = resolveByName(c.ref, v.trim(), c.header);
          if (res.error) rowErrors.push(res.error);
          else raw.payment = `${c.ref === 'cards' ? 'card' : 'account'}:${res.value}`;
        }
      } else if (c.kind === 'notify') {
        notifyRaw[c.type] = v;
        hasNotify = true;
      } else {
        const f = c.field;
        if (f.type === 'ref') {
          if (v.trim()) {
            const res = resolveByName(f.ref, v.trim(), f.label);
            if (res.error) rowErrors.push(res.error);
            else raw[f.key] = res.value;
          } else raw[f.key] = null;
        } else if (f.type === 'links') {
          const res = parseLinksCell(v);
          if (res.error) rowErrors.push(res.error);
          else raw.links = res.value;
        } else raw[f.key] = v;
      }
    }
    if (cell('支払カード')?.trim() && cell('支払口座')?.trim()) rowErrors.push('支払カードと支払口座はどちらか一方だけを入力してください。');
    if (ledger === 'contracts' && raw.payment === undefined && (index.has('支払カード') || index.has('支払口座'))) raw.payment = '';
    const { values, errors: fieldErrors } = buildValues(def, raw, hasNotify ? notifyRaw : null);
    rowErrors.push(...fieldErrors.map((e) => e.message));
    const known = registeredMembers();
    if (known.length > 0 && values.holder && !known.includes(values.holder)) {
      rowErrors.push(`名義人「${values.holder}」が家族の名前の一覧にありません。設定画面の「家族の名前」に先に登録してください。`);
    }
    if (id && usedIds.has(id)) rowErrors.push('同じIDの行が複数あります。');
    if (rowErrors.length) {
      fatal.push(...rowErrors.map((m) => `${rowNo}行目: ${m}`));
      return;
    }
    if (cardNumberSuspects(values)) suspects += 1;
    const finalId = id || crypto.randomUUID();
    usedIds.add(finalId);
    if (existing.has(finalId)) updates += 1;
    else inserts += 1;
    rows.push({ id: finalId, ...values });
  });
  return { rows, errors: [...fatal, ...errors], fatal: fatal.length > 0, inserts, updates, suspects };
}

// Rows of one upsert must have the same keys: fill missing ones from the existing row or defaults.
function uniformRows(ledger, rows) {
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return rows.map((r) => {
    const base = find(ledger, r.id) || {};
    const out = {};
    for (const k of keys) {
      if (k in r) out[k] = r[k];
      else if (k in base) out[k] = base[k];
      else if (k === 'links') out[k] = [];
      else if (k === 'tags') out[k] = [];
      else if (k === 'notify_days') out[k] = {};
      else if (k === 'status') out[k] = 'active';
      else if (['mf_linked', 'family_card', 'etc_card', 'auto_renew'].includes(k)) out[k] = false;
      else out[k] = null;
    }
    return out;
  });
}

function importSection() {
  const ledgerSel = h('select', { id: 'import-ledger' }, LEDGER_ORDER.map((k) => h('option', { value: k }, LEDGERS[k].label)));
  const file = h('input', { type: 'file', id: 'import-file', accept: '.csv,text/csv' });
  const result = h('div', { class: 'import-result' });
  const run = h('button', { type: 'button', class: 'primary', onclick: (ev) => busy(ev.currentTarget, async () => {
    result.replaceChildren();
    const f = file.files[0];
    if (!f) {
      toast('CSVファイルを選んでください。', 'error');
      return;
    }
    if (f.size > MAX_IMPORT_BYTES) {
      toast('ファイルが大きすぎます（5MBまで）。', 'error');
      return;
    }
    const ledger = ledgerSel.value;
    let prep;
    try {
      prep = prepareImport(ledger, decodeCSVBytes(await f.arrayBuffer()));
    } catch (e) {
      console.error(e.message);
      toast('CSVファイルを読み込めませんでした。形式を確認してください。', 'error');
      return;
    }
    if (prep.errors.length) {
      result.append(h('ul', { class: 'error small' }, prep.errors.slice(0, 30).map((m) => h('li', {}, m)),
        prep.errors.length > 30 ? h('li', {}, `ほか${prep.errors.length - 30}件`) : null));
    }
    if (prep.fatal || !prep.rows || prep.rows.length === 0) {
      if (prep.fatal) result.prepend(h('p', { class: 'error' }, 'エラーがあるため取り込みませんでした。修正してからもう一度お試しください。'));
      return;
    }
    let msg = `${LEDGERS[ledger].label}: 追加 ${prep.inserts}件、更新 ${prep.updates}件を取り込みます。よろしいですか？`;
    if (prep.suspects) msg += `\n\n⚠ ${prep.suspects}行にカード番号の全桁と思われる数字が含まれています。`;
    if (!window.confirm(msg)) return;
    for (let i = 0; i < prep.rows.length; i += 200) await db.upsertRows(ledger, uniformRows(ledger, prep.rows.slice(i, i + 200)));
    await reloadLedger(ledger);
    file.value = '';
    result.prepend(h('p', { role: 'status' }, `取り込みました（追加 ${prep.inserts}件、更新 ${prep.updates}件）。`));
    toast('取り込みが完了しました。');
  }) }, '取り込む');

  return h('section', { class: 'card' },
    h('h2', {}, 'CSV の取り込み・書き出し'),
    h('h3', {}, 'テンプレート'),
    h('p', { class: 'muted small' }, '見出し行だけのCSVです。Excel などで2行目から入力して保存し、下の「取り込み」で読み込みます。'),
    h('div', { class: 'button-row' }, LEDGER_ORDER.map((k) => h('button', { type: 'button', class: 'small', onclick: () => download(`テンプレート_${LEDGERS[k].csvName}.csv`, ledgerCSV(k, false), 'text/csv') }, LEDGERS[k].label))),
    h('h3', {}, '取り込み'),
    h('ul', { class: 'muted small' },
      h('li', {}, '順番: 口座 → クレジットカード → 契約・固定費／ポイントカード・会員情報（引き落とし口座などは名前で結びつけるため）。'),
      h('li', {}, 'ID が空欄の行は追加、書き出したCSVの ID が入った行はその内容で更新します。'),
      h('li', {}, 'はい/いいえ、日付は 2026-01-31、年月は 2027-05、リンクは1行に「名前|URL」、タグは空白区切り。'),
      h('li', {}, 'エラーが1件でもあると何も取り込みません。')),
    h('label', { for: 'import-ledger' }, '取り込む台帳'), ledgerSel,
    h('label', { for: 'import-file' }, 'CSVファイル（UTF-8 または Excel の CSV）'), file,
    h('div', { class: 'actions' }, run),
    result,
    h('h3', {}, '書き出し'),
    h('div', { class: 'button-row' }, LEDGER_ORDER.map((k) => h('button', { type: 'button', class: 'small', onclick: () => download(`${LEDGERS[k].csvName}_${todayJST()}.csv`, ledgerCSV(k), 'text/csv') }, LEDGERS[k].label))));
}

// ---------------------------------------------------------------- backup

async function fullBackup(status) {
  await loadAll();
  const files = LEDGER_ORDER.map((k) => ({ name: `${LEDGERS[k].csvName}.csv`, data: ledgerCSV(k) }));
  const photoRows = [['写真ID', '品名', '品ID', 'ファイル', '登録日時']];
  let i = 0;
  for (const p of state.photos) {
    i += 1;
    status.textContent = `写真を取得しています（${i}/${state.photos.length}）…`;
    const blob = await db.downloadPhoto(p.path);
    const name = `photos/${p.item_id}/${p.id}.jpg`;
    files.push({ name, data: new Uint8Array(await blob.arrayBuffer()) });
    photoRows.push([p.id, (find('items', p.item_id) || {}).name || '', p.item_id, name, p.created_at]);
  }
  files.push({ name: '写真一覧.csv', data: toCSV(photoRows) });
  status.textContent = 'ZIPファイルを作成しています…';
  const zip = createZip(files);
  download(`家の管理ハブ_バックアップ_${todayJST()}.zip`, new Blob([zip], { type: 'application/zip' }));
  await saveSetting('last_backup_at', new Date().toISOString());
  status.textContent = `バックアップを書き出しました（写真${state.photos.length}枚を含む）。`;
}

function backupSection() {
  const status = h('p', { class: 'small', role: 'status' });
  const last = state.settings.last_backup_at;
  return h('section', { class: 'card' },
    h('h2', {}, 'バックアップ'),
    h('p', {}, `最後のバックアップ: ${last ? new Date(last).toLocaleString('ja-JP') : 'まだありません'}`),
    h('p', { class: 'muted small' }, `全台帳のCSVと写真を1つのZIPファイルにまとめてダウンロードします。Supabase の無料プランには自動バックアップが無いため、月1回程度の実行をおすすめします（${BACKUP_REMIND_DAYS}日たつとホーム画面でお知らせします）。写真が多い場合はPCでの実行をおすすめします。`),
    h('button', { type: 'button', class: 'primary', onclick: (ev) => busy(ev.currentTarget, () => fullBackup(status).catch((e) => { status.textContent = ''; throw e; })) }, '全データを書き出す（ZIP）'),
    status);
}

// ---------------------------------------------------------------- usage

function meter(label, used, limit) {
  const ratio = Math.min(1, used / limit);
  const pct = Math.round((used / limit) * 1000) / 10;
  const level = ratio >= 0.9 ? 'critical' : ratio >= 0.7 ? 'warning' : 'ok';
  const word = level === 'critical' ? '⚠ 上限間近' : level === 'warning' ? '⚠ 注意' : '';
  const fill = h('div', { class: 'meter-fill' });
  fill.style.width = `${Math.max(ratio * 100, used > 0 ? 1 : 0)}%`; // CSSOM, allowed by the CSP (no inline style attribute)
  return h('div', { class: 'meter-wrap' },
    h('div', { class: 'meter-head' }, h('span', {}, label), h('span', { class: 'muted small' }, `${formatBytes(used)} / ${formatBytes(limit)}（${pct}%）${word ? ` ${word}` : ''}`)),
    h('div', { class: `meter meter-${level}`, role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': limit, 'aria-valuenow': used, 'aria-label': `${label} ${pct}%` }, fill));
}

function usageSection() {
  const box = h('div', {}, h('p', { class: 'muted' }, '読み込み中…'));
  db.rpc('usage_stats').then((u) => {
    box.replaceChildren(
      meter('データベース', Number(u.db_bytes), FREE_DB_BYTES),
      meter(`写真（${u.photo_count}枚）`, Number(u.storage_bytes), FREE_STORAGE_BYTES),
      h('p', { class: 'muted small' }, '上限は Supabase 無料プランの値です（2026-10-31 時点の調査。公式ページでは未確認）。データベースの値には Supabase 自体の管理用データも含まれます。'));
  }).catch((e) => {
    console.error(e.detail || e);
    box.replaceChildren(h('p', { class: 'error' }, '使用量を取得できませんでした。'));
  });
  return h('section', { class: 'card' }, h('h2', {}, '使用量'), box);
}

// ---------------------------------------------------------------- notifications settings

function defaultDeviceLabel() {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return 'Android';
  if (/iPhone|iPad/i.test(ua)) return 'iPhone/iPad';
  if (/Windows/i.test(ua)) return 'Windows PC';
  if (/Mac/i.test(ua)) return 'Mac';
  return 'この端末';
}

function notifySection() {
  const body = h('div');
  const draw = async () => {
    const key = state.settings.vapid_public_key;
    const nodes = [];
    if (!push.pushSupported()) {
      nodes.push(h('p', { class: 'error' }, 'この端末・ブラウザは通知に対応していません。Android は Chrome でホーム画面に追加してから開いてください。'));
    } else if (!key) {
      nodes.push(h('p', {}, '通知の鍵がまだありません。最初に1回だけ作成します。'));
      nodes.push(h('button', { type: 'button', class: 'primary', onclick: (ev) => busy(ev.currentTarget, () => createKeys(false)) }, '通知の鍵を作成'));
    } else {
      const sub = await push.currentSubscription();
      const label = h('input', { type: 'text', id: 'device-label', value: defaultDeviceLabel(), maxlength: 100 });
      nodes.push(h('p', {}, sub ? '✓ この端末は通知を受け取ります（毎朝8時ごろ）。' : 'この端末は通知を受け取っていません。'));
      if (Notification.permission === 'denied') nodes.push(h('p', { class: 'error small' }, '通知がブラウザでブロックされています。ブラウザのサイト設定で通知を許可してください。'));
      if (!sub) {
        nodes.push(h('label', { for: 'device-label' }, '端末の名前'), label);
        nodes.push(h('button', { type: 'button', class: 'primary', onclick: (ev) => busy(ev.currentTarget, async () => {
          const res = await push.subscribe(key, label.value.trim().slice(0, 100));
          if (res === 'denied') toast('通知が許可されませんでした。', 'error');
          else toast('この端末で通知を受け取る設定をしました。');
          draw();
        }) }, 'この端末で通知を受け取る'));
      } else {
        nodes.push(h('button', { type: 'button', onclick: (ev) => busy(ev.currentTarget, async () => { await push.unsubscribe(); toast('この端末の通知を止めました。'); draw(); }) }, 'この端末の通知を止める'));
      }
      nodes.push(h('p', { class: 'muted small' }, 'テスト通知: GitHub のリポジトリ → Actions →「毎朝の通知」→ Run workflow で「テスト通知」を選んで実行します。'));
      nodes.push(h('details', {}, h('summary', {}, '通知の鍵を作り直す'),
        h('p', { class: 'small' }, '鍵が漏れた・GitHub に登録した秘密の値を無くした場合のみ使います。作り直すと、すべての端末で通知の設定をやり直す必要があります。'),
        h('button', { type: 'button', class: 'danger small', onclick: (ev) => busy(ev.currentTarget, () => createKeys(true)) }, '作り直す')));
    }
    body.replaceChildren(...nodes);
  };

  const createKeys = async (regenerate) => {
    if (regenerate && !window.confirm('通知の鍵を作り直します。すべての端末で通知の設定をやり直す必要があります。よろしいですか？')) return;
    const keys = await push.generateVapidKeys();
    if (regenerate) {
      await push.unsubscribe().catch((e) => console.error(e.detail || e));
      await db.deleteAll('push_subscriptions');
    }
    await saveSetting('vapid_public_key', keys.publicKey);
    const box = h('textarea', { readonly: true, rows: 2, class: 'secret', value: keys.privateKey, 'aria-label': '秘密の値' });
    body.replaceChildren(
      h('p', {}, '✓ 鍵を作成しました。下の「秘密の値」を GitHub に登録してください。この値は二度と表示されません。'),
      h('ol', { class: 'small' },
        h('li', {}, 'GitHub のリポジトリ → Settings → Secrets and variables → Actions を開く'),
        h('li', {}, '「New repository secret」で Name に VAPID_PRIVATE_KEY、Secret に下の値を貼り付けて保存'),
        h('li', {}, '登録できたらこの画面を再読み込みし、「この端末で通知を受け取る」を押す')),
      box,
      h('button', { type: 'button', onclick: async () => {
        try {
          await navigator.clipboard.writeText(keys.privateKey);
          toast('コピーしました。');
        } catch {
          box.select();
          toast('コピーできませんでした。値を長押しして選択・コピーしてください。', 'error');
        }
      } }, 'コピー'),
      h('p', { class: 'muted small' }, '秘密の値は他人に見せないでください。チャットやメールに貼り付けないでください。'));
  };

  draw().catch(handleError);
  return h('section', { class: 'card' }, h('h2', {}, '通知（この端末）'), body);
}

function membersSection() {
  const area = h('textarea', { id: 'members-input', rows: 4, maxlength: MAX_MEMBERS * (MAX_MEMBER_LENGTH + 2), value: registeredMembers().join('\n') });
  const error = h('p', { class: 'error small', role: 'alert' });
  const save = h('button', { type: 'button', class: 'primary', onclick: (ev) => busy(ev.currentTarget, async () => {
    const res = parseMembers(area.value);
    error.textContent = res.error || '';
    if (res.error) return;
    await saveSetting('members', res.value);
    area.value = res.value.join('\n');
    toast('家族の名前を保存しました。');
  }) }, '家族の名前を保存');
  return h('section', { class: 'card' }, h('h2', {}, '家族の名前'),
    h('p', { class: 'muted small' }, `各台帳の「名義人」を、ここに登録した名前から選べます（最大${MAX_MEMBERS}人・1人${MAX_MEMBER_LENGTH}文字まで）。名前を変えても、入力済みのデータの名義人は自動では変わりません。`),
    h('label', { for: 'members-input' }, '家族の名前（1行に1人）'), area, error,
    h('div', { class: 'actions' }, save));
}

function shortcutSection() {
  const field = { key: 'links', label: 'ホーム画面のショートカット', type: 'links' };
  const input = fieldInput(field, { links: state.settings.shortcuts || DEFAULT_SHORTCUTS });
  const save = h('button', { type: 'button', class: 'primary', onclick: (ev) => busy(ev.currentTarget, async () => {
    const res = validateLinks(input.get());
    const err = input.el.querySelector('.field-error');
    err.textContent = res.error || '';
    if (res.error) return;
    await saveSetting('shortcuts', res.value);
    toast('ショートカットを保存しました。');
  }) }, '保存');
  return h('section', { class: 'card' }, h('h2', {}, 'ショートカット'), input.el,
    h('p', { class: 'muted small' }, '銀行のリンクは口座台帳の「関連リンク」から自動で表示されます。'), h('div', { class: 'actions' }, save));
}

function accountSection() {
  return h('section', { class: 'card' }, h('h2', {}, 'アカウント'),
    h('p', {}, `ログイン中: ${db.currentEmail() || ''}`),
    h('div', { class: 'button-row' },
      h('button', { type: 'button', onclick: (ev) => busy(ev.currentTarget, async () => { await db.signOut('local'); resetState(); render(); }) }, 'ログアウト'),
      h('button', { type: 'button', class: 'danger', onclick: (ev) => busy(ev.currentTarget, async () => {
        if (!window.confirm('すべての端末（2人のスマホ・PCを含む）からログアウトします。端末をなくしたときに使います。よろしいですか？')) return;
        await db.signOut('global');
        resetState();
        render();
      }) }, 'すべての端末からログアウト')),
    h('p', { class: 'muted small' }, '端末をなくしたときは「すべての端末からログアウト」を押してから、パスワードを変更してください。'));
}

function renderSettings() {
  setView('設定', h('h1', {}, '設定'), notifySection(), membersSection(), backupSection(), importSection(), shortcutSection(), usageSection(), accountSection());
}

// ---------------------------------------------------------------- start

db.setSignedOutHandler(() => {
  resetState();
  render();
});
window.addEventListener('hashchange', () => render());
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch((e) => console.error(`service worker registration failed: ${e.message}`));
}
render();
