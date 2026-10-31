// Form/CSV value parsing and validation. Returns user-facing messages in Japanese.
import { EVENT_TYPES, toDayNumber } from './events.js';
import { optionPairs } from './schema.js';

export const MAX_LINKS = 20;
export const MAX_TAGS = 20;

export function safeUrl(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!/^https?:\/\//i.test(v) || v.length > 2000) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

function normDate(raw) {
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(raw);
  if (!m) return null;
  const iso = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return toDayNumber(iso) === null ? null : iso;
}

function normMonth(raw) {
  // Accepts 2027-05, 2027/5, and Excel-style 2027/5/1.
  const m = /^(\d{4})[-/.](\d{1,2})(?:[-/.]\d{1,2})?$/.exec(raw);
  if (!m) return null;
  const mo = Number(m[2]);
  return mo >= 1 && mo <= 12 ? `${m[1]}-${String(mo).padStart(2, '0')}` : null;
}

function toHalfWidth(s) {
  return s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/[，,]/g, '');
}

const TRUE_WORDS = ['はい', 'あり', '有', '○', '〇', 'true', 'TRUE', '1', 'yes'];
const FALSE_WORDS = ['いいえ', 'なし', '無', '×', 'false', 'FALSE', '0', 'no', ''];

// Parse one scalar field. Returns { value } or { error }.
export function parseField(field, raw) {
  const s = typeof raw === 'string' ? raw.trim() : raw;
  const empty = s === '' || s === null || s === undefined;
  const label = field.label;
  switch (field.type) {
    case 'text':
    case 'textarea':
      if (empty) return field.required ? { error: `${label}を入力してください。` } : { value: null };
      if (s.length > (field.max || 200)) return { error: `${label}は${field.max}文字以内で入力してください。` };
      return { value: s };
    case 'email':
      if (empty) return { value: null };
      if (s.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return { error: `${label}の形式が正しくありません。` };
      return { value: s };
    case 'url':
      if (empty) return { value: null };
      return safeUrl(s) ? { value: safeUrl(s) } : { error: `${label}は http:// または https:// で始まるURLを入力してください。` };
    case 'select':
    case 'status': {
      if (empty && field.required) return { error: `${label}を選んでください。` };
      if (empty) return field.type === 'status' ? { value: 'active' } : { value: null };
      const hit = optionPairs(field).find(([v, l]) => v === s || l === s);
      return hit ? { value: hit[0] } : { error: `${label}は「${optionPairs(field).map((p) => p[1]).join('」「')}」のいずれかにしてください。` };
    }
    case 'int': {
      if (empty) return { value: null };
      const t = toHalfWidth(String(s)).replace(/円$/, '');
      if (!/^\d+$/.test(t) || Number(t) > (field.max || 100000000)) return { error: `${label}は0以上の整数で入力してください。` };
      return { value: Number(t) };
    }
    case 'decimal': {
      if (empty) return field.required ? { error: `${label}を入力してください。` } : { value: null };
      const t = toHalfWidth(String(s));
      const n = Number(t);
      if (!/^\d+(\.\d+)?$/.test(t) || n < (field.min ?? 0) || n > (field.max ?? 100000)) {
        return { error: `${label}は${field.min ?? 0}〜${field.max ?? 100000}の数で入力してください。` };
      }
      return { value: n };
    }
    case 'code': {
      // Fixed-length numeric code (bank code 4 digits, branch number 3 digits). Excel drops leading zeros, so pad.
      if (empty) return { value: null };
      const t = toHalfWidth(String(s));
      return new RegExp(`^\\d{1,${field.digits}}$`).test(t)
        ? { value: t.padStart(field.digits, '0') }
        : { error: `${label}は数字${field.digits}桁で入力してください。` };
    }
    case 'accountno': {
      if (empty) return { value: null };
      const t = toHalfWidth(String(s)).replace(/[\s\-ー－‐]/g, '');
      return /^\d{4,14}$/.test(t) ? { value: t } : { error: `${label}は数字4〜14桁で入力してください。` };
    }
    case 'last4': {
      if (empty) return { value: null };
      const t = toHalfWidth(String(s));
      return /^\d{4}$/.test(t) ? { value: t } : { error: `${label}は数字4桁で入力してください（全桁は保存しません）。` };
    }
    case 'day':
    case 'monthnum': {
      if (empty) return { value: null };
      const t = toHalfWidth(String(s)).replace(/[日月]$/, '').replace(/^末$/, '31');
      const max = field.type === 'day' ? 31 : 12;
      const n = Number(t);
      return /^\d{1,2}$/.test(t) && n >= 1 && n <= max ? { value: n } : { error: `${label}は1〜${max}の数字で入力してください。` };
    }
    case 'date': {
      if (empty) return { value: null };
      const v = normDate(String(s));
      return v ? { value: v } : { error: `${label}は 2026-01-31 の形式で入力してください。` };
    }
    case 'month': {
      if (empty) return { value: null };
      const v = normMonth(String(s));
      return v ? { value: v } : { error: `${label}は 2027-05 の形式で入力してください。` };
    }
    case 'bool':
      if (typeof s === 'boolean') return { value: s };
      if (TRUE_WORDS.includes(s)) return { value: true };
      if (FALSE_WORDS.includes(s ?? '')) return { value: false };
      return { error: `${label}は「はい」または「いいえ」で入力してください。` };
    default:
      return { error: `${label}: unsupported field type ${field.type}` };
  }
}

// Tags: split by spaces, 、 or ,
export function parseTags(raw) {
  const list = String(raw || '')
    .split(/[\s、,，]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  const uniq = [...new Set(list)];
  if (uniq.length > MAX_TAGS) return { error: `タグは${MAX_TAGS}個までです。` };
  if (uniq.some((t) => t.length > 30)) return { error: 'タグは1つ30文字以内にしてください。' };
  return { value: uniq };
}

// Links: array of { label, url }. Empty rows are dropped.
export function validateLinks(links) {
  const out = [];
  for (const l of links || []) {
    const label = String(l.label || '').trim();
    const url = String(l.url || '').trim();
    if (!label && !url) continue;
    const safe = safeUrl(url);
    if (!safe) return { error: `リンク「${label || url}」のURLは http:// または https:// で始めてください。` };
    if (label.length > 50) return { error: 'リンクの名前は50文字以内にしてください。' };
    out.push({ label: label || 'リンク', url: safe });
  }
  if (out.length > MAX_LINKS) return { error: `リンクは${MAX_LINKS}件までです。` };
  return { value: out };
}

// CSV links cell: one link per line, "名前|URL" or just "URL".
export function parseLinksCell(raw) {
  const links = String(raw || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const i = line.lastIndexOf('|');
      return i >= 0 ? { label: line.slice(0, i), url: line.slice(i + 1) } : { label: '', url: line };
    });
  return validateLinks(links);
}

export function linksCell(links) {
  return (links || []).map((l) => `${l.label}|${l.url}`).join('\n');
}

// Notification override: "" -> default (undefined), "なし" -> [], "30,7" -> [30, 7]
export function parseNotifyDays(raw, type) {
  const s = toHalfWidth(String(raw || '').trim().replace(/、/g, ' ')).replace(/日前?/g, '');
  if (s === '') return { value: undefined };
  if (['なし', '無し', '-', 'しない'].includes(s)) return { value: [] };
  const parts = s.split(/[\s/]+|,/).filter(Boolean);
  if (parts.length > 5 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 365)) {
    return { error: `${EVENT_TYPES[type].label}の通知タイミングは「30 7」のように0〜365の日数で入力してください（「なし」で通知しない）。` };
  }
  return { value: [...new Set(parts.map(Number))].sort((a, b) => b - a) };
}

export function notifyDaysText(record, type) {
  const v = record && record.notify_days ? record.notify_days[type] : undefined;
  if (!Array.isArray(v)) return '';
  return v.length === 0 ? 'なし' : v.join(' ');
}

// Card numbers must not be stored: detect 13-19 digit sequences that pass the Luhn check.
export function findCardNumberLike(text) {
  if (typeof text !== 'string') return false;
  const candidates = text.replace(/[ -]/g, '').match(/\d{13,19}/g) || [];
  return candidates.some((digits) => {
    let sum = 0;
    for (let i = 0; i < digits.length; i += 1) {
      let d = Number(digits[digits.length - 1 - i]);
      if (i % 2 === 1) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
    }
    return sum % 10 === 0;
  });
}
