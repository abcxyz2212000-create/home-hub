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
  sorted.forEach(([label, value, color], i) => {
    const y = i * rowH;
    svg.append(s('text', { x: 0, y: y + 18, class: 'bar-label' }, shorten(label, 6)));
    svg.append(s('rect', { x: labelW, y: y + 8, width: trackW, height: 12, rx: 4, class: 'bar-track' }));
    const fill = s('rect', { x: labelW, y: y + 8, width: Math.max((trackW * value) / max, 3), height: 12, rx: 4, class: 'bar-fill' });
    if (color) fill.style.fill = color; // a person's color (CSSOM, allowed by the CSP)
    svg.append(fill);
    svg.append(s('text', { x: W, y: y + 18, class: 'bar-value', 'text-anchor': 'end' }, format(value)));
  });
  return svg;
}

// Flow diagram, 3 columns (accounts -> cards -> contracts) or 4 columns (people -> accounts -> cards
// -> contracts). Band width = monthly amount.
// columns: [[node], ...], node: { id, label, sub, value, color, href }
//   sub on a source/account node replaces the default "月 ○円" line; on a leaf it is appended.
// links: [{ from, to, value, color }]
export function flowChart(columns, links, { compact = false, ariaLabel = 'お金の流れ' } = {}) {
  const four = columns.length === 4;
  const W = four ? 460 : 360;
  const X = four ? [0, 66, 222, 318] : [0, 150, 222];
  const role = four ? ['person', 'source', 'mid', 'leaf'] : ['source', 'mid', 'leaf'];
  const nodeW = 8;
  const gap = compact ? 6 : 10;
  const minSlot = compact ? 0 : 18;
  const total = Math.max(...columns.map((list) => list.reduce((sum, n) => sum + n.value, 0)), 1);
  const rightCount = columns[columns.length - 1].length;
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
  const H = Math.max(...[...nodes.values()].map((n) => n.y + Math.max(n.h, minSlot)), 10) + 6;
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
    const r = role[n.col];
    if (r === 'person') {
      svg.append(label(n, s('text', { x: n.x + 12, y: n.y + 14, class: 'flow-name' }, shorten(n.label, 4))));
      if (n.h >= 26 || !compact) svg.append(s('text', { x: n.x + 12, y: n.y + 28, class: 'flow-sub' }, n.sub || yen(n.value)));
    } else if (r === 'source') {
      svg.append(label(n, s('text', { x: n.x + 14, y: n.y + 14, class: 'flow-name' }, shorten(n.label, 9))));
      if (n.h >= 26 || !compact) svg.append(s('text', { x: n.x + 14, y: n.y + 28, class: 'flow-sub' }, n.sub || `月 ${yen(n.value)}`));
    } else if (r === 'mid' && four) {
      // 4 columns: the account labels use the space on the left, so card names go to the right
      svg.append(label(n, s('text', { x: n.x + 12, y: mid, class: 'flow-name' }, shorten(n.label, 6))));
    } else if (r === 'mid') {
      svg.append(label(n, s('text', { x: n.x - 5, y: mid, class: 'flow-name', 'text-anchor': 'end' }, shorten(n.label, 8))));
    } else if (n.h >= 9 || !compact) {
      svg.append(label(n, s('text', { x: n.x + 14, y: mid, class: 'flow-leaf' },
        shorten(n.label, 8), ' ', s('tspan', { class: 'flow-sub' }, `${yen(n.value)}${n.sub || ''}`))));
    }
  }
  return svg;
}

// Line chart over months. series: [{ label, color, points: [{ x: 'YYYY-MM', y }] }] (same x for all).
// The y axis always includes 0; January of each year gets a tick.
export function lineChart(series, ariaLabel, format = yen) {
  const W = 360;
  const H = 170;
  const left = 46;
  const right = 8;
  const top = 10;
  const bottom = 22;
  const xs = series.length ? series[0].points.map((p) => p.x) : [];
  const ys = series.flatMap((s) => s.points.map((p) => p.y));
  const yMax = Math.max(0, ...ys);
  const yMin = Math.min(0, ...ys);
  const span = yMax - yMin || 1;
  const x = (i) => left + (xs.length > 1 ? ((W - left - right) * i) / (xs.length - 1) : 0);
  const y = (v) => top + ((H - top - bottom) * (yMax - v)) / span;
  const svg = root(W, H, ariaLabel);
  for (const v of [...new Set([yMax, 0, yMin])]) {
    svg.append(s('line', { x1: left, y1: y(v), x2: W - right, y2: y(v), class: v === 0 ? 'line-zero' : 'line-grid' }));
    svg.append(s('text', { x: left - 4, y: y(v) + 4, class: 'line-tick', 'text-anchor': 'end' }, format(v).replace('円', '')));
  }
  xs.forEach((ym, i) => {
    if (!ym.endsWith('-01') && i !== 0) return;
    svg.append(s('line', { x1: x(i), y1: H - bottom, x2: x(i), y2: H - bottom + 4, class: 'line-grid' }));
    svg.append(s('text', { x: x(i), y: H - 6, class: 'line-tick', 'text-anchor': i === 0 ? 'start' : 'middle' }, `${ym.slice(0, 4)}年`));
  });
  for (const ser of series) {
    if (!ser.points.length) continue;
    svg.append(s('polyline', { points: ser.points.map((p, i) => `${x(i)},${y(p.y)}`).join(' '), class: 'line-path', stroke: ser.color }));
    const last = ser.points.length - 1;
    svg.append(s('circle', { cx: x(last), cy: y(ser.points[last].y), r: 3.5, fill: ser.color }));
  }
  return svg;
}

// ---------------------------------------------------------------- flow as a graph (2026-11-01)
//
// Boxes in rows (tier 0: personal accounts, 1: shared account, 2: cards, 3: outside), each box once,
// joined by arrows of the same width. Each arrow carries text lines (what for, how much). Arrows that
// skip a row run along the side so that they never cross a box.
// model: { nodes: [{ id, label, tier, icon (an <svg> from icons.js), href, color }],
//          edges: [{ from, to, lines: [string] }] }

// rough width of a text at 11px (CJK ~11px, others ~6.5px)
function textWidth(t, size = 11) {
  let w = 0;
  for (const ch of String(t)) w += /[\u0000-ÿ]/.test(ch) ? size * 0.6 : size;
  return w;
}

function fitText(t, maxWidth, size = 11) {
  let out = '';
  for (const ch of String(t)) {
    if (textWidth(`${out}${ch}…`, size) > maxWidth) return `${out}…`;
    out += ch;
  }
  return out;
}

export function flowGraph(model, { ariaLabel = 'お金の流れ', width = 360 } = {}) {
  const W = width;
  const BOX_H = 40;
  const LINE = 14;
  const tiers = [...new Set(model.nodes.map((n) => n.tier))].sort((a, b) => a - b);
  const rowOf = new Map(tiers.map((t, i) => [t, i]));
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  const rows = tiers.map((t) => model.nodes.filter((n) => n.tier === t));
  const edges = model.edges.filter((e) => byId.has(e.from) && byId.has(e.to));
  const skips = (e) => rowOf.get(byId.get(e.to).tier) - rowOf.get(byId.get(e.from).tier) > 1;
  // gap below each row: room for the labels of the arrows that start there
  const gaps = rows.map((_, i) => {
    const lines = edges.filter((e) => rowOf.get(byId.get(e.from).tier) === i && !skips(e)).map((e) => e.lines.length);
    return Math.max(56, 30 + LINE * Math.max(0, ...lines));
  });
  // side lanes for arrows that skip rows
  const lanes = { left: 0, right: 0 };
  // rows passed by a skipping arrow leave room on that side for the arrow and its label
  const SIDE = 96;
  const xOf = (row, j, l, r) => l + ((W - l - r) * (j + 0.5)) / row.length;
  const reserved = rows.map(() => ({ l: 0, r: 0 }));
  for (const e of edges.filter(skips)) {
    const ra = rowOf.get(byId.get(e.from).tier);
    const rb = rowOf.get(byId.get(e.to).tier);
    const srcRow = rows[ra];
    const left = xOf(srcRow, srcRow.indexOf(byId.get(e.from)), 0, 0) <= W / 2;
    for (let i = ra + 1; i < rb; i += 1) reserved[i][left ? 'l' : 'r'] = SIDE;
  }
  const pos = new Map();
  let y = 8;
  rows.forEach((row, i) => {
    const { l, r } = reserved[i];
    const bw = Math.min(170, (W - l - r) / row.length - 12);
    row.forEach((n, j) => pos.set(n.id, { x: xOf(row, j, l, r), y, w: bw }));
    y += BOX_H + gaps[i];
  });
  const H = y - gaps[gaps.length - 1] + 10;
  const svg = root(W, H, ariaLabel);
  svg.classList.add('flow-graph');
  svg.append(s('defs', {}, s('marker', { id: 'fg-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' },
    s('path', { d: 'M0 0L10 5L0 10z', class: 'fg-head' }))));
  const lineLayer = s('g', {});
  const labelLayer = s('g', {});
  const boxLayer = s('g', {});
  svg.append(lineLayer, boxLayer, labelLayer);

  const label = (lines, x, yMid, anchor) => {
    const widths = lines.map((l) => textWidth(l));
    const w = Math.max(...widths) + 10;
    const hgt = lines.length * LINE + 6;
    const left = anchor === 'start' ? x : anchor === 'end' ? x - w : x - w / 2;
    const top = yMid - hgt / 2;
    labelLayer.append(s('g', { class: 'fg-label' },
      s('rect', { x: left, y: top, width: w, height: hgt, rx: 5 }),
      lines.map((l, k) => s('text', { x: left + 5, y: top + 4 + LINE * (k + 0.78) }, l))));
  };

  for (const e of edges) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    const from = byId.get(e.from);
    const y1 = a.y + BOX_H;
    const y2 = b.y;
    let d;
    if (!skips(e)) {
      const my = (y1 + y2) / 2;
      d = `M${a.x} ${y1} C${a.x} ${my} ${b.x} ${my} ${b.x} ${y2 - 2}`;
      // near the start of the arrow, so that arrows meeting at one box keep their labels apart
      const lines = e.lines.map((l) => fitText(l, 200));
      const half = Math.max(...lines.map((l) => textWidth(l))) / 2 + 5;
      const lx = a.x + (b.x - a.x) * 0.15;
      label(lines, Math.min(Math.max(lx, half + 2), W - half - 2), my, 'middle');
    } else {
      const side = a.x <= W / 2 ? 'left' : 'right';
      lanes[side] += 1;
      const lx = side === 'left' ? 6 + (lanes[side] - 1) * 8 : W - 6 - (lanes[side] - 1) * 8;
      // into the side of the target box
      const tx = side === 'left' ? b.x - b.w / 2 - 2 : b.x + b.w / 2 + 2;
      const ty = y2 + BOX_H / 2;
      d = `M${a.x} ${y1} C${a.x} ${y1 + 22} ${lx} ${y1 + 8} ${lx} ${y1 + 34} L${lx} ${ty - 12} C${lx} ${ty} ${lx} ${ty} ${tx} ${ty}`;
      const lines = e.lines.flatMap((l) => {
        const m = /^(.*?)\s+([\d,]+円.*)$/.exec(l);
        return m ? [fitText(m[1], SIDE - 18), m[2]] : [fitText(l, SIDE - 18)];
      });
      label(lines, side === 'left' ? lx + 5 : lx - 5, (y1 + 34 + ty - 12) / 2, side === 'left' ? 'start' : 'end');
    }
    const path = s('path', { d, class: 'fg-line', 'marker-end': 'url(#fg-arrow)' });
    if (from.color) path.style.stroke = from.color; // CSSOM: allowed by the CSP
    lineLayer.append(path);
  }

  for (const n of model.nodes) {
    const p = pos.get(n.id);
    const left = p.x - p.w / 2;
    const rect = s('rect', { x: left, y: p.y, width: p.w, height: BOX_H, rx: 9 });
    if (n.color && n.kind !== 'outside') rect.style.stroke = n.color;
    const g = s('g', { class: `fg-node${n.kind ? ` fg-${n.kind}` : ''}` }, rect,
      s('text', { x: left + 34, y: p.y + BOX_H / 2 + 4 }, fitText(n.label, p.w - 40)));
    if (n.icon) {
      n.icon.setAttribute('x', left + 9);
      n.icon.setAttribute('y', p.y + BOX_H / 2 - 9);
      n.icon.setAttribute('width', 18);
      n.icon.setAttribute('height', 18);
      if (n.color && n.kind !== 'outside') n.icon.style.color = n.color;
      g.append(n.icon);
    }
    boxLayer.append(n.href ? s('a', { href: n.href }, g) : g);
  }
  return svg;
}
