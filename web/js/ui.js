// Small UI components rendered as HTML strings (every dynamic value goes
// through esc) plus the watchlist store, market colour assignment and the
// sideways-scrolling nav and tab strips.
import { esc, short, num, usd, pct, bps, deltaHtml, signClass } from './format.js';

export const ICON = {
  cube: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.8l5.4 3.1v6.2L8 14.2l-5.4-3.1V4.9z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M2.6 4.9L8 8l5.4-3.1M8 8v6.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
  bell: '<svg viewBox="0 0 16 16"><path d="M4 11.5V7a4 4 0 0 1 8 0v4.5l1.2 1.2H2.8zM6.5 13.5a1.5 1.5 0 0 0 3 0" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
  star: '<svg viewBox="0 0 16 16"><path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z" fill="currentColor"/></svg>',
  starOff: '<svg viewBox="0 0 16 16"><path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
  copy: '<svg viewBox="0 0 16 16"><rect x="5" y="5" width="8.5" height="8.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M3 10.5V3.8C3 3.1 3.6 2.5 4.3 2.5H10" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  ext: '<svg viewBox="0 0 16 16"><path d="M9 3h4v4M13 3L7.5 8.5M11.5 9.5V13H3V4.5h3.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  download: '<svg viewBox="0 0 16 16"><path d="M8 2.5v8M4.5 7L8 10.5 11.5 7M3 13h10" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  plus: '<svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  x: '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  image: '<svg viewBox="0 0 16 16"><rect x="2.5" y="3" width="11" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M2.8 11.2l3.4-3.4 2.6 2.6 1.6-1.6 3 3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><circle cx="10.5" cy="6" r="1.1" fill="currentColor"/></svg>'
};
// Download buttons for a chart (shown on hover): its data as CSV, its image as PNG.
export const chartTools = (chartId, name, { csv = true } = {}) => `<span class="chart-tools">${csv ? `<button class="icon-btn" data-export="csv" data-chart="${esc(chartId)}" data-name="${esc(name)}" title="Download CSV" aria-label="Download CSV">${ICON.download}</button>` : ''}<button class="icon-btn" data-export="png" data-chart="${esc(chartId)}" data-name="${esc(name)}" title="Download PNG" aria-label="Download PNG">${ICON.image}</button></span>`;
export const EXPLORER = 'https://monadvision.com';
// Telegram alerts bot (from /health, when the server runs one): deep links
// open a chat that starts watching the wallet.
let alertsBot = null, botKnown;
export const alertsBotReady = new Promise(resolve => { botKnown = resolve; });
export const setAlertsBot = name => { alertsBot = /^\w{5,32}$/.test(name ?? '') ? name : null; botKnown(); };
export const alertsBotName = () => alertsBot;
export const alertsLink = address => (alertsBot && /^0x[0-9a-fA-F]{40}$/.test(address ?? '') ? `https://t.me/${alertsBot}?start=watch_${address}` : null);

// --- market colours: follow the market, never its rank in a given view ----------
const SLOTS = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)'];
export const SLOT_HEX = ['#7b7dea', '#d36c00', '#00a999', '#b28500', '#cd5ea2', '#0098de'];
export const OTHER_HEX = '#5c5b66';
// Main assets keep a colour close to their own brand on every page: MON
// purple, BTC orange, SOL teal, ZEC gold, LIT pink, ETH blue. Other markets
// take a free slot by volume, or grey "Other".
const ASSET_SLOT = { MON: 0, BTC: 1, SOL: 2, ZEC: 3, LIT: 4, ETH: 5 };
const COLOR_KEY = 'ps.colors.v2';
let colorMap = {};
try { colorMap = JSON.parse(localStorage.getItem(COLOR_KEY) || '{}'); } catch { colorMap = {}; }
// markets: [{ id, symbol }] ranked by all-time volume (plain ids also accepted).
export function assignColors(markets) {
  const list = markets.map(m => (typeof m === 'object' ? m : { id: m, symbol: null }));
  for (const m of list) { const slot = ASSET_SLOT[assetOf(m.symbol)]; if (slot !== undefined) colorMap[m.id] = slot; }
  const used = new Set(Object.values(colorMap));
  for (const m of list) { if (colorMap[m.id] !== undefined) continue; const slot = SLOTS.findIndex((_, i) => !used.has(i)); if (slot === -1) break; colorMap[m.id] = slot; used.add(slot); }
  try { localStorage.setItem(COLOR_KEY, JSON.stringify(colorMap)); } catch { /* storage unavailable */ }
}
export const colorOf = id => (colorMap[id] === undefined ? OTHER_HEX : SLOT_HEX[colorMap[id]]);
export const hasColor = id => colorMap[id] !== undefined;

// --- market logos: self-hosted, keyed by base asset (sources in web/img/markets/README.md)
const LOGOS = { BTC: 'btc.svg', ETH: 'eth.svg', SOL: 'sol.svg', MON: 'mon.svg', HYPE: 'hype.png', ZEC: 'zec.svg', LIT: 'lit.png', VVV: 'vvv.png', TAO: 'tao.png', PUMP: 'pump.png' };
// 'SOL_v2' and 'BTC Perp' are the same assets as 'SOL' and 'BTC'.
export const assetOf = symbol => String(symbol ?? '').replace(/(\s+perp|[_-]v\d+)$/i, '').trim().toUpperCase();
// A newly listed market has no logo file yet: it gets its first letter on its
// colour, at the logo's size, until one is added.
export const logo = (id, symbol, size = 16) => {
  const file = LOGOS[assetOf(symbol)];
  if (file) return `<img class="tk" src="img/markets/${file}" alt="" width="${size}" height="${size}">`;
  return `<i class="tk tk-letter" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.55)}px;background:${colorOf(id)}">${esc(assetOf(symbol).slice(0, 1) || '?')}</i>`;
};

// --- components ---------------------------------------------------------------------
// `link` makes the cell open the market page (for views that are not the market itself).
export const mkt = (id, symbol, name = null, { link = false } = {}) => {
  const inner = `${logo(id, symbol)}${esc(symbol ?? `#${id}`)}${name ? ` <span class="nm">${esc(name)}</span>` : ''}`;
  return link ? `<a class="mkt" href="#/markets/${esc(id)}">${inner}</a>` : `<span class="mkt">${inner}</span>`;
};
export const mktLink = (id, symbol) => mkt(id, symbol, null, { link: true });
// Funding interval as the chain runs it now (seconds from the API), not a fixed text.
export function fundingTip(intervalSeconds) {
  const s = Number(intervalSeconds);
  const every = s > 0 ? `about every ${s >= 5400 ? `${(s / 3600).toFixed(1)} h` : `${Math.round(s / 60)} min`}` : 'on a fixed block schedule';
  return `Funding settles ${every}; shown as the rate for 8 hours and for a year (APR).`;
}
export const sideTag = side => { const s = String(side ?? '').toLowerCase(); return s === 'long' || s === 'short' ? `<span class="side ${s}">${s === 'long' ? 'LONG' : 'SHORT'}</span>` : '<span class="faint">—</span>'; };
export function addr(address, account, { star = true } = {}) {
  const key = address || String(account ?? '');
  if (!key) return '<span class="faint">—</span>';
  const label = address ? short(address) : `#${esc(account)}`;
  return `<span class="addr"><a href="#/wallet/${esc(key)}" title="${esc(address || `Account ${account}`)}">${label}</a>${address ? `<button class="icon-btn" data-copy="${esc(address)}" title="Copy address">${ICON.copy}</button>` : ''}${star ? `<button class="icon-btn ${watch.has(key) ? 'on' : ''}" data-watch="${esc(key)}" title="Watch wallet">${watch.has(key) ? ICON.star : ICON.starOff}</button>` : ''}</span>`;
}
// basis: what the delta compares with, shown after it ("vs prev", "in 24h").
// A " · " in the label or the note keeps to the word before it, so a wrapped line never starts with it.
export const keepDots = html => String(html).replaceAll(' · ', '\u00a0· ');
export function kpi({ label, value, delta = undefined, invert = false, basis = null, basisTitle = null, note = '', spark = null, tip = null, cls = '' }) {
  return `<div class="kpi ${cls}"><div class="kpi-label">${keepDots(esc(label))}${tip ? ` <span class="info-tip" tabindex="0" title="${esc(tip)}">i</span>` : ''}</div><div class="kpi-value">${value}</div><div class="kpi-row">${delta === undefined ? '' : `${deltaHtml(delta, invert, basisTitle)}${basis ? `<span class="kpi-basis">${esc(basis)}</span>` : ''}`}<span class="kpi-note">${keepDots(note)}</span></div>${spark ? `<div class="spark" id="${esc(spark)}"></div>` : ''}</div>`;
}
export const seg = (name, options, active) => `<div class="seg" role="group">${options.map(([v, label]) => `<button data-seg="${esc(name)}" data-v="${esc(v)}" class="${String(v) === String(active) ? 'on' : ''}">${esc(label)}</button>`).join('')}</div>`;
export const tabs = (name, options, active) => `<div class="tabs" role="tablist">${options.map(([v, label]) => `<button role="tab" data-tab="${esc(name)}" data-v="${esc(v)}" class="${v === active ? 'on' : ''}">${esc(label)}</button>`).join('')}</div>`;
export function ratio(long, short) {
  const l = num(long) ?? 0, s = num(short) ?? 0, t = l + s;
  if (!t) return '<span class="faint">—</span>';
  const lp = Math.round(l / t * 100);
  return `<div class="ratio-wrap"><div class="ratio"><i class="l" style="width:${lp}%"></i><i class="s" style="width:${100 - lp}%"></i></div><div class="lbl"><span>${lp}% L</span><span>${100 - lp}% S</span></div></div>`;
}
export const pnl = v => (num(v) === null ? '—' : `<span class="${signClass(v)}">${usd(v, { sign: true })}</span>`);
// What the taker did, from the position event behind the fill. Colour
// follows direction (buying is green); flips name the new side.
const VERBS = { open: 'Open', increase: 'Add', decrease: 'Reduce', close: 'Close', invert: 'Flip to', deleverage: 'ADL', unwind: 'Unwind' };
export function tradeAction(r) {
  const side = r.side === 'long' || r.side === 'short' ? r.side : '';
  if (r.kind === 'liquidation') return `<span class="tag bad">Liq</span> <span class="muted">${esc(side)}</span>`;
  const verb = VERBS[r.kind];
  return `<span class="${r.buy ? 'pos' : 'neg'}" title="${r.buy ? 'Bought' : 'Sold'} as taker">${verb ? `${verb} ${esc(side)}` : r.buy ? 'Buy' : 'Sell'}</span>`;
}

// Funding per 8h with its APR; a zero rate is shown quietly.
export function fundingCell(f, { apr = true } = {}) {
  const rate = num(f?.rate_8h_pct);
  if (rate === null) return '<span class="faint">—</span>';
  if (rate === 0) return '<span class="faint" title="Zero rate: no funding payments this interval">0% · flat</span>';
  return `<span class="${signClass(rate, 4)}">${pct(rate, { digits: 4, sign: true })}</span>${apr ? `<div class="sub">${pct(f.apr_pct, { digits: 1, sign: true })} APR</div>` : ''}`;
}
export const pctCell = (v, sign = true) => (num(v) === null ? '<span class="faint">—</span>' : `<span class="${sign ? signClass(v) : ''}">${pct(v, { sign })}</span>`);
// Whole basis points from 100 up, where a decimal adds nothing (+2405 bps, +25.2 bps).
export const bpsCell = v => (num(v) === null ? '<span class="faint">—</span>' : `<span class="${signClass(v, 1)}">${bps(v, { sign: true, digits: Math.abs(num(v)) >= 100 ? 0 : 1 })}</span>`);
export const skeleton = (rows = 6) => `<div class="panel-body">${Array.from({ length: rows }, (_, i) => `<div class="skeleton sk-line" style="width:${92 - (i % 3) * 14}%"></div>`).join('')}</div>`;
export const skChart = () => '<div class="panel-body"><div class="skeleton sk-block"></div></div>';
export const empty = text => `<div class="empty-state">${esc(text)}</div>`;

// Sortable table: columns [{ key, label, n: numeric, sort: value fn, render }]
export function table({ id, columns, rows, sortKey = null, sortDir = 'desc', rowAttrs = () => '', compact = false, emptyText = 'No data' }) {
  if (!rows.length) return empty(emptyText);
  let list = rows;
  const col = columns.find(c => c.key === sortKey);
  if (col?.sort) { list = [...rows].sort((a, b) => { const x = col.sort(a), y = col.sort(b); return (x > y ? 1 : x < y ? -1 : 0) * (sortDir === 'asc' ? 1 : -1); }); }
  // A number with a second line under it (APR under a rate, "5 liq." under an
  // amount) is centred, header included, so both lines and the header share
  // one axis; single-line numbers stay right-aligned for easy comparison.
  const cells = list.map((r, i) => columns.map(c => c.render(r, i)));
  const stacked = columns.map((c, j) => Boolean(c.n) && cells.some(row => /class="sub[\s"]/.test(row[j])));
  const align = (c, j) => (c.center || stacked[j] ? 'c' : c.n ? 'n' : '');
  const head = columns.map((c, j) => `<th class="${align(c, j)} ${c.sort ? 'sort' : ''} ${c.key === sortKey ? 'sorted' : ''}" ${c.sort ? `data-sort="${esc(id)}:${esc(c.key)}"` : ''}${c.tip ? ` title="${esc(c.tip)}"` : ''}>${esc(c.label)}${c.key === sortKey ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}</th>`).join('');
  const body = list.map((r, i) => `<tr ${rowAttrs(r, i)}>${columns.map((c, j) => `<td class="${align(c, j)} ${c.cls ?? ''}">${cells[i][j]}</td>`).join('')}</tr>`).join('');
  return `<div class="table-wrap"><table class="t ${compact ? 'compact' : ''}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

// --- watchlist (this browser only) ------------------------------------------------------
export const watch = {
  list() { try { return JSON.parse(localStorage.getItem('ps.watch') || '[]'); } catch { return []; } },
  has(key) { return this.list().some(w => w.key.toLowerCase() === String(key).toLowerCase()); },
  toggle(key, label = '') {
    const list = this.list(), i = list.findIndex(w => w.key.toLowerCase() === String(key).toLowerCase());
    if (i >= 0) list.splice(i, 1); else list.push({ key: String(key), label, added: Date.now() });
    try { localStorage.setItem('ps.watch', JSON.stringify(list.slice(-50))); } catch { /* storage unavailable */ }
    window.dispatchEvent(new CustomEvent('watchlist'));
    return i < 0;
  }
};

export function toast(message) {
  const el = document.getElementById('toast');
  el.textContent = message; el.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), 1800);
}

export function download(filename, text, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Per-market series merged by displayed asset: a relisted market and its
// delisted original ('SOL_v2' shown as 'SOL', and 'SOL') become one series.
// The row keeps the id of the member with the most activity, for its colour.
export function mergeByAsset(rows, fields) {
  const byName = new Map();
  for (const r of rows) {
    const total = fields.reduce((a, f) => a + r[f].reduce((b, v) => b + (Number(v) || 0), 0), 0);
    const cur = byName.get(r.symbol);
    if (!cur) { byName.set(r.symbol, { ...r, _total: total, ...Object.fromEntries(fields.map(f => [f, r[f].map(v => Number(v) || 0)])) }); continue; }
    for (const f of fields) cur[f] = cur[f].map((v, i) => v + (Number(r[f][i]) || 0));
    if (total > cur._total) cur.id = r.id;
    cur._total += total;
  }
  return [...byName.values()];
}

// --- sideways strips: on narrow screens the nav and tab rows scroll sideways ------------------
// The current page's link, and a tab row's open tab when the row first renders,
// are scrolled to the middle so neither sits off-screen (the edge fades are CSS).
const nav = document.querySelector('.nav'), seen = new WeakSet();
const centre = (strip, item) => { if (item && strip.scrollWidth > strip.clientWidth) strip.scrollTo({ left: strip.scrollLeft + item.getBoundingClientRect().left - strip.getBoundingClientRect().left - (strip.clientWidth - item.offsetWidth) / 2 }); };
new MutationObserver(() => centre(nav, nav.querySelector('.active'))).observe(nav, { subtree: true, attributeFilter: ['class'] });
new MutationObserver(() => document.querySelectorAll('.tabs').forEach(t => { if (!seen.has(t)) { seen.add(t); centre(t, t.querySelector('.on')); } })).observe(document.getElementById('view'), { childList: true, subtree: true });
// Only a width change can turn the nav into a strip; phones also fire height-only resizes as the URL bar hides.
let width = innerWidth;
window.addEventListener('resize', () => { if (innerWidth !== width) { width = innerWidth; centre(nav, nav.querySelector('.active')); } });
// Without scroll timelines (Firefox) the CSS edge fades take their widths from
// here: how far each strip hides at either edge, up to 40px, on every scroll and
// once a frame after the page or the window changes.
if (!CSS.supports('animation-timeline: scroll()')) {
  const STRIPS = '.table-wrap, .tabs, .nav';
  const fade = s => { const past = s.scrollWidth - s.clientWidth - s.scrollLeft; s.style.setProperty('--fade-l', `${Math.min(40, Math.max(0, s.scrollLeft))}px`); s.style.setProperty('--fade-r', `${Math.min(40, Math.max(0, past))}px`); };
  let queued = false;
  const soon = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; document.querySelectorAll(STRIPS).forEach(fade); }); };
  document.addEventListener('scroll', e => { if (e.target.matches?.(STRIPS)) fade(e.target); }, true);
  window.addEventListener('resize', soon);
  new MutationObserver(soon).observe(document.getElementById('view'), { childList: true, subtree: true });
  soon();
}

// --- hover notes ------------------------------------------------------------------------
// Every title="" on the site shows in one styled note instead of the browser's
// plain box: on first hover the attribute moves to data-tip, so the native one
// never opens. An (i) also opens on tap, for touch screens.
if (typeof document !== 'undefined') {
  const pop = Object.assign(document.createElement('div'), { className: 'tip-pop', hidden: true });
  pop.setAttribute('role', 'tooltip');
  document.body.append(pop);
  let on = null, shownAt = 0;
  const place = el => {
    const r = el.getBoundingClientRect(), p = pop.getBoundingClientRect(), gap = 8;
    const above = r.top - p.height - gap >= 8;
    const left = Math.min(window.innerWidth - p.width - 8, Math.max(8, r.left + r.width / 2 - p.width / 2));
    pop.style.transform = `translate(${Math.round(left)}px, ${Math.round(above ? r.top - p.height - gap : r.bottom + gap)}px)`;
  };
  const show = el => {
    if (el.hasAttribute('title')) { el.dataset.tip = el.getAttribute('title'); el.removeAttribute('title'); }
    if (!el.dataset.tip) return;
    on = el; shownAt = Date.now(); pop.textContent = el.dataset.tip; pop.hidden = false; place(el);
  };
  const hide = () => { on = null; pop.hidden = true; };
  const noted = t => t?.closest?.('[title]:not([title=""]), [data-tip]:not([data-tip=""])');
  document.addEventListener('mouseover', e => { const el = noted(e.target); if (el && el !== on) show(el); else if (!el && on) hide(); });
  document.addEventListener('mouseout', e => { if (!e.relatedTarget) hide(); });
  document.addEventListener('focusin', e => { const el = noted(e.target); if (el) show(el); });
  document.addEventListener('focusout', hide);
  // A tap on (i) toggles its note (the tap's own mouseover has just opened it); a tap elsewhere closes it.
  document.addEventListener('click', e => { const el = e.target.closest?.('.info-tip'); if (el) { if (on === el && Date.now() - shownAt > 400) hide(); else show(el); } else if (on) hide(); });
  window.addEventListener('scroll', hide, true);
  window.addEventListener('hashchange', hide);
}
