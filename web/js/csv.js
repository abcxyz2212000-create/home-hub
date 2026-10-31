// CSV reading and writing (RFC 4180) without external libraries.

const FORMULA_START = /^[=+\-@\t\r]/;

// Parse CSV text into an array of rows (arrays of strings).
export function parseCSV(text) {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r' || ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
    } else {
      field += ch;
    }
    i += 1;
  }
  if (quoted) throw new Error('CSV parse error: unterminated quoted field');
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

// Values starting with = + - @ are prefixed with ' so that Excel does not run them as formulas.
function escapeFormula(value) {
  return FORMULA_START.test(value) ? `'${value}` : value;
}

export function unescapeFormula(value) {
  return value.length > 1 && value[0] === "'" && FORMULA_START.test(value.slice(1)) ? value.slice(1) : value;
}

export function toCSV(rows) {
  const lines = rows.map((r) =>
    r
      .map((v) => {
        const s = escapeFormula(v === null || v === undefined ? '' : String(v));
        return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
      })
      .join(','),
  );
  // BOM + CRLF so that Excel on Windows opens it as UTF-8.
  return '﻿' + lines.join('\r\n') + '\r\n';
}

// Decode a CSV file: UTF-8 first, then Shift_JIS (Excel "CSV (comma delimited)" on Japanese Windows).
export function decodeCSVBytes(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('shift_jis').decode(buffer);
  }
}
