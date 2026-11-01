// 家の管理ハブ: single page app (vanilla JS, hash routing).
import * as db from './supabase.js';
import { AppError } from './supabase.js';
import { LEDGERS, LEDGER_ORDER, MEMBER_DEF, optionPairs, optionLabel } from './schema.js';
import { EVENT_TYPES, collectEvents, upcomingEvents, monthlyCost, monthlyTotal, todayJST, toDayNumber } from './events.js';
import {
  parseField, parseTags, validateLinks, parseLinksCell, linksCell, parseNotifyDays, notifyDaysText, findCardNumberLike, safeUrl,
} from './validate.js';
import { parseCSV, toCSV, decodeCSVBytes, unescapeFormula } from './csv.js';
import { sortedHistory, applyPriceChange, periodText, priceAt } from './prices.js';
import {
  parseMfRows, classifyMf, matchContract, normalizeText, summarizeMonth, plannedInMonth, personalTotal, settlementMemo, depositCandidates, depositEntryFor, DEPOSIT_AUTO_FROM,
} from './mf.js';
import { createZip } from './zip.js';
import { compressImage } from './image.js';
import { parseOcrText, receiptMemo, recognizeImage } from './ocr.js';
import * as push from './push.js';
import { icon, LEDGER_ICONS } from './icons.js';
import { timelineChart, barChart, lineChart, flowGraph, urgency } from './charts.js';
import {
  ymAdd, ymLabel, participantIds, firstYM, history, statement, YM_RE, contractDeduction, planRuleSync, ruleSchedule,
} from './shared.js';
import {
  CATEGORIES, GROUPS, CYCLES, WEEKDAYS, monthlyHours, basePoints, adjustedPoints, timesPerCycle, workload, choreSharers, isDueOn, scheduleText,
} from './chores.js';

const FREE_DB_BYTES = 500 * 1024 * 1024;
const FREE_STORAGE_BYTES = 1024 * 1024 * 1024;
const BACKUP_REMIND_DAYS = 30;
const MAX_PHOTOS_PER_ITEM = 20;
const MAX_IMPORT_ROWS = 2000;
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

const DEFAULT_SHORTCUTS = [
  { label: 'マネーフォワード ME', url: 'https://moneyforward.com/' },
  { label: 'Amazon', url: 'https://www.amazon.co.jp/' },
  { label: 'Google パスワードマネージャー', url: 'https://passwords.google.com/' },
];

const state = {
  loaded: false,
  data: { accounts: [], cards: [], contracts: [], items: [], memberships: [] },
  photos: [],
  settings: {},
  members: [],
  chores: [],
  sharedRules: [],
  sharedEntries: [],
  depositReports: [], // 入金報告 (reference only)
  attachments: [], // images of one-off items and deposit reports
  tx: new Map(), // ym -> statement lines (null while loading)
  txYear: new Map(), // 'YYYY' -> statement lines of the year (null while loading)
  money: { tab: 'member', member: null, ext: null, flow: null }, // お金の流れ: the open tab and each tab's month or year
  personal: null, // { pending, review } statement lines owed by one person / being checked (null until loaded)
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

// A shortcut as a tile with the site's icon (its /favicon.ico). When the icon cannot be loaded, the
// first letter of the name is shown instead.
function shortcutTile(s) {
  const safe = safeUrl(s.url);
  const label = s.label || safe || s.url;
  const letter = h('span', { class: 'shortcut-letter', 'aria-hidden': 'true' }, Array.from(String(label).trim())[0] || '?');
  const badge = h('span', { class: 'shortcut-icon' }, letter);
  if (safe) {
    const img = h('img', { src: `${new URL(safe).origin}/favicon.ico`, alt: '', referrerpolicy: 'no-referrer', width: 28, height: 28 });
    img.addEventListener('load', () => {
      if (img.naturalWidth > 1) badge.replaceChildren(img);
    });
    img.addEventListener('error', () => img.remove());
  }
  const body = [badge, h('span', { class: 'shortcut-label' }, label)];
  return safe
    ? h('a', { class: 'shortcut', href: safe, target: '_blank', rel: 'noopener noreferrer' }, ...body)
    : h('span', { class: 'shortcut' }, ...body);
}

function view() {
  return document.getElementById('view');
}

function setView(title, ...nodes) {
  document.title = title ? `${title} | 家の管理ハブ` : '家の管理ハブ';
  const root = view();
  root.replaceChildren(...nodes.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false));
  updateStickyOffset();
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------- page frame (same on every page)
//
// The page head stays at the top while the page scrolls (below the app bar; on wide screens below the
// menu too): ① back link + icon + title + main action, ② main tabs, ③ sub switch (one row).
const PAGE_ICONS = { home: ['home', 'lg-home'], ledgers: ['grid', 'lg-ledgers'], chores: ['chore', 'lg-chores'], flow: ['flow', 'lg-flow'], settings: ['gear', 'lg-settings'] };

function pageIcon(name) {
  if (LEDGERS[name]) return ledgerIcon(name);
  const [ic, cls] = PAGE_ICONS[name] || ['grid', 'lg-ledgers'];
  return h('span', { class: `icbox ${cls}` }, icon(ic));
}

// { title, icon: page key or ledger key, back: { href, text }, action: node, tabs: [{ key, label, href }],
//   tab: active key, sub: node, help: [title, ...paragraphs] }
function pageHead({ title, icon: iconName, back, action, tabs, tab, sub, help }) {
  return h('div', { class: 'page-head' },
    h('div', { class: 'page-title' },
      back ? h('a', { class: 'back-btn', href: back.href, 'aria-label': back.text || '戻る' }, h('span', { 'aria-hidden': 'true' }, '‹')) : null,
      iconName ? pageIcon(iconName) : null,
      h('h1', {}, title),
      help ? helpButton(...help) : null,
      action ? h('div', { class: 'page-action' }, action) : null),
    tabs ? h('nav', { class: 'tabs', 'aria-label': `${title}の表示` }, tabs.map((t) => h('a', {
      class: `tab${t.key === tab ? ' active' : ''}`, href: t.href, 'aria-current': t.key === tab ? 'page' : null,
    }, t.label))) : null,
    sub ? h('div', { class: 'page-sub' }, sub) : null);
}

// Small segmented switch: [{ label, href, active }]
function segmented(items, label) {
  return h('div', { class: 'segmented', role: 'group', 'aria-label': label }, items.map((i) => h('a', {
    class: i.active ? 'active' : '', href: i.href, 'aria-current': i.active ? 'true' : null,
  }, i.label)));
}

// 「?」: an explanation opens in a small window instead of text on the page.
function helpButton(title, ...paragraphs) {
  return h('button', { type: 'button', class: 'help-btn', 'aria-label': `${title}の説明`, onclick: (ev) => { ev.preventDefault(); openHelp(title, paragraphs); } }, '?');
}

function openHelp(title, paragraphs) {
  const dialog = h('dialog', { class: 'help-dialog', 'aria-label': title },
    h('h2', {}, title),
    paragraphs.flat().filter(Boolean).map((p) => (typeof p === 'string' ? h('p', {}, p) : p)),
    h('div', { class: 'actions' }, h('button', { type: 'button', class: 'primary', onclick: () => dialog.close() }, '閉じる')));
  dialog.addEventListener('close', () => dialog.remove());
  dialog.addEventListener('click', (ev) => { if (ev.target === dialog) dialog.close(); });
  document.body.append(dialog);
  dialog.showModal();
}

// A card heading: icon + title (+ ? + right-side link or action).
function cardHead(iconName, title, { help, action } = {}) {
  return h('div', { class: 'card-head' },
    h('h2', { class: 'with-icon' }, iconName ? icon(iconName) : null, title, help ? helpButton(title, ...help) : null),
    action || null);
}

// Height of the bars above the page head (app bar, and the menu when it sits at the top).
function updateStickyOffset() {
  const header = document.querySelector('.app-header');
  const nav = document.getElementById('nav');
  let top = header ? header.offsetHeight : 0;
  if (nav && !nav.hidden && getComputedStyle(nav).position === 'sticky') top += nav.offsetHeight;
  document.documentElement.style.setProperty('--page-head-top', `${top}px`);
}
window.addEventListener('resize', updateStickyOffset);

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

// The logged-in person in the user master (null: not registered or inactive).
function me() {
  const email = (db.currentEmail() || '').toLowerCase();
  return state.members.find((m) => m.active && m.email && m.email === email) || null;
}

function isAdmin() {
  const m = me();
  return Boolean(m && m.role === 'admin');
}

function memberById(id) {
  return state.members.find((m) => m.id === id) || null;
}

function nick(m) {
  return m.nickname || m.name;
}

// Holder fields show the legal name; everything else (greeting, assignee, history) the nickname.
function memberName(id) {
  const m = memberById(id);
  if (!m) return '（削除済み）';
  return m.active ? m.name : `${m.name}（無効）`;
}

function memberNick(id) {
  const m = memberById(id);
  if (!m) return '（削除済み）';
  return m.active ? nick(m) : `${nick(m)}（無効）`;
}

const ROLE_FIELD = MEMBER_DEF.fields.find((f) => f.key === 'role');

function activeAdminsWithLogin(exceptId) {
  return state.members.filter((m) => m.role === 'admin' && m.active && m.email && m.id !== exceptId);
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
  const [accounts, cards, contracts, items, memberships, photos, settings, members, chores, sharedRules, sharedEntries, depositReports, attachments] = await Promise.all([
    db.selectAll('accounts'),
    db.selectAll('cards'),
    db.selectAll('contracts'),
    db.selectAll('items'),
    db.selectAll('memberships'),
    db.selectAll('item_photos', 'created_at.asc'),
    db.selectAll('settings', 'key.asc'),
    db.selectAll('members'),
    db.selectAll('chores'),
    db.selectAll('shared_rules', 'start_ym.asc'),
    db.selectAll('shared_entries', 'ym.asc'),
    db.selectAll('deposit_reports', 'paid_on.asc'),
    db.selectAll('shared_attachments', 'created_at.asc'),
  ]);
  state.data = { accounts, cards, contracts, items, memberships };
  state.photos = photos;
  state.settings = Object.fromEntries(settings.map((s) => [s.key, s.value]));
  state.members = members;
  state.chores = chores;
  state.sharedRules = sharedRules;
  state.sharedEntries = sharedEntries;
  state.depositReports = depositReports;
  state.attachments = attachments;
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
  state.mfBox = null;
  state.loaded = false;
  state.data = { accounts: [], cards: [], contracts: [], items: [], memberships: [] };
  state.photos = [];
  state.settings = {};
  state.members = [];
  state.chores = [];
  state.sharedRules = [];
  state.sharedEntries = [];
  state.depositReports = [];
  state.attachments = [];
  clearTxCache();
  state.personal = null;
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
    const active = target === page || (target === 'ledgers' && ['list', 'view', 'edit'].includes(page))
      || (target === 'settings' && page === 'member')
      || (target === 'chores' && ['chore', 'chore-edit'].includes(page))
      || (target === 'flow' && ['shared', 'shared-entry', 'shared-rule', 'tx', 'deposit-report'].includes(page));
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
  if (route().page === 'password') {
    nav.hidden = !me();
    setNav('settings');
    renderPassword();
    return;
  }
  if (!me()) {
    nav.hidden = true;
    renderNotMember();
    return;
  }
  const { page, a, b } = route();
  setNav(page);
  if (page === 'home') renderHome();
  else if (page === 'ledgers') renderLedgers();
  else if (page === 'list' && LEDGERS[a]) renderList(a);
  else if (page === 'view' && LEDGERS[a]) renderView(a, b);
  else if (page === 'edit' && LEDGERS[a]) renderEdit(a, b);
  else if (page === 'settings') renderSettings(a);
  else if (page === 'flow') renderMoney(a, b);
  else if (page === 'shared') renderMoney('member', a || thisYM());
  else if (page === 'shared-entry') renderSharedEntry(a, b);
  else if (page === 'deposit-report') renderDepositReport(a, b);
  else if (page === 'shared-rule') renderSharedRule(a);
  else if (page === 'tx') renderTx(a);
  else if (page === 'chores') renderChores(a);
  else if (page === 'chore') renderChore(a);
  else if (page === 'chore-edit') renderChoreEdit(a);
  else if (page === 'member') renderMember(a);
  else location.hash = '#/';
}

// ---------------------------------------------------------------- setup / login

function renderSetupNeeded() {
  setView('初期設定', h('section', { class: 'card' },
    h('h1', {}, '初期設定が必要です'),
    h('p', {}, 'web/js/config.js に Supabase の URL と公開キーを設定してください。'),
    h('p', { class: 'muted' }, '手順は docs/setup.md を参照してください。')));
}

// Logged in, but not an active member of the user master: no data is readable (RLS).
function renderNotMember() {
  setView('利用できません', h('section', { class: 'card' },
    h('h1', {}, 'このアカウントは利用者として登録されていません'),
    h('p', {}, `ログイン中: ${db.currentEmail() || ''}`),
    h('p', {}, '管理者に、ユーザーマスターへの登録（または有効化）を依頼してください。'),
    h('button', { type: 'button', onclick: (ev) => busy(ev.currentTarget, async () => { await db.signOut('local'); resetState(); render(); }) }, 'ログアウト')));
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
  state.loginNotice ? h('p', { class: 'error', role: 'alert' }, state.loginNotice) : null,
  h('label', { for: 'login-email' }, 'メールアドレス'), email,
  h('label', { for: 'login-password' }, 'パスワード'), password,
  error, submit);
  state.loginNotice = null;
  setView('ログイン', form, forgotPasswordBox(email));
}

// 「パスワードを忘れた場合」: Supabase e-mails a link that opens this app (see handleAuthLink).
function forgotPasswordBox(loginEmail) {
  const email = h('input', { type: 'email', id: 'reset-email', autocomplete: 'username', maxlength: 254 });
  const status = h('p', { role: 'status' });
  const send = h('button', { type: 'button', onclick: (ev) => busy(ev.currentTarget, async () => {
    status.className = '';
    const value = email.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || value.length > 254) {
      status.className = 'error';
      status.textContent = 'メールアドレスを正しく入力してください。';
      return;
    }
    await db.requestPasswordReset(value, `${location.origin}${location.pathname}`);
    status.className = 'muted';
    status.textContent = '登録されているメールアドレスなら、パスワードの再設定のメールを送りました。メールのリンクを、この端末で開いてください（リンクは一定時間で使えなくなります）。';
  }) }, '再設定のメールを送る');
  const box = h('details', { class: 'card forgot' },
    h('summary', {}, 'パスワードを忘れた場合'),
    h('label', { for: 'reset-email' }, '再設定するメールアドレス'), email, send, status);
  box.addEventListener('toggle', () => {
    if (box.open && !email.value) email.value = loginEmail.value.trim();
  });
  return box;
}

// Opened from a link in an e-mail (invite / password reset): keep the session, then set a password.
async function handleAuthLink() {
  const link = db.linkFragment(location.hash);
  if (!link) return;
  const base = `${location.pathname}${location.search}`;
  window.history.replaceState(null, '', `${base}#/`); // the tokens must not stay in the address bar or history
  if (link.error) {
    state.loginNotice = link.error;
    return;
  }
  try {
    await db.signInWithLink(link);
    resetState();
    state.passwordFromLink = true;
    window.history.replaceState(null, '', `${base}#/password`);
  } catch (e) {
    console.error(e.detail || e);
    await db.signOut('local').catch(() => {});
    state.loginNotice = 'メールのリンクでログインできませんでした。もう一度「パスワードを忘れた場合」からメールを送ってください。';
  }
}

// Change the password: with the current one, or (after an e-mail link) without it.
function renderPassword() {
  const fromLink = Boolean(state.passwordFromLink);
  const current = h('input', { type: 'password', id: 'pw-current', autocomplete: 'current-password' });
  const next = h('input', { type: 'password', id: 'pw-new', autocomplete: 'new-password', maxlength: db.MAX_PASSWORD, placeholder: `${db.MIN_PASSWORD}文字以上` });
  const again = h('input', { type: 'password', id: 'pw-again', autocomplete: 'new-password', maxlength: db.MAX_PASSWORD });
  const error = h('p', { class: 'error', role: 'alert' });
  const submit = h('button', { type: 'submit', class: 'primary' }, 'パスワードを変更');
  const done = fromLink ? '#/' : '#/settings/account';
  const form = h('form', { class: 'card form', novalidate: true, onsubmit: (ev) => {
    ev.preventDefault();
    busy(submit, async () => {
      error.textContent = '';
      const problem = !fromLink && !current.value ? '今のパスワードを入力してください。'
        : next.value.length < db.MIN_PASSWORD ? `新しいパスワードは${db.MIN_PASSWORD}文字以上にしてください。`
          : new TextEncoder().encode(next.value).length > db.MAX_PASSWORD ? '新しいパスワードが長すぎます（半角72文字まで）。'
            : next.value !== again.value ? '確認用のパスワードが一致しません。'
              : !fromLink && next.value === current.value ? '今と同じパスワードです。別のパスワードにしてください。' : null;
      if (problem) {
        error.textContent = problem;
        return;
      }
      if (!fromLink) {
        try {
          await db.signIn(db.currentEmail(), current.value);
        } catch (e) {
          console.error(e.detail || e);
          error.textContent = e.status === 400 || e.status === 401 ? '今のパスワードが違います。' : e.message;
          return;
        }
      }
      try {
        await db.changePassword(next.value);
      } catch (e) {
        console.error(e.detail || e);
        error.textContent = e instanceof AppError ? e.message : 'パスワードを変更できませんでした。';
        return;
      }
      for (const i of [current, next, again]) i.value = '';
      state.passwordFromLink = false;
      toast('パスワードを変更しました。');
      location.hash = done;
    });
  } },
  fromLink ? h('p', {}, `${db.currentEmail() || ''} の新しいパスワードを決めてください。`) : null,
  fromLink ? null : h('div', { class: 'field' }, h('label', { for: 'pw-current' }, '今のパスワード'), current),
  h('div', { class: 'field' }, h('label', { for: 'pw-new' }, '新しいパスワード'), next),
  h('div', { class: 'field' }, h('label', { for: 'pw-again' }, '新しいパスワード（確認）'), again),
  error,
  h('div', { class: 'actions' }, h('a', { class: 'button', href: done, onclick: () => { state.passwordFromLink = false; } }, fromLink ? 'あとで' : 'キャンセル'), submit));
  setView('パスワードの変更', pageHead({ title: fromLink ? 'パスワードの設定' : 'パスワードの変更', icon: 'settings', back: fromLink ? null : { href: '#/settings/account', text: '設定へ' } }), form);
}

// ---------------------------------------------------------------- home

const URGENCY_ICON = { past: 'check', crit: 'alert', warn: 'clock', ok: 'clock' };
// Short ledger names for the small dashboard tiles.
const TILE_LABELS = { accounts: '口座', cards: 'カード', contracts: '契約・固定費', items: '書類・家電', memberships: '会員情報' };

function ledgerIcon(ledger, extra = '') {
  return h('span', { class: `icbox lg-${ledger} ${extra}`.trim() }, icon(LEDGER_ICONS[ledger]));
}

// Status is shown by color + icon + text (never by color alone).
function eventBadge(e) {
  const u = urgency(e.daysLeft);
  const text = e.daysLeft < 0 ? `${-e.daysLeft}日前に過ぎました` : e.daysLeft === 0 ? '今日' : `あと${e.daysLeft}日`;
  return h('span', { class: `badge badge-${u}` }, icon(URGENCY_ICON[u]), text);
}

function eventList(events) {
  if (events.length === 0) return h('p', { class: 'muted' }, '近い予定はありません。');
  return h('ul', { class: 'events' }, events.map((e) => h('li', {},
    eventBadge(e),
    h('div', {},
      h('div', { class: 'event-name' }, h('a', { href: `#/view/${e.ledger}/${e.id}` }, e.name)),
      h('div', { class: 'muted small' }, `${e.label}・${e.date}`)))));
}

// Big "days left" panel on a detail page, with an elapsed-period gauge when the start date is known.
function deadlineHero(e, r) {
  const u = urgency(e.daysLeft);
  const start = e.type === 'warranty' ? r.purchase_date : e.type === 'contract_renewal' ? r.contract_date : null;
  const startN = start ? toDayNumber(start) : null;
  const endN = toDayNumber(e.date);
  const todayN = toDayNumber(todayJST());
  let gauge = null;
  if (startN !== null && endN > startN) {
    const ratio = Math.min(Math.max((todayN - startN) / (endN - startN), 0), 1);
    const fill = h('div', { class: `gauge-fill gauge-${u}` });
    fill.style.width = `${Math.round(ratio * 100)}%`; // CSSOM, allowed by the CSP
    gauge = [
      h('div', { class: 'gauge', role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(ratio * 100), 'aria-label': `期間の経過 ${Math.round(ratio * 100)}%` }, fill),
      h('div', { class: 'gauge-scale muted small' }, h('span', {}, start), h('span', {}, `経過 ${Math.round(ratio * 100)}%`), h('span', {}, e.date)),
    ];
  }
  return h('section', { class: `card deadline deadline-${u}` },
    h('h2', { class: 'with-icon' }, icon('clock'), e.label),
    h('div', { class: 'deadline-main' },
      e.daysLeft < 0
        ? h('span', { class: 'deadline-days' }, '過ぎました')
        : [h('span', { class: 'deadline-days num' }, e.daysLeft === 0 ? '今日' : String(e.daysLeft)), e.daysLeft === 0 ? null : h('span', { class: 'deadline-unit' }, '日')],
      h('span', { class: 'deadline-date' }, eventBadge(e), h('span', { class: 'muted small' }, `${e.date}まで`))),
    gauge);
}

// Shortcuts from the 関連リンク of accounts (named after the bank) and cards (named after the link).
function bankShortcuts() {
  const pick = (r) => r.links.find((l) => /ログイン/.test(l.label)) || r.links[0];
  const live = (r) => r.status !== 'closed' && r.links && r.links.length > 0;
  return [
    ...state.data.accounts.filter(live).map((a) => ({ label: a.institution || a.name, url: pick(a).url })),
    ...state.data.cards.filter(live).map((c) => ({ label: pick(c).label || c.name, url: pick(c).url })),
  ].filter((v, i, list) => list.findIndex((x) => x.url === v.url) === i);
}

function backupReminder() {
  const total = LEDGER_ORDER.reduce((n, k) => n + state.data[k].length, 0);
  if (total === 0) return null;
  const last = state.settings.last_backup_at;
  const days = last ? Math.floor((Date.now() - Date.parse(last)) / 86400000) : null;
  if (days !== null && days < BACKUP_REMIND_DAYS) return null;
  return h('section', { class: 'card notice' },
    h('p', {}, days === null ? 'まだバックアップしていません。' : `最後のバックアップから${days}日たっています。`),
    h('a', { href: '#/settings/data', class: 'button' }, '設定画面でバックアップする'));
}

function weekdayJa(iso) {
  return '日月火水木金土'[new Date(`${iso}T00:00:00Z`).getUTCDay()];
}

function kpi(label, value, unit, cls = '') {
  return h('div', { class: `kpi ${cls}`.trim() }, h('div', { class: 'kpi-label' }, label), h('div', { class: 'kpi-value num' }, value, h('small', {}, unit)));
}

function sectionHead(iconName, title, link, help) {
  return h('h2', { class: 'with-icon' }, icon(iconName), title, help ? helpButton(title, ...help) : null,
    link ? h('a', { class: 'more', href: link.href }, link.text, icon('chevron', 'ic ic-sm')) : null);
}

function renderHome() {
  const today = todayJST();
  const all = collectEvents(state.data, today);
  const events = upcomingEvents(all);
  const soon = all.filter((e) => e.daysLeft >= 0 && e.daysLeft <= 30).length;
  const active = state.data.contracts.filter((c) => c.status !== 'closed' && monthlyCost(c) > 0);
  const byCategory = new Map();
  for (const c of active) byCategory.set(c.category || '未分類', (byCategory.get(c.category || '未分類') || 0) + monthlyCost(c));
  const shortcuts = [...(state.settings.shortcuts || DEFAULT_SHORTCUTS), ...bankShortcuts()];
  const records = LEDGER_ORDER.reduce((n, k) => n + state.data[k].filter((r) => r.status !== 'closed').length, 0);
  const flow = flowModel();
  const pushHint = h('div');
  const [, m, d] = today.split('-').map(Number);

  setView('ホーム',
    pageHead({ title: `${m}月${d}日（${weekdayJa(today)}）`, icon: 'home' }),
    backupReminder(),
    pushHint,
    h('div', { class: 'kpis' },
      kpi('固定費 / 月', yen(monthlyTotal(state.data.contracts)).replace('円', ''), '円', 'kpi-main'),
      kpi('期限 30日以内', String(soon), '件', soon > 0 ? 'kpi-alert' : ''),
      kpi('登録データ', String(records), '件')),
    h('div', { class: 'dash-grid' },
      todayChoresCard(),
      sharedHomeCard(),
      h('section', { class: 'card' },
        sectionHead('clock', '期限が近い予定'),
        events.some((e) => e.daysLeft >= 0) ? timelineChart(events) : null,
        eventList(events)),
      h('section', { class: 'card' },
        sectionHead('yen', '固定費の内訳（月額）', { href: '#/list/contracts', text: '契約へ' }, ['年払いの契約は12で割った月額で計算しています。解約済みは含みません。']),
        byCategory.size === 0
          ? h('p', { class: 'muted' }, '金額が入力された契約はまだありません。')
          : barChart([...byCategory.entries()], '固定費の種類別の月額')),
      h('section', { class: 'card' },
        sectionHead('flow', 'お金の流れ', { href: '#/flow/flow', text: '拡大' }),
        flow.columns[flow.columns.length - 1].length === 0 && flow.columns.length === 3
          ? h('p', { class: 'muted' }, '支払方法と金額が入った契約を登録すると、口座からの流れを表示します。')
          : flowTree(flow)),
      h('section', { class: 'card' },
        sectionHead('grid', '台帳'),
        h('div', { class: 'tiles' }, LEDGER_ORDER.map((k) => h('a', { class: 'tile', href: `#/list/${k}` },
          ledgerIcon(k),
          h('div', { class: 'tile-count num' }, String(state.data[k].filter((r) => r.status !== 'closed').length), h('small', {}, ' 件')),
          h('div', { class: 'tile-label' }, TILE_LABELS[k]))))),
      h('section', { class: 'card' },
        sectionHead('link', 'ショートカット', null, ['口座・カードの台帳の「関連リンク」も表示します。その他は設定画面で変更できます。']),
        h('div', { class: 'shortcuts' }, shortcuts.map(shortcutTile)))));

  push.currentSubscription().then((sub) => {
    if (!sub && push.pushSupported()) {
      pushHint.replaceChildren(h('section', { class: 'card notice' },
        h('p', { class: 'with-icon' }, icon('bell'), 'この端末ではまだ通知を受け取る設定をしていません。'),
        h('a', { href: '#/settings/account', class: 'button' }, '通知を設定する')));
    }
  }).catch((e) => console.error(`push status check failed: ${e.message}`));
}

// ---------------------------------------------------------------- money flow

const MAX_FLOW_ACCOUNTS = 8; // categorical palette slots; the rest is folded into "その他"

// The account chosen as the shared account (settings, admin only); null when not set or deleted.
// Account name with the details that tell accounts apart (branch, kind, last 4 digits only).
function accountLabel(a) {
  const details = [a.branch, a.kind, a.last4 && `下4桁 ${a.last4}`].filter(Boolean);
  return details.length ? `${a.name}（${details.join('・')}）` : a.name;
}

function sharedAccountId() {
  const id = state.settings.shared_account_id;
  return typeof id === 'string' && find('accounts', id) ? id : null;
}

// ---- contracts paid from a personal account (共通の費用) -> recurring rules kept by the app

function deductionContext() {
  return { accounts: state.data.accounts, cards: state.data.cards, sharedAccountId: sharedAccountId() };
}

function deductionText(contract) {
  const { target, reason } = contractDeduction(contract, deductionContext());
  if (!target) return reason;
  return `→ ${memberNick(target.member_id)}の当月分から${target.month_of_year ? `毎年${target.month_of_year}月に` : '毎月'} ${yen(-target.amount)}を差し引きます。`;
}

async function applyRulePlan(plan) {
  for (const e of plan.end) await db.updateRow('shared_rules', e.id, { end_ym: e.end_ym });
  for (const u of plan.update) await db.updateRow('shared_rules', u.id, { label: u.label });
  for (const id of plan.remove) await db.deleteWhere('shared_rules', 'id', id);
  if (plan.create.length) await db.insertRows('shared_rules', plan.create);
  return plan.end.length + plan.update.length + plan.remove.length + plan.create.length;
}

// Keep the rule of one contract in line with it from this month on (adoptRuleId: an existing
// manual rule that becomes this contract's rule, so that its history is kept).
async function syncContractRules(contract, adoptRuleId = null, fromYm = thisYM()) {
  if (adoptRuleId) {
    await db.updateRow('shared_rules', adoptRuleId, { contract_id: contract.id });
    await reloadShared();
  }
  const { target } = contract.deleted ? { target: null } : contractDeduction(contract, deductionContext());
  const changed = await applyRulePlan(planRuleSync(contract.id, target, state.sharedRules, fromYm));
  if (changed) await reloadShared();
}

// After accounts, cards or the shared account change, every contract may deduct differently.
async function syncAllContractRules() {
  const linked = new Set(state.sharedRules.filter((r) => r.contract_id).map((r) => r.contract_id));
  let changed = 0;
  for (const c of state.data.contracts) {
    if (!c.shared_cost && !linked.has(c.id)) continue;
    const { target } = contractDeduction(c, deductionContext());
    changed += await applyRulePlan(planRuleSync(c.id, target, state.sharedRules, thisYM()));
  }
  if (changed) await reloadShared();
}

// Manual rules that an existing contract can take over (offsets that are still running).
function adoptableRules() {
  const current = thisYM();
  return state.sharedRules.filter((r) => !r.contract_id && r.amount < 0 && (!r.end_ym || r.end_ym >= current));
}

// [(people ->) accounts -> cards -> contracts] for one month ('YYYY-MM') or one year ('YYYY').
// Month: the contract amount of that month (price history; yearly contracts / 12) and each member's
// 当月分. Year: the amounts paid in that year (monthly: each month, yearly: the payment month) and the
// sum of 当月分. Closed contracts are left out (the closing date is not kept).
function flowModel(period = thisYM()) {
  const isYear = period.length === 4;
  const months = isYear ? Array.from({ length: 12 }, (_, i) => `${period}-${String(i + 1).padStart(2, '0')}`) : [period];
  const amountOf = (c) => {
    if (c.status === 'closed') return 0;
    if (!isYear) {
      const v = Number(priceAt(c, period));
      return Number.isFinite(v) && v > 0 ? (c.cycle === 'yearly' ? v / 12 : v) : 0;
    }
    if (c.cycle === 'yearly' && !c.renewal_date) return Math.max(0, Number(priceAt(c, months[11])) || 0);
    return months.reduce((n, m) => n + plannedInMonth(c, m), 0);
  };
  const monthlyCost = amountOf; // the amount used throughout this model
  const ym = period;
  const contracts = state.data.contracts.filter((c) => amountOf(c) > 0);
  const cardOf = (id) => (id ? find('cards', id) : null);
  const source = (c) => {
    const card = cardOf(c.pay_card_id);
    if (card) return card.debit_account_id && find('accounts', card.debit_account_id) ? card.debit_account_id : 'none';
    return c.pay_account_id && find('accounts', c.pay_account_id) ? c.pay_account_id : 'none';
  };
  const sharedId = sharedAccountId();
  const inflows = sharedId
    ? sharedMembers().map((m) => ({
      m,
      value: isYear
        ? history(state.sharedRules, state.sharedEntries, m.id, months[11]).filter((r) => r.ym.startsWith(`${period}-`)).reduce((n, r) => n + r.charges, 0)
        : statement(state.sharedRules, state.sharedEntries, m.id, ym).charges,
    })).filter((x) => x.value > 0)
    : [];
  const totals = new Map();
  for (const c of contracts) totals.set(source(c), (totals.get(source(c)) || 0) + monthlyCost(c));
  const ranked = [...totals.entries()].filter(([k]) => k !== 'none' && k !== sharedId).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  if (sharedId && (inflows.length || totals.has(sharedId))) ranked.unshift(sharedId);
  const kept = new Set(ranked.slice(0, ranked.length > MAX_FLOW_ACCOUNTS ? MAX_FLOW_ACCOUNTS - 1 : MAX_FLOW_ACCOUNTS));
  const group = (acc) => (acc === 'none' ? 'none' : kept.has(acc) ? acc : 'other');
  const color = new Map([...kept].map((k, i) => [k, `var(--series-${i + 1})`]));
  color.set('other', 'var(--series-other)');
  color.set('none', 'var(--series-none)');

  const accNodes = new Map();
  const accNode = (g) => {
    if (!accNodes.has(g)) {
      accNodes.set(g, {
        id: `a:${g}`,
        label: g === 'none' ? '口座が未設定' : g === 'other' ? 'その他の口座' : find('accounts', g).name + (g === sharedId ? '（共通）' : ''),
        value: 0,
        out: 0,
        in: 0,
        color: color.get(g),
        href: g === 'none' || g === 'other' ? null : `#/view/accounts/${g}`,
      });
    }
    return accNodes.get(g);
  };
  const cardNodes = new Map();
  const leaves = [];
  const links = new Map();
  const addLink = (from, to, value, col) => {
    const key = `${from}>${to}`;
    const l = links.get(key) || { from, to, value: 0, color: col };
    l.value += value;
    links.set(key, l);
  };
  for (const c of contracts) {
    const g = group(source(c));
    const v = monthlyCost(c);
    const acc = accNode(g);
    acc.out += v;
    const card = cardOf(c.pay_card_id);
    leaves.push({ id: `k:${c.id}`, label: c.name, value: v, color: color.get(g), href: `#/view/contracts/${c.id}`, sub: c.cycle === 'yearly' && !isYear ? '※' : '', group: g, via: card ? card.id : '' });
    if (card) {
      const cn = cardNodes.get(card.id) || { id: `c:${card.id}`, label: card.name, value: 0, color: color.get(g), href: `#/view/cards/${card.id}`, group: g };
      cn.value += v;
      cardNodes.set(card.id, cn);
      addLink(acc.id, cn.id, v, color.get(g));
      addLink(cn.id, `k:${c.id}`, v, color.get(g));
    } else {
      addLink(acc.id, `k:${c.id}`, v, color.get(g));
    }
  }
  const people = inflows.map(({ m, value }) => {
    const acc = accNode(sharedId);
    acc.in += value;
    addLink(`p:${m.id}`, acc.id, value, color.get(sharedId));
    return { id: `p:${m.id}`, label: nick(m), value, color: color.get(sharedId), href: `#/flow/member/${period}` };
  });
  for (const n of accNodes.values()) {
    n.value = Math.max(n.in, n.out);
    if (n.in > 0) n.sub = `入 ${yen(n.in)} / 出 ${yen(n.out)}`;
    else n.sub = `${isYear ? '年' : '月'} ${yen(n.out)}`;
  }
  const order = ['none', 'other'];
  const groupRank = (g) => (order.includes(g) ? 100 + order.indexOf(g) : [...kept].indexOf(g));
  const left = [...accNodes.entries()].sort((a, b) => groupRank(a[0]) - groupRank(b[0])).map(([, n]) => n);
  const mid = [...cardNodes.values()].sort((a, b) => groupRank(a.group) - groupRank(b.group) || b.value - a.value);
  const right = leaves.sort((a, b) => groupRank(a.group) - groupRank(b.group) || (a.via ? 0 : 1) - (b.via ? 0 : 1)
    || a.via.localeCompare(b.via) || b.value - a.value);
  const columns = people.length ? [people, left, mid, right] : [left, mid, right];
  const sharedIn = people.reduce((n, p) => n + p.value, 0);
  const sharedOut = sharedId ? contracts.filter((c) => source(c) === sharedId).reduce((n, c) => n + monthlyCost(c), 0) : 0;
  return { columns, links: [...links.values()], accounts: left, sharedId, sharedIn, sharedOut };
}

// The flow as one box per account / card and one box for everything outside, joined by arrows of the
// same width that say what the money is for and how much (charts.js flowGraph).
const FLOW_ITEMS_SHOW = 3;

function flowGraphModel(flow) {
  const nodes = new Map(flow.columns.flat().map((n) => [n.id, n]));
  const kind = (id) => id.slice(0, 1); // p person, a account, c card, k contract
  const sharedNodeId = flow.sharedId ? `a:${flow.sharedId}` : null;
  // a person is drawn as their own account (one box), or as themselves when they have none
  const personAccount = (memberId) => state.data.accounts.find((a) => a.holder_id === memberId && a.id !== flow.sharedId && a.status !== 'closed');
  const boxIdOf = (id) => {
    if (kind(id) === 'k') return 'x:outside';
    if (kind(id) === 'p') {
      const acc = personAccount(id.slice(2));
      return acc ? `a:${acc.id}` : id;
    }
    return id;
  };
  const out = new Map();
  const addBox = (id, base) => {
    if (out.has(id)) return;
    const k = kind(id);
    if (id === 'x:outside') {
      out.set(id, { id, label: '外部（支払先）', tier: 3, kind: 'outside', icon: icon('out'), href: '#/list/contracts' });
      return;
    }
    if (k === 'a') {
      const accId = id.slice(2);
      const acc = find('accounts', accId);
      const owner = acc && acc.holder_id ? state.members.find((m) => m.id === acc.holder_id) : null;
      const isShared = id === sharedNodeId;
      const name = !acc ? (base ? base.label : id)
        : isShared ? `${acc.name}（共通）`
          : owner && !acc.name.includes(nick(owner)) ? `${acc.name}（${nick(owner)}）` : acc.name;
      out.set(id, { id, label: name, tier: id === sharedNodeId ? 1 : 0, kind: id === sharedNodeId ? 'shared' : 'account', icon: icon('bank'), href: acc ? `#/view/accounts/${accId}` : null, color: base ? base.color : null });
      return;
    }
    if (k === 'c') {
      out.set(id, { id, label: base.label, tier: 2, kind: 'card', icon: icon('card'), href: base.href, color: base.color });
      return;
    }
    out.set(id, { id, label: base.label, tier: 0, kind: 'person', icon: icon('user'), href: base.href, color: base.color });
  };
  // arrows: one per pair of boxes, listing what goes through it
  const arrows = new Map();
  for (const l of flow.links) {
    const from = boxIdOf(l.from);
    const to = boxIdOf(l.to);
    addBox(from, nodes.get(l.from));
    addBox(to, nodes.get(l.to));
    const key = `${from}>${to}`;
    if (!arrows.has(key)) arrows.set(key, { from, to, items: [] });
    const target = nodes.get(l.to);
    const what = kind(l.from) === 'p' ? '当月分' : kind(l.to) === 'c' ? 'カードの引き落とし' : target ? target.label : '支払い';
    arrows.get(key).items.push({ what, value: l.value });
  }
  const edges = [...arrows.values()].map((a) => {
    const items = a.items.sort((x, y) => y.value - x.value);
    const shown = items.length > FLOW_ITEMS_SHOW + 1 ? items.slice(0, FLOW_ITEMS_SHOW) : items;
    const rest = items.slice(shown.length);
    const lines = shown.map((i) => `${i.what} ${yen(Math.round(i.value))}`);
    if (rest.length) lines.push(`ほか${rest.length}件 ${yen(Math.round(rest.reduce((n, i) => n + i.value, 0)))}`);
    return { from: a.from, to: a.to, lines };
  });
  return { nodes: [...out.values()], edges };
}

function flowTree(flow, { unit = '月額' } = {}) {
  return flowGraph(flowGraphModel(flow), { ariaLabel: `お金の流れ（${unit}）` });
}

function flowLegend(flow) {
  return h('div', { class: 'legend' }, flow.accounts.map((n) => {
    const sw = h('span', { class: 'swatch' });
    sw.style.background = n.color;
    return h('span', {}, sw, n.label);
  }));
}

// ---------------------------------------------------------------- shared account statement (MoneyForward ME)

// The account a contract is paid from (card -> its debit account). null if not set.
function contractSourceAccountId(c) {
  const card = c.pay_card_id ? find('cards', c.pay_card_id) : null;
  const id = card ? card.debit_account_id : c.pay_account_id;
  return id && find('accounts', id) ? id : null;
}

function txMonthRange(ym) {
  return `date=gte.${ym}-01&date=lt.${ymAdd(ym, 1)}-01`;
}

// Statement lines of one month, loaded on demand (cached until something is imported or changed).
function monthTransactions(ym) {
  if (state.tx.has(ym)) return state.tx.get(ym);
  state.tx.set(ym, null);
  db.selectWhere('transactions', `${txMonthRange(ym)}&order=date.desc`)
    .then((rows) => {
      state.tx.set(ym, rows);
      const { page } = route();
      if (page === 'flow' || page === 'shared') render();
    })
    .catch((e) => {
      state.tx.delete(ym);
      handleError(e);
    });
  return null;
}

async function fetchAllPaged(table, query) {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const rows = await db.selectWhere(table, `${query}&limit=1000&offset=${offset}`);
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

// The same box is reused while the page redraws (e.g. when the month's lines arrive), so a file being
// read and its preview are not lost.
function mfImportBox() {
  if (state.mfBox) return state.mfBox;
  const status = h('div', { class: 'import-status', role: 'status' });
  const input = h('input', { type: 'file', accept: '.csv,text/csv', 'aria-label': 'マネーフォワードの CSV ファイル' });
  input.addEventListener('change', () => busy(input, async () => {
    status.replaceChildren();
    const file = input.files[0];
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      status.replaceChildren(h('p', { class: 'error' }, 'ファイルが大きすぎます（5MBまで）。期間を分けて書き出してください。'));
      return;
    }
    const { items, errors } = parseMfRows(parseCSV(decodeCSVBytes(new Uint8Array(await file.arrayBuffer()))));
    if (errors.length) {
      status.replaceChildren(h('p', { class: 'error' }, 'エラーがあるため取り込みませんでした。'),
        h('ul', { class: 'error small' }, errors.slice(0, 10).map((m) => h('li', {}, m))));
      return;
    }
    const sharedId = sharedAccountId();
    if (!sharedId) {
      status.replaceChildren(h('p', { class: 'error' }, '先に共通口座を設定してください（このページの「共通口座の収支」または設定画面）。'));
      return;
    }
    const { inScope, skipped, manual, unknown } = classifyMf(items, { accounts: state.data.accounts, cards: state.data.cards, sharedAccountId: sharedId });
    const hint = [
      manual ? h('p', { class: 'meta' }, `手入力の記録 ${manual}件は対象外`) : null,
      unknown.length
        ? h('p', { class: 'meta' }, `対象外の金融機関: ${unknown.join('、')}`, helpButton('対象外の金融機関', '共通口座や、共通口座から引き落とされるカードなら、口座・カードの台帳で「マネーフォワードでの名前」にこの名前を入れてください。'))
        : null,
    ].filter(Boolean);
    if (inScope.length === 0) {
      status.replaceChildren(h('p', { class: 'error' }, '共通口座の明細が見つかりませんでした。'), ...hint);
      return;
    }
    const dates = inScope.map((t) => t.date).sort();
    const existing = await fetchAllPaged('transactions', `date=gte.${dates[0]}&date=lte.${dates[dates.length - 1]}&select=mf_id,contract_id,deposit_entry_id,deposit_ignored`);
    const known = new Map(existing.map((t) => [t.mf_id, t.contract_id]));
    const prior = new Map(existing.map((t) => [t.mf_id, t]));
    const contracts = state.data.contracts;
    const rows = inScope.map((t) => ({ ...t, contract_id: known.has(t.mf_id) ? known.get(t.mf_id) : matchContract(t.description, contracts) }));
    const added = rows.filter((t) => !known.has(t.mf_id)).length;
    const linked = rows.filter((t) => !known.has(t.mf_id) && t.contract_id).length;
    // deposits by members (振込名義), recorded in the shared account ledger after saving
    const deposits = depositCandidates(rows.map((t) => ({ ...t, ...(prior.has(t.mf_id) ? { deposit_entry_id: prior.get(t.mf_id).deposit_entry_id, deposit_ignored: prior.get(t.mf_id).deposit_ignored } : {}) })), state.members);
    const countText = (list) => [...new Set(list.map((d) => d.member_id))].map((id) => `${memberNick(id)} ${list.filter((d) => d.member_id === id).length}件`).join('・');
    const ins = deposits.filter((d) => d.tx.amount > 0);
    const outs = deposits.filter((d) => d.tx.amount < 0);
    const depositText = [
      ins.length ? `入金として記録: ${ins.length}件（${countText(ins)}）` : null,
      outs.length ? `共通口座からの受け取りとして記録: ${outs.length}件（${countText(outs)}）` : null,
    ].filter(Boolean).join('　') || null;
    const save = h('button', { type: 'button', class: 'primary', onclick: (ev) => busy(ev.currentTarget, async () => {
      const saved = [];
      for (let i = 0; i < rows.length; i += 500) saved.push(...await db.upsertRows('transactions', rows.slice(i, i + 500), 'mf_id'));
      const recorded = await recordDeposits(depositCandidates(saved, state.members));
      clearTxCache();
      toast(`取り込みました（追加 ${added}件、更新 ${rows.length - added}件${recorded ? `、個人との入出金の記録 ${recorded}件` : ''}）。`);
      input.value = '';
      state.mfBox = null;
      render();
    }) }, '取り込む');
    status.replaceChildren(...[
      h('p', {}, `${dates[0]}〜${dates[dates.length - 1]}：追加 ${added}件（うち契約に自動でひも付け ${linked}件）、更新 ${rows.length - added}件、対象外 ${skipped + manual}件`),
      depositText ? h('p', {}, depositText) : null,
      ...hint,
      h('div', { class: 'actions' }, save)].filter(Boolean));
  }));
  state.mfBox = h('div', { class: 'mf-import' },
    h('div', { class: 'button-row' }, h('label', { class: 'button' }, 'マネーフォワードの CSV を選ぶ', input),
      helpButton('マネーフォワードの取り込み',
        'マネーフォワード ME の入出金（家計簿データ）の CSV を選びます。共通口座と、共通口座から引き落とされるカードの明細だけを保存します。同じ期間を取り込み直しても重複しません。',
        `${ymLabel(DEPOSIT_AUTO_FROM)}以降の明細から、ユーザーの「振込名義」で個人との入出金を見分けて記録します（入金 → その人の入金、個人への出金 → その人の「共通口座からの受け取り」）。依頼人名の部分は見ません。`,
        '手入力の立替の記録（保有金融機関が「なし」）は取り込みません。')),
    status);
  return state.mfBox;
}

function txRow(t) {
  return h('a', { class: 'list-item', href: `#/tx/${t.id}` },
    h('div', { class: 'list-body' },
      h('div', { class: 'list-title' }, t.description || '（内容なし）',
        t.personal_member_id ? h('span', { class: 'tag tag-personal' }, `${memberNick(t.personal_member_id)}の負担${t.settled_entry_id ? '・精算済み' : ''}`) : null,
        t.needs_review ? h('span', { class: 'tag tag-review' }, '確認中') : null,
        t.deposit_entry_id ? h('span', { class: 'tag tag-deposit' }, t.amount < 0 ? '受け取りとして記録済み' : '入金として記録済み') : null),
      h('div', { class: 'muted small' }, [t.date.slice(5).replace('-', '/'), t.institution, t.category && `${t.category}${t.subcategory ? `・${t.subcategory}` : ''}`].filter(Boolean).join('　'))),
    h('span', { class: 'num' }, signedYen(t.amount)),
    icon('chevron', 'ic ic-sm list-chevron'));
}

// Plan (contracts) vs actual (imported statement) for the shared account in one month.
function actualCard(ym) {
  const sharedId = sharedAccountId();
  const head = h('h2', { class: 'with-icon' }, icon('database'), `共通口座の明細（実績）`);
  if (!sharedId) return h('section', { class: 'card' }, head, h('p', { class: 'muted' }, '共通口座を設定すると、マネーフォワードの明細を取り込めます。'));
  const txs = monthTransactions(ym);
  if (txs === null) return h('section', { class: 'card' }, head, h('p', { class: 'muted' }, '読み込み中…'), mfImportBox());
  const sum = summarizeMonth(txs, state.members);
  const planned = state.data.contracts.filter((c) => contractSourceAccountId(c) === sharedId && plannedInMonth(c, ym) > 0);
  const ids = new Set([...planned.map((c) => c.id), ...sum.byContract.keys()]);
  const rows = [...ids].map((id) => find('contracts', id)).filter(Boolean)
    .map((c) => ({ c, plan: plannedInMonth(c, ym), actual: sum.byContract.get(c.id) || 0 }))
    .sort((a, b) => b.plan - a.plan || b.actual - a.actual);
  const planTotal = planned.reduce((n, c) => n + plannedInMonth(c, ym), 0);
  const state1 = (r) => (r.actual === 0 ? (txs.length ? '未確認' : '—') : r.plan === 0 ? '予定外' : r.actual === r.plan ? '一致' : `差 ${signedYen(r.actual - r.plan)}`);
  return h('section', { class: 'card' }, head,
    txs.length === 0 ? h('p', { class: 'muted' }, 'この月の明細はまだ取り込まれていません。') : [
      h('div', { class: 'kpis kpis-3' },
        kpi('入金（外部から）', yen(sum.inflow).replace('円', ''), '円'),
        kpi('出金（外部へ）', yen(sum.outflow).replace('円', ''), '円'),
        kpi('固定費（予定）', yen(planTotal).replace('円', ''), '円')),
      rows.length ? [h('h3', {}, '契約ごとの予定と実績'),
        h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
          h('thead', {}, h('tr', {}, h('th', {}, '契約'), h('th', { class: 'num' }, '予定'), h('th', { class: 'num' }, '実績'), h('th', {}, '状態'))),
          h('tbody', {}, rows.map((r) => h('tr', {},
            h('td', {}, h('a', { href: `#/view/contracts/${r.c.id}` }, r.c.name)),
            h('td', { class: 'num' }, r.plan ? yen(r.plan) : '—'),
            h('td', { class: 'num' }, r.actual ? yen(r.actual) : '—'),
            h('td', { class: r.actual === 0 && r.plan > 0 ? 'warn-text' : '' }, state1(r)))))))] : null,
      sum.byCategory.size ? [h('h3', {}, '契約にない支出（大項目別）'), barChart([...sum.byCategory.entries()], '契約にない支出の大項目別の金額')] : null,
      sum.unlinked.length ? [h('h3', { class: 'with-icon' }, `契約にない明細（${sum.unlinked.length}件）`, helpButton('契約にない明細', '固定費なら、明細を開いて契約にひも付けると、次から自動で照合します。')),
        h('div', { class: 'list' }, sum.unlinked.map(txRow))] : null,
      txs.filter((t) => t.contract_id && t.counted && !t.transfer).length ? h('details', {}, h('summary', {}, '契約にひも付いた明細'),
        h('div', { class: 'list' }, txs.filter((t) => t.contract_id && t.counted && !t.transfer).map(txRow))) : null,
      sum.memberFlows.length ? h('details', {}, h('summary', {}, `個人との入出金（${sum.memberFlows.length}件。外部との入出金には含めず、「個人 ⇔ 共通口座」で扱います）`),
        h('div', { class: 'list' }, sum.memberFlows.map(txRow))) : null,
      sum.personal.length ? h('details', {}, h('summary', {}, `個人負担（${sum.personal.length}件。共通の支出には含めず、本人が精算）`),
        h('div', { class: 'list' }, sum.personal.map(txRow))) : null,
      sum.excluded.length ? h('details', {}, h('summary', {}, `振替・集計対象外（${sum.excluded.length}件。カードの引き落としなど、二重に数えないもの）`),
        h('div', { class: 'list' }, sum.excluded.map(txRow))) : null,
    ],
    mfImportBox());
}

// Record deposits found in the statement and link each line to its record (no double records).
async function recordDeposits(candidates) {
  for (const c of candidates) {
    const [entry] = await db.insertRows('shared_entries', [depositEntryFor(c)]);
    await db.updateRow('transactions', c.tx.id, { deposit_entry_id: entry.id });
  }
  if (candidates.length) await reloadShared();
  return candidates.length;
}

function personalLines() {
  if (state.personal) return state.personal;
  if (state.personal === undefined) return null; // loading
  state.personal = undefined;
  Promise.all([
    fetchAllPaged('transactions', 'personal_member_id=not.is.null&settled_entry_id=is.null&order=date.asc'),
    fetchAllPaged('transactions', 'needs_review=eq.true&order=date.asc'),
  ]).then(([pending, review]) => {
    state.personal = { pending, review };
    const { page } = route();
    if (page === 'flow' || page === 'shared') render();
  }).catch((e) => {
    state.personal = null;
    handleError(e);
  });
  return null;
}

// Settle one person's lines: one 臨時の費目 (plus = they put that much more into the shared account).
async function settlePersonal(memberId, lines) {
  const total = personalTotal(lines);
  if (total <= 0) {
    toast('精算する金額がありません。', 'error');
    return;
  }
  const label = `個人負担の精算（${lines.length}件）`;
  if (!window.confirm(`${memberNick(memberId)}の個人負担 ${lines.length}件・${yen(total)}を、${ymLabel(thisYM())}の臨時の費目として追加します。よろしいですか？`)) return;
  const [entry] = await db.insertRows('shared_entries', [{ member_id: memberId, ym: thisYM(), kind: 'charge', label, amount: total, memo: settlementMemo(lines) }]);
  for (const t of lines) await db.updateRow('transactions', t.id, { settled_entry_id: entry.id });
  await reloadShared();
  clearTxCache();
  state.personal = null;
  toast(`${label}を追加しました。`);
  render();
}

function personalCard() {
  if (!sharedAccountId()) return null;
  const data = personalLines();
  const head = h('h2', { class: 'with-icon' }, icon('user'), '個人負担の精算', helpButton('個人負担の精算',
    '共通口座やカードで払ったもののうち本人が負担するものは、明細を開いて「負担」を「○○の個人負担」にすると、ここにまとまります。',
    '「精算する」を押すと、合計を今月の臨時の費目（その人が共通口座へ追加で入れる額）として追加します。その臨時の費目を削除すると、精算待ちに戻ります。',
    '「確認中」は誰の負担か確かめている明細です。決まるまでは共通の支出として数えます。'));
  if (!data) return h('section', { class: 'card' }, head, h('p', { class: 'muted' }, '読み込み中…'));
  if (data.pending.length === 0 && data.review.length === 0) {
    return h('section', { class: 'card' }, head,
      h('p', { class: 'muted' }, '精算待ちはありません。'));
  }
  const byMember = new Map();
  for (const t of data.pending) {
    if (!byMember.has(t.personal_member_id)) byMember.set(t.personal_member_id, []);
    byMember.get(t.personal_member_id).push(t);
  }
  return h('section', { class: 'card' }, head,
    [...byMember].map(([memberId, lines]) => h('div', { class: 'personal-group' },
      h('div', { class: 'title-row' },
        h('h3', {}, `${memberNick(memberId)}：精算待ち ${lines.length}件・${yen(personalTotal(lines))}`),
        isAdmin() || (me() && me().id === memberId)
          ? h('button', { type: 'button', class: 'primary', onclick: (ev) => busy(ev.currentTarget, () => settlePersonal(memberId, lines)) }, '精算する')
          : null),
      h('div', { class: 'list' }, lines.map(txRow)))),
    data.review.length ? [h('h3', {}, `確認中（${data.review.length}件）`),
      h('div', { class: 'list' }, data.review.map(txRow))] : null,
  );
}

async function relinkUnlinked() {
  const rows = await fetchAllPaged('transactions', 'contract_id=is.null&select=id,description&order=date.asc');
  let n = 0;
  for (const t of rows) {
    const id = matchContract(t.description, state.data.contracts);
    if (id) {
      await db.updateRow('transactions', t.id, { contract_id: id });
      n += 1;
    }
  }
  clearTxCache();
  return n;
}

function renderTx(id) {
  const back = (title) => pageHead({ title, icon: 'flow', back: { href: '#/flow/ext', text: 'お金へ' } });
  setView('明細', back('明細'), h('p', { class: 'muted' }, '読み込み中…'));
  db.selectWhere('transactions', `id=eq.${encodeURIComponent(id)}`).then((rows) => {
    const t = rows[0];
    if (!t) {
      setView('見つかりません', back('明細'), h('p', {}, 'この明細は見つかりませんでした。'));
      return;
    }
    const contracts = [...state.data.contracts].sort(byName);
    const select = h('select', { id: 'f-contract' }, h('option', { value: '' }, '（ひも付けない）'),
      contracts.map((c) => h('option', { value: c.id, selected: c.id === t.contract_id }, c.name + (c.status === 'closed' ? '（解約済み）' : ''))));
    const remember = h('input', { type: 'checkbox', id: 'f-remember', checked: !t.contract_id });
    const keyword = h('input', { type: 'text', id: 'f-keyword', maxlength: 50, value: t.description.replace(/[\s　]+/g, ' ').trim().slice(0, 20), placeholder: '例: 中部電力（毎回変わる部分は消す）' });
    const counted = h('input', { type: 'checkbox', id: 'f-counted', checked: t.counted && !t.transfer, disabled: t.transfer });
    const burdenNow = t.personal_member_id || (t.needs_review ? 'review' : '');
    const burden = h('select', { id: 'f-burden', disabled: Boolean(t.settled_entry_id) },
      h('option', { value: '', selected: burdenNow === '' }, '共通'),
      h('option', { value: 'review', selected: burdenNow === 'review' }, '確認中（誰の負担か確かめる）'),
      state.members.filter((m) => m.active || m.id === t.personal_member_id).sort(byName)
        .map((m) => h('option', { value: m.id, selected: burdenNow === m.id }, `${nick(m)}の個人負担`)));
    const save = h('button', { type: 'button', class: 'primary', onclick: (ev) => busy(ev.currentTarget, async () => {
      const contractId = select.value || null;
      const burdenValues = t.settled_entry_id ? {} : {
        personal_member_id: burden.value && burden.value !== 'review' ? burden.value : null,
        needs_review: burden.value === 'review',
      };
      await db.updateRow('transactions', t.id, { contract_id: contractId, counted: t.transfer ? t.counted : counted.checked, ...burdenValues });
      state.personal = null;
      let relinked = 0;
      if (contractId && remember.checked) {
        const word = keyword.value.trim();
        if (normalizeText(word).length < 2) {
          toast('キーワードは2文字以上にしてください。', 'error');
          return;
        }
        const c = find('contracts', contractId);
        const list = String(c.match_keywords || '').split(/[,、，\n]+/).map((k) => k.trim()).filter(Boolean);
        if (!list.some((k) => normalizeText(k) === normalizeText(word))) {
          const joined = [...list, word].join('、');
          if (joined.length > 500) {
            toast('キーワードが多すぎます。契約の画面で整理してください。', 'error');
            return;
          }
          await db.updateRow('contracts', c.id, { match_keywords: joined });
          await reloadLedger('contracts');
        }
        relinked = await relinkUnlinked();
      }
      clearTxCache();
      toast(relinked ? `保存しました（ほかに ${relinked}件をひも付けました）。` : '保存しました。');
      location.hash = `#/flow/ext/${t.date.slice(0, 7)}`;
    }) }, '保存');
    setView('明細', back(t.description || '明細'),
      h('section', { class: 'card' },
        h('dl', { class: 'shared-figures' },
          h('dt', {}, '日付'), h('dd', {}, t.date),
          h('dt', {}, '金額'), h('dd', { class: 'num' }, signedYen(t.amount)),
          h('dt', {}, '金融機関'), h('dd', {}, t.institution || ''),
          h('dt', {}, '分類'), h('dd', {}, [t.category, t.subcategory].filter(Boolean).join('・')),
          t.memo ? [h('dt', {}, 'メモ'), h('dd', {}, t.memo)] : null),
        t.transfer ? h('p', {}, h('span', { class: 'tag' }, '振替'), helpButton('振替', 'マネーフォワードで「振替」の明細です（カードの引き落としなど）。二重に数えないよう集計に含めません。')) : null),
      h('section', { class: 'card form' },
        h('div', { class: 'field' }, h('label', { for: 'f-contract' }, '契約にひも付ける'), select),
        h('div', { class: 'field checkbox' }, remember, h('label', { for: 'f-remember' }, 'キーワードとして覚え、ほかの明細も照合する')),
        h('div', { class: 'field' }, h('label', { for: 'f-keyword' }, 'キーワード（明細の内容に含まれる語）'), keyword,
),
        h('div', { class: 'field checkbox' }, counted, h('label', { for: 'f-counted' }, '集計に含める')),
        h('div', { class: 'field' }, h('div', { class: 'label-row' }, h('label', { for: 'f-burden' }, '負担'), helpButton('負担',
          '共通口座で払ったが本人が負担するもの（個人の買い物など）は「○○の個人負担」にします。共通の支出から外れ、「個人負担の精算」にまとまります。',
          '精算済みの明細を変えるときは、精算の臨時の費目を先に削除してください。')), burden,
          t.settled_entry_id ? h('span', { class: 'tag' }, '精算済み') : null),
        h('div', { class: 'actions' }, h('a', { class: 'button', href: `#/flow/ext/${t.date.slice(0, 7)}` }, 'キャンセル'), save)));
  }).catch(handleError);
}

// ---------------------------------------------------------------- shared account (共通口座)

function thisYM() {
  return todayJST().slice(0, 7);
}

// Participants in a stable order: whoever was recorded first comes first (as in the former sheet).
function sharedMembers() {
  const ids = participantIds(state.sharedRules, state.sharedEntries);
  const first = (id) => [...state.sharedRules, ...state.sharedEntries].filter((r) => r.member_id === id)
    .map((r) => String(r.created_at || '')).sort()[0] || '';
  return ids.map((id) => memberById(id) || { id, name: '（削除済み）' })
    .sort((a, b) => first(a.id).localeCompare(first(b.id)) || byName(a, b));
}

function signedYen(n) {
  return n < 0 ? `−${yen(-n)}` : yen(n);
}

function sharedHomeCard() {
  const mine = me();
  if (!mine || !participantIds(state.sharedRules, state.sharedEntries).includes(mine.id)) return null;
  const st = statement(state.sharedRules, state.sharedEntries, mine.id, thisYM());
  return h('section', { class: 'card' },
    sectionHead('bank', `共通口座への入金（${Number(thisYM().slice(5))}月）`, { href: `#/flow/member/${thisYM()}`, text: '詳しく' }),
    h('div', { class: 'kpis kpis-2' },
      kpi('当月分', signedYen(st.charges).replace('円', ''), '円'),
      kpi('未入金の残高', signedYen(st.balance).replace('円', ''), '円', st.balance > 0 ? 'kpi-alert' : '')),
    advanceButton(mine.id, thisYM()));
}

function sharedAccountPicker() {
  if (!isAdmin()) return h('p', { class: 'muted' }, 'どの口座が共通口座かは、管理者が設定します。');
  const select = h('select', { 'aria-label': '共通口座にする口座' }, h('option', { value: '' }, '（選んでください）'),
    [...state.data.accounts].sort(byName).map((a) => h('option', { value: a.id, selected: a.id === sharedAccountId() }, accountLabel(a) + (a.status === 'closed' ? '（解約済み）' : ''))));
  const save = h('button', { type: 'button', class: 'primary', onclick: (ev) => busy(ev.currentTarget, async () => {
    if (!select.value) {
      toast('口座を選んでください。', 'error');
      return;
    }
    await saveSetting('shared_account_id', select.value);
    await syncAllContractRules();
    toast('共通口座を設定しました。');
    render();
  }) }, '共通口座にする');
  return h('div', { class: 'inline-form' }, select, save);
}

// Money page: the overall diagram (people -> shared account -> cards -> payees, this month) and the
// balance of the shared account, then two tabs, each with its own month or year:
//   ext    共通口座 ⇔ 外部       statement of the shared account (plan vs actual)
//   member 個人 ⇔ 共通口座       what each member puts in (当月分, deposits, balance)
const MONEY_TABS = { member: '個人 ⇔ 共通口座', ext: '共通口座 ⇔ 外部', flow: '流れ図' };

// 'YYYY-MM' (a month) or 'YYYY' (a year); anything else -> null.
function moneyPeriod(v) {
  if (YM_RE.test(v || '')) return v;
  if (/^\d{4}$/.test(v || '') && Number(v) >= 2000 && Number(v) <= 2100) return v;
  return null;
}

function renderMoney(tabParam, periodParam) {
  const current = thisYM();
  const tab = MONEY_TABS[tabParam] ? tabParam : state.money.tab;
  const period = moneyPeriod(periodParam) || state.money[tab] || current;
  state.money.tab = tab;
  state.money[tab] = period;
  const tabs = Object.entries(MONEY_TABS).map(([key, label]) => ({ key, label, href: `#/flow/${key}/${state.money[key] || current}` }));
  const isYear = period.length === 4;
  const content = tab === 'ext' ? (isYear ? extYearView(period) : extMonthView(period))
    : tab === 'flow' ? flowView(period)
      : (isYear ? memberYearView(period) : memberMonthView(period));
  setView('お金', pageHead({ title: 'お金', icon: 'flow', tabs, tab, sub: periodNav(tab, period) }), ...[content].flat().filter(Boolean));
}

// ---- tab 3: 流れ図 (people -> shared account -> cards -> payees), the balance of the shared account

function flowView(period) {
  const isYear = period.length === 4;
  const unit = isYear ? '年額' : '月額';
  const flow = flowModel(period);
  const lastCol = flow.columns[flow.columns.length - 1];
  const hasFlow = lastCol.length > 0 || flow.columns.length === 4;
  const sharedAcc = flow.sharedId ? find('accounts', flow.sharedId) : null;
  const flowCard = h('section', { class: 'card' },
    h('h2', { class: 'with-icon' }, flow.columns.length === 4 ? `${flow.columns[0].map((p) => p.label).join('・')} → 口座 → カード → 支払先（${unit}）` : `口座 → カード → 支払先（${unit}）`,
      helpButton('お金の流れ図', isYear
        ? '左端はその年に共通口座へ入れる当月分の合計、右側は契約のその年の額（月払いは各月の額の合計、年払いは支払月の額）です。'
        : '左端は共通口座へ入れる当月分、右側はその月の契約の額です（※ 年払いは12で割った額）。',
      '帯の太さは金額です。カードの利用額（変動分）は含みません。名前を押すと詳細を開きます。')),
    hasFlow
      ? flowTree(flow, { unit, isYear })
      : h('p', { class: 'muted' }, '支払方法と金額が入った契約を登録すると、口座からの流れを表示します。'));
  const diff = flow.sharedIn - flow.sharedOut;
  const balanceCard = h('section', { class: 'card' },
    h('h2', { class: 'with-icon' }, icon('bank'), sharedAcc ? `共通口座の収支（${sharedAcc.name}・${unit}）` : '共通口座の収支',
      helpButton('共通口座の収支', '入る額は全員の当月分の合計です。', '出る額は、共通口座から直接、またはこの口座から引き落とされるカードで払う契約の額です（契約の登録が少ないと実際より小さくなります）。')),
    sharedAcc
      ? [h('div', { class: 'kpis kpis-3' },
        kpi('入る額', yen(flow.sharedIn).replace('円', ''), '円'),
        kpi('出る額', yen(flow.sharedOut).replace('円', ''), '円'),
        kpi(diff < 0 ? '差（不足）' : '差（余裕）', signedYen(diff).replace('円', ''), '円', diff < 0 ? 'kpi-alert' : '')),
      diff < 0 ? h('p', { class: 'error with-icon' }, icon('alert'), '共通口座から出る固定費が、入る額より多くなっています。') : null]
      : [h('p', {}, '共通口座にする口座を選ぶと、入る額と出る額を比べられます。'), sharedAccountPicker()]);
  return [flowCard, balanceCard, accountTotalsCard(flow, unit)];
}

// ◀ period ▶ and the month / year switch of one tab.
function periodNav(tab, period) {
  const current = thisYM();
  const isYear = period.length === 4;
  const link = (p) => `#/flow/${tab}/${p}`;
  const year = period.slice(0, 4);
  const now = isYear ? year === current.slice(0, 4) : period === current;
  const monthOfYear = year === current.slice(0, 4) ? current : `${year}-01`;
  return [
    h('div', { class: 'month-nav' },
      h('a', { class: 'button small', href: link(isYear ? String(Number(year) - 1) : ymAdd(period, -1)), 'aria-label': isYear ? '前の年' : '前の月' }, '◀'),
      h('div', { class: 'month-label' },
        h('h2', {}, isYear ? `${Number(year)}年` : ymLabel(period)),
        now ? h('span', { class: 'badge badge-now' }, isYear ? '今年' : '今月')
          : h('a', { class: 'badge badge-jump', href: link(isYear ? current.slice(0, 4) : current) }, isYear ? '今年へ' : '今月へ')),
      h('a', { class: 'button small', href: link(isYear ? String(Number(year) + 1) : ymAdd(period, 1)), 'aria-label': isYear ? '次の年' : '次の月' }, '▶')),
    segmented([
      { label: '月ごと', href: link(isYear ? monthOfYear : period), active: !isYear },
      { label: '年間', href: link(year), active: isYear },
    ], '月ごと・年間'),
  ];
}

// ---- tab 1: 共通口座 ⇔ 外部

function extMonthView(ym) {
  return actualCard(ym);
}

// Statement lines of one year (loaded on demand, cached like the months).
function yearTransactions(year) {
  if (state.txYear.has(year)) return state.txYear.get(year);
  state.txYear.set(year, null);
  fetchAllPaged('transactions', `date=gte.${year}-01-01&date=lt.${Number(year) + 1}-01-01&order=date.asc`)
    .then((rows) => {
      state.txYear.set(year, rows);
      const { page } = route();
      if (page === 'flow' || page === 'shared') render();
    })
    .catch((e) => {
      state.txYear.delete(year);
      handleError(e);
    });
  return null;
}

function clearTxCache() {
  state.tx.clear();
  state.txYear.clear();
}

function extYearView(year) {
  const sharedId = sharedAccountId();
  const head = h('h2', { class: 'with-icon' }, icon('database'), `共通口座の明細（${Number(year)}年）`,
    helpButton('年間の明細', '入金・出金は外部とのお金だけです（個人との入出金・振替・個人負担は含みません）。', '月を押すとその月の詳細を開きます。'));
  if (!sharedId) return h('section', { class: 'card' }, head, h('p', { class: 'muted' }, '共通口座を設定すると、マネーフォワードの明細を取り込めます。'));
  const txs = yearTransactions(year);
  if (txs === null) return h('section', { class: 'card' }, head, h('p', { class: 'muted' }, '読み込み中…'));
  const contracts = state.data.contracts.filter((c) => contractSourceAccountId(c) === sharedId);
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
  const rows = months.map((ym) => {
    const lines = txs.filter((t) => t.date.startsWith(ym));
    const sum = summarizeMonth(lines, state.members);
    return { ym, has: lines.length > 0, inflow: sum.inflow, outflow: sum.outflow, planned: contracts.reduce((n, c) => n + plannedInMonth(c, ym), 0) };
  });
  const year1 = summarizeMonth(txs, state.members);
  const total = (k) => rows.reduce((n, r) => n + r[k], 0);
  const planByContract = new Map(contracts.map((c) => [c.id, months.reduce((n, ym) => n + plannedInMonth(c, ym), 0)]));
  const ids = new Set([...[...planByContract].filter(([, v]) => v > 0).map(([id]) => id), ...year1.byContract.keys()]);
  const contractRows = [...ids].map((id) => find('contracts', id)).filter(Boolean)
    .map((c) => ({ c, plan: planByContract.get(c.id) || 0, actual: year1.byContract.get(c.id) || 0 }))
    .sort((a, b) => b.plan - a.plan || b.actual - a.actual);
  const numCell = (v, has) => h('td', { class: 'num' }, has ? yen(v) : '—');
  return [
    h('section', { class: 'card' }, head,
      txs.length === 0 ? h('p', { class: 'muted' }, 'この年の明細はまだ取り込まれていません。') : null,
      h('div', { class: 'kpis kpis-3' },
        kpi('入金（外部から）', yen(year1.inflow).replace('円', ''), '円'),
        kpi('出金（外部へ）', yen(year1.outflow).replace('円', ''), '円'),
        kpi('固定費（予定）', yen(total('planned')).replace('円', ''), '円')),
      h('div', { class: 'table-wrap' }, h('table', { class: 'table year-table' },
        h('thead', {}, h('tr', {}, h('th', {}, '月'), h('th', { class: 'num' }, '入金'), h('th', { class: 'num' }, '出金'), h('th', { class: 'num' }, '固定費（予定）'))),
        h('tbody', {},
          rows.map((r) => h('tr', {},
            h('th', { scope: 'row' }, h('a', { href: `#/flow/ext/${r.ym}` }, `${Number(r.ym.slice(5))}月`)),
            numCell(r.inflow, r.has), numCell(r.outflow, r.has), h('td', { class: 'num' }, r.planned ? yen(r.planned) : '—'))),
          h('tr', { class: 'total' }, h('th', { scope: 'row' }, '合計'), numCell(total('inflow'), true), numCell(total('outflow'), true), numCell(total('planned'), true))))),
),
    contractRows.length ? h('section', { class: 'card' },
      h('h2', {}, '契約ごとの予定と実績（年間）'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, h('th', {}, '契約'), h('th', { class: 'num' }, '予定'), h('th', { class: 'num' }, '実績'), h('th', { class: 'num' }, '差'))),
        h('tbody', {}, contractRows.map((r) => h('tr', {},
          h('td', {}, h('a', { href: `#/view/contracts/${r.c.id}` }, r.c.name)),
          h('td', { class: 'num' }, r.plan ? yen(r.plan) : '—'),
          h('td', { class: 'num' }, r.actual ? yen(r.actual) : '—'),
          h('td', { class: 'num' }, r.plan && r.actual ? signedYen(r.actual - r.plan) : '—'))))))) : null,
    year1.byCategory.size ? h('section', { class: 'card' },
      h('h2', {}, '契約にない支出（大項目別・年間）'),
      barChart([...year1.byCategory.entries()].sort((a, b) => b[1] - a[1]), '契約にない支出の大項目別の年間の金額')) : null,
  ];
}

// ---- tab 2: 個人 ⇔ 共通口座

// Shared costs paid from a personal account (not imported): the planned amount and whose 当月分 it reduces.
function personalCostsCard() {
  const ctx = deductionContext();
  const rows = state.data.contracts.map((c) => ({ c, d: contractDeduction(c, ctx).target })).filter((x) => x.d)
    .sort((a, b) => memberNick(a.d.member_id).localeCompare(memberNick(b.d.member_id), 'ja') || a.d.amount - b.d.amount);
  return h('section', { class: 'card' },
    h('h2', { class: 'with-icon' }, icon('user'), '個人の口座から払っている共通の費用', helpButton('個人の口座から払っている共通の費用',
      '契約で「共通の費用」にし、支払元を個人の口座（またはその口座から引き落とされるカード）にすると、ここに出ます。',
      '個人の口座の明細は取り込まないため、予定の額です。その人の当月分から差し引きます。')),
    rows.length === 0
      ? h('p', { class: 'muted' }, 'ありません。')
      : [h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, h('th', {}, '契約'), h('th', {}, '差し引く人'), h('th', {}, 'いつ'), h('th', { class: 'num' }, '金額（予定）'))),
        h('tbody', {}, rows.map(({ c, d }) => h('tr', {},
          h('td', {}, h('a', { href: `#/view/contracts/${c.id}` }, c.name)),
          h('td', {}, memberNick(d.member_id)),
          h('td', {}, d.month_of_year ? `毎年${d.month_of_year}月` : '毎月'),
          h('td', { class: 'num' }, yen(-d.amount)))))))]);
}

function memberIntroCard() {
  return h('section', { class: 'card' },
    h('h2', {}, '共通口座への入金'),
    h('p', {}, '共通口座への入金を、人ごとに管理します。まず「定例項目」（毎月の基本の額や、個人で払っている共通の費用）を登録してください。'),
    isAdmin() ? h('a', { class: 'button primary', href: '#/shared-rule/new' }, '＋ 定例項目を追加') : null);
}

// 「立替を記録」: on one's own card (administrators: on every card).
function advanceButton(memberId, ym) {
  const mine = me();
  if (!isAdmin() && !(mine && mine.id === memberId)) return null;
  return h('div', { class: 'button-row equal' },
    h('a', { class: 'button primary', href: `#/shared-entry/new/advance:${memberId}:${ym}` }, '立替を記録'),
    h('a', { class: 'button', href: `#/deposit-report/new/${memberId}` }, '入金を報告'));
}

function memberMonthView(ym) {
  const current = thisYM();
  const members = sharedMembers();
  const { sharedRules: rules, sharedEntries: entries } = state;
  if (members.length === 0) return [memberIntroCard(), personalCostsCard(), personalCard()];
  const sts = members.map((m) => ({ m, st: statement(rules, entries, m.id, ym) }));

  // per-member cards
  const cards = h('div', { class: 'shared-cards' }, sts.map(({ m, st }) => h('section', { class: 'card shared-card' },
    h('h3', { class: 'with-icon' }, icon('user'), nick(m)),
    h('dl', { class: 'shared-figures' },
      h('dt', {}, '当月分'), h('dd', { class: 'num' }, signedYen(st.charges)),
      h('dt', {}, '入金済み'), h('dd', { class: 'num' }, yen(st.deposit)),
      h('dt', {}, '未入金の残高'), h('dd', { class: `num big${st.balance > 0 ? ' due' : ''}` }, signedYen(st.balance))),
    advanceButton(m.id, ym))));

  // the month as in the former spreadsheet
  // recurring items (定例) and one-off items (臨時) are shown as separate groups
  const isRule = (i) => Boolean(i.rule);
  const labelsOf = (pick) => {
    const out = [];
    for (const { st } of sts) for (const i of st.items) if (pick(i) && !out.includes(i.label)) out.push(i.label);
    return out;
  };
  const ruleLabels = labelsOf(isRule);
  const tempLabels = labelsOf((i) => !isRule(i));
  const cell = (st, label, rule) => {
    const hits = st.items.filter((i) => i.label === label && isRule(i) === rule);
    return h('td', { class: 'num' }, hits.length ? signedYen(hits.reduce((n, i) => n + i.amount, 0)) : '—');
  };
  const row = (label, f, cls) => h('tr', { class: cls }, h('th', { scope: 'row' }, label), sts.map(({ st }) => f(st)));
  const group = (title, labels, rule) => (labels.length === 0 ? null : [
    h('tr', { class: 'group' }, h('th', { scope: 'rowgroup', colspan: String(sts.length + 1) }, title)),
    labels.map((l) => row(l, (st) => cell(st, l, rule), 'item')),
  ]);
  const table = h('div', { class: 'table-wrap' }, h('table', { class: 'table shared-table' },
    h('thead', {}, h('tr', {}, h('th', {}, '費目'), sts.map(({ m }) => h('th', { class: 'num' }, nick(m))))),
    h('tbody', {},
      row('前月繰越', (st) => h('td', { class: 'num' }, signedYen(st.carry)), 'sub'),
      group('定例（毎月）', ruleLabels, true),
      group('臨時（この月だけ）', tempLabels, false),
      row('当月分（小計）', (st) => h('td', { class: 'num' }, signedYen(st.charges)), 'subtotal'),
      row('合計', (st) => h('td', { class: 'num' }, signedYen(st.total)), 'total'),
      row('入金', (st) => h('td', { class: 'num' }, st.deposit ? yen(st.deposit) : '—')),
      row('未入金（翌月へ）', (st) => h('td', { class: 'num' }, signedYen(st.balance)), 'total'))));

  const monthEntries = entries.filter((e) => e.ym === ym)
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'charge' ? -1 : 1) || String(a.created_at || '').localeCompare(String(b.created_at || '')));
  const entryList = monthEntries.length === 0
    ? h('p', { class: 'muted' }, 'この月の臨時の費目・入金はありません（定例だけです）。')
    : h('div', { class: 'list' }, monthEntries.map((e) => h('a', { class: 'list-item', href: `#/shared-entry/${e.id}` },
      h('div', { class: 'list-body' },
        h('div', { class: 'list-title' }, `${memberNick(e.member_id)}：${e.kind === 'deposit' ? '入金' : e.label}`,
          attachmentsOf('entry', e.id).length ? h('span', { class: 'tag tag-attach' }, '添付あり') : null),
        [e.paid_on ? dateText(e.paid_on) : null, e.memo].filter(Boolean).length
          ? h('div', { class: 'muted small' }, [e.paid_on ? dateText(e.paid_on) : null, e.memo].filter(Boolean).join('　')) : null),
      h('span', { class: 'num' }, e.kind === 'deposit' ? yen(e.amount) : signedYen(e.amount)),
      icon('chevron', 'ic ic-sm list-chevron'))));

  // balance over time
  const start = firstYM(rules, entries);
  const end = ym > current ? ym : current;
  const series = members.map((m, i) => {
    const byYM = new Map(history(rules, entries, m.id, end).map((r) => [r.ym, r.balance]));
    const points = [];
    for (let x = start; x <= end; x = ymAdd(x, 1)) points.push({ x, y: byYM.get(x) ?? 0 });
    return { label: nick(m), color: `var(--series-${i + 1})`, points };
  });
  const legend = h('div', { class: 'legend' }, series.map((s) => {
    const sw = h('span', { class: 'swatch' });
    sw.style.background = s.color;
    return h('span', {}, sw, `${s.label} ${signedYen(s.points[s.points.length - 1].y)}`);
  }));

  const rulesByMember = members.map((m) => {
    const list = rules.filter((r) => r.member_id === m.id)
      .sort((a, b) => (a.end_ym && a.end_ym < current) - (b.end_ym && b.end_ym < current) || b.start_ym.localeCompare(a.start_ym));
    return h('div', {}, h('h3', {}, nick(m)), h('div', { class: 'list' }, list.map((r) => h('a', { class: `list-item${r.end_ym && r.end_ym < current ? ' ended' : ''}`, href: `#/shared-rule/${r.id}` },
      h('div', { class: 'list-body' },
        h('div', { class: 'list-title' }, r.label, r.contract_id ? h('span', { class: 'tag tag-contract' }, '契約') : null),
        h('div', { class: 'muted small' }, ruleSchedule(r))),
      h('span', { class: 'num' }, signedYen(r.amount)),
      icon('chevron', 'ic ic-sm list-chevron')))));
  });
  return [
    h('section', { class: 'month-panel', 'aria-label': `${ymLabel(ym)}の入金状況` },
      h('h2', { class: 'with-icon' }, '共通口座への入金状況', helpButton('共通口座への入金状況', '入金はマネーフォワードの明細から自動で記録します（取り込みは管理者）。', '立替は自分のカードの「立替を記録」、振り込んだら「入金を報告」から入れます。')),
      cards),
    h('section', { class: 'card' },
      h('h2', { class: 'with-icon' }, `${ymLabel(ym)}の内訳`, helpButton('内訳',
        'プラスは共通口座へ入れる額、マイナスは個人で払った共通の費用（入れる額から差し引き）です。',
        '合計 = 前月繰越 + 当月分。共通口座から個人へ出たお金は「共通口座からの受け取り」（プラス）として自動で入ります。')),
      table,
      h('h3', {}, 'この月の立替・入金など'),
      entryList,
      isAdmin() ? h('div', { class: 'button-row equal' },
        h('a', { class: 'button', href: `#/shared-entry/new/deposit::${ym}` }, '＋ 入金（管理者）'),
        h('a', { class: 'button', href: `#/shared-entry/new/charge::${ym}` }, '＋ 臨時の費目（管理者）')) : null),
    depositReportsCard(ym, sts),
    personalCostsCard(),
    personalCard(),
    h('section', { class: 'card' },
      h('h2', {}, '未入金の残高の推移'),
      lineChart(series, '人ごとの未入金の残高の推移'),
      legend),
    h('section', { class: 'card' },
      cardHead(null, '定例項目', {
        help: ['毎月自動で計上されます。', isAdmin() ? '金額が変わるときは、今の項目に終了月を入れ、新しい金額で追加します。' : '定例項目は管理者が設定します。'],
        action: isAdmin() ? h('a', { class: 'button small', href: '#/shared-rule/new' }, '＋ 追加') : null,
      }),
      rulesByMember),
  ];
}

function memberYearView(year) {
  const members = sharedMembers();
  const { sharedRules: rules, sharedEntries: entries } = state;
  if (members.length === 0) return [memberIntroCard(), personalCostsCard()];
  const cards = members.map((m) => {
    const last12 = year === thisYM().slice(0, 4) ? thisYM() : `${year}-12`; // future months are not shown
    const rows = history(rules, entries, m.id, last12).filter((r) => r.ym.startsWith(`${year}-`));
    const head = h('h2', { class: 'with-icon' }, icon('user'), `${nick(m)}（${Number(year)}年）`);
    if (rows.length === 0) return h('section', { class: 'card' }, head, h('p', { class: 'muted' }, 'この年の記録はありません。'));
    const charges = rows.reduce((n, r) => n + r.charges, 0);
    const deposit = rows.reduce((n, r) => n + r.deposit, 0);
    const last = rows[rows.length - 1];
    return h('section', { class: 'card member-year' }, head,
      h('div', { class: 'kpis kpis-3' },
        kpi('当月分の合計', signedYen(charges).replace('円', ''), '円'),
        kpi('入金の合計', yen(deposit).replace('円', ''), '円'),
        kpi(last.ym.endsWith('-12') ? '年末の未入金' : `${Number(last.ym.slice(5))}月末の未入金`, signedYen(last.balance).replace('円', ''), '円', last.balance > 0 ? 'kpi-alert' : '')),
      h('div', { class: 'table-wrap' }, h('table', { class: 'table year-table' },
        h('thead', {}, h('tr', {}, h('th', {}, '月'), h('th', { class: 'num' }, '当月分'), h('th', { class: 'num' }, '入金'), h('th', { class: 'num' }, '未入金の残高'))),
        h('tbody', {},
          rows.map((r) => h('tr', {},
            h('th', { scope: 'row' }, h('a', { href: `#/flow/member/${r.ym}` }, `${Number(r.ym.slice(5))}月`)),
            h('td', { class: 'num' }, signedYen(r.charges)),
            h('td', { class: 'num' }, r.deposit ? yen(r.deposit) : '—'),
            h('td', { class: `num${r.balance > 0 ? ' due' : ''}` }, signedYen(r.balance)))),
          h('tr', { class: 'total' }, h('th', { scope: 'row' }, '合計'), h('td', { class: 'num' }, signedYen(charges)), h('td', { class: 'num' }, yen(deposit)), h('td', { class: 'num' }, signedYen(last.balance)))))),
      h('p', { class: 'meta' }, `前年からの繰越 ${signedYen(rows[0].carry)}`));
  });
  return [...cards, personalCostsCard()];
}

function accountTotalsCard(flow, unit = '月額') {
  const rows = flow.accounts.filter((n) => n.out > 0);
  if (rows.length === 0) return null;
  return h('section', { class: 'card' },
    h('h2', { class: 'with-icon' }, icon('bank'), `口座ごとの引き落とし（${unit}）`),
    h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', {}, '口座'), h('th', { class: 'num' }, unit))),
      h('tbody', {}, rows.map((n) => {
        const sw = h('span', { class: 'swatch' });
        sw.style.background = n.color;
        return h('tr', {}, h('td', {}, sw, n.href ? h('a', { href: n.href }, n.label) : n.label), h('td', { class: 'num' }, yen(n.out)));
      }))));
}

function sharedMemberSelect(id, value) {
  const ids = new Set(participantIds(state.sharedRules, state.sharedEntries));
  const choices = state.members.filter((m) => m.active || ids.has(m.id) || m.id === value).sort(byName);
  return h('select', { id }, choices.map((m) => h('option', { value: m.id, selected: m.id === value }, nick(m) + (m.active ? '' : '（無効）'))));
}

function labelSuggestions(listId) {
  const labels = [...new Set([...state.sharedRules.map((r) => r.label), ...state.sharedEntries.filter((e) => e.kind === 'charge').map((e) => e.label)])].sort();
  return h('datalist', { id: listId }, labels.map((l) => h('option', { value: l })));
}

const SHARED_ENTRY_FIELDS = {
  ym: { key: 'ym', label: '月', type: 'month', required: true, help: '' },
  label: { key: 'label', label: '費目', type: 'text', required: true, max: 50 },
  amount: { key: 'amount', label: '金額（円）', type: 'yen', required: true, max: 100000000, help: 'プラス＝共通口座へ入れる額、マイナス＝個人で払った共通の費用（例: -2662）' },
  deposit: { key: 'amount', label: '入金額（円）', type: 'yen', required: true, min: 1, max: 100000000 },
  memo: { key: 'memo', label: 'メモ', type: 'textarea', max: 2000 },
};

async function reloadShared() {
  [state.sharedRules, state.sharedEntries, state.depositReports, state.attachments] = await Promise.all([
    db.selectAll('shared_rules', 'start_ym.asc'), db.selectAll('shared_entries', 'ym.asc'),
    db.selectAll('deposit_reports', 'paid_on.asc'), db.selectAll('shared_attachments', 'created_at.asc')]);
}

function sharedForm({ title, back, fields, extra, onSave, onDelete }) {
  const summary = h('div', { class: 'error', role: 'alert' });
  const submit = h('button', { type: 'submit', class: 'primary' }, '保存');
  const form = h('form', { class: 'card form', novalidate: true, onsubmit: (ev) => {
    ev.preventDefault();
    busy(submit, async () => {
      for (const p of form.querySelectorAll('.field-error')) p.textContent = '';
      summary.textContent = '';
      const errors = [];
      const values = {};
      for (const i of fields) {
        const res = parseField(i.field, i.get());
        if (res.error) errors.push({ key: i.field.key, message: res.error });
        else if (res.value === null && i.field.type === 'month' && i.field.required) errors.push({ key: i.field.key, message: `${i.field.label}を入力してください。` });
        else values[i.field.key] = res.value;
      }
      const more = extra.validate ? extra.validate(values) : [];
      errors.push(...more);
      if (errors.length) {
        for (const e of errors) {
          const box = form.querySelector(`[data-key="${e.key}"] .field-error`);
          if (box) box.textContent = e.message;
        }
        summary.textContent = `入力内容を確認してください（${errors.length}件）。`;
        return;
      }
      await onSave({ ...values, ...extra.values() });
    });
  } },
  summary, extra.before || null, fields.map((i) => i.el), extra.after || null,
  h('div', { class: 'actions' }, h('a', { class: 'button', href: back }, 'キャンセル'), submit));
  const del = onDelete ? h('button', { type: 'button', class: 'danger', onclick: (ev) => busy(ev.currentTarget, onDelete) }, '削除') : null;
  setView(title, pageHead({ title, icon: 'flow', back: { href: back, text: '戻る' } }), form, del ? h('div', { class: 'actions' }, del) : null);
}

// Who may change a record of the shared account ledger (the database enforces the same rule):
// administrators everything; a member only their own one-off items (立替 etc.). Deposits come from the
// statement import.
function canWriteEntry(e) {
  const mine = me();
  return isAdmin() || Boolean(mine && e.kind === 'charge' && e.member_id === mine.id);
}

const ADVANCE_FIELD = { key: 'amount', label: '立て替えた額（円）', type: 'yen', required: true, min: 1, max: 100000000, help: 'プラスで入力します。日付の月の当月分から差し引きます。' };
const PAID_ON_FIELD = { key: 'paid_on', label: '日付', type: 'date', required: true };
const MAX_ATTACHMENTS = 3;

function dateText(d) {
  const [y, m, day] = String(d).split('-').map(Number);
  return `${y}/${m}/${day}`;
}

// kind: 'entry' (one-off item) | 'report' (deposit report)
function attachmentsOf(kind, id) {
  return state.attachments.filter((a) => (kind === 'entry' ? a.entry_id : a.report_id) === id);
}

// Thumbnails of saved attachments (tap to enlarge); with onRemove, each has a delete button.
function attachmentThumbs(list, onRemove) {
  return h('div', { class: 'photos' }, list.map((p) => {
    const img = h('img', { alt: '添付画像', loading: 'lazy' });
    photoUrl(p.thumb_path).then((url) => { img.src = url; }).catch((e) => console.error(e.detail || e));
    return h('figure', { class: 'photo' },
      h('button', { type: 'button', class: 'photo-open', onclick: () => openPhoto(p), 'aria-label': '画像を拡大' }, img),
      onRemove ? h('button', { type: 'button', class: 'small danger', onclick: (ev) => busy(ev.currentTarget, () => onRemove(p)) }, '削除') : null);
  }));
}

// Picker for up to MAX_ATTACHMENTS images: saved ones (removable at once) + new ones (uploaded on save).
// Returns { el, files: () => [File], firstImage: () => File | saved row | null }.
function attachmentBox(kind, parentId, title, onRead = null) {
  const pending = [];
  const box = h('div', { class: 'field attach-box' });
  const status = h('p', { class: 'muted small', role: 'status' });
  const input = h('input', { type: 'file', accept: 'image/*', multiple: true, id: `attach-${kind}`, class: 'visually-hidden' });
  const saved = () => (parentId ? attachmentsOf(kind, parentId) : []);
  const draw = () => {
    const previews = pending.map((file, i) => {
      const url = URL.createObjectURL(file);
      const img = h('img', { alt: '追加する画像', src: url });
      return h('figure', { class: 'photo' }, img,
        h('button', { type: 'button', class: 'small', onclick: () => { pending.splice(i, 1); URL.revokeObjectURL(url); draw(); } }, '外す'));
    });
    box.replaceChildren(...[
      h('div', { class: 'label-row' }, h('span', { class: 'label' }, `${title}（${saved().length + pending.length}/${MAX_ATTACHMENTS}）`),
        helpButton(title, `${MAX_ATTACHMENTS}枚まで。縮小してから保存します。`, 'カード番号の全桁などが写っていないか確認してください。', onRead ? '「画像から読む」で金額・日付などの候補を入れます。保存前に確認してください。' : null)),
      saved().length ? attachmentThumbs(saved(), async (p) => {
        if (!window.confirm('この画像を削除しますか？')) return;
        await removeAttachments([p]);
        draw();
      }) : null,
      previews.length ? h('div', { class: 'photos' }, previews) : null,
      h('div', { class: 'button-row' },
        saved().length + pending.length < MAX_ATTACHMENTS ? h('label', { for: `attach-${kind}`, class: 'button' }, '画像を追加（撮影・選択）') : null,
        onRead && (pending.length || saved().length) ? h('button', { type: 'button', onclick: (ev) => busy(ev.currentTarget, () => readFirstImage()) }, '画像から読む（OCR）') : null),
      input,
      status].filter(Boolean));
  };
  // OCR of the first image (the one just added, or the first saved one); onRead gets the parsed values
  const readFirstImage = async () => {
    const first = pending[0] || saved()[0];
    if (!first) return;
    status.textContent = '読み取りの準備をしています（初回は数MBを読み込みます）…';
    try {
      const image = first instanceof Blob ? first : await db.downloadPhoto(first.path);
      const text = await recognizeImage(image, (p, label) => { status.textContent = `${label}…${Math.round(p * 100)}%`; });
      status.textContent = onRead(parseOcrText(text, kind === 'entry' ? 'receipt' : 'transfer'));
    } catch (e) {
      console.error(`ocr failed: ${e && e.message}`);
      status.textContent = '画像を読み取れませんでした。手で入力してください。';
    }
  };
  input.addEventListener('change', () => {
    const files = [...input.files];
    input.value = '';
    const room = MAX_ATTACHMENTS - saved().length - pending.length;
    if (files.length > room) toast(`画像は${MAX_ATTACHMENTS}枚までです。`, 'error');
    pending.push(...files.slice(0, Math.max(0, room)));
    draw();
  });
  draw();
  return { el: box, files: () => [...pending], firstImage: () => pending[0] || saved()[0] || null, status };
}

// Put OCR suggestions into the form (the user checks them before saving). Returns the message to show.
function fillFromOcr(form, result, { memo = false } = {}) {
  const set = (id, value) => {
    const el = form.querySelector(`#${id}`);
    if (!el || value === null || value === undefined || value === '') return false;
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  };
  const got = [];
  if (set('f-amount', result.amount)) got.push(`金額 ${yen(result.amount)}`);
  if (set('f-paid_on', result.date)) got.push(`日付 ${dateText(result.date)}`);
  if (memo) {
    const text = receiptMemo(result);
    const el = form.querySelector('#f-memo');
    if (text && el) {
      el.value = el.value.trim() ? `${el.value.trim()}\n${text}` : text;
      got.push('店名・品目（メモ）');
    }
  }
  return got.length ? `読み取った値を入れました（${got.join('、')}）。保存する前に確認・修正してください。` : '金額や日付を読み取れませんでした。手で入力してください。';
}

// Compress and upload images for a record; returns how many were saved.
async function uploadAttachments(kind, parentId, files, status) {
  let done = 0;
  for (const file of files) {
    if (status) status.textContent = `画像を保存しています（${done + 1}/${files.length}）…`;
    let compressed;
    try {
      compressed = await compressImage(file);
    } catch (e) {
      console.error(e.message);
      toast(`「${file.name}」は画像として読み込めませんでした（JPEG・PNG などを選んでください。30MB まで）。`, 'error');
      continue;
    }
    const id = crypto.randomUUID();
    const dir = kind === 'entry' ? 'receipts' : 'deposit-reports';
    const path = `${dir}/${parentId}/${id}.jpg`;
    const thumbPath = `${dir}/${parentId}/${id}_thumb.jpg`;
    try {
      await db.uploadPhoto(path, compressed.photo);
      await db.uploadPhoto(thumbPath, compressed.thumb);
      await db.insertRows('shared_attachments', [{ id, [kind === 'entry' ? 'entry_id' : 'report_id']: parentId, path, thumb_path: thumbPath, bytes: compressed.photo.size + compressed.thumb.size }]);
      done += 1;
    } catch (e) {
      handleError(e);
      db.removePhotos([path, thumbPath]).catch((err) => console.error(err.detail || err));
    }
  }
  return done;
}

async function removeAttachments(list) {
  if (list.length === 0) return;
  for (const p of list) await db.deleteWhere('shared_attachments', 'id', p.id);
  await db.removePhotos(list.flatMap((p) => [p.path, p.thumb_path])).catch((e) => console.error(e.detail || e));
  const ids = new Set(list.map((p) => p.id));
  state.attachments = state.attachments.filter((p) => !ids.has(p.id));
}

// preset: "kind:memberId:ym" (kind = advance | charge | deposit).
function renderSharedEntry(id, preset) {
  const isNew = id === 'new';
  const mine = me();
  let e = isNew ? null : state.sharedEntries.find((x) => x.id === id);
  if (!isNew && !e) {
    setView('見つかりません', h('p', {}, 'この記録は見つかりませんでした。'), h('a', { href: '#/flow/member' }, 'お金へ戻る'));
    return;
  }
  let advance;
  if (isNew) {
    const [kind, memberId, ym] = String(preset || '').split(':');
    // members record only their own 立替
    const k = isAdmin() && ['deposit', 'charge'].includes(kind) ? kind : 'advance';
    advance = k === 'advance';
    e = {
      kind: k === 'deposit' ? 'deposit' : 'charge',
      member_id: isAdmin() && memberId ? memberId : mine.id,
      ym: ym && YM_RE.test(ym) ? ym : thisYM(),
      paid_on: advance ? todayJST() : null,
      label: k === 'deposit' ? '入金' : advance ? '立替' : '',
    };
  } else {
    advance = e.kind === 'charge' && (e.amount < 0 || Boolean(e.paid_on)) && !(isAdmin() && !e.paid_on);
  }
  const back = `#/flow/member/${e.ym}`;
  const deposit = e.kind === 'deposit';
  const name = deposit ? '入金' : advance ? '立替' : '臨時の費目';
  const files = deposit ? [] : attachmentsOf('entry', e.id);
  if (!isNew && !canWriteEntry(e)) {
    setView(name, pageHead({ title: `${memberNick(e.member_id)}の${name}`, icon: 'flow', back: { href: back, text: 'お金へ' } }),
      h('section', { class: 'card' },
        h('dl', { class: 'shared-figures' },
          h('dt', {}, '人'), h('dd', {}, memberNick(e.member_id)),
          e.paid_on ? [h('dt', {}, '日付'), h('dd', {}, dateText(e.paid_on))] : [h('dt', {}, '月'), h('dd', {}, ymLabel(e.ym))],
          h('dt', {}, '費目'), h('dd', {}, e.label),
          h('dt', {}, '金額'), h('dd', { class: 'num' }, deposit ? yen(e.amount) : signedYen(e.amount)),
          e.memo ? [h('dt', {}, 'メモ'), h('dd', {}, e.memo)] : null),
        files.length ? attachmentThumbs(files) : null,
        h('p', { class: 'meta with-icon' }, deposit ? '明細から自動で記録' : '本人と管理者だけが変更できます',
          helpButton('変更できる人', deposit ? '入金はマネーフォワードの明細から自動で記録しています。直すときは管理者に連絡してください。' : '自分の記録だけ変更できます。直すときは本人か管理者に連絡してください。'))));
    return;
  }
  const fixedMember = !isAdmin();
  const member = fixedMember ? null : sharedMemberSelect('f-member', e.member_id);
  const memberField = fixedMember
    ? h('p', { class: 'muted' }, `人: ${memberNick(e.member_id)}`)
    : h('div', { class: 'field', 'data-key': 'member_id' }, h('label', { for: 'f-member' }, '人'), member, h('p', { class: 'error small field-error' }));
  const f = SHARED_ENTRY_FIELDS;
  const shown = advance ? { ...e, amount: isNew ? null : -e.amount } : e;
  // 立替 by date; older items (moved from the spreadsheet) keep their month
  const byDate = advance && (isNew || Boolean(e.paid_on));
  const when = byDate ? PAID_ON_FIELD : f.ym;
  const defs = deposit ? [f.ym, f.deposit, f.memo] : [when, f.label, advance ? ADVANCE_FIELD : f.amount, f.memo];
  const fields = defs.map((field) => ({ ...fieldInput(field, shown), field }));
  if (!deposit) fields[1].el.querySelector('input').setAttribute('list', 'shared-labels');
  const attach = deposit ? null : attachmentBox('entry', isNew ? null : e.id, '領収書などの画像',
    advance ? (result) => fillFromOcr(view(), result, { memo: true }) : null);
  sharedForm({
    title: isNew ? `${name}を記録` : `${name}を編集`,
    back,
    fields,
    extra: {
      before: memberField,
      after: deposit ? null : h('div', {}, labelSuggestions('shared-labels'), attach.el),
      values: () => ({ member_id: fixedMember ? e.member_id : member.value, kind: e.kind, ...(deposit ? { label: '入金' } : {}) }),
    },
    onSave: async (values) => {
      const row = advance ? { ...values, amount: -values.amount } : { ...values };
      if (byDate) row.ym = row.paid_on.slice(0, 7);
      const saved = isNew ? (await db.insertRows('shared_entries', [row]))[0] : await db.updateRow('shared_entries', id, row);
      if (attach && attach.files().length) await uploadAttachments('entry', saved.id, attach.files(), attach.status);
      await reloadShared();
      toast('保存しました。');
      location.hash = `#/flow/member/${row.ym}`;
    },
    onDelete: isNew ? null : async () => {
      if (!window.confirm(`この${name}を削除します。添付した画像も消えます。元に戻せません。よろしいですか？`)) return;
      const fromStatement = await db.selectWhere('transactions', `deposit_entry_id=eq.${encodeURIComponent(id)}&select=id`);
      for (const t of fromStatement) await db.updateRow('transactions', t.id, { deposit_ignored: true });
      await removeAttachments(attachmentsOf('entry', id));
      await db.deleteWhere('shared_entries', 'id', id);
      clearTxCache();
      state.personal = null;
      await reloadShared();
      toast('削除しました。');
      location.hash = back;
    },
  });
}

// ---- deposit reports (入金報告): reference only, the deposit records come from the statement

const REPORT_FIELDS = [
  { key: 'paid_on', label: '振込日', type: 'date', required: true },
  { key: 'amount', label: '入金した額（円）', type: 'yen', required: true, min: 1, max: 100000000 },
  { key: 'memo', label: 'メモ', type: 'textarea', max: 2000 },
];

function canWriteReport(r) {
  const mine = me();
  return isAdmin() || Boolean(mine && r.member_id === mine.id);
}

// #/deposit-report/new/<memberId> or #/deposit-report/<id>
function renderDepositReport(id, memberParam) {
  const isNew = id === 'new';
  const mine = me();
  const r = isNew
    ? { member_id: isAdmin() && memberParam ? memberParam : mine.id, paid_on: todayJST() }
    : state.depositReports.find((x) => x.id === id);
  if (!r) {
    setView('見つかりません', h('p', {}, 'この入金報告は見つかりませんでした。'), h('a', { href: '#/flow/member' }, 'お金へ戻る'));
    return;
  }
  const back = `#/flow/member/${String(r.paid_on).slice(0, 7)}`;
  if (!isNew && !canWriteReport(r)) {
    setView('入金報告', pageHead({ title: `${memberNick(r.member_id)}の入金報告`, icon: 'flow', back: { href: back, text: 'お金へ' } }),
      h('section', { class: 'card' },
        h('dl', { class: 'shared-figures' },
          h('dt', {}, '振込日'), h('dd', {}, dateText(r.paid_on)),
          h('dt', {}, '金額'), h('dd', { class: 'num' }, yen(r.amount)),
          r.memo ? [h('dt', {}, 'メモ'), h('dd', {}, r.memo)] : null),
        attachmentsOf('report', r.id).length ? attachmentThumbs(attachmentsOf('report', r.id)) : null,
        h('p', { class: 'meta' }, '本人と管理者だけが変更できます')));
    return;
  }
  const fixedMember = !isAdmin();
  const member = fixedMember ? null : sharedMemberSelect('f-member', r.member_id);
  const memberField = fixedMember
    ? h('p', { class: 'muted' }, `人: ${memberNick(r.member_id)}`)
    : h('div', { class: 'field', 'data-key': 'member_id' }, h('label', { for: 'f-member' }, '人'), member, h('p', { class: 'error small field-error' }));
  const fields = REPORT_FIELDS.map((field) => ({ ...fieldInput(field, r), field }));
  const attach = attachmentBox('report', isNew ? null : r.id, '振込完了画面などの画像', (result) => fillFromOcr(view(), result));
  sharedForm({
    title: isNew ? '入金を報告' : '入金報告を編集',
    back,
    fields,
    extra: {
      before: memberField,
      after: attach.el,
      values: () => ({ member_id: fixedMember ? r.member_id : member.value }),
    },
    onSave: async (values) => {
      const saved = isNew ? (await db.insertRows('deposit_reports', [values]))[0] : await db.updateRow('deposit_reports', id, values);
      if (attach.files().length) await uploadAttachments('report', saved.id, attach.files(), attach.status);
      await reloadShared();
      toast(isNew ? '入金を報告しました。' : '保存しました。');
      location.hash = `#/flow/member/${values.paid_on.slice(0, 7)}`;
    },
    onDelete: isNew ? null : async () => {
      if (!window.confirm('この入金報告を削除します。添付した画像も消えます。よろしいですか？')) return;
      await removeAttachments(attachmentsOf('report', id));
      await db.deleteWhere('deposit_reports', 'id', id);
      await reloadShared();
      toast('削除しました。');
      location.hash = back;
    },
  });
}

// Reports of one month next to the deposits recorded from the statement (per member).
function depositReportsCard(ym, sts) {
  const reports = state.depositReports.filter((r) => String(r.paid_on).startsWith(ym));
  return h('section', { class: 'card' },
    h('h2', { class: 'with-icon' }, `入金報告（${ymLabel(ym)}）`, helpButton('入金報告',
      '報告は記録として残すだけで、計算には使いません（入金の実績はマネーフォワードの明細から自動で記録します）。',
      '報告は振込日の月で数えます。明細の取り込みが遅れると差が出ます。')),
    h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', {}, '人'), h('th', { class: 'num' }, '報告の合計'), h('th', { class: 'num' }, '明細からの入金'), h('th', { class: 'num' }, '差'))),
      h('tbody', {}, sts.map(({ m, st }) => {
        const reported = reports.filter((r) => r.member_id === m.id).reduce((n, r) => n + r.amount, 0);
        return h('tr', {},
          h('td', {}, nick(m)),
          h('td', { class: 'num' }, reported ? yen(reported) : '—'),
          h('td', { class: 'num' }, st.deposit ? yen(st.deposit) : '—'),
          h('td', { class: 'num' }, reported || st.deposit ? signedYen(st.deposit - reported) : '—'));
      })))),
    reports.length ? h('div', { class: 'list' }, reports.map((r) => h('a', { class: 'list-item', href: `#/deposit-report/${r.id}` },
      h('div', { class: 'list-body' },
        h('div', { class: 'list-title' }, `${memberNick(r.member_id)}：${dateText(r.paid_on)}`,
          attachmentsOf('report', r.id).length ? h('span', { class: 'tag tag-attach' }, '添付あり') : null),
        r.memo ? h('div', { class: 'muted small' }, r.memo) : null),
      h('span', { class: 'num' }, yen(r.amount)),
      icon('chevron', 'ic ic-sm list-chevron')))) : h('p', { class: 'muted' }, 'この月の入金報告はありません。'),
  );
}

const SHARED_RULE_FIELDS = [
  { key: 'label', label: '費目', type: 'text', required: true, max: 50 },
  { key: 'amount', label: '金額（円/月）', type: 'yen', required: true, max: 10000000, help: 'プラス＝毎月入れる額（基本など）、マイナス＝個人で払っている共通の費用（家賃など）' },
  { key: 'start_ym', label: '開始月', type: 'month', required: true, help: '' },
  { key: 'end_ym', label: '終了月', type: 'month', help: '空欄＝続ける。金額が変わるときは、ここに最後の月を入れて新しい項目を追加します。' },
  { key: 'memo', label: 'メモ', type: 'textarea', max: 2000 },
];

function renderSharedRule(id) {
  const isNew = id === 'new';
  const mine = me();
  const r = isNew ? { member_id: (sharedMembers()[0] || mine || {}).id, start_ym: thisYM() } : state.sharedRules.find((x) => x.id === id);
  if (!r) {
    setView('見つかりません', h('p', {}, 'この定例項目は見つかりませんでした。'), h('a', { href: '#/flow/member' }, 'お金へ戻る'));
    return;
  }
  if (r.contract_id) {
    // kept by the app from the contract: change the contract instead
    const c = find('contracts', r.contract_id);
    setView(`${r.label}（定例）`, pageHead({ title: `${r.label}（定例）`, icon: 'flow', back: { href: '#/flow/member', text: 'お金へ' } }),
      h('section', { class: 'card' },
        h('dl', { class: 'shared-figures' },
          h('dt', {}, '人'), h('dd', {}, memberNick(r.member_id)),
          h('dt', {}, '金額'), h('dd', { class: 'num' }, signedYen(r.amount)),
          h('dt', {}, '期間'), h('dd', {}, ruleSchedule(r))),
        h('p', {}, 'この定例項目は契約から自動で管理しています。金額・支払元・解約などは契約の画面で変更してください（過去の月の計算は変わりません）。'),
        h('div', { class: 'button-row' },
          c ? h('a', { class: 'button primary', href: `#/view/contracts/${c.id}` }, `契約「${c.name}」を開く`) : h('p', { class: 'muted' }, '元の契約は削除されています。'),
          h('a', { class: 'button', href: '#/flow/member' }, '戻る'))));
    return;
  }
  if (!isAdmin()) {
    if (isNew) {
      location.hash = '#/flow/member';
      return;
    }
    setView(`${r.label}（定例）`, pageHead({ title: `${r.label}（定例）`, icon: 'flow', back: { href: '#/flow/member', text: 'お金へ' } }),
      h('section', { class: 'card' },
        h('dl', { class: 'shared-figures' },
          h('dt', {}, '人'), h('dd', {}, memberNick(r.member_id)),
          h('dt', {}, '金額'), h('dd', { class: 'num' }, signedYen(r.amount)),
          h('dt', {}, '期間'), h('dd', {}, ruleSchedule(r)),
          r.memo ? [h('dt', {}, 'メモ'), h('dd', {}, r.memo)] : null),
        h('p', { class: 'meta' }, '管理者だけが変更できます')));
    return;
  }
  const member = sharedMemberSelect('f-member', r.member_id);
  const memberField = h('div', { class: 'field', 'data-key': 'member_id' }, h('label', { for: 'f-member' }, '人'), member, h('p', { class: 'error small field-error' }));
  const fields = SHARED_RULE_FIELDS.map((field) => ({ field, ...fieldInput(field, r) }));
  fields[0].el.querySelector('input').setAttribute('list', 'shared-labels');
  sharedForm({
    title: isNew ? '定例項目を追加' : `${r.label}（定例）を編集`,
    back: '#/flow/member',
    fields,
    extra: {
      before: memberField,
      after: labelSuggestions('shared-labels'),
      values: () => ({ member_id: member.value }),
      validate: (v) => (v.start_ym && v.end_ym && v.end_ym < v.start_ym ? [{ key: 'end_ym', message: '終了月は開始月以降にしてください。' }] : []),
    },
    onSave: async (values) => {
      if (isNew) await db.insertRows('shared_rules', [values]);
      else await db.updateRow('shared_rules', id, values);
      await reloadShared();
      toast('保存しました。');
      location.hash = '#/flow/member';
    },
    onDelete: isNew ? null : async () => {
      if (!window.confirm(`定例項目「${r.label}」を削除します。過去の月の計算からも消えます。金額が変わっただけなら、削除せず終了月を入れてください。よろしいですか？`)) return;
      await db.deleteWhere('shared_rules', 'id', id);
      await reloadShared();
      toast('削除しました。');
      location.hash = '#/flow/member';
    },
  });
}

function transactionsCSV(rows) {
  const head = ['ID', 'マネーフォワードID', '日付', '内容', '金額（円）', '保有金融機関', '大項目', '中項目', 'メモ', '集計対象', '振替', '契約'];
  return toCSV([head, ...rows.map((t) => [t.id, t.mf_id, t.date, t.description, t.amount, t.institution || '', t.category || '', t.subcategory || '', t.memo || '',
    t.counted ? '1' : '0', t.transfer ? '1' : '0', t.contract_id ? (find('contracts', t.contract_id) || { name: '（削除済み）' }).name : ''])]);
}

function sharedRulesCSV() {
  const head = ['ID', '人', '費目', '金額（円/月）', '開始月', '終了月', '年1回の月', '元の契約', 'メモ'];
  const rows = state.sharedRules.map((r) => [r.id, memberNick(r.member_id), r.label, r.amount, r.start_ym, r.end_ym || '',
    r.month_of_year || '', r.contract_id ? (find('contracts', r.contract_id) || { name: '（削除済み）' }).name : '', r.memo || '']);
  return toCSV([head, ...rows]);
}

function sharedEntriesCSV() {
  const head = ['ID', '月', '日付', '人', '種類', '費目', '金額（円）', 'メモ', '添付'];
  const rows = state.sharedEntries.map((e) => [e.id, e.ym, e.paid_on || '', memberNick(e.member_id), e.kind === 'deposit' ? '入金' : '臨時', e.label, e.amount, e.memo || '', attachmentsOf('entry', e.id).length]);
  return toCSV([head, ...rows]);
}

function depositReportsCSV() {
  const head = ['ID', '振込日', '人', '金額（円）', 'メモ', '添付'];
  return toCSV([head, ...state.depositReports.map((r) => [r.id, r.paid_on, memberNick(r.member_id), r.amount, r.memo || '', attachmentsOf('report', r.id).length])]);
}

// ---------------------------------------------------------------- ledgers / list

function renderLedgers() {
  setView('台帳', pageHead({ title: '台帳', icon: 'ledgers' }), h('div', { class: 'tiles tiles-wide' }, LEDGER_ORDER.map((k) => {
    const rows = state.data[k];
    const active = rows.filter((r) => r.status !== 'closed').length;
    return h('a', { class: 'tile', href: `#/list/${k}` },
      ledgerIcon(k),
      h('div', { class: 'tile-count num' }, String(active), h('small', {}, ' 件')),
      h('div', { class: 'tile-label' }, LEDGERS[k].label),
      rows.length > active ? h('div', { class: 'meta' }, `解約済み ${rows.length - active}件`) : null);
  })));
}

function searchText(record) {
  return Object.values(record).flatMap((v) => (Array.isArray(v) ? v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : x)) : [v]))
    .filter((v) => typeof v === 'string').join(' ').toLowerCase();
}

function summaryLine(ledger, r) {
  return LEDGERS[ledger].summary(r).filter(Boolean).join('・');
}

const BRAND_CLASS = { VISA: 'visa', Mastercard: 'master', JCB: 'jcb', 'American Express': 'amex', 'Diners Club': 'diners' };

// A credit card drawn as a card face (brand color, last 4 digits, expiry).
function cardFace(r) {
  const expiry = collectEvents({ cards: [r] }, todayJST()).find((e) => e.type === 'card_expiry');
  const account = r.debit_account_id ? find('accounts', r.debit_account_id) : null;
  const flag = r.status === 'closed'
    ? h('span', { class: 'cc-flag' }, '解約済み')
    : expiry && expiry.daysLeft >= 0 && expiry.daysLeft <= 30
      ? h('span', { class: 'cc-flag' }, icon('alert', 'ic ic-sm'), `期限まで${expiry.daysLeft}日`)
      : null;
  return h('a', { class: 'cc-wrap', href: `#/view/cards/${r.id}` },
    h('div', { class: `cc cc-${BRAND_CLASS[r.brand] || 'other'}${r.status === 'closed' ? ' cc-closed' : ''}` },
      h('div', { class: 'cc-row' }, h('span', { class: 'cc-name' }, r.name), h('span', { class: 'cc-brand' }, [r.kind, r.brand].filter(Boolean).join(' · '))),
      h('div', { class: 'cc-chip' }),
      h('div', { class: 'cc-digits num' }, `●●●● ●●●● ●●●● ${r.last4 || '●●●●'}`),
      h('div', { class: 'cc-row cc-meta' },
        h('span', {}, r.expiry_ym ? `有効期限 ${r.expiry_ym.slice(5)}/${r.expiry_ym.slice(2, 4)}` : '有効期限 未入力'),
        flag)),
    h('div', { class: 'cc-info' },
      h('span', { class: 'with-icon' }, icon('bank', 'ic ic-sm'), `引き落とし: ${account ? account.name : '未設定'}`),
      h('span', {}, r.annual_fee ? `年会費 ${yen(r.annual_fee)}${r.annual_fee_month ? `（${r.annual_fee_month}月）` : ''}` : r.annual_fee === 0 ? '年会費 無料' : '')));
}

function renderList(ledger) {
  const def = LEDGERS[ledger];
  const q = h('input', { type: 'search', placeholder: '名前・メモ・タグで検索', 'aria-label': '検索' });
  const status = h('select', { 'aria-label': '状態で絞り込み' },
    h('option', { value: 'active' }, '利用中のみ'), h('option', { value: 'all' }, 'すべて'), h('option', { value: 'closed' }, '解約済みのみ'));
  const list = h('div', { class: ledger === 'cards' ? 'cc-list' : 'list' });
  const update = () => {
    const words = q.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const rows = state.data[ledger].filter((r) => (status.value === 'all' || (status.value === 'closed') === (r.status === 'closed'))
      && words.every((w) => searchText(r).includes(w)));
    if (rows.length === 0) {
      list.replaceChildren(h('p', { class: 'muted' }, '該当するデータはありません。'));
      return;
    }
    if (ledger === 'cards') {
      list.replaceChildren(...rows.map(cardFace));
      return;
    }
    list.replaceChildren(...rows.map((r) => h('a', { class: 'list-item', href: `#/view/${ledger}/${r.id}` },
      ledgerIcon(ledger, 'icbox-sm'),
      h('div', { class: 'list-body' },
        h('div', { class: 'list-title' }, r.name, r.status === 'closed' ? h('span', { class: 'badge badge-past' }, '解約済み') : null),
        h('div', { class: 'meta' }, summaryLine(ledger, r)),
        r.tags && r.tags.length ? h('div', { class: 'tags' }, r.tags.map((t) => h('span', { class: 'tag' }, t))) : null),
      icon('chevron', 'ic ic-sm list-chevron'))));
  };
  q.addEventListener('input', update);
  status.addEventListener('change', update);
  update();
  setView(def.label,
    pageHead({ title: def.label, icon: ledger, back: { href: '#/ledgers', text: '台帳へ' }, action: h('a', { class: 'button primary', href: `#/edit/${ledger}/new` }, '＋ 追加') }),
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
    case 'member': return v ? memberName(v) : null;
    case 'payment': return paymentNodes(r);
    case 'links': return v && v.length ? h('ul', { class: 'links' }, v.map((l) => h('li', {}, extLink(l.url, l.label)))) : null;
    case 'tags': return v && v.length ? h('div', { class: 'tags' }, v.map((t) => h('span', { class: 'tag' }, t))) : null;
    case 'url': return v ? extLink(v) : null;
    case 'accountno': return v ? maskedNumber(v) : r.last4 ? `下4桁 ${r.last4}` : null;
    case 'int': return v === null || v === undefined ? null : field.key.includes('fee') || field.key === 'amount' ? yen(v) : String(v);
    case 'select':
    case 'status': return v ? optionLabel(field, v) : null;
    case 'day': return v ? (v === 31 ? '末日' : `${v}日`) : null;
    case 'monthnum': return v ? `${v}月` : null;
    default: return v === null || v === undefined || v === '' ? null : String(v);
  }
}

const REVEAL_MS = 30000;

// "●●●1234" with a button that shows the full number for 30 seconds.
function maskedNumber(value) {
  const masked = `●●●${value.slice(-4)}`;
  const text = h('span', { class: 'masked' }, masked);
  let timer = null;
  const hide = () => {
    clearTimeout(timer);
    text.textContent = masked;
    button.textContent = '表示';
    button.setAttribute('aria-pressed', 'false');
  };
  const button = h('button', { type: 'button', class: 'small', 'aria-pressed': 'false', onclick: () => {
    if (button.getAttribute('aria-pressed') === 'true') return hide();
    text.textContent = value;
    button.textContent = '隠す';
    button.setAttribute('aria-pressed', 'true');
    timer = setTimeout(hide, REVEAL_MS);
  } }, '表示');
  return h('span', { class: 'masked-wrap' }, text, ' ', button);
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
  if (ledger === 'contracts') {
    const prices = sortedHistory(r.price_history);
    return [
      prices.length ? h('section', { class: 'card' }, h('h2', { class: 'with-icon' }, '金額の履歴', helpButton('金額の履歴', '金額を変えるときは「編集」で金額と適用開始月を入れます。', '予定と実績の比較では、その月の金額を使います。')),
        h('table', { class: 'table' },
          h('thead', {}, h('tr', {}, h('th', {}, '期間'), h('th', { class: 'num' }, '金額'))),
          h('tbody', {}, prices.slice().reverse().map((p) => h('tr', {}, h('td', {}, periodText(p) + (p.to ? '' : '（今）')), h('td', { class: 'num' }, yen(p.amount)))))),
) : null,
      r.shared_cost ? h('section', { class: 'card' }, h('h2', {}, '共通口座への入金との関係'), h('p', {}, deductionText(r)),
        h('a', { href: '#/flow' }, 'お金の流れ（共通口座）を見る')) : null,
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
  if (ledger === 'contracts') await syncContractRules({ ...r, deleted: true });
  await db.removePhotos(photos.flatMap((p) => [p.path, p.thumb_path]));
  await db.deleteWhere(ledger, 'id', r.id);
  state.photos = state.photos.filter((p) => p.item_id !== r.id);
  await Promise.all([reloadLedger(ledger), ...(ledger === 'accounts' ? [reloadLedger('cards'), reloadLedger('contracts')] : []),
    ...(ledger === 'cards' ? [reloadLedger('contracts'), reloadLedger('memberships')] : [])]);
  if (ledger === 'accounts' || ledger === 'cards') await syncAllContractRules();
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
  const heroes = events.map((e) => deadlineHero(e, r));
  const delBtn = h('button', { type: 'button', class: 'danger', onclick: (ev) => busy(ev.currentTarget, () => deleteRecord(ledger, r)) }, '削除');

  setView(r.name,
    pageHead({ title: r.name, icon: ledger, back: { href: `#/list/${ledger}`, text: `${def.label}の一覧へ` }, action: h('a', { class: 'button primary', href: `#/edit/${ledger}/${r.id}` }, '編集') }),
    heroes.length ? h('div', { class: 'hero-grid' }, heroes) : null,
    h('section', { class: 'card' }, h('dl', { class: 'fields' }, [...rows, ...notifyRows].map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]))),
    def.photos ? photoSection(r) : null,
    relations(ledger, r),
    historySection(ledger, r, def.fields),
    h('div', { class: 'actions' }, delBtn));
}

// ---------------------------------------------------------------- change history

const HISTORY_LIMIT = 50;
const EXTRA_LABELS = { pay_card_id: '支払カード', pay_account_id: '支払口座', notify_days: '通知のタイミング', price_history: '金額の履歴' };

function formatTime(iso) {
  return iso ? new Date(iso).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' }) : '';
}

function historyValue(field, key, v) {
  if (v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) return '（なし）';
  if (key === 'pay_card_id') return (find('cards', v) || { name: '（削除済み）' }).name;
  if (key === 'pay_account_id') return (find('accounts', v) || { name: '（削除済み）' }).name;
  if (key === 'price_history') return sortedHistory(v).map((p) => `${periodText(p)} ${yen(p.amount)}`).join('、') || '（なし）';
  if (key === 'notify_days') {
    const parts = Object.entries(v).map(([t, days]) => `${EVENT_TYPES[t] ? EVENT_TYPES[t].label : t}: ${days.length ? `${days.join('・')}日前` : '通知しない'}`);
    return parts.length ? parts.join('、') : '初期設定';
  }
  if (field) {
    if (field.type === 'bool') return v ? 'はい' : 'いいえ';
    if (field.type === 'ref') return (find(field.ref, v) || { name: '（削除済み）' }).name;
    if (field.type === 'member') return memberName(v);
    if (field.type === 'member-nick') return memberNick(v);
    if (field.type === 'schedule') return Array.isArray(v) ? v.join('・') : String(v);
    if (field.type === 'select' || field.type === 'status') return optionLabel(field, v);
    if (field.type === 'links') return v.map((l) => l.label).join('、');
    if (field.type === 'tags') return v.join(' ');
  }
  const text = typeof v === 'string' ? v : JSON.stringify(v);
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

function historyLine(entry, fields) {
  const head = h('div', { class: 'muted small' }, `${formatTime(entry.at)}　${entry.actor_name}`);
  const simple = { insert: '追加しました', delete: '削除しました', photo_insert: '写真を追加しました', photo_delete: '写真を削除しました' };
  if (simple[entry.action]) return h('li', {}, head, h('div', {}, simple[entry.action]));
  const changes = Object.entries(entry.changes || {}).map(([key, pair]) => {
    const [before, after] = Array.isArray(pair) ? pair : [null, null];
    const field = fields.find((f) => f.key === key);
    const label = field ? field.label : EXTRA_LABELS[key] || key;
    return h('div', {}, `${label}: ${historyValue(field, key, before)} → ${historyValue(field, key, after)}`);
  });
  return h('li', {}, head, changes.length ? changes : h('div', {}, '変更しました'));
}

// Who created / last changed the record, and its change history (newest first).
function historySection(table, record, fields) {
  const box = h('div', {}, h('p', { class: 'muted' }, '読み込み中…'));
  const who = (id) => (id ? memberNick(id) : '—');
  const stamps = [
    record.created_at ? `作成: ${who(record.created_by)}（${formatTime(record.created_at)}）` : null,
    record.updated_at ? `最終更新: ${who(record.updated_by)}（${formatTime(record.updated_at)}）` : null,
  ].filter(Boolean);
  db.selectWhere('audit_log', `table_name=eq.${table}&record_id=eq.${encodeURIComponent(record.id)}&order=at.desc&limit=${HISTORY_LIMIT}`)
    .then((rows) => {
      box.replaceChildren(rows.length === 0
        ? h('p', { class: 'muted' }, '履歴はまだありません。')
        : h('ul', { class: 'history' }, rows.map((e) => historyLine(e, fields))));
    })
    .catch((e) => {
      console.error(e.detail || e);
      box.replaceChildren(h('p', { class: 'error' }, '変更履歴を読み込めませんでした。'));
    });
  return h('section', { class: 'card' }, h('h2', { class: 'with-icon' }, '変更履歴', helpButton('変更履歴', `新しい順に最大${HISTORY_LIMIT}件を表示します。`, '口座番号は伏せ字で記録しています。')),
    stamps.length ? h('div', { class: 'muted small stamps' }, stamps.map((t) => h('div', {}, t))) : null,
    box,
  );
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
    status);
}

// ---------------------------------------------------------------- edit form

function fieldInput(field, r, ledger) {
  const id = `f-${field.key}`;
  const v = r ? r[field.key] : undefined;
  const wrap = (input, getter, help) => ({
    el: h('div', { class: 'field', 'data-key': field.key },
      field.type === 'bool' ? null : h('div', { class: 'label-row' }, h('label', { for: id }, field.label, field.required ? h('span', { class: 'req' }, ' *') : null), help ? helpButton(field.label, help) : null),
      input,
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
        rows.map((x) => h('option', { value: x.id, selected: x.id === v }, (field.ref === 'accounts' ? accountLabel(x) : x.name) + (x.status === 'closed' ? '（解約済み）' : ''))));
      return wrap(el, () => el.value || null);
    }
    case 'payment': {
      const cur = r && r.pay_card_id ? `card:${r.pay_card_id}` : r && r.pay_account_id ? `account:${r.pay_account_id}` : '';
      const el = h('select', { id }, h('option', { value: '' }, '（未設定・現金など）'),
        h('optgroup', { label: 'カード' }, [...state.data.cards].sort(byName).map((c) => h('option', { value: `card:${c.id}`, selected: cur === `card:${c.id}` }, c.name))),
        h('optgroup', { label: '口座（直接引き落とし）' }, [...state.data.accounts].sort(byName).map((a) => h('option', { value: `account:${a.id}`, selected: cur === `account:${a.id}` }, accountLabel(a)))));
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
      return wrap(el, () => el.value, field.help !== undefined ? field.help : 'カード券面の「MM/YY」の年月を入力します。');
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
    case 'member': {
      const choices = [...state.members].filter((m) => m.active || m.id === v).sort(byName);
      const el = h('select', { id }, h('option', { value: '' }, '（未設定）'),
        choices.map((m) => h('option', { value: m.id, selected: m.id === v }, `${m.name}${m.nickname ? `（${m.nickname}）` : ''}${m.active ? '' : '（無効）'}`)),
        v && !memberById(v) ? h('option', { value: v, selected: true }, '（削除済み）') : null);
      return wrap(el, () => el.value || null, '設定画面の「ユーザー」に登録した人から選びます。');
    }
    case 'yen': {
      const el = h('input', { type: 'text', id, value: v ?? '', maxlength: 14, autocomplete: 'off' });
      return wrap(el, () => el.value, field.help);
    }
    case 'accountno': {
      const el = h('input', { type: 'text', inputmode: 'numeric', id, value: v || '', maxlength: 20, autocomplete: 'off' });
      return wrap(el, () => el.value, '数字のみ（4〜14桁）。詳細画面では伏せ字で表示します。');
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
      h('div', { class: 'label-row' }, h('label', { for: id }, `通知: ${EVENT_TYPES[type].label}（何日前）`), helpButton('通知のタイミング', '例: 「30 7」で30日前と7日前。「なし」で通知しない。空欄は初期設定。')), el,
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
    } else if (field.type === 'ref' || field.type === 'member') {
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
  // Accounts keep last4 in sync with the full number (used in lists and summaries).
  if (def.key === 'accounts' && 'account_no' in values) values.last4 = values.account_no ? values.account_no.slice(-4) : null;
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
  // contracts: what "共通の費用" means for this contract, and taking over an existing manual rule
  let adopt = null;
  let priceFrom = null;
  if (ledger === 'contracts') {
    const shared = inputs.find((i) => i.field.key === 'shared_cost');
    const preview = h('p', { class: 'deduction small', 'aria-live': 'polite' });
    const candidates = !isAdmin() ? [] : isNew || !state.sharedRules.some((x) => x.contract_id === r.id) ? adoptableRules() : [];
    adopt = candidates.length ? h('select', { id: 'f-adopt' }, h('option', { value: '' }, '（引き継がない・今月から差し引く）'),
      candidates.map((x) => h('option', { value: x.id }, `${memberNick(x.member_id)}：${x.label} ${signedYen(x.amount)}（${ruleSchedule(x)}）`))) : null;
    const adoptBox = adopt ? h('div', { class: 'field', 'data-key': 'adopt' }, h('div', { class: 'label-row' }, h('label', { for: 'f-adopt' }, '既存の定例項目に引き継ぐ'), helpButton('既存の定例項目に引き継ぐ', '共通口座の定例項目で同じ支払いを管理していた場合に選びます。過去の月の記録をそのまま引き継ぎ、二重に差し引きません。')), adopt) : null;
    const update = () => {
      const raw = Object.fromEntries(inputs.map((i) => [i.field.key, i.get()]));
      const v = { ...(r || {}), ...buildValues(def, raw, null).values, name: raw.name || '（名前未入力）' };
      preview.textContent = v.shared_cost ? deductionText(v) : '';
      preview.hidden = !v.shared_cost;
      if (adoptBox) adoptBox.hidden = !v.shared_cost;
    };
    // the form is built from inputs[].el later, so wrap the checkbox with its explanation here
    shared.el = h('div', { class: 'shared-cost-box' },
      h('div', { class: 'label-row' }, shared.el, helpButton('共通の費用', '個人の口座から払っている家の費用なら印を付けます。', 'その人が共通口座へ入れる額（当月分）から自動で差し引きます。')),
      preview, adoptBox);
    // amount by period: when the amount of an existing contract changes, ask from which month
    if (!isNew && r.amount !== null && r.amount !== undefined) {
      const amountInput = inputs.find((i) => i.field.key === 'amount');
      priceFrom = h('input', { type: 'month', id: 'f-price-from', value: thisYM() });
      const box = h('div', { class: 'field', 'data-key': 'price_from', hidden: true },
        h('div', { class: 'label-row' }, h('label', { for: 'f-price-from' }, '新しい金額の適用開始月'), helpButton('新しい金額の適用開始月', `今の金額（${yen(r.amount)}）はその前の月までになり、金額の履歴に残ります。過去の月の予定額は変わりません。`)), priceFrom,
        h('p', { class: 'error small field-error' }));
      const toggle = () => { box.hidden = String(amountInput.get()).replace(/[,円\s]/g, '') === String(r.amount); };
      amountInput.el.addEventListener('input', toggle);
      amountInput.el = h('div', {}, amountInput.el, box);
    }
    setTimeout(update, 0);
    for (const i of inputs) i.el.addEventListener('input', update);
    for (const i of inputs) i.el.addEventListener('change', update);
  }
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
        let ruleFrom = thisYM();
        if (priceFrom && values.amount !== null && values.amount !== r.amount) {
          const from = priceFrom.value;
          if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(from)) {
            form.querySelector('[data-key="price_from"] .field-error').textContent = '適用開始月を選んでください。';
            summary.textContent = '入力内容を確認してください（1件）。';
            return;
          }
          values.price_history = applyPriceChange(r.price_history, r.amount, values.amount, from);
          ruleFrom = from;
        }
        if (cardNumberSuspects(values) && !window.confirm('カード番号の全桁と思われる数字が含まれています。カード番号・暗証番号は保存しない方針です。このまま保存しますか？')) return;
        const saved = isNew ? (await db.insertRows(ledger, [values]))[0] : await db.updateRow(ledger, id, values);
        await reloadLedger(ledger);
        if (ledger === 'contracts') await syncContractRules(saved, adopt && !adopt.closest('[hidden]') ? adopt.value || null : null, ruleFrom);
        if (ledger === 'contracts' && (values.match_keywords || null) !== ((r && r.match_keywords) || null)) await relinkUnlinked();
        if (ledger === 'contracts') clearTxCache();
        if (ledger === 'accounts' || ledger === 'cards') await syncAllContractRules();
        toast('保存しました。');
        location.hash = `#/view/${ledger}/${saved.id}`;
      });
    },
  },
  summary,
  inputs.map((i) => i.el),
  notifyInputs.length ? h('fieldset', {}, h('legend', {}, '通知のタイミング'), notifyInputs.map((n) => n.el)) : null,
  h('div', { class: 'actions' },
    h('a', { class: 'button', href: isNew ? `#/list/${ledger}` : `#/view/${ledger}/${id}` }, 'キャンセル'),
    submit));

  setView(isNew ? `${def.label}を追加` : `${r.name}を編集`,
    pageHead({ title: isNew ? `${def.label}を追加` : `${r.name}を編集`, icon: ledger, back: { href: isNew ? `#/list/${ledger}` : `#/view/${ledger}/${r.id}`, text: '戻る' } }), form);
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
  if (f.type === 'member') return (memberById(v) || {}).name || '';
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
  const cols = csvColumns(ledger);
  const aliases = def.csvAliases || {};
  const normalize = (row) => row.map((x) => aliases[x.trim()] || x.trim());
  // The header may follow a title row (e.g. "口座マスタ"): use the first of the top 5 rows that has the name column.
  const headerAt = table.slice(0, 5).findIndex((row) => normalize(row).includes(def.fields[0].label));
  if (headerAt < 0) return { errors: [`見出しに「${def.fields[0].label}」がありません。${def.label}のテンプレートを使ってください。`] };
  const body = table.slice(headerAt + 1);
  if (body.length === 0) return { errors: ['データの行がありません（見出しの次の行からデータです）。'] };
  if (body.length > MAX_IMPORT_ROWS) return { errors: [`一度に取り込めるのは${MAX_IMPORT_ROWS}行までです。`] };
  const header = normalize(table[headerAt]);
  const dup = header.filter((x, i) => x && header.indexOf(x) !== i);
  if (dup.length) return { errors: [`見出し「${[...new Set(dup)].join('」「')}」が重複しています（別名を含む）。どちらか一方にしてください。`] };
  const index = new Map(header.map((x, i) => [x, i]));
  const unknown = header.filter((x) => x && !cols.some((c) => c.header === x));
  const errors = unknown.length ? [`認識できない見出しは無視します: ${unknown.join('、')}`] : [];
  const fatal = [];
  const rows = [];
  let inserts = 0;
  let updates = 0;
  let suspects = 0;
  const existing = new Set(state.data[ledger].map((r) => r.id));
  const usedIds = new Set();

  body.forEach((line, i) => {
    const rowNo = headerAt + i + 2;
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
        } else if (f.type === 'member') {
          if (v.trim()) {
            const hit = state.members.find((m) => m.name === v.trim()) || state.members.find((m) => m.nickname === v.trim());
            if (hit) raw[f.key] = hit.id;
            else rowErrors.push(`${f.label}「${v.trim()}」がユーザーマスターにありません。設定画面の「ユーザー」に先に登録してください。`);
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
    h('h3', { class: 'with-icon' }, 'テンプレート', helpButton('テンプレート', '見出し行だけのCSVです。Excel などで2行目から入力して保存し、「取り込み」で読み込みます。')),
    h('div', { class: 'button-row' }, LEDGER_ORDER.map((k) => h('button', { type: 'button', class: 'small', onclick: () => download(`テンプレート_${LEDGERS[k].csvName}.csv`, ledgerCSV(k, false), 'text/csv') }, LEDGERS[k].label))),
    isAdmin() ? [h('h3', { class: 'with-icon' }, '取り込み', helpButton('CSV の取り込み',
      '順番: 口座 → カード → 契約・固定費／ポイントカード・会員情報（引き落とし口座などは名前で結びつけるため）。',
      'ID が空欄の行は追加、書き出したCSVの ID が入った行はその内容で更新します。',
      'はい/いいえ、日付は 2026-01-31、年月は 2027-05、リンクは1行に「名前|URL」、タグは空白区切り。',
      'エラーが1件でもあると何も取り込みません。',
      '口座は、口座マスタの見出し（摘要・支店名・預金科目・口座番号・口座名義）のままでも取り込めます。表題の行が上にあっても構いません。')),
    h('label', { for: 'import-ledger' }, '取り込む台帳'), ledgerSel,
    h('label', { for: 'import-file' }, 'CSVファイル（UTF-8 または Excel の CSV）'), file,
    h('div', { class: 'actions' }, run),
    result] : null,
    h('h3', {}, '書き出し'),
    h('div', { class: 'button-row' }, LEDGER_ORDER.map((k) => h('button', { type: 'button', class: 'small', onclick: () => download(`${LEDGERS[k].csvName}_${todayJST()}.csv`, ledgerCSV(k), 'text/csv') }, LEDGERS[k].label))));
}

// ---------------------------------------------------------------- backup

async function fullBackup(status) {
  await loadAll();
  const files = LEDGER_ORDER.map((k) => ({ name: `${LEDGERS[k].csvName}.csv`, data: ledgerCSV(k) }));
  files.push({ name: '家事.csv', data: choresCSV() });
  files.push({ name: '共通口座_明細（マネーフォワード）.csv', data: transactionsCSV(await fetchAllPaged('transactions', 'order=date.asc')) });
  files.push({ name: '共通口座_定例項目.csv', data: sharedRulesCSV() }, { name: '共通口座_臨時の費目と入金.csv', data: sharedEntriesCSV() });
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
  files.push({ name: '共通口座_入金報告.csv', data: depositReportsCSV() });
  const attachRows = [['画像ID', '種類', '記録ID', 'ファイル', '登録日時']];
  let j = 0;
  for (const a of state.attachments) {
    j += 1;
    status.textContent = `添付画像を取得しています（${j}/${state.attachments.length}）…`;
    const blob = await db.downloadPhoto(a.path);
    const name = `attachments/${a.id}.jpg`;
    files.push({ name, data: new Uint8Array(await blob.arrayBuffer()) });
    attachRows.push([a.id, a.entry_id ? '立替など' : '入金報告', a.entry_id || a.report_id, name, a.created_at]);
  }
  files.push({ name: '添付画像一覧.csv', data: toCSV(attachRows) });
  status.textContent = 'ZIPファイルを作成しています…';
  const zip = createZip(files);
  download(`家の管理ハブ_バックアップ_${todayJST()}.zip`, new Blob([zip], { type: 'application/zip' }));
  await saveSetting('last_backup_at', new Date().toISOString());
  status.textContent = `バックアップを書き出しました（写真${state.photos.length}枚・添付画像${state.attachments.length}枚を含む）。`;
}

function backupSection() {
  const status = h('p', { class: 'small', role: 'status' });
  const last = state.settings.last_backup_at;
  return h('section', { class: 'card' },
    h('h2', { class: 'with-icon' }, 'バックアップ', helpButton('バックアップ', '全台帳のCSVと写真・添付画像を1つのZIPファイルにまとめてダウンロードします。', `Supabase の無料プランには自動バックアップが無いため、月1回程度の実行をおすすめします（${BACKUP_REMIND_DAYS}日たつとホーム画面でお知らせします）。`, '写真が多い場合はPCでの実行をおすすめします。')),
    h('p', {}, `最後のバックアップ: ${last ? new Date(last).toLocaleString('ja-JP') : 'まだありません'}`),
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
    );
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
    } else if (!key && !isAdmin()) {
      nodes.push(h('p', {}, '管理者が通知の鍵を作成するまで、通知は設定できません。'));
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
          const res = await push.subscribe(key, label.value.trim().slice(0, 100), me().id);
          if (res === 'denied') toast('通知が許可されませんでした。', 'error');
          else toast('この端末で通知を受け取る設定をしました。');
          draw();
        }) }, 'この端末で通知を受け取る'));
      } else {
        nodes.push(h('button', { type: 'button', onclick: (ev) => busy(ev.currentTarget, async () => { await push.unsubscribe(); toast('この端末の通知を止めました。'); draw(); }) }, 'この端末の通知を止める'));
      }
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
      h('p', { class: 'notice-text small' }, '⚠ 秘密の値は他人に見せない・チャットやメールに貼らない'));
  };

  draw().catch(handleError);
  return h('section', { class: 'card' }, h('h2', {}, '通知（この端末）'), body);
}

function membersSection() {
  const rows = [...state.members].sort(byName);
  return h('section', { class: 'card' },
    h('div', { class: 'title-row' }, h('h2', {}, 'ユーザー'),
      isAdmin() ? h('a', { class: 'button small primary', href: '#/member/new' }, '＋ ユーザーを追加') : null),
    h('ul', { class: 'member-list' }, rows.map((m) => h('li', {},
      h('a', { href: `#/member/${m.id}` }, nick(m)),
      m.nickname ? h('span', { class: 'muted small' }, `（${m.name}）`) : null,
      h('span', { class: 'muted small' }, ` ${optionLabel(ROLE_FIELD, m.role)}・${m.email ? 'ログインあり' : 'ログインなし'}${m.active ? '' : '・無効'}`)))),
  );
}

// Problems with keeping at least one active administrator who can log in (checked again by the database).
function lastAdminProblem(member, values) {
  if (!member || member.role !== 'admin' || !member.active || !member.email) return null;
  const stays = values && values.role === 'admin' && values.active && values.email;
  if (stays || activeAdminsWithLogin(member.id).length > 0) return null;
  return '管理者が1人もいなくなるため、この変更はできません。先に別の人を管理者にしてください。';
}

function renderMember(id) {
  const isNew = id === 'new';
  const m = isNew ? null : memberById(id);
  if ((!isNew && !m) || (isNew && !isAdmin())) {
    location.hash = '#/settings/users';
    return;
  }
  const back = (title) => pageHead({ title, icon: 'settings', back: { href: '#/settings/users', text: '設定へ' } });
  if (!isAdmin()) {
    const rows = MEMBER_DEF.fields.filter((f) => f.key !== 'name').map((f) => [f.label, fieldValueNodes(f, m) ?? '（なし）']);
    setView(m.name, back(m.name),
      h('section', { class: 'card' }, h('dl', { class: 'fields' }, rows.map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]))),
      h('p', { class: 'meta' }, '管理者だけが変更できます'),
      historySection('members', m, MEMBER_DEF.fields));
    return;
  }
  const inputs = MEMBER_DEF.fields.map((f) => ({ field: f, ...fieldInput(f, m || { role: 'member', active: true }) }));
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
        const { values, errors } = buildValues(MEMBER_DEF, raw, null);
        if (values.email) values.email = values.email.toLowerCase();
        const problem = errors.length ? null : lastAdminProblem(m, values);
        if (errors.length || problem) {
          for (const e of errors) {
            const box = form.querySelector(`[data-key="${e.key}"] .field-error`);
            if (box) box.textContent = e.message;
          }
          summary.textContent = problem || `入力内容を確認してください（${errors.length}件）。`;
          return;
        }
        if (isNew) await db.insertRows('members', [values]);
        else await db.updateRow('members', id, values);
        state.members = await db.selectAll('members');
        toast('ユーザーを保存しました。');
        location.hash = '#/settings/users';
      });
    },
  },
  summary,
  inputs.map((i) => i.el),
  h('div', { class: 'actions' }, h('a', { class: 'button', href: '#/settings/users' }, 'キャンセル'), submit));

  const del = isNew ? null : h('button', { type: 'button', class: 'danger', onclick: (ev) => busy(ev.currentTarget, async () => {
    const problem = lastAdminProblem(m, null);
    if (problem) {
      toast(problem, 'error');
      return;
    }
    if (state.sharedRules.some((r) => r.member_id === m.id) || state.sharedEntries.some((e) => e.member_id === m.id)) {
      toast('共通口座の記録があるため削除できません。使わなくなった人は「有効」を外してください。', 'error');
      return;
    }
    const used = LEDGER_ORDER.reduce((n, k) => n + state.data[k].filter((r) => r.holder_id === m.id).length, 0);
    let msg = `「${m.name}」を削除します。元に戻せません。よろしいですか？`;
    if (used > 0) msg += `\n\n${used}件のデータの名義人に設定されています。削除すると名義人が空になります。使わなくなった人は、削除せず「有効」を外すのがおすすめです。`;
    if (!window.confirm(msg)) return;
    await db.deleteWhere('members', 'id', m.id);
    state.members = await db.selectAll('members');
    await Promise.all(LEDGER_ORDER.map((k) => reloadLedger(k)));
    toast('ユーザーを削除しました。');
    location.hash = '#/settings/users';
  }) }, '削除');

  setView(isNew ? 'ユーザーを追加' : `${m.name}を編集`, back(isNew ? 'ユーザーを追加' : `${m.name}を編集`), form,
    m ? historySection('members', m, MEMBER_DEF.fields) : null,
    del ? h('div', { class: 'actions' }, del) : null);
}

function shortcutSection() {
  if (!isAdmin()) return null;
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
  return h('section', { class: 'card' }, h('h2', { class: 'with-icon' }, 'ショートカット', helpButton('ショートカット', '口座・カードの台帳の「関連リンク」は自動で表示されます。ここではそれ以外のリンクを設定します。')), input.el,
    h('div', { class: 'actions' }, save));
}

function accountSection() {
  return h('section', { class: 'card' }, h('h2', { class: 'with-icon' }, 'アカウント', helpButton('端末をなくしたとき', '「このアカウントのすべての端末からログアウト」を押してから、パスワードを変更してください。')),
    h('p', {}, `ログイン中: ${nick(me())}（${optionLabel(ROLE_FIELD, me().role)}）`),
    h('p', { class: 'muted small' }, db.currentEmail() || ''),
    h('div', { class: 'button-row' },
      h('button', { type: 'button', onclick: (ev) => busy(ev.currentTarget, async () => { await db.signOut('local'); resetState(); render(); }) }, 'ログアウト'),
      h('button', { type: 'button', class: 'danger', onclick: (ev) => busy(ev.currentTarget, async () => {
        if (!window.confirm('このアカウント（自分）がログインしているすべての端末からログアウトします。他の人のログインは切れません。端末をなくしたときに使います。よろしいですか？')) return;
        await db.signOut('global');
        resetState();
        render();
      }) }, 'このアカウントのすべての端末からログアウト')),
    h('div', { class: 'button-row' }, h('a', { class: 'button', href: '#/password' }, 'パスワードを変更')),
  );
}

function sharedAccountSection() {
  if (!isAdmin()) return null;
  const acc = sharedAccountId() ? find('accounts', sharedAccountId()) : null;
  return h('section', { class: 'card' }, h('h2', { class: 'with-icon' }, '共通口座', helpButton('共通口座', '個人からの入金を受け、共通の費用を払う口座です。お金のページで使います。')),
    h('p', {}, `今の設定: ${acc ? accountLabel(acc) : '未設定'}`),
    sharedAccountPicker());
}

const SETTINGS_TABS = { account: 'アカウント', users: 'ユーザー', data: 'データ', other: 'その他' };

function renderSettings(tabParam) {
  // その他 (shared account, shortcuts) is for administrators only
  const keys = Object.keys(SETTINGS_TABS).filter((k) => k !== 'other' || isAdmin());
  const tab = keys.includes(tabParam) ? tabParam : (keys.includes(state.settingsTab) ? state.settingsTab : 'account');
  state.settingsTab = tab;
  const tabs = keys.map((key) => ({ key, label: SETTINGS_TABS[key], href: `#/settings/${key}` }));
  const content = {
    account: () => [accountSection(), notifySection()],
    users: () => [membersSection()],
    data: () => [backupSection(), importSection(), usageSection()],
    other: () => [sharedAccountSection(), shortcutSection()],
  }[tab]();
  setView('設定', pageHead({ title: '設定', icon: 'settings', tabs, tab }), ...content);
}

// ---------------------------------------------------------------- chores (plan, workload, today)

const CYCLE_FIELD = { key: 'cycle', label: 'サイクル', type: 'select', required: true, options: Object.entries(CYCLES).map(([k, v]) => [k, v.label]) };
const CHORE_FIELDS = [
  { key: 'name', label: 'タスク名', type: 'text', required: true, max: 200 },
  { key: 'category', label: 'カテゴリ', type: 'select', options: CATEGORIES },
  { key: 'chore_group', label: 'グループ', type: 'select', options: GROUPS },
  CYCLE_FIELD,
  { key: 'schedule', label: 'やる日', type: 'schedule' },
  { key: 'times', label: '回数（サイクルあたり）', type: 'decimal', min: 0.1, max: 1000 },
  { key: 'minutes', label: '1回の時間（分）', type: 'decimal', min: 0, max: 10000 },
  { key: 'adjust', label: '調整係数', type: 'decimal', min: 0.1, max: 5, help: '大変さの重み（標準 1.0。今の表では 0.8〜1.1）。' },
  { key: 'points_override', label: '点数/月（随時のみ）', type: 'decimal', min: 0, max: 1000000 },
  { key: 'assignee', label: '担当', type: 'assignee' },
  { key: 'status', label: '状態', type: 'status', options: [['active', '利用中'], ['closed', '停止']] },
  { key: 'memo', label: 'メモ', type: 'textarea', max: 5000 },
];
const ASSIGNEE_LABEL = { all: '全員', tbd: '未定' };

function points(n) {
  return `${Math.round(n).toLocaleString('ja-JP')}点`;
}

function hours(n) {
  return `${(Math.round(n * 100) / 100).toLocaleString('ja-JP')}時間`;
}

function assigneeText(c) {
  if (c.assignee_type === 'member' && c.assignee_id) return memberNick(c.assignee_id);
  return ASSIGNEE_LABEL[c.assignee_type] || '未定';
}

function choreSummary(c) {
  const parts = [scheduleText(c)];
  if (c.cycle !== 'adhoc' && c.minutes !== null && c.minutes !== undefined) parts.push(`${Number(c.minutes)}分/回`);
  parts.push(assigneeText(c));
  return parts.join('・');
}

function choreRow(c) {
  const h1 = monthlyHours(c);
  return h('a', { class: 'list-item', href: `#/chore/${c.id}` },
    h('span', { class: 'icbox icbox-sm lg-chores' }, icon('chore')),
    h('div', { class: 'list-body' },
      h('div', { class: 'list-title' }, c.name, c.status === 'closed' ? h('span', { class: 'badge badge-past' }, '停止') : null),
      h('div', { class: 'muted small' }, [c.category, choreSummary(c)].filter(Boolean).join('・'))),
    h('div', { class: 'chore-figure num' }, h('strong', {}, points(adjustedPoints(c))), h('span', { class: 'muted small' }, h1 === null ? '随時' : `${hours(h1)}/月`)),
    icon('chevron', 'ic ic-sm list-chevron'));
}

// Today's chores: mine first, then the others; "all" chores are everyone's.
function todayChores() {
  const today = todayJST();
  const mine = me() ? me().id : null;
  const due = state.chores.filter((c) => isDueOn(c, today));
  const isMine = (c) => c.assignee_type === 'all' || (c.assignee_type === 'member' && c.assignee_id === mine);
  return [...due.filter(isMine), ...due.filter((c) => !isMine(c))].map((c) => ({ chore: c, mine: isMine(c) }));
}

function todayChoresCard() {
  const list = todayChores();
  return h('section', { class: 'card' },
    sectionHead('chore', '今日の家事', { href: '#/chores/today', text: '家事へ' }),
    list.length === 0
      ? h('p', { class: 'muted' }, '今日の家事はありません（やる日を決めた家事だけ表示します）。')
      : h('ul', { class: 'today-chores' }, list.map(({ chore, mine }) => h('li', { class: mine ? 'mine' : '' },
        h('a', { href: `#/chore/${chore.id}` }, chore.name),
        h('span', { class: `badge ${mine ? 'badge-warn' : ''}` }, icon('user'), assigneeText(chore))))));
}

function workloadSection() {
  const { rows, tbd } = workload(state.chores, state.members);
  if (rows.length === 0 && tbd.count === 0) return h('section', { class: 'card' }, h('p', { class: 'muted' }, '家事を登録すると、担当ごとの負担を表示します。'));
  const sorted = [...rows].sort((a, b) => b.points - a.points);
  const diff = sorted.length >= 2 ? sorted[0].points - sorted[sorted.length - 1].points : 0;
  const categories = [...new Set(rows.flatMap((r) => Object.keys(r.byCategory)))].sort((a, b) => CATEGORIES.indexOf(a) - CATEGORIES.indexOf(b));
  return h('section', { class: 'card' },
    h('h2', { class: 'with-icon' }, icon('user'), '分担（月あたりの負担）', helpButton('分担の点数', '点数＝月の時間×1000×調整係数（随時は入力した点数×調整係数）。', '「全員」の家事は、担当のある人で等分しています。担当が未定の家事は合計に含めません。')),
    barChart(rows.map((r) => [nick(r.member), r.points]), '担当ごとの月の負担（調整後の点数）', points),
    sorted.length >= 2
      ? h('p', { class: 'balance' }, diff < 0.5 ? '負担は同じです。' : `${nick(sorted[0].member)} が ${nick(sorted[sorted.length - 1].member)} より ${points(diff)} 多い`)
      : null,
    h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', {}, ''), rows.map((r) => h('th', { class: 'num' }, nick(r.member))))),
      h('tbody', {},
        categories.map((cat) => h('tr', {}, h('td', {}, cat), rows.map((r) => h('td', { class: 'num' }, points(r.byCategory[cat] || 0))))),
        h('tr', { class: 'total' }, h('td', {}, '合計'), rows.map((r) => h('td', { class: 'num' }, points(r.points)))),
        h('tr', {}, h('td', {}, '時間/月'), rows.map((r) => h('td', { class: 'num' }, hours(r.hours)))))),
    tbd.count > 0 ? h('p', { class: 'meta' }, `担当が未定 ${points(tbd.points)}（${Math.round(tbd.count)}件・合計に含めない）`) : null);
}

const CHORE_TABS = { today: '今日', list: '一覧', load: '負担の割合' };

function renderChores(tabParam) {
  const who = h('select', { 'aria-label': '担当で絞り込み' }, h('option', { value: '' }, '担当: すべて'),
    choreSharers(state.chores, state.members).map((m) => h('option', { value: `member:${m.id}` }, nick(m))),
    h('option', { value: 'all' }, '全員'), h('option', { value: 'tbd' }, '未定'));
  const cat = h('select', { 'aria-label': 'カテゴリで絞り込み' }, h('option', { value: '' }, 'カテゴリ: すべて'), CATEGORIES.map((c) => h('option', { value: c }, c)));
  const list = h('div', { class: 'list' });
  const update = () => {
    const [type, id] = who.value.split(':');
    const rows = state.chores
      .filter((c) => !who.value || (type === 'member' ? c.assignee_type === 'member' && c.assignee_id === id : c.assignee_type === type))
      .filter((c) => !cat.value || c.category === cat.value)
      .sort((a, b) => (a.status === 'closed') - (b.status === 'closed') || CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) || a.name.localeCompare(b.name, 'ja'));
    list.replaceChildren(...(rows.length === 0 ? [h('p', { class: 'muted' }, '該当する家事はありません。')] : rows.map(choreRow)));
  };
  who.addEventListener('change', update);
  cat.addEventListener('change', update);
  update();
  const tab = CHORE_TABS[tabParam] ? tabParam : (state.choresTab || 'today');
  state.choresTab = tab;
  const tabs = Object.entries(CHORE_TABS).map(([key, label]) => ({ key, label, href: `#/chores/${key}` }));
  setView('家事',
    pageHead({ title: '家事', icon: 'chores', tabs, tab, action: h('a', { class: 'button primary', href: '#/chore-edit/new' }, '＋ 追加') }),
    tab === 'today' ? todayChoresCard() : null,
    tab === 'load' ? workloadSection() : null,
    tab === 'list' ? [h('div', { class: 'filters filters-2' }, who, cat), list] : null);
}

function renderChore(id) {
  const c = state.chores.find((x) => x.id === id);
  if (!c) {
    setView('見つかりません', h('section', { class: 'card' }, h('p', {}, '家事が見つかりません。削除された可能性があります。'), h('a', { href: '#/chores' }, '家事の一覧へ')));
    return;
  }
  const h1 = monthlyHours(c);
  const formula = c.cycle === 'adhoc'
    ? `随時: ${points(basePoints(c))} × 調整係数 ${Number(c.adjust)} = ${points(adjustedPoints(c))}`
    : `${Number(c.minutes || 0)}分 × ${timesPerCycle(c)}回 × ${CYCLES[c.cycle].label}の換算 ${CYCLES[c.cycle].perMonth === 1 / 12 ? '1/12' : CYCLES[c.cycle].perMonth} ÷ 60 = ${hours(h1)}/月 → ${points(basePoints(c))} × 調整係数 ${Number(c.adjust)} = ${points(adjustedPoints(c))}`;
  const rows = [
    ['カテゴリ', c.category || '—'], ['グループ', c.chore_group || '—'], ['やる日', scheduleText(c)],
    ['担当', assigneeText(c)], ['状態', c.status === 'closed' ? '停止' : '利用中'], ['メモ', c.memo || '—'],
  ];
  const del = h('button', { type: 'button', class: 'danger', onclick: (ev) => busy(ev.currentTarget, async () => {
    if (!window.confirm(`「${c.name}」を削除します。元に戻せません。よろしいですか？（やめた家事は「停止」にもできます）`)) return;
    await db.deleteWhere('chores', 'id', c.id);
    state.chores = await db.selectAll('chores');
    toast('削除しました。');
    location.hash = '#/chores/list';
  }) }, '削除');
  setView(c.name,
    pageHead({ title: c.name, icon: 'chores', back: { href: '#/chores/list', text: '家事の一覧へ' }, action: h('a', { class: 'button primary', href: `#/chore-edit/${c.id}` }, '編集') }),
    h('section', { class: 'card' },
      h('div', { class: 'kpis kpis-2' },
        h('div', { class: 'kpi kpi-main' }, h('div', { class: 'kpi-label' }, '点数 / 月'), h('div', { class: 'kpi-value num' }, Math.round(adjustedPoints(c)).toLocaleString('ja-JP'), h('small', {}, '点'))),
        h('div', { class: 'kpi' }, h('div', { class: 'kpi-label' }, '時間 / 月'), h('div', { class: 'kpi-value num' }, h1 === null ? '—' : (Math.round(h1 * 100) / 100).toLocaleString('ja-JP'), h('small', {}, h1 === null ? '' : '時間')))),
      h('p', { class: 'muted small formula' }, formula)),
    h('section', { class: 'card' }, h('dl', { class: 'fields' }, rows.map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]))),
    historySection('chores', c, CHORE_FIELDS.concat([{ key: 'assignee_id', label: '担当', type: 'member-nick' }, { key: 'assignee_type', label: '担当の種類', type: 'select', options: [['member', '人'], ['all', '全員'], ['tbd', '未定']] }])),
    h('div', { class: 'actions' }, del));
}

function scheduleInput(cycle, values) {
  const set = new Set((values || []).map(Number));
  const choices = cycle === 'week' ? WEEKDAYS.map((w, i) => [i, w])
    : cycle === 'month' ? Array.from({ length: 31 }, (_, i) => [i + 1, String(i + 1)])
      : cycle === 'year' ? Array.from({ length: 12 }, (_, i) => [i + 1, `${i + 1}月`]) : [];
  const box = h('div', { class: `day-picker day-picker-${cycle}` }, choices.map(([v, label]) => h('label', { class: 'day' },
    h('input', { type: 'checkbox', value: String(v), checked: set.has(v) }), h('span', {}, label))));
  return { el: box, get: () => [...box.querySelectorAll('input:checked')].map((i) => Number(i.value)) };
}

function renderChoreEdit(id) {
  const isNew = id === 'new';
  const c = isNew ? { cycle: 'week', adjust: 1, status: 'active', assignee_type: 'member', assignee_id: me() ? me().id : null, schedule: [] } : state.chores.find((x) => x.id === id);
  if (!c) {
    renderChore(id);
    return;
  }
  const byKey = Object.fromEntries(CHORE_FIELDS.map((f) => [f.key, f]));
  const simple = ['name', 'category', 'chore_group', 'cycle', 'times', 'minutes', 'adjust', 'points_override', 'status', 'memo']
    .map((k) => ({ field: byKey[k], ...fieldInput(byKey[k], c) }));
  const input = Object.fromEntries(simple.map((i) => [i.field.key, i]));
  const assignee = h('select', { id: 'f-assignee' },
    state.members.filter((m) => m.active || m.id === c.assignee_id).sort(byName).map((m) => h('option', { value: `member:${m.id}`, selected: c.assignee_type === 'member' && c.assignee_id === m.id }, nick(m))),
    h('option', { value: 'all', selected: c.assignee_type === 'all' }, '全員（等分）'),
    h('option', { value: 'tbd', selected: c.assignee_type === 'tbd' || (c.assignee_type === 'member' && !c.assignee_id) }, '未定'));
  const scheduleBox = h('div', { class: 'field', 'data-key': 'schedule' }, h('span', { class: 'label' }, 'やる日'));
  const scheduleHelp = h('p', { class: 'muted small' });
  let schedule = scheduleInput(c.cycle, c.schedule);
  const preview = h('p', { class: 'preview num' });
  const cycleSelect = input.cycle.el.querySelector('select');
  const draw = () => {
    const cycle = cycleSelect.value || 'week';
    const keep = schedule.get();
    schedule = scheduleInput(cycle, cycle === c.cycle ? keep : []);
    scheduleBox.replaceChildren(h('span', { class: 'label' }, 'やる日'), schedule.el, scheduleHelp);
    scheduleHelp.textContent = cycle === 'week' ? '曜日を選ぶと、その数が週の回数になり、その日の朝にお知らせします。'
      : cycle === 'month' ? '日にちを選ぶと、その数が月の回数になります（31日など無い日は月末）。'
        : cycle === 'year' ? '月を選ぶと、その数が年の回数になり、その月の1日にお知らせします。' : '';
    scheduleBox.hidden = !['week', 'month', 'year'].includes(cycle);
    input.points_override.el.hidden = cycle !== 'adhoc';
    input.times.el.hidden = cycle === 'adhoc';
    input.minutes.el.hidden = cycle === 'adhoc';
    schedule.el.addEventListener('change', updatePreview);
    updatePreview();
  };
  const current = () => {
    const cycle = cycleSelect.value || 'week';
    const sched = ['week', 'month', 'year'].includes(cycle) ? schedule.get() : [];
    return { cycle, schedule: sched, times: sched.length || Number(input.times.get()) || 0, minutes: Number(input.minutes.get()) || 0, adjust: Number(input.adjust.get()) || 1, points_override: Number(input.points_override.get()) || 0 };
  };
  function updatePreview() {
    const v = current();
    const auto = ['week', 'month', 'year'].includes(v.cycle) && v.schedule.length > 0;
    const timesInput = input.times.el.querySelector('input');
    timesInput.disabled = auto;
    if (auto) timesInput.value = String(v.schedule.length);
    const hrs = monthlyHours(v);
    preview.textContent = `→ ${hrs === null ? '随時' : `${hours(hrs)}/月`}・${points(adjustedPoints(v))}/月`;
  }
  cycleSelect.addEventListener('change', draw);
  for (const k of ['times', 'minutes', 'adjust', 'points_override']) input[k].el.querySelector('input').addEventListener('input', updatePreview);
  const summary = h('div', { class: 'error', role: 'alert' });
  const submit = h('button', { type: 'submit', class: 'primary' }, '保存');
  const form = h('form', { class: 'card form', novalidate: true, onsubmit: (ev) => {
    ev.preventDefault();
    busy(submit, async () => {
      for (const p of form.querySelectorAll('.field-error')) p.textContent = '';
      summary.textContent = '';
      const errors = [];
      const values = {};
      for (const i of simple) {
        const res = parseField(i.field, i.get());
        if (res.error) errors.push({ key: i.field.key, message: res.error });
        else values[i.field.key] = res.value;
      }
      values.schedule = ['week', 'month', 'year'].includes(values.cycle) ? schedule.get().sort((a, b) => a - b) : [];
      if (values.cycle === 'adhoc') {
        values.times = null;
        if (values.points_override === null) errors.push({ key: 'points_override', message: '随時の家事は、点数/月を入力してください。' });
      } else {
        values.points_override = null;
        if (values.schedule.length > 0) values.times = values.schedule.length;
        else if (!values.times) errors.push({ key: 'times', message: 'やる日を選ぶか、回数を入力してください。' });
        if (values.minutes === null) errors.push({ key: 'minutes', message: '1回の時間（分）を入力してください。' });
      }
      if (values.adjust === null) values.adjust = 1;
      const [type, memberId] = assignee.value.split(':');
      values.assignee_type = type;
      values.assignee_id = type === 'member' ? memberId : null;
      if (errors.length) {
        for (const e of errors) {
          const box = form.querySelector(`[data-key="${e.key}"] .field-error`);
          if (box) box.textContent = e.message;
        }
        summary.textContent = `入力内容を確認してください（${errors.length}件）。`;
        return;
      }
      const saved = isNew ? (await db.insertRows('chores', [values]))[0] : await db.updateRow('chores', id, values);
      state.chores = await db.selectAll('chores');
      toast('保存しました。');
      location.hash = `#/chore/${saved.id}`;
    });
  } },
  summary,
  input.name.el, input.category.el, input.chore_group.el, input.cycle.el, scheduleBox,
  input.times.el, input.minutes.el, input.points_override.el, input.adjust.el,
  h('div', { class: 'field', 'data-key': 'assignee' }, h('label', { for: 'f-assignee' }, '担当'), assignee, h('p', { class: 'error small field-error' })),
  input.status.el, input.memo.el,
  preview,
  h('div', { class: 'actions' }, h('a', { class: 'button', href: isNew ? '#/chores/list' : `#/chore/${id}` }, 'キャンセル'), submit));
  draw();
  setView(isNew ? '家事を追加' : `${c.name}を編集`,
    pageHead({ title: isNew ? '家事を追加' : `${c.name}を編集`, icon: 'chores', back: { href: isNew ? '#/chores/list' : `#/chore/${c.id}`, text: '戻る' } }), form);
}

function choresCSV() {
  const head = ['ID', 'タスク名', 'カテゴリ', 'グループ', 'サイクル', 'やる日', '回数', '分/回', '調整係数', '点数/月（随時）', '担当', '状態', '時間/月', '調整後点数/月', 'メモ'];
  const rows = state.chores.map((c) => [c.id, c.name, c.category || '', c.chore_group || '', CYCLES[c.cycle] ? CYCLES[c.cycle].label : c.cycle,
    (c.schedule || []).join(' '), c.times ?? '', c.minutes ?? '', c.adjust ?? '', c.points_override ?? '', assigneeText(c), c.status === 'closed' ? '停止' : '利用中',
    monthlyHours(c) === null ? '' : Math.round(monthlyHours(c) * 1000) / 1000, Math.round(adjustedPoints(c) * 100) / 100, c.memo || '']);
  return toCSV([head, ...rows]);
}

// ---------------------------------------------------------------- start

db.setSignedOutHandler(() => {
  resetState();
  render();
});
window.addEventListener('hashchange', () => handleAuthLink().finally(() => render())); // the e-mail link may open in a tab that already shows the app
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch((e) => console.error(`service worker registration failed: ${e.message}`));
}
handleAuthLink().finally(() => render());
