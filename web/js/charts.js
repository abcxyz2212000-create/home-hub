// SVG charts built with DOM APIs (text is always set with textContent; no external libraries).
// Colors are CSS custom properties defined in css/app.css, so light/dark themes switch in one place.
const NS = 'http://www.w3.org/2000/svg';

function s(tag, attrs, ...children) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v !== null && v !== undefined && v !== false) el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function root(width, height, label) {
  return s('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', role: 'img', 'aria-label': label, class: 'chart' });
}

export function shorten(text, max) {
  const t = String(text ?? '');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const yen = (n) => `${Math.round(n).toLocaleString('ja-JP')}円`;

// Deadline status: color is always paired with an icon and a "あと○日" label elsewhere.
export function urgency(daysLeft) {
  if (daysLeft < 0) return 'past';
  if (daysLeft <= 7) return 'crit';
  if (daysLeft <= 30) return 'warn';
  return 'ok';
}

// Timeline from today to `span` days ahead with one marker per event.
// events: [{ daysLeft, date: 'YYYY-MM-DD', name }]
export function timelineChart(events, span = 60) {
  const W = 360;
  const H = 74;
  const x0 = 14;
  const x1 = W - 14;
  const lineY = 52;
  const x = (d) => x0 + ((x1 - x0) * Math.min(Math.max(d, 0), span)) / span;
  const svg = root(W, H, `今日から${span}日先までの期限（${events.length}件）`);
  svg.append(s('line', { x1: x0, y1: lineY, x2: x1, y2: lineY, class: 'tl-axis' }));
  svg.append(s('rect', { x: x0, y: lineY - 2, width: x(7) - x0, height: 4, rx: 2, class: 'tl-crit-zone' }));
  for (const t of [0, 30, span]) {
    svg.append(s('line', { x1: x(t), y1: lineY - 4, x2: x(t), y2: lineY + 4, class: 'tl-axis' }));
    svg.append(s('text', { x: x(t), y: H - 4, class: 'tl-tick', 'text-anchor': t === 0 ? 'start' : t === span ? 'end' : 'middle' }, t === 0 ? '今日' : `${t}日後`));
  }
  const shown = events.filter((e) => e.daysLeft >= 0 && e.daysLeft <= span);
  shown.forEach((e, i) => {
    const cx = x(e.daysLeft);
    const labelY = 12 + (i % 3) * 12;
    const anchor = cx < 60 ? 'start' : cx > W - 60 ? 'end' : 'middle';
    svg.append(s('line', { x1: cx, y1: labelY + 3, x2: cx, y2: lineY - 7, class: 'tl-stem' }));
    svg.append(s('circle', { cx, cy: lineY, r: 6.5, class: `tl-dot tl-${urgency(e.daysLeft)}` }));
    svg.append(s('text', { x: cx, y: labelY, class: 'tl-label', 'text-anchor': anchor }, `${e.date.slice(5).replace('-', '/')} ${shorten(e.name, 7)}`));
  });
  return svg;
}

// Ranked horizontal bars of one hue (magnitude). rows: [[label, value]] (sorted by the caller or here).
export function barChart(rows, ariaLabel, format = yen) {
  const sorted = [...rows].sort((a, b) => b[1] - a[1]);
  const max = Math.max(...sorted.map((r) => r[1]), 1);
  const W = 360;
  const rowH = 28;
  const labelW = 70;
  const valueW = 78;
  const trackW = W - labelW - valueW;
  const svg = root(W, sorted.length * rowH, ariaLabel);
  sorted.forEach(([label, value], i) => {
    const y = i * rowH;
    svg.append(s('text', { x: 0, y: y + 18, class: 'bar-label' }, shorten(label, 6)));
    svg.append(s('rect', { x: labelW, y: y + 8, width: trackW, height: 12, rx: 4, class: 'bar-track' }));
    svg.append(s('rect', { x: labelW, y: y + 8, width: Math.max((trackW * value) / max, 3), height: 12, rx: 4, class: 'bar-fill' }));
    svg.append(s('text', { x: W, y: y + 18, class: 'bar-value', 'text-anchor': 'end' }, format(value)));
  });
  return svg;
}

// Three-column flow (accounts -> cards -> contracts). Band width = monthly amount.
// columns: [[node], [node], [node]], node: { id, label, sub, value, color, href }
// links: [{ from, to, value, color }]
export function flowChart(columns, links, { compact = false, ariaLabel = 'お金の流れ' } = {}) {
  const W = 360;
  const X = [0, 150, 222];
  const nodeW = 8;
  const gap = compact ? 6 : 10;
  const minSlot = compact ? 0 : 18;
  const total = columns[0].reduce((sum, n) => sum + n.value, 0) || 1;
  const rightCount = columns[2].length;
  const target = compact ? 160 : Math.max(240, rightCount * 24);
  const scale = target / total;
  const nodes = new Map();
  columns.forEach((list, col) => {
    let y = 4;
    for (const n of list) {
      const hgt = n.value * scale;
      nodes.set(n.id, { ...n, col, x: X[col], y, h: hgt, out: [], in: [] });
      y += Math.max(hgt, minSlot) + gap;
    }
  });
  const H = Math.max(...[...nodes.values()].map((n) => n.y + Math.max(n.h, minSlot))) + 6;
  const svg = root(W, H, ariaLabel);

  for (const l of links) {
    const a = nodes.get(l.from);
    const b = nodes.get(l.to);
    if (!a || !b || l.value <= 0) continue;
    const link = { ...l, a, b, h: l.value * scale };
    a.out.push(link);
    b.in.push(link);
  }
  // order bands by the position of the other end to reduce crossings
  for (const n of nodes.values()) {
    let oy = n.y;
    for (const l of n.out.sort((p, q) => p.b.y - q.b.y)) { l.y0 = oy; oy += l.h; }
    let iy = n.y;
    for (const l of n.in.sort((p, q) => p.a.y - q.a.y)) { l.y1 = iy; iy += l.h; }
  }
  const bands = s('g', { class: 'flow-bands' });
  for (const n of nodes.values()) {
    for (const l of n.out) {
      const xa = l.a.x + nodeW;
      const xb = l.b.x;
      const m = (xa + xb) / 2;
      bands.append(s('path', {
        d: `M${xa},${l.y0} C${m},${l.y0} ${m},${l.y1} ${xb},${l.y1} L${xb},${l.y1 + l.h} C${m},${l.y1 + l.h} ${m},${l.y0 + l.h} ${xa},${l.y0 + l.h} Z`,
        fill: l.color,
        class: 'flow-band',
      }));
    }
  }
  svg.append(bands);

  const label = (n, el) => (n.href ? s('a', { href: n.href }, el) : el);
  for (const n of nodes.values()) {
    svg.append(s('rect', { x: n.x, y: n.y, width: nodeW, height: Math.max(n.h, 2), rx: 2, fill: n.color }));
    const mid = n.y + Math.max(n.h, 12) / 2 + 4;
    if (n.col === 0) {
      svg.append(label(n, s('text', { x: n.x + 14, y: n.y + 14, class: 'flow-name' }, shorten(n.label, 9))));
      if (n.h >= 26 || !compact) svg.append(s('text', { x: n.x + 14, y: n.y + 28, class: 'flow-sub' }, `月 ${yen(n.value)}`));
    } else if (n.col === 1) {
      svg.append(label(n, s('text', { x: n.x - 5, y: mid, class: 'flow-name', 'text-anchor': 'end' }, shorten(n.label, 8))));
    } else if (n.h >= 9 || !compact) {
      svg.append(label(n, s('text', { x: n.x + 14, y: mid, class: 'flow-leaf' },
        shorten(n.label, 8), ' ', s('tspan', { class: 'flow-sub' }, `${yen(n.value)}${n.sub || ''}`))));
    }
  }
  return svg;
}
