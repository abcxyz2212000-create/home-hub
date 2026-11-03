// One-time: upload the evidence files listed in evidence-upload/manifest.json to the private bucket
// "evidence" and record them in budget_attachments. Runs on GitHub Actions (.github/workflows/
// evidence-upload.yml) by hand. Skips a file already recorded for the same year and name.
// Logs of a public repository are public: only counts and years are printed.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { CONFIG } from '../web/js/config.js';

const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
if (!key) throw new Error('missing environment variable SUPABASE_SERVICE_ROLE_KEY');
const base = (process.env.SUPABASE_URL || CONFIG.supabaseUrl).replace(/\/$/, '');
const headers = { apikey: key };
if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;
const TYPES = { pdf: 'application/pdf', jpg: 'image/jpeg', png: 'image/png' };

const manifest = JSON.parse(readFileSync('evidence-upload/manifest.json', 'utf8'));
const existing = await (await fetch(`${base}/rest/v1/budget_attachments?select=year,name,path`, { headers })).json();

// files left by an earlier failed run (stored, not recorded) are removed first
for (const year of new Set(manifest.map((f) => f.year))) {
  const res = await fetch(`${base}/storage/v1/object/list/evidence`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ prefix: `budget/${year}`, limit: 100 }) });
  if (!res.ok) throw new Error(`list failed: HTTP ${res.status} ${await res.text()}`);
  const orphans = (await res.json()).map((o) => `budget/${year}/${o.name}`).filter((p) => !existing.some((e) => e.path === p));
  if (orphans.length) {
    await fetch(`${base}/storage/v1/object/evidence`, { method: 'DELETE', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: orphans }) });
    console.log(`${year}: removed ${orphans.length} unrecorded file(s)`);
  }
}
let added = 0;
for (const f of manifest) {
  if (existing.some((e) => e.year === f.year && e.name === f.name)) {
    console.log(`${f.year}: already there`);
    continue;
  }
  const ext = f.file.split('.').pop().toLowerCase();
  const type = TYPES[ext];
  if (!type) throw new Error(`unsupported file type: ${ext}`);
  const body = readFileSync(`evidence-upload/${f.file}`);
  if (body.length > 5 * 1024 * 1024) throw new Error(`${f.year}: file over 5 MB`);
  const path = `budget/${f.year}/${randomUUID()}.${ext}`;
  let res = await fetch(`${base}/storage/v1/object/evidence/${path}`, { method: 'POST', headers: { ...headers, 'Content-Type': type, 'x-upsert': 'false' }, body });
  if (!res.ok) throw new Error(`${f.year}: upload failed: HTTP ${res.status} ${await res.text()}`);
  res = await fetch(`${base}/rest/v1/budget_attachments`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify([{ year: f.year, path, name: f.name, content_type: type, bytes: body.length, created_by: null }]),
  });
  if (!res.ok) {
    const text = await res.text();
    await fetch(`${base}/storage/v1/object/evidence`, { method: 'DELETE', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: [path] }) });
    throw new Error(`${f.year}: record failed (file removed again): HTTP ${res.status} ${text}`);
  }
  added += 1;
  console.log(`${f.year}: uploaded`);
}
console.log(`Added ${added} of ${manifest.length} file(s).`);
