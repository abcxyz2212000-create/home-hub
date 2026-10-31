// Small Supabase client built on fetch (Auth, REST/PostgREST, Storage). No external libraries.
import { CONFIG } from './config.js';

const SESSION_KEY = 'homehub.session';
const BUCKET = 'item-photos';

export class AppError extends Error {
  // message: user-facing Japanese text; detail: English text for the console.
  constructor(message, detail, status) {
    super(message);
    this.detail = detail;
    this.status = status;
  }
}

let session = loadSession();
let refreshing = null;
let onSignedOut = () => {};

export function setSignedOutHandler(fn) {
  onSignedOut = fn;
}

function loadSession() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    return s && s.access_token && s.refresh_token ? s : null;
  } catch {
    return null;
  }
}

function saveSession(data) {
  session = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at || Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
    email: data.user ? data.user.email : session && session.email,
  };
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function clearSession() {
  session = null;
  localStorage.removeItem(SESSION_KEY);
}

export function isConfigured() {
  const url = CONFIG.supabaseUrl || '';
  // http is accepted only for a local test server
  const urlOk = /^https:\/\/[^/]+$/.test(url) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url);
  return urlOk && typeof CONFIG.supabaseKey === 'string' && CONFIG.supabaseKey.length > 20;
}

export function currentEmail() {
  return session ? session.email : null;
}

export function isSignedIn() {
  return session !== null;
}

function baseHeaders(extra = {}) {
  return { apikey: CONFIG.supabaseKey, ...extra };
}

async function rawFetch(url, options) {
  try {
    return await fetch(url, options);
  } catch (e) {
    throw new AppError('通信に失敗しました。インターネット接続を確認してください。', `network error: ${e.message}`);
  }
}

async function readError(res) {
  let body = null;
  try {
    body = await res.json();
  } catch {
    // body is not JSON
  }
  const code = body && (body.code || body.error_code || body.error);
  const msg = body && (body.message || body.msg || body.error_description);
  return { code, detail: `HTTP ${res.status} ${code || ''} ${msg || ''}`.trim() };
}

function userMessage(status, code) {
  if (status === 401) return 'ログインの有効期限が切れました。もう一度ログインしてください。';
  if (status === 403 || code === '42501') return 'この操作を行う権限がありません。';
  if (status === 409 || code === '23505') return '同じデータが既に登録されています。';
  if (code === '23514' || code === '22P02' || code === '22001') return '入力内容が正しくないため保存できませんでした。';
  if (code === '23503') return '関連するデータが見つからないため保存できませんでした。';
  if (status === 413) return 'ファイルが大きすぎます。';
  if (status >= 500) return 'サーバーでエラーが発生しました。しばらくしてからもう一度お試しください。';
  return `処理に失敗しました（コード: ${code || status}）。`;
}

// ---------------------------------------------------------------- Auth

export async function signIn(email, password) {
  const res = await rawFetch(`${CONFIG.supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: baseHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const { code, detail } = await readError(res);
    if (res.status === 400 || res.status === 401) {
      throw new AppError('メールアドレスまたはパスワードが違います。', detail, res.status);
    }
    if (res.status === 429) throw new AppError('ログインの試行回数が多すぎます。しばらく待ってからお試しください。', detail, 429);
    throw new AppError(userMessage(res.status, code), detail, res.status);
  }
  saveSession(await res.json());
}

async function refreshSession() {
  if (!session) throw new AppError(userMessage(401), 'no session', 401);
  if (!refreshing) {
    refreshing = (async () => {
      const res = await rawFetch(`${CONFIG.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: baseHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ refresh_token: session.refresh_token }),
      });
      if (!res.ok) {
        const { detail } = await readError(res);
        clearSession();
        onSignedOut();
        throw new AppError(userMessage(401), `refresh failed: ${detail}`, 401);
      }
      saveSession(await res.json());
    })().finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}

async function accessToken() {
  if (!session) throw new AppError(userMessage(401), 'not signed in', 401);
  if (session.expires_at - 60 < Date.now() / 1000) await refreshSession();
  return session.access_token;
}

// scope 'local' signs out this device, 'global' revokes the sessions of every device.
export async function signOut(scope = 'local') {
  if (session) {
    try {
      const token = await accessToken();
      const res = await rawFetch(`${CONFIG.supabaseUrl}/auth/v1/logout?scope=${scope}`, {
        method: 'POST',
        headers: baseHeaders({ Authorization: `Bearer ${token}` }),
      });
      if (!res.ok && scope === 'global') {
        const { code, detail } = await readError(res);
        throw new AppError(userMessage(res.status, code), detail, res.status);
      }
    } finally {
      clearSession();
    }
  }
}

// ---------------------------------------------------------------- Authorized requests

async function authFetch(url, options = {}, retry = true) {
  const token = await accessToken();
  const res = await rawFetch(url, { ...options, headers: baseHeaders({ ...(options.headers || {}), Authorization: `Bearer ${token}` }) });
  if (res.status === 401 && retry) {
    await refreshSession();
    return authFetch(url, options, false);
  }
  if (!res.ok) {
    const { code, detail } = await readError(res);
    if (res.status === 401) {
      clearSession();
      onSignedOut();
    }
    throw new AppError(userMessage(res.status, code), `${options.method || 'GET'} ${url.replace(CONFIG.supabaseUrl, '')}: ${detail}`, res.status);
  }
  return res;
}

const rest = (path) => `${CONFIG.supabaseUrl}/rest/v1/${path}`;

export async function selectAll(table, order = 'name.asc') {
  const res = await authFetch(rest(`${table}?select=*&order=${order}`));
  return res.json();
}

export async function insertRows(table, rows) {
  const res = await authFetch(rest(table), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(rows),
  });
  return res.json();
}

export async function upsertRows(table, rows, onConflict = 'id') {
  const res = await authFetch(rest(`${table}?on_conflict=${onConflict}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(rows),
  });
  return res.json();
}

export async function updateRow(table, id, values) {
  const res = await authFetch(rest(`${table}?id=eq.${encodeURIComponent(id)}`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(values),
  });
  const rows = await res.json();
  if (rows.length !== 1) throw new AppError('対象のデータが見つかりませんでした。画面を更新してください。', `update ${table} ${id}: ${rows.length} rows`);
  return rows[0];
}

export async function deleteWhere(table, column, value) {
  await authFetch(rest(`${table}?${column}=eq.${encodeURIComponent(value)}`), { method: 'DELETE' });
}

export async function deleteAll(table) {
  await authFetch(rest(`${table}?id=not.is.null`), { method: 'DELETE' });
}

export async function rpc(name, args = {}) {
  const res = await authFetch(rest(`rpc/${name}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  return res.json();
}

// ---------------------------------------------------------------- Storage

function objectPath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

export async function uploadPhoto(path, blob) {
  await authFetch(`${CONFIG.supabaseUrl}/storage/v1/object/${BUCKET}/${objectPath(path)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/jpeg', 'x-upsert': 'false' },
    body: blob,
  });
}

export async function downloadPhoto(path) {
  const res = await authFetch(`${CONFIG.supabaseUrl}/storage/v1/object/authenticated/${BUCKET}/${objectPath(path)}`);
  return res.blob();
}

export async function removePhotos(paths) {
  if (paths.length === 0) return;
  await authFetch(`${CONFIG.supabaseUrl}/storage/v1/object/${BUCKET}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes: paths }),
  });
}
