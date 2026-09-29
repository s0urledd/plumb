// Markets list: price, change, volume, open interest, funding, skew and risk
// for every market over the chosen window.
import { get, stream } from '../api.js';
import { usd, int, price, pct, num, esc } from '../format.js';
import { seg, table, mkt, ratio, pctCell, fundingCell, fundingTip, skeleton, skChart, empty, assignColors, chartTools } from '../ui.js';
import { divergingHeatmap } from '../charts.js';

const WINDOWS = [['24h', '24H'], ['7d', '7D'], ['30d', '30D'], ['all', 'All']];

export function mount(el, { query, setQuery }) {
  let w = WINDOWS.some(([v]) => v === query.get('window')) ? query.get('window') : '24h';
  let sort = { key: 'volume', dir: 'desc' }, data = null, alive = true;
  el.innerHTML = `
    <div class="page-head"><div><h1>Markets</h1><div class="sub">Every Perpl market with live prices, open interest and funding.</div></div><div id="win">${seg('window', WINDOWS, w)}</div></div>
    <div class="stack">
    <section class="panel"><div class="panel-body flush" id="list">${skeleton(10)}</div></section>
    <section class="panel"><div class="panel-head"><div><h2>Funding</h2><div class="desc" id="f-desc">Annualised funding rate per market</div></div><div class="head-right">${chartTools('funding-map', 'funding')}</div></div>
      <div class="panel-body"><div class="chart" id="funding-map">${skChart()}</div></div></section>
    </div>`;
  // Not trading: closed on the contract, or open with no trades in the window and
  // no open positions (a listing nobody trades yet). Both are tagged and dimmed alike.
  const idle = r => r.active === false || (!num(r.volume) && !num(r.open_interest));
  const idleTitle = r => (r.active === false ? 'Not open for trading' : `Open for trading, but no trades ${w === 'all' ? 'yet' : `in ${w}`} and no open positions`);
  const COLS = [
    { key: 'symbol', label: 'Market', sort: r => r.symbol, render: r => `${mkt(r.id, r.symbol, r.name && r.name !== r.symbol && r.name !== `${r.symbol} Perp` ? r.name : null)}${idle(r) ? ` <span class="tag" title="${idleTitle(r)}">inactive</span>` : ''}` },
    { key: 'mark', label: 'Mark', n: true, sort: r => num(r.mark ?? r.close), render: r => price(r.mark ?? r.close) },
    { key: 'change_pct', label: 'Change', n: true, sort: r => num(r.change_pct) ?? -1e9, render: r => pctCell(r.change_pct) },
    { key: 'range', label: 'Low – High', n: true, render: r => r.low ? `<span class="muted">${price(r.low)} – ${price(r.high)}</span>` : '—' },
    { key: 'volume', label: 'Volume', n: true, sort: r => num(r.volume), render: r => usd(r.volume) },
    { key: 'trades', label: 'Trades', tip: 'Matches between a maker and a taker, each counted once', n: true, sort: r => r.fills ?? 0, render: r => int(r.fills) },
    { key: 'fees', label: 'Fees', n: true, sort: r => num(r.fees) ?? 0, render: r => usd(r.fees) },
    { key: 'open_interest', label: 'Open interest', n: true, sort: r => num(r.open_interest) ?? 0, render: r => `${usd(r.open_interest)}${r.oi_cap_pct !== null && r.oi_cap_pct !== undefined ? `<div class="sub">${pct(r.oi_cap_pct, { digits: 1 })} of cap</div>` : ''}` },
    { key: 'funding', label: 'Funding 8h', get tip() { return fundingTip(data?.markets?.find(m => m.funding?.interval_seconds)?.funding.interval_seconds); }, n: true, sort: r => r.funding?.rate_8h_pct ?? 0, render: r => fundingCell(r.funding) },
    { key: 'cost', label: 'Cost $10K', n: true, tip: 'Average cost of a $10K market buy and sell on the onchain order book, versus the mid price. Includes half the spread.', sort: r => r.cost_10k_bps ?? -1, render: r => (r.cost_10k_bps === null || r.cost_10k_bps === undefined ? '<span class="faint">—</span>' : `${r.cost_10k_bps.toFixed(1)} bps${r.spread_bps !== null && r.spread_bps !== undefined ? `<div class="sub">spread ${r.spread_bps.toFixed(r.spread_bps < 1 ? 2 : 1)}</div>` : ''}`) },
    { key: 'ls', label: 'Long / short positions', sort: r => r.long_position_share_pct ?? 0, render: r => ratio(r.long_positions, r.short_positions) },
    { key: 'lev', label: 'Avg lev. L / S', n: true, render: r => r.long_leverage || r.short_leverage ? `${r.long_leverage ? r.long_leverage.toFixed(1) + 'x' : '—'} / ${r.short_leverage ? r.short_leverage.toFixed(1) + 'x' : '—'}` : '—' },
    { key: 'max_leverage', label: 'Max lev.', n: true, sort: r => r.max_leverage ?? 0, render: r => (r.max_leverage ? `${r.max_leverage}x` : '—') },
    { key: 'insurance', label: 'Insurance', n: true, sort: r => num(r.insurance) ?? 0, render: r => usd(r.insurance) }
  ];
  function render() { if (data) el.querySelector('#list').innerHTML = table({ id: 'm', columns: COLS, rows: data.markets, sortKey: sort.key, sortDir: sort.dir, rowAttrs: r => `class="link${idle(r) ? ' inactive' : ''}" data-href="/markets/${r.id}"` }); }
  async function load() { data = await get(`protocol?window=${w}`); if (!alive) return; assignColors([...data.markets].sort((a, b) => num(b.volume) - num(a.volume)).map(m => ({ id: m.id, symbol: m.symbol }))); render(); }
  // Funding across markets and time: APR per bucket, green when longs pay.
  async function loadFunding() {
    const [f, p] = await Promise.all([get(`funding?window=${w}`, { maxAge: 30000 }), get(`protocol?window=${w}`).catch(() => null)]);
    if (!alive) return;
    // A relisted market and its delisted original share a name: the old one's row says so.
    const closed = new Set((p?.markets ?? []).filter(m => m.active === false).map(m => m.id));
    const twins = f.series.map(s => s.symbol).filter((x, i, all) => all.indexOf(x) !== i);
    const rowName = s => {
      if (!twins.includes(s.symbol)) return s.symbol;
      if (closed.has(s.id)) return `${s.symbol} (inactive)`;
      return f.series.some(o => o.symbol === s.symbol && closed.has(o.id)) ? s.symbol : `${s.symbol} #${s.id}`; // no closed one known: the ids tell them apart
    };
    const node = el.querySelector('#funding-map'); node.innerHTML = '';
    const b = f.meta.bucket_seconds;
    const all = f.series.flatMap(s => s.points.map(p => p.t));
    if (!all.length) { node.innerHTML = empty('No funding events in this window'); return; }
    const times = []; for (let t = Math.min(...all); t <= Math.max(...all); t += b) times.push(t);
    // Each bucket is annualised with the funding interval of its own time (the API's apr_pct).
    const oi = new Map(f.markets.map(m => [m.id, num(m.open_interest) ?? 0]));
    const rows = f.series.filter(s => s.points.some(p => p.apr_pct !== null && p.apr_pct !== undefined)).sort((a, b2) => (oi.get(b2.id) ?? 0) - (oi.get(a.id) ?? 0)).map(s => {
      const at = new Map(s.points.filter(p => p.apr_pct !== null && p.apr_pct !== undefined).map(p => [p.t, p.apr_pct]));
      return { name: rowName(s), values: times.map(t => at.get(t) ?? null) };
    });
    node.style.height = `${Math.max(180, rows.length * 30 + 70)}px`;
    el.querySelector('#f-desc').textContent = `Annualised rate per market, ${b >= 86400 ? 'daily' : b >= 14400 ? '4-hour' : 'hourly'} averages · green: longs pay shorts, red: shorts pay longs`;
    // Scale to the data: the 95th percentile of |APR|, rounded up to a step.
    const mags = rows.flatMap(r => r.values).filter(v => v !== null).map(Math.abs).sort((a, b2) => a - b2);
    const p95 = mags.length ? mags[Math.min(mags.length - 1, Math.floor(mags.length * 0.95))] : 0;
    const clamp = [10, 20, 25, 50, 100, 200].find(x => x >= p95) ?? 200;
    el.querySelector('#f-desc').textContent += ` · scale ±${clamp}% APR`;
    divergingHeatmap(node, { times, rows, bucketSeconds: b, clamp, labels: ['longs pay', 'shorts pay'], fmt: v => `${pct(v, { digits: 1, sign: true })} APR` });
  }
  // 24h follows every push; longer windows refetch at most every 15 s.
  let lastLongLoad = 0;
  const off = stream.on('protocol', () => {
    if (w === '24h') { load().catch(() => {}); return; }
    if (Date.now() - lastLongLoad < 15000) return;
    lastLongLoad = Date.now();
    get(`protocol?window=${w}`, { maxAge: 0 }).then(() => load()).catch(() => {});
  });
  load().catch(error => { el.querySelector('#list').innerHTML = `<div class="empty-state">${esc(error.message)}</div>`; });
  loadFunding().catch(() => { el.querySelector('#funding-map').innerHTML = empty('Funding history unavailable'); });
  return {
    onSeg(name, v) { if (name === 'window') setQuery({ window: v === '24h' ? null : v }); },
    onSort(id, key) { sort = { key, dir: sort.key === key && sort.dir === 'desc' ? 'asc' : 'desc' }; render(); },
    update(q) { w = WINDOWS.some(([v]) => v === q.get('window')) ? q.get('window') : '24h'; el.querySelector('#win').innerHTML = seg('window', WINDOWS, w); load().catch(() => {}); loadFunding().catch(() => {}); },
    destroy() { alive = false; off(); }
  };
}
