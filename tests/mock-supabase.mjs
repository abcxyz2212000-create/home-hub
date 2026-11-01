// In-memory stand-in for the parts of Supabase the app uses (Auth, PostgREST subset, Storage),
// plus a static file server for web/ and a fake push service. Test use only.
import http from 'node:http';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

export const OWNER = { email: 'owner@example.com', password: 'correct-horse-battery', id: '11111111-1111-1111-1111-111111111111' };
export const MEMBER = { email: 'hanako@example.com', password: 'member-pass-phrase', id: '22222222-2222-2222-2222-222222222222' };
export const STRANGER = { email: 'stranger@example.com', password: 'stranger-pass-phrase', id: '33333333-3333-3333-3333-333333333333' };
const USERS = [OWNER, MEMBER, STRANGER];
export const ANON_KEY = 'test-publishable-key-0123456789';
export const SERVICE_KEY = 'test-service-key-0123456789';

const WEB = fileURLToPath(new URL('../web/', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const DEFAULTS = {
  status: 'active', links: [], tags: [], notify_days: {}, mf_linked: false, family_card: false, etc_card: false, auto_renew: false, shared_cost: false, price_history: [],
};
const TABLES = ['accounts', 'cards', 'contracts', 'items', 'memberships', 'item_photos', 'settings', 'push_subscriptions', 'notification_log', 'members', 'audit_log', 'chores', 'shared_rules', 'shared_entries', 'transactions', 'deposit_reports', 'shared_attachments'];
const TABLE_DEFAULTS = {
  members: { role: 'member', active: true, email: null, nickname: null, transfer_names: null, gender: null },
  settings: {}, notification_log: {}, push_subscriptions: {}, audit_log: {},
  chores: { status: 'active', schedule: [], adjust: 1, assignee_type: 'member', assignee_id: null },
  shared_rules: { end_ym: null, memo: null, month_of_year: null, contract_id: null },
  shared_entries: { memo: null, paid_on: null },
  deposit_reports: { memo: null },
  shared_attachments: { entry_id: null, report_id: null, bytes: 0 },
  transactions: { contract_id: null, account_id: null, card_id: null, memo: null, counted: true, transfer: false, personal_member_id: null, needs_review: false, settled_entry_id: null, deposit_entry_id: null, deposit_ignored: false },
};
const SET_NULL = {
  accounts: [['cards', 'debit_account_id'], ['contracts', 'pay_account_id']],
  cards: [['contracts', 'pay_card_id'], ['memberships', 'card_id']],
  contracts: [['shared_rules', 'contract_id'], ['transactions', 'contract_id']],
  shared_entries: [['transactions', 'settled_entry_id'], ['transactions', 'deposit_entry_id']],
  members: [...['accounts', 'cards', 'contracts', 'items', 'memberships'].map((t) => [t, 'holder_id']), ['chores', 'assignee_id']],
};

export function createMock() {
  const db = Object.fromEntries(TABLES.map((t) => [t, []]));
  const files = new Map();
  const tokens = new Map(); // access token -> user
  const refresh = new Map();
  const pushes = [];
  const passwords = new Map(USERS.map((u) => [u.email, u.password])); // changeable per mock
  const recoveries = []; // e-mails a reset link was requested for

  const issue = (user) => {
    const access = crypto.randomUUID();
    const r = crypto.randomUUID();
    tokens.set(access, user);
    refresh.set(r, user);
    return { access_token: access, refresh_token: r, expires_in: 3600, token_type: 'bearer', user: { id: user.id, email: user.email } };
  };

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(body === undefined ? '' : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };

  const readBody = (req) => new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });

  const matches = (row, params) => {
    for (const [k, v] of params) {
      if (['select', 'order', 'on_conflict', 'limit', 'offset'].includes(k)) continue;
      if (v.startsWith('eq.') && String(row[k]) !== v.slice(3)) return false;
      if (v === 'not.is.null' && (row[k] === null || row[k] === undefined)) return false;
      if (v.startsWith('lt.') && !(String(row[k]) < v.slice(3))) return false;
      if (v.startsWith('gte.') && !(String(row[k]) >= v.slice(4))) return false;
      if (v === 'is.null' && !(row[k] === null || row[k] === undefined)) return false;
    }
    return true;
  };

  const api = async (req, res, url) => {
    const body = await readBody(req);
    const key = req.headers.apikey;
    if (key !== ANON_KEY && key !== SERVICE_KEY) return send(res, 401, { message: 'invalid apikey' });

    if (url.pathname === '/auth/v1/token') {
      const data = JSON.parse(body.toString() || '{}');
      if (url.searchParams.get('grant_type') === 'password') {
        const user = USERS.find((u) => u.email === data.email && passwords.get(u.email) === data.password);
        if (user) return send(res, 200, issue(user));
        return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
      }
      if (refresh.has(data.refresh_token)) {
        const user = refresh.get(data.refresh_token);
        refresh.delete(data.refresh_token);
        return send(res, 200, issue(user));
      }
      return send(res, 400, { error: 'invalid_grant' });
    }

    if (url.pathname === '/auth/v1/recover' && req.method === 'POST') {
      const data = JSON.parse(body.toString() || '{}');
      recoveries.push({ email: data.email, redirect_to: url.searchParams.get('redirect_to') });
      return send(res, 200, {});
    }

    const service = key === SERVICE_KEY;
    const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (!service && !tokens.has(bearer)) return send(res, 401, { code: 'PGRST301', message: 'JWT expired' });

    if (url.pathname === '/auth/v1/user') {
      const user = tokens.get(bearer);
      if (req.method === 'PUT') {
        const data = JSON.parse(body.toString() || '{}');
        if (typeof data.password !== 'string' || data.password.length < 6) return send(res, 422, { code: 422, error_code: 'weak_password', msg: 'Password should be at least 6 characters.' });
        if (data.password === passwords.get(user.email)) return send(res, 422, { code: 422, error_code: 'same_password', msg: 'New password should be different from the old password.' });
        passwords.set(user.email, data.password);
      }
      return send(res, 200, { id: user.id, email: user.email });
    }

    if (url.pathname === '/auth/v1/logout') {
      if (url.searchParams.get('scope') === 'global') {
        tokens.clear();
        refresh.clear();
      } else tokens.delete(bearer);
      return send(res, 204);
    }

    if (url.pathname.startsWith('/storage/v1/object/')) {
      const rest = decodeURIComponent(url.pathname.slice('/storage/v1/object/'.length));
      if (req.method === 'POST') {
        const path = rest.replace(/^item-photos\//, '');
        if (files.has(path)) return send(res, 409, { error: 'Duplicate' });
        files.set(path, body);
        return send(res, 200, { Key: rest });
      }
      if (req.method === 'GET') {
        const path = rest.replace(/^authenticated\/item-photos\//, '');
        if (!files.has(path)) return send(res, 404, { error: 'not_found' });
        return send(res, 200, files.get(path), { 'Content-Type': 'image/jpeg' });
      }
      if (req.method === 'DELETE') {
        for (const p of JSON.parse(body.toString()).prefixes) files.delete(p);
        return send(res, 200, []);
      }
    }

    if (url.pathname === '/rest/v1/rpc/usage_stats') {
      const storage = [...files.values()].reduce((s, b) => s + b.length, 0);
      return send(res, 200, { db_bytes: JSON.stringify(db).length + 8 * 1024 * 1024, storage_bytes: storage, photo_count: db.item_photos.length });
    }

    const table = url.pathname.replace('/rest/v1/', '');
    if (!TABLES.includes(table)) return send(res, 404, { code: 'PGRST205', message: `no table ${table}` });
    if (table === 'notification_log' && !service) return send(res, 401, { code: '42501', message: 'permission denied' });
    const params = [...url.searchParams.entries()];
    const rows = db[table];

    if (req.method === 'GET') {
      let out = rows.filter((r) => matches(r, params));
      const order = url.searchParams.get('order');
      if (order) {
        const [col, dir] = order.split('.');
        out = [...out].sort((a, b) => String(a[col] ?? '').localeCompare(String(b[col] ?? ''), 'ja') * (dir === 'desc' ? -1 : 1));
      }
      const offset = Number(url.searchParams.get('offset')) || 0;
      const limit = Number(url.searchParams.get('limit'));
      if (offset > 0) out = out.slice(offset);
      if (limit > 0) out = out.slice(0, limit);
      return send(res, 200, out);
    }
    if (req.method === 'POST') {
      const input = JSON.parse(body.toString());
      const list = Array.isArray(input) ? input : [input];
      const upsert = (req.headers.prefer || '').includes('merge-duplicates');
      const conflict = url.searchParams.get('on_conflict') || 'id';
      const result = [];
      for (const item of list) {
        if (item.pay_card_id && item.pay_account_id) return send(res, 400, { code: '23514', message: 'check violation' });
        const existing = rows.find((r) => item[conflict] !== undefined && r[conflict] === item[conflict]);
        if (existing && !upsert) return send(res, 409, { code: '23505', message: 'duplicate key' });
        if (existing) {
          Object.assign(existing, item, { updated_at: new Date().toISOString() });
          result.push(existing);
        } else {
          const row = { id: crypto.randomUUID(), ...(TABLE_DEFAULTS[table] ?? DEFAULTS), ...item, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
          if (table === 'notification_log') row.sent_at = row.created_at;
          rows.push(row);
          result.push(row);
        }
      }
      return send(res, 201, (req.headers.prefer || '').includes('return=representation') ? result : undefined);
    }
    if (req.method === 'PATCH') {
      const values = JSON.parse(body.toString());
      const hit = rows.filter((r) => matches(r, params));
      for (const r of hit) Object.assign(r, values, { updated_at: new Date().toISOString() });
      return send(res, 200, hit);
    }
    if (req.method === 'DELETE') {
      const gone = rows.filter((r) => matches(r, params));
      db[table] = rows.filter((r) => !gone.includes(r));
      for (const g of gone) {
        for (const [t, col] of SET_NULL[table] || []) for (const r of db[t]) if (r[col] === g.id) r[col] = null;
        if (table === 'items') db.item_photos = db.item_photos.filter((p) => p.item_id !== g.id);
      }
      return send(res, 204);
    }
    return send(res, 405, { message: 'method not allowed' });
  };

  const apiServer = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'apikey, authorization, content-type, prefer, x-upsert');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return send(res, 204);
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname.startsWith('/push/')) {
      const body = await readBody(req);
      pushes.push({ id: url.pathname.slice(6), headers: req.headers, body });
      return send(res, url.pathname === '/push/gone' ? 410 : 201);
    }
    try {
      return await api(req, res, url);
    } catch (e) {
      return send(res, 500, { message: e.message });
    }
  });

  // Static server for web/. config.js and the CSP are rewritten to point at the mock API.
  const staticServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, '') || 'index.html';
    if (rel.includes('..')) return send(res, 400, 'bad path');
    const apiUrl = `http://127.0.0.1:${apiServer.address().port}`;
    if (rel === 'js/config.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      return res.end(`export const CONFIG = { supabaseUrl: '${apiUrl}', supabaseKey: '${ANON_KEY}' };`);
    }
    try {
      let data = await readFile(join(WEB, rel.endsWith('/') ? `${rel}index.html` : rel));
      if (rel === 'index.html') data = Buffer.from(data.toString().replace('https://*.supabase.co', apiUrl));
      res.writeHead(200, { 'Content-Type': TYPES[extname(rel)] || 'application/octet-stream' });
      return res.end(data);
    } catch {
      return send(res, 404, 'not found');
    }
  });

  return {
    db, files, pushes, passwords, recoveries,
    // tokens as they arrive in a link from an e-mail (invite / password reset)
    linkTokens: (user) => issue(user),
    async start() {
      await new Promise((r) => apiServer.listen(0, '127.0.0.1', r));
      await new Promise((r) => staticServer.listen(0, '127.0.0.1', r));
      return { apiUrl: `http://127.0.0.1:${apiServer.address().port}`, appUrl: `http://127.0.0.1:${staticServer.address().port}/` };
    },
    async stop() {
      await new Promise((r) => apiServer.close(r));
      await new Promise((r) => staticServer.close(r));
    },
  };
}
