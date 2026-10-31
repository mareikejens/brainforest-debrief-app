// The network graph: the person you just met is the one pink node, joining nodes from your vault.
// Pure SVG, no library. Modes: start (your network, the new node at the edge), live (the new node is
// the orb, mentions appear around it), working (links being made), preview (the links about to be written).
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
const short = (s, n = 18) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// Small deterministic jitter so the layout does not jump between renders.
const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

export function drawGraph(svg, { center, nodes = [], mode = 'live' }) {
  const W = 320, H = mode === 'preview' ? 120 : 190;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.replaceChildren();
  svg.dataset.mode = mode;
  const defs = el('defs');
  const gid = `core-${svg.id || 'g'}`;
  const g = el('radialGradient', { id: gid });
  [['0', '#ffffff'], ['.35', '#fbb8ff'], ['1', '#f570ff']].forEach(([o, c]) => g.append(el('stop', { offset: o, 'stop-color': c })));
  defs.append(g); svg.append(defs);

  const list = nodes.slice(0, 7);
  const big = mode === 'live' || mode === 'working';
  const c = mode === 'start' ? { x: 248, y: 138 } : { x: W / 2, y: H / 2 };
  const pts = list.map((n, i) => {
    const j = (hash(n.label) % 100) / 100;
    if (mode === 'start') {
      // a loose network across the left two thirds
      const cols = [[40, 60], [96, 30], [150, 92], [70, 140], [196, 40], [270, 64], [118, 168]];
      const [x, y] = cols[i % cols.length];
      return { ...n, x: x + (j - .5) * 16, y: y + (j - .5) * 12 };
    }
    const a = (i / Math.max(list.length, 1)) * Math.PI * 2 - Math.PI / 2 + (j - .5) * .35;
    const rx = big ? 118 : 120, ry = big ? 72 : 42;
    return { ...n, x: c.x + Math.cos(a) * rx, y: c.y + Math.sin(a) * ry };
  });

  const edges = el('g');
  if (mode === 'start') {
    pts.forEach((p, i) => { if (i) edges.append(el('line', { class: 'edge', x1: pts[i - 1].x, y1: pts[i - 1].y, x2: p.x, y2: p.y })); });
    pts.slice(0, 2).forEach((p) => edges.append(el('line', { class: 'edge new', x1: p.x, y1: p.y, x2: c.x, y2: c.y })));
  } else {
    pts.forEach((p) => edges.append(el('line', { class: 'edge new', x1: c.x, y1: c.y, x2: p.x, y2: p.y })));
  }
  svg.append(edges);

  pts.forEach((p) => {
    svg.append(el('circle', { class: p.fresh ? 'node fresh' : 'node', cx: p.x, cy: p.y, r: p.fresh ? 4.5 : 3.5 }));
    const t = el('text', { class: 'lbl', x: p.x, y: p.y + (p.y < c.y ? -9 : 15), 'text-anchor': 'middle' });
    t.textContent = short(p.label);
    svg.append(t);
  });

  const r = big ? 24 : mode === 'start' ? 7 : 8;
  svg.append(el('circle', { class: 'halo b', cx: c.x, cy: c.y, r: r * (big ? 2.4 : 3) }));
  svg.append(el('circle', { class: 'halo', cx: c.x, cy: c.y, r: r * (big ? 1.65 : 2) }));
  svg.append(el('circle', { cx: c.x, cy: c.y, r, fill: `url(#${gid})` }));
  if (center && !big) {
    const t = el('text', { class: 'lbl hi', x: c.x, y: c.y + r + 15, 'text-anchor': 'middle' });
    t.textContent = short(center, 22);
    svg.append(t);
  }
}

/** Vault names (notes, contacts, dictionary terms) that she said out loud. Longest first, max 6. */
export function mentions(text, names) {
  const low = ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
  const hits = [];
  for (const n of [...new Set(names)].sort((a, b) => b.length - a.length)) {
    const k = n.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    if (k.length < 3) continue;
    if (low.includes(` ${k} `) && !hits.some((h) => h.toLowerCase().includes(k))) hits.push(n);
    if (hits.length >= 6) break;
  }
  return hits;
}
