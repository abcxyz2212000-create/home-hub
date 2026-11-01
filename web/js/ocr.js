// OCR of a receipt photo (立替) or a bank's transfer-completed screen (入金報告).
// Tesseract.js is bundled under vendor/tesseract and loaded only when used; the image never leaves the
// browser. The parsing below is pure (tested with sample texts) and only suggests values: the user
// checks them before saving.

const VENDOR = new URL('../vendor/tesseract/', import.meta.url).href;

// Run OCR on an image (File / Blob). onProgress(0..1, label) is optional.
export async function recognizeImage(image, onProgress = () => {}) {
  const Tesseract = await import(`${VENDOR}tesseract.esm.min.js`);
  const createWorker = Tesseract.createWorker || (Tesseract.default && Tesseract.default.createWorker);
  const worker = await createWorker('jpn', 1, {
    workerPath: `${VENDOR}worker.min.js`,
    corePath: `${VENDOR}core`,
    langPath: `${VENDOR}lang`,
    workerBlobURL: false,
    gzip: true,
    logger: (m) => {
      if (m && typeof m.progress === 'number') onProgress(m.progress, m.status === 'recognizing text' ? '読み取り中' : '準備中');
    },
  });
  try {
    const { data } = await worker.recognize(image);
    return String(data.text || '');
  } finally {
    await worker.terminate();
  }
}

const AMOUNT_RE = /([¥￥\\]\s*)?(\d{1,3}(?:[,，.]\d{3})+|\d+)\s*(円)?/g;

function toAmount(s) {
  const n = Number(String(s).replace(/[,，.]/g, ''));
  return Number.isInteger(n) && n > 0 && n <= 100000000 ? n : null;
}

// Amounts written on a line (with ¥ / 円 marks first). Phone numbers and dates are left out.
function amountsOn(line) {
  const out = [];
  const clean = line.replace(/\d{2,4}[-‐ー−]\d{2,4}[-‐ー−]\d{3,4}/g, ' ')
    .replace(/\d{2,4}\s*[年/.-]\s*\d{1,2}\s*[月/.-]\s*\d{1,2}\s*日?/g, ' ')
    .replace(/\d{1,2}\s*[:：]\s*\d{2}/g, ' ');
  for (const m of clean.matchAll(AMOUNT_RE)) {
    const v = toAmount(m[2]);
    if (v !== null) out.push({ value: v, marked: Boolean(m[1] || m[3]) });
  }
  return out;
}

const TOTAL_KEYS = [/合\s*計/, /お?支\s*払\s*(金\s*額|額)?/, /ご?請\s*求\s*(金\s*額|額)/, /お?振\s*込\s*(金\s*額|額)/, /振\s*替\s*金\s*額/, /取\s*引\s*金\s*額/, /金\s*額/];
const NOT_TOTAL = /小\s*計|対\s*象|内\s*税|消\s*費\s*税|税\s*率|お?預\s*り|お?釣|手\s*数\s*料|残\s*高|ポイント|点\s*数/;

// The total: the first number on (or right after) a line with a total keyword, by keyword priority;
// otherwise the largest amount written with ¥ or 円.
export function findAmount(lines) {
  for (const key of TOTAL_KEYS) {
    for (let i = 0; i < lines.length; i += 1) {
      if (!key.test(lines[i]) || NOT_TOTAL.test(lines[i])) continue;
      const here = amountsOn(lines[i].replace(key, ' '));
      if (here.length) return here[here.length - 1].value;
      const next = lines[i + 1] ? amountsOn(lines[i + 1]) : [];
      if (next.length) return next[0].value;
    }
  }
  const marked = lines.flatMap(amountsOn).filter((a) => a.marked).map((a) => a.value);
  return marked.length ? Math.max(...marked) : null;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function validDate(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return y >= 2000 && y <= 2100 && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
}

// The first date written in full (2026年10月5日 / 2026/10/05 / 2026-10-05 / 2026.10.05 / 令和8年10月5日).
export function findDate(text) {
  const t = String(text);
  const western = /(20\d{2})\s*[年/.\-]\s*(\d{1,2})\s*[月/.\-]\s*(\d{1,2})/g;
  const reiwa = /(?:令和|R)\s*(\d{1,2})\s*[年/.\-]\s*(\d{1,2})\s*[月/.\-]\s*(\d{1,2})/g;
  const found = [];
  for (const m of t.matchAll(western)) found.push({ at: m.index, v: validDate(Number(m[1]), Number(m[2]), Number(m[3])) });
  for (const m of t.matchAll(reiwa)) found.push({ at: m.index, v: validDate(2018 + Number(m[1]), Number(m[2]), Number(m[3])) });
  const ok = found.filter((f) => f.v).sort((a, b) => a.at - b.at);
  return ok.length ? ok[0].v : null;
}

const SKIP_LINE = /領\s*収|レシート|tel|電\s*話|〒|登録番号|no\.|#|様|毎度|ありがとう|http|www|店\s*舗|レジ|担当|責/i;

// Store name: the first line that looks like a name (not numbers, not the receipt title).
export function findStore(lines) {
  for (const l of lines.slice(0, 8)) {
    const s = l.trim();
    if (s.length < 2 || s.length > 30 || SKIP_LINE.test(s)) continue;
    const letters = s.replace(/[\d\s¥￥,.:\-/()（）*＊]/g, '');
    if (letters.length >= 2) return s;
  }
  return null;
}

// Item names: lines that end with a price, between the top and the total line.
export function findItems(lines, max = 5) {
  const out = [];
  for (const l of lines) {
    if (TOTAL_KEYS.slice(0, 1).some((k) => k.test(l)) || /小\s*計/.test(l)) break;
    if (NOT_TOTAL.test(l) || SKIP_LINE.test(l) || findDate(l) || /\d{1,2}\s*[:：]\s*\d{2}/.test(l)) continue;
    const m = /^(.*?[^\d\s¥￥,.*＊]{2,}.*?)\s*[¥￥\\]?\s*\d{1,3}(?:[,，]\d{3})*\s*円?\s*[*＊A-Z軽]?$/.exec(l.trim());
    if (m) {
      const name = m[1].replace(/^[\d\s*＊.・-]+/, '').replace(/\s+/g, ' ').trim();
      if (name.length >= 2 && name.length <= 30) out.push(name);
    }
    if (out.length >= max) break;
  }
  return out;
}

// kind: 'receipt' (立替: amount, date, store, items) | 'transfer' (入金報告: amount, date).
export function parseOcrText(text, kind = 'receipt') {
  const lines = String(text || '').normalize('NFKC').split(/\r?\n/).map((l) => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean);
  const out = { amount: findAmount(lines), date: findDate(lines.join('\n')) };
  if (kind === 'receipt') {
    out.store = findStore(lines);
    out.items = findItems(lines.slice(out.store ? lines.indexOf(out.store) + 1 : 0));
  }
  return out;
}

// Text for the memo: "店名：品目、品目" (at most 200 characters).
export function receiptMemo({ store, items }) {
  const text = [store, (items || []).join('、')].filter(Boolean).join('：');
  return text.length <= 200 ? text : `${text.slice(0, 199)}…`;
}
