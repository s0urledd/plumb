// Shell: hash router, header (search, live status), event delegation, the
// server-sent event stream and the indexing banner.
import { get, stream } from './api.js';
import { esc, short, int, dateTime, price, pct, signClass } from './format.js';
import { watch, toast, ICON, assignColors, download, logo, setAlertsBot } from './ui.js';
import { disposeAll, chartCsv, chartPng } from './charts.js';

const routes = [
  [/^\/?$/, () => import('./views/overview.js')],
  [/^\/markets\/?$/, () => import('./views/markets.js')],
  [/^\/markets\/(\d+)$/, () => import('./views/market.js')],
  [/^\/traders\/?$/, () => import('./views/traders.js')],
  [/^\/liquidations\/?$/, () => import('./views/liquidations.js')],
  [/^\/risk\/?$/, () => import('./views/risk.js')],
  [/^\/wallet\/([0-9a-zA-Zx]{1,42})$/, () => import('./views/wallet.js')],
  [/^\/compare\/?$/, () => import('./views/compare.js')],
  [/^\/(?:alerts|watchlist)\/?$/, () => import('./views/alerts.js')], // the watchlist lives on the alerts page
  [/^\/status\/?$/, () => import('./views/status.js')]
];

const view = document.getElementById('view');
let current = null; // { key, mod, instance }

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs = ''] = raw.split('?');
  return { path: path || '/', query: new URLSearchParams(qs) };
}
export function navigate(path, query = null) {
  const qs = query ? `?${new URLSearchParams(Object.entries(query).filter(([, v]) => v !== null && v !== undefined && v !== '')).toString()}` : '';
  location.hash = `#${path}${qs === '?' ? '' : qs}`;
}
export function setQuery(patch) {
  const { path, query } = parseHash();
  for (const [k, v] of Object.entries(patch)) { if (v === null || v === undefined || v === '') query.delete(k); else query.set(k, v); }
  const qs = query.toString();
  history.replaceState(null, '', `#${path}${qs ? `?${qs}` : ''}`);
  route(true);
}

// Each navigation takes a number; a view module that loads after a newer
// navigation started is not mounted.
let navigation = 0;
async function route(queryOnly = false) {
  const nav = ++navigation;
  const { path, query } = parseHash();
  const hit = routes.find(([re]) => re.test(path));
  document.querySelectorAll('.nav a').forEach(a => a.classList.toggle('active', a.getAttribute('href') === `#${path.match(/^\/[a-z]*/)?.[0] ?? '/'}` || (path === '/' && a.dataset.nav === 'overview') || ((path.startsWith('/wallet') || path.startsWith('/compare')) && a.dataset.nav === 'traders') || (path.startsWith('/markets') && a.dataset.nav === 'markets') || (path.startsWith('/watchlist') && a.dataset.nav === 'alerts')));
  if (!hit) { view.innerHTML = '<div class="empty-state">Page not found. <a href="#/">Back to overview</a></div>'; return; }
  const params = path.match(hit[0]).slice(1);
  const key = `${hit[0]}:${params.join('/')}`;
  if (queryOnly && current?.key === key && current.instance?.update) { current.instance.update(query); return; }
  current?.instance?.destroy?.();
  current = null;
  disposeAll();
  const mod = await hit[1]();
  if (nav !== navigation) return;
  view.innerHTML = '';
  window.scrollTo({ top: 0 });
  const instance = mod.mount(view, { params, query, navigate, setQuery });
  current = { key, mod, instance };
}
window.addEventListener('hashchange', () => route(false));

// --- delegated interactions -------------------------------------------------------------
document.addEventListener('click', async event => {
  const t = event.target.closest('[data-copy],[data-watch],[data-seg],[data-tab],[data-sort],tr[data-href],[data-action],[data-export]');
  if (!t) return;
  if (t.dataset.export) {
    const w = parseHash().query.get('window');
    const node = document.getElementById(t.dataset.chart), file = `plumb-${t.dataset.name || 'chart'}${w ? `-${w}` : ''}-${new Date().toISOString().slice(0, 10)}`;
    if (t.dataset.export === 'csv') { const csv = chartCsv(node); if (csv) download(`${file}.csv`, csv); else toast('Nothing to export yet'); }
    else { const url = chartPng(node); if (url) Object.assign(document.createElement('a'), { href: url, download: `${file}.png` }).click(); else toast('Nothing to export yet'); }
    return;
  }
  if (t.dataset.copy) { event.preventDefault(); try { await navigator.clipboard.writeText(t.dataset.copy); toast('Address copied'); } catch { toast('Copy failed'); } return; }
  if (t.dataset.watch) { event.preventDefault(); event.stopPropagation(); const on = watch.toggle(t.dataset.watch); t.classList.toggle('on', on); t.innerHTML = on ? ICON.star : ICON.starOff; toast(on ? 'Added to watchlist' : 'Removed from watchlist'); return; }
  if (t.dataset.seg) { current?.instance?.onSeg?.(t.dataset.seg, t.dataset.v); return; }
  if (t.dataset.tab) { current?.instance?.onTab?.(t.dataset.tab, t.dataset.v); return; }
  if (t.dataset.sort) { const [id, key] = t.dataset.sort.split(':'); current?.instance?.onSort?.(id, key); return; }
  if (t.dataset.action) { current?.instance?.onAction?.(t.dataset.action, t, event); return; }
  if (t.dataset.href && !event.target.closest('a,button')) { location.hash = t.dataset.href; }
});

// --- search ------------------------------------------------------------------------------
const input = document.getElementById('search'), results = document.getElementById('search-results');
let searchTimer = null, selected = -1;
function openResult(key) { results.hidden = true; input.value = ''; input.blur(); navigate(`/wallet/${key}`); }
input.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = input.value.trim();
  if (!q) { results.hidden = true; return; }
  searchTimer = setTimeout(async () => {
    if (!/^(0x[0-9a-fA-F]{1,40}|\d{1,9})$/.test(q)) { results.innerHTML = '<div class="empty">Enter a 0x address (or prefix) or an account ID</div>'; results.hidden = false; return; }
    try {
      const r = await get(`search?q=${encodeURIComponent(q)}`, { maxAge: 10000 });
      selected = -1;
      results.innerHTML = r.rows.length ? r.rows.map(x => `<a href="#/wallet/${esc(x.address)}" data-key="${esc(x.address)}"><span class="mono">${esc(short(x.address))}</span><span class="faint">#${esc(x.account)}</span></a>`).join('') : '<div class="empty">No Perpl account found</div>';
      results.hidden = false;
    } catch { results.innerHTML = '<div class="empty">Search unavailable</div>'; results.hidden = false; }
  }, 160);
});
input.addEventListener('keydown', e => {
  const items = [...results.querySelectorAll('a')];
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); selected = Math.max(0, Math.min(items.length - 1, selected + (e.key === 'ArrowDown' ? 1 : -1))); items.forEach((a, i) => a.classList.toggle('sel', i === selected)); }
  else if (e.key === 'Enter') { const q = input.value.trim(); if (items[selected]) openResult(items[selected].dataset.key); else if (/^0x[0-9a-fA-F]{40}$/.test(q) || /^\d{1,9}$/.test(q)) openResult(q); else if (items[0]) openResult(items[0].dataset.key); }
  else if (e.key === 'Escape') { results.hidden = true; input.blur(); }
});
results.addEventListener('click', e => { const a = e.target.closest('a[data-key]'); if (a) { e.preventDefault(); openResult(a.dataset.key); } });
document.addEventListener('click', e => { if (!e.target.closest('.search')) results.hidden = true; });
document.addEventListener('keydown', e => { if (e.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) { e.preventDefault(); input.focus(); } });

// --- live status + banner -----------------------------------------------------------------
const live = document.getElementById('live'), liveText = document.getElementById('live-text'), banner = document.getElementById('banner');
let lastBlock = null, lastBlockAt = 0, streamOpen = true;
function setLive(state, text) { live.className = `live ${state}`; liveText.textContent = text; }
// The pill shows the latest finalized block and how old it is. A stream that
// drops and reconnects within a few seconds (a deploy, a proxy hiccup) keeps
// the pill steady; it warns only when blocks actually stop arriving.
const RECONNECT_GRACE_MS = 4000, DELAYED_MS = 15000;
function renderLive() {
  if (!lastBlock) return;
  const since = Date.now() - lastBlockAt;
  if (!streamOpen && since > RECONNECT_GRACE_MS) { setLive('warn', 'Reconnecting…'); return; }
  const age = lastBlock.ts ? Math.max(0, Math.round(Date.now() / 1000 - Number(lastBlock.ts))) : null;
  const delayed = since > DELAYED_MS;
  setLive(delayed ? 'warn' : 'ok', `${delayed ? 'Delayed' : 'Block'} · #${int(lastBlock.block)}${age === null ? '' : ` · ${age < 60 ? `${age}s` : `${Math.floor(age / 60)}m`}`}`);
  live.title = age === null ? 'Latest finalized block' : `Latest finalized block, ${age}s old`;
}
stream.on('block', b => { lastBlock = b; lastBlockAt = Date.now(); renderLive(); });
stream.on('status', s => { streamOpen = s === 'open'; renderLive(); });
setInterval(renderLive, 1000);
function showBanner(p) {
  if (!p || (!p.running && !(p.pct < 100 && p.total_blocks !== '0'))) { banner.hidden = true; return; }
  const eta = p.eta_s ? (p.eta_s > 3600 ? `${Math.floor(p.eta_s / 3600)}h ${Math.round(p.eta_s % 3600 / 60)}m` : `${Math.max(1, Math.round(p.eta_s / 60))}m`) : '—';
  banner.hidden = false;
  banner.innerHTML = `<div class="banner-inner"><b>Indexing Perpl history</b><div class="bar"><i style="width:${Math.min(100, p.pct ?? 0)}%"></i></div><span class="num">${(p.pct ?? 0).toFixed(1)}% · ETA ${eta}</span><span class="faint">Recent windows are complete; longer windows fill in as blocks are indexed.</span></div>`;
}
stream.on('backfill', showBanner);

// MON price in the header: the mark of Perpl's MON market (chain state, not an
// external feed), refreshed by every protocol push.
const ticker = document.getElementById('ticker');
function renderTicker(markets) {
  const m = markets?.find(x => String(x.symbol).toUpperCase() === 'MON');
  const p = m?.mark ?? m?.close;
  if (!m || p === null || p === undefined) return;
  const ch = Number(m.change_pct);
  ticker.hidden = false;
  ticker.href = `#/markets/${m.id}`;
  ticker.title = 'MON mark price on Perpl · change over 24 hours';
  ticker.innerHTML = `${logo(m.id, 'MON', 16)}<span class="tp">$${esc(price(p))}</span>${Number.isFinite(ch) ? `<span class="${signClass(ch) || 'faint'}">${pct(ch, { sign: true })}</span>` : ''}`;
}
stream.on('protocol', p => renderTicker(p.markets));
get('protocol?window=24h', { maxAge: 5000 }).then(p => renderTicker(p.markets)).catch(() => {});
async function poll() {
  try {
    const h = await get('health', { maxAge: 0 });
    showBanner(h.index?.backfill);
    setAlertsBot(h.alerts?.bot);
    if (!lastBlockAt && h.index?.live?.to) setLive('ok', `Block · #${int(h.index.live.to)}`);
  } catch { setLive('bad', 'Offline'); }
}
poll(); setInterval(poll, 30000);
stream.connect();
// Market colours follow all-time volume rank, assigned once per browser
// before the first view renders (bounded wait).
Promise.race([get('protocol?window=all', { maxAge: 60000 }).then(p => assignColors([...p.markets].sort((a, b) => Number(b.volume) - Number(a.volume)).map(m => ({ id: m.id, symbol: m.symbol })))).catch(() => {}), new Promise(resolve => setTimeout(resolve, 1500))]).then(() => route());
export { lastBlock, dateTime };
