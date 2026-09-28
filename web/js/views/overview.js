// Protocol overview: headline metrics for the chosen window, volume by market
// next to the live tape, the markets table, a grid of trend charts and the
// latest liquidations and flows.
import { get, stream } from '../api.js';
import { usd, compact, int, price, pct, num, esc, timeOnly, ago, duration } from '../format.js';
import { kpi, seg, table, mkt, sideTag, addr, ratio, pctCell, fundingCell, fundingTip, tradeAction, chartTools, skeleton, skChart, empty, assignColors, colorOf, hasColor, logo, ICON, OTHER_HEX, SLOT_HEX, mergeByAsset } from '../ui.js';
import { sparkline, stackedBars, lineChart, signedBars, twoSided, toggleSeries, COLORS, CUMULATIVE } from '../charts.js';

const WINDOWS = [['24h', '24H'], ['7d', '7D'], ['30d', '30D'], ['all', 'All']];
const MIN_SIZES = [['0', 'All'], ['100', '≥$100'], ['1000', '≥$1K'], ['10000', '≥$10K']];
const FEE_VIEWS = [['type', 'By type'], ['market', 'By market']];
const FLOW_VIEWS = [['recent', 'Latest'], ['in', 'Top in'], ['out', 'Top out']];
// Windows other than 24h have no push of their own: refetch at most this often while blocks arrive.
const LONG_WINDOW_REFRESH_MS = 15000;
const segSm = (name, options, active) => seg(name, options, active).replace('class="seg"', 'class="seg sm"');

export function mount(el, { query, setQuery }) {
  let w = WINDOWS.some(([v]) => v === query.get('window')) ? query.get('window') : '24h';
  let feeView = 'type';
  let sort = { key: 'volume', dir: 'desc' };
  let minSize = localStorage.getItem('ps.minsize') ?? '100';
  let data = null, series = null, alive = true, flows = null, flowView = 'recent', lastLongLoad = 0, trendsLoaded = false;
  const tape = [], off = [];
  // The trend charts each keep their own window, independent of the one at the
  // top (which drives the headline metrics, the volume chart and the markets).
  const TRENDS = ['oi', 'tvl', 'flows', 'traders', 'fees', 'liq', 'tpnl', 'taker'];
  const pw = Object.fromEntries(TRENDS.map(id => [id, w]));
  const custom = new Set(); // charts set to a window of their own; the rest follow the page
  const winCtl = id => `${segSm(`tw:${id}`, WINDOWS, pw[id])}${custom.has(id) ? `<button class="trend-reset" data-action="treset" data-v="${id}" title="Follow the page window again">↺ ${w === 'all' ? 'All' : w.toUpperCase()}</button>` : ''}`;
  const panel = (id, title, desc, extra = '') => `<section class="panel trend"><div class="panel-head"><div class="trend-id"><h2>${title}</h2><div class="desc">${desc}</div>${extra}</div><div class="trend-side"><div class="trend-ctl">${chartTools(id, id)}<span id="${id}-win" class="trend-win">${winCtl(id)}</span></div><div class="head-value" id="${id}-v"></div></div></div><div class="panel-body"><div class="chart sm" id="${id}">${skChart()}</div></div></section>`;

  el.innerHTML = `
    <div class="page-head hero">
      <div class="hero-id">
        <div><h1><img class="hero-logo" src="img/venues/perpl.png" alt="" width="26" height="26">Perpl <span class="hero-muted">Analytics</span></h1>
          <div class="sub">Live analytics for Perpl on Monad: markets, traders, liquidation risk and alerts, from every onchain trade.</div></div>
      </div>
      <div class="hero-actions"><a class="btn primary" href="https://app.perpl.xyz" target="_blank" rel="noopener noreferrer">Trade on Perpl ${ICON.ext}</a><div id="win">${seg('window', WINDOWS, w)}</div></div>
    </div>
    <div class="stack">
      <div class="kpis" id="kpis">${Array.from({ length: 6 }, () => '<div class="kpi"><div class="skeleton sk-line" style="width:40%"></div><div class="skeleton" style="height:26px;width:70%;margin-top:10px"></div><div class="skeleton" style="height:28px;margin-top:10px"></div></div>').join('')}</div>
      <div class="grid g-main">
        <section class="panel">
          <div class="panel-head"><div><h2>Trading volume</h2><div class="desc">Maker-fill notional by market; line: running total</div></div><div class="head-right">${chartTools('main-chart', 'volume')}</div></div>
          <div class="panel-head" style="min-height:0;padding-top:0"><div class="legend toggles" id="legend"></div><span class="head-right"><span id="bucket"></span><span class="meta" id="chart-meta"></span></span></div>
          <div class="panel-body"><div class="chart" id="main-chart">${skChart()}</div></div>
        </section>
        <section class="panel fill">
          <div class="panel-head"><h2>Live trades</h2><div id="minsize">${segSm('min', MIN_SIZES, minSize)}</div></div>
          <div class="panel-body flush scroll" id="tape">${skeleton(8)}</div>
          <div class="panel-foot"><span id="tape-meta">Finalized blocks · aggressor side · UTC</span><span id="tape-count"></span></div>
        </section>
      </div>
      <section class="panel">
        <div class="panel-head"><div><h2>Markets</h2><div class="desc" id="markets-meta"></div></div><a class="meta" href="#/markets">All markets →</a></div>
        <div class="panel-body flush" id="markets">${skeleton(8)}</div>
      </section>
      <div class="section-label">Trends</div>
      <div class="grid g-2">
        ${panel('oi', 'Open interest', 'One side, priced at the last trade')}
        ${panel('tvl', 'TVL', 'Collateral in the exchange contract')}
        ${panel('flows', 'Deposits and withdrawals', 'Deposits up, withdrawals down; line: net per period')}
        ${panel('traders', 'Active traders', 'Distinct accounts trading per period: returning, and new (first trade ever)')}
        ${panel('fees', 'Fees', 'Gross fees on fills', `<div id="fees-mode">${segSm('feesv', FEE_VIEWS, feeView)}</div>`)}
        ${panel('liq', 'Liquidations', 'Liquidated notional by market')}
        ${panel('tpnl', 'Trader PnL', 'Realized PnL of all traders per period (price PnL + funding, before fees)')}
        ${panel('taker', 'Taker flow', 'Aggressive buys up, sells down; line: net per period')}
      </div>
      <div class="section-label">Activity</div>
      <div class="grid g-3">
        <section class="panel"><div class="panel-head"><h2>Latest liquidations</h2><a class="meta" href="#/liquidations">View all →</a></div><div class="panel-body flush" id="liqs">${skeleton(5)}</div></section>
        <section class="panel"><div class="panel-head"><h2>Deposits and withdrawals</h2><div id="flowview">${segSm('flowv', FLOW_VIEWS, flowView)}</div></div><div class="panel-body flush" id="flowlist">${skeleton(5)}</div></section>
        <section class="panel fill"><div class="panel-head"><h2>Across windows</h2><span class="meta">Exchange totals</span></div><div class="panel-body flush fill-table" id="windows">${skeleton(5)}</div></section>
      </div>
      <div class="section-label">Market share</div>
      <div class="grid g-2" id="landscape-grid">
        <section class="panel"><div class="panel-head"><div><h2>Perps on Monad</h2><div class="desc">Open interest by venue</div></div><span class="meta" id="ls-chain-meta"></span></div><div class="panel-body flush" id="ls-chain">${skeleton(4)}</div></section>
        <section class="panel"><div class="panel-head"><div><h2>Among all perps</h2><div class="desc">Open interest by venue</div></div><span class="meta" id="ls-meta"></span></div><div class="panel-body flush" id="ls-all">${skeleton(6)}</div></section>
      </div>
    </div>`;
  const $ = id => el.querySelector(`#${id}`);
  // Every figure says which period it covers: the window, or "now" for state.
  const windowLabel = () => (w === 'all' ? 'all-time' : w);
  const BUCKET_NAMES = { 3600: 'hourly', 14400: '4-hour', 86400: 'daily', 604800: 'weekly' };
  // Period length: the API's default per window (all-time: weekly), or daily/weekly on request.
  const BUCKET_CHOICES = { '30d': [['1d', 'Daily'], ['1w', 'Weekly']], all: [['1d', 'Daily'], ['1w', 'Weekly']] };
  let bucket = null;
  const seriesPath = () => `protocol/series?window=${w}${bucket ? `&bucket=${bucket}` : ''}`;
  function renderBucket() { const c = BUCKET_CHOICES[w]; $('bucket').innerHTML = c ? segSm('bucket', c, bucket ?? (w === 'all' ? '1w' : '1d')) : ''; }

  async function load() {
    const [p, s] = await Promise.all([get(`protocol?window=${w}`), get(seriesPath())]);
    if (!alive) return;
    data = p; series = s;
    assignColors([...p.markets].sort((a, b) => num(b.volume) - num(a.volume)).map(m => ({ id: m.id, symbol: m.symbol })));
    renderBucket(); renderKpis(); renderVolume(); renderMarkets(); renderWindows();
    if (!trendsLoaded) { trendsLoaded = true; loadTrends().catch(() => {}); }
  }
  async function loadFeeds() {
    const [t, l, f] = await Promise.all([get('trades?limit=200', { maxAge: 800 }), get('liquidations?limit=8'), get(`flows?window=${w}`)]);
    if (!alive) return;
    tape.length = 0; tape.push(...t.rows);
    renderTape(); renderLiqs(l); renderFlows(f);
  }

  // Change over the window from the running-sum series (null until history is complete).
  function seriesChange(field, sr = series, win = w) {
    if (win === 'all' || !sr?.meta?.cumulative_complete) return undefined; // from launch the change is meaningless
    const vals = sr.points.map(p => num(p[field])).filter(v => v !== null);
    if (vals.length < 2 || !vals[0]) return undefined;
    return Math.round((vals.at(-1) - vals[0]) / vals[0] * 10000) / 100;
  }
  function spark(key, values, color = COLORS.accent) { const node = $(key); if (node && values.some(v => v !== null && v !== undefined)) sparkline(node, values, { color }); }
  function renderKpis() {
    const h = data.headline, c = data.current, pts = series.points;
    const cov = data.meta.coverage, wl = windowLabel();
    // A change against a previous window that is still being indexed would mislead: hide it.
    // All-time has no previous period, so no change is shown (not a "—").
    const ch = v => (w === 'all' || data.meta.previous_complete === false ? undefined : v);
    const partial = cov && !cov.complete ? ' <span class="tag warn" title="History for this window is still being indexed">partial</span>' : '';
    // Window totals compare with the window before; open interest and TVL show their change within the window.
    const days = { '24h': 1, '7d': 7, '30d': 30 }[w], yearly = days ? (num(h.protocol_fees.value) ?? 0) * 365 / days : null;
    const vsPrev = { basis: 'vs prev', basisTitle: `Compared with the previous ${wl}` }, within = { basis: `in ${wl}`, basisTitle: `Change over the last ${wl}` };
    $('kpis').innerHTML = [
      kpi({ label: `Volume · ${wl}`, value: usd(h.volume.value), delta: ch(h.volume.change_pct), ...vsPrev, note: `${int(data.markets.reduce((a, m) => a + (m.fills ?? 0), 0))} trades${partial}`, spark: 'sp-vol', tip: 'Notional of every match, counted once (the maker side). A trade is one match between a maker and a taker.' }),
      kpi({ label: 'Open interest', value: usd(c?.open_interest), delta: seriesChange('open_interest'), ...within, note: c ? `${int(c.positions)} open positions` : '', spark: 'sp-oi', tip: 'Long notional at the mark price; equal to short notional by construction, so each contract counts once. The change compares the window\'s first and last points of the event-derived series.' }),
      kpi({ label: 'TVL', value: usd(c?.tvl), delta: seriesChange('tvl'), ...within, note: `${usd(h.net_flow.value, { sign: true })} net flow · ${wl}`, spark: 'sp-tvl', tip: 'Collateral held by the exchange contract, read from chain state.' }),
      kpi({ label: `Fees · ${wl}`, value: usd(h.fees.value), delta: ch(h.fees.change_pct), ...vsPrev, note: `Revenue ${usd(h.protocol_fees.value)}${yearly ? ` · ≈${usd(yearly)}/yr` : ''}`, spark: 'sp-fees', tip: `${w === '24h' ? `Revenue (the protocol share) runs at about ${usd((num(h.protocol_fees.value) ?? 0) * 365)} a year at this pace. ` : ''}Fees charged on fills, gross: ${usd(h.insurance_fees.value)} to the insurance fund and ${usd(h.protocol_fees.value)} protocol share, of which ${usd(h.builder_fees)} went to order builders. Rebates and referral shares are paid outside fills and are not deducted.` }),
      kpi({ label: `Active traders · ${wl}`, value: int(h.traders.value), delta: ch(h.traders.change_pct), ...vsPrev, note: `${int(h.new_accounts.value)} new accounts`, spark: 'sp-tr' }),
      kpi({ label: `Liquidations · ${wl}`, value: usd(h.liquidated.value), delta: ch(h.liquidated.change_pct), ...vsPrev, invert: true, note: `${int(h.liquidations.value)} liquidations`, spark: 'sp-liq' })
    ].join('');
    spark('sp-vol', pts.map(p => num(p.volume)));
    spark('sp-oi', pts.map(p => num(p.open_interest)));
    spark('sp-tvl', pts.map(p => num(p.tvl)));
    spark('sp-fees', pts.map(p => num(p.fees)));
    spark('sp-tr', pts.map(p => p.traders));
    spark('sp-liq', pts.map(p => num(p.liquidated)), COLORS.short);
  }

  // Stacked by market: the six largest markets keep their colour, the rest fold into Other.
  function byMarket(metric, sr = series) {
    const all = mergeByAsset(sr.by_market ?? [], ['volume', 'liquidated', 'fees']).filter(m => m[metric].some(v => num(v) > 0));
    const top = all.filter(m => hasColor(m.id)), rest = all.filter(m => !hasColor(m.id));
    const list = top.map(m => ({ id: m.id, name: m.symbol, color: colorOf(m.id), data: m[metric].map(num) }));
    if (rest.length) list.push({ name: 'Other', color: OTHER_HEX, data: sr.times.map((_, i) => rest.reduce((a, m) => a + num(m[metric][i]), 0)) });
    return list;
  }
  // The swatch keeps the series colour; the logo (when the asset has one) names it.
  const legendLogo = s => { if (s.id === undefined) return ''; const html = logo(s.id, s.name, 14); return html.startsWith('<img') ? html : ''; };
  function renderVolume() {
    const node = $('main-chart'), b = series.meta.bucket_seconds;
    node.innerHTML = '';
    // With the daily/weekly switch shown, the meta names only the span.
    $('chart-meta').textContent = BUCKET_CHOICES[w] ? `${w === 'all' ? 'All-time' : `Last ${w}`} · UTC` : `${w === 'all' ? 'All-time' : `Last ${w}`} · ${BUCKET_NAMES[b] ?? `${series.meta.bucket}`} bars · UTC`;
    const list = byMarket('volume');
    stackedBars(node, { times: series.times, series: list, bucketSeconds: b, cumulative: true, zoom: true });
    $('legend').innerHTML = list.map(s => `<button class="lg" data-action="toggle" data-name="${esc(s.name)}"><i style="background:${s.color}"></i>${legendLogo(s)}${esc(s.name)}</button>`).join('')
      + `<button class="lg" data-action="toggle" data-name="${CUMULATIVE}"><i style="background:#fff;height:2px;border-radius:1px"></i>Cumulative</button>`;
  }
  // Open interest and TVL are running sums from launch, so they wait for the backfill.
  let backfill = null;
  function historyNote() {
    const p = backfill && !backfill.complete && backfill.pct < 100 ? ` Indexing is ${Math.floor(backfill.pct)}% done${backfill.eta_s ? `, about ${duration(backfill.eta_s)} left` : ''}.` : '';
    return `A running sum over every event since launch, drawn once history indexing completes.${p}`;
  }
  function headValue(id, value, note = '') { const n = $(`${id}-v`); if (n) n.innerHTML = `<div class="hv">${value}</div>${note ? `<div class="hn">${note}</div>` : ''}`; }
  // Fees per period by type (protocol revenue, insurance fund) or by market.
  function renderFees() {
    const d = trendOf.fees, node = $('fees'); if (!node || !d) return;
    const sr = d.s, pts = sr.points, times = sr.times, b = sr.meta.bucket_seconds;
    node.innerHTML = '';
    const list = feeView === 'market' ? byMarket('fees', sr) : [{ name: 'Protocol (revenue)', color: SLOT_HEX[0], data: pts.map(p => num(p.protocol_fees)) }, { name: 'Insurance fund', color: SLOT_HEX[2], data: pts.map(p => num(p.insurance_fees)) }];
    if (list.length) stackedBars(node, { times, series: list, bucketSeconds: b }); else node.innerHTML = empty('No fees in this window');
  }
  // Each trend panel: its window's totals (header) and series (chart).
  const trendOf = {};
  const winLabel = win => (win === 'all' ? 'all-time' : win);
  const trendData = (win, fresh) => Promise.all([get(`protocol?window=${win}`, { maxAge: fresh ? 0 : 15000 }), get(`protocol/series?window=${win}`, { maxAge: fresh ? 0 : 15000 })]).then(([p, s]) => ({ p, s }));
  async function loadTrend(id, fresh = false) {
    const win = pw[id];
    const d = await trendData(win, fresh);
    if (!alive || pw[id] !== win) return; // switched again meanwhile
    trendOf[id] = d; renderTrend(id);
  }
  const loadTrends = (fresh = false) => Promise.all(TRENDS.map(id => loadTrend(id, fresh).catch(() => {})));
  function renderTrend(id) {
    const d = trendOf[id], node = $(id); if (!d || !node) return;
    const win = pw[id], sr = d.s, pts = sr.points, times = sr.times, b = sr.meta.bucket_seconds, h = d.p.headline, c = d.p.current;
    node.innerHTML = '';
    // Open interest and TVL: axes start at zero, so a 1% move looks like one; the change over the window is in the header.
    const moved = field => { const x = seriesChange(field, sr, win); return x === undefined ? (win === 'all' ? 'now' : '') : `<span class="${x > 0 ? 'pos' : x < 0 ? 'neg' : 'faint'}">${x > 0 ? '+' : ''}${x.toFixed(Math.abs(x) < 10 ? 1 : 0)}%</span> over ${win}`; };
    const cumulative = sr.meta.cumulative_complete;
    switch (id) {
      case 'oi':
        headValue('oi', usd(c?.open_interest), moved('open_interest'));
        if (cumulative) lineChart(node, { times, series: [{ name: 'Open interest', color: COLORS.accent, data: pts.map(p => num(p.open_interest)) }], bucketSeconds: b }); else node.innerHTML = empty(historyNote());
        break;
      case 'tvl':
        headValue('tvl', usd(c?.tvl), moved('tvl'));
        if (cumulative) lineChart(node, { times, series: [{ name: 'TVL', color: SLOT_HEX[0], data: pts.map(p => num(p.tvl)) }], bucketSeconds: b }); else node.innerHTML = empty(historyNote());
        break;
      case 'flows':
        headValue('flows', `<span class="${num(h.net_flow.value) >= 0 ? 'pos' : 'neg'}">${usd(h.net_flow.value, { sign: true })}</span>`, `${usd(h.deposits.value)} in · ${usd(h.withdrawals.value)} out · ${winLabel(win)}`);
        twoSided(node, { times, bucketSeconds: b, up: { name: 'Deposits', data: pts.map(p => p.deposits) }, down: { name: 'Withdrawals', data: pts.map(p => p.withdrawals) }, net: 'Net deposits' });
        break;
      case 'traders':
        {
          // New: accounts trading for the first time ever; the rest came back.
          const fresh = pts.reduce((a, p) => a + (p.new_traders ?? 0), 0);
          headValue('traders', int(h.traders.value), `${winLabel(win)} distinct · ${int(fresh)} new`);
          stackedBars(node, { times, series: [
            { name: 'Returning traders', color: COLORS.accent, data: pts.map(p => Math.max(0, (p.traders ?? 0) - (p.new_traders ?? 0))) },
            { name: 'New traders', color: SLOT_HEX[2], data: pts.map(p => p.new_traders ?? 0) }
          ], bucketSeconds: b, fmt: v => int(v), yFmt: v => (Math.abs(v) >= 1000 ? compact(v, { digits: 1 }) : int(v)) });
        }
        break;
      case 'fees':
        headValue('fees', usd(h.fees.value), `${usd(h.protocol_fees.value)} protocol · ${usd(h.insurance_fees.value)} insurance · ${winLabel(win)}`);
        renderFees();
        break;
      case 'liq': {
        headValue('liq', usd(h.liquidated.value), `${int(h.liquidations.value)} liquidations · ${winLabel(win)}`);
        const list = byMarket('liquidated', sr);
        if (list.length) stackedBars(node, { times, series: list, bucketSeconds: b, cumulative: true }); else node.innerHTML = empty('No liquidations in this window');
        break;
      }
      case 'tpnl': {
        // Header figures come from the window's own totals, not from summing the
        // chart's buckets; 'after fees' is the Traders page's figure for the same window.
        const total = num(h.realized_pnl?.value ?? h.realized_pnl) ?? 0;
        const value = `<span class="${total >= 0 ? 'pos' : 'neg'}">${usd(total, { sign: true })}</span>`;
        headValue('tpnl', value, winLabel(win));
        get(`traders/summary?window=${win}`, { maxAge: 20000 }).then(t => { if (alive && t && pw.tpnl === win) headValue('tpnl', value, `${winLabel(win)} · after fees ${usd(t.net_pnl, { sign: true })}`); }).catch(() => {});
        signedBars(node, { times, values: pts.map(p => num(p.realized_pnl)), bucketSeconds: b, name: 'Trader realized PnL' });
        break;
      }
      case 'taker': {
        const buys = d.p.markets.reduce((a, m) => a + (num(m.taker_buy) ?? 0), 0), sells = d.p.markets.reduce((a, m) => a + (num(m.taker_sell) ?? 0), 0);
        headValue('taker', buys + sells ? `${pct(buys / (buys + sells) * 100, { digits: 1 })} buys` : '—', `${usd(buys)} bought · ${usd(sells)} sold · ${winLabel(win)}`);
        twoSided(node, { times, bucketSeconds: b, up: { name: 'Taker buys', data: pts.map(p => p.taker_buy) }, down: { name: 'Taker sells', data: pts.map(p => p.taker_sell) }, net: 'Net taker buying' });
        break;
      }
      default:
    }
  }

  const marketCols = () => [
    { key: 'symbol', label: 'Market', sort: r => r.symbol, render: r => `${mkt(r.id, r.symbol)}${r.active === false ? ' <span class="tag" title="Not open for trading">inactive</span>' : ''}` },
    { key: 'mark', label: 'Price', n: true, sort: r => num(r.mark ?? r.close), render: r => price(r.mark ?? r.close) },
    { key: 'change_pct', label: w === 'all' ? 'Change' : `${w} change`, n: true, sort: r => num(r.change_pct) ?? -1e9, render: r => pctCell(r.change_pct) },
    { key: 'volume', label: 'Volume', n: true, cls: 'cell-bar', sort: r => num(r.volume), render: r => `${usd(r.volume)}<span class="track"><i style="width:${Math.max(2, Math.min(100, r.share_pct ?? 0))}%"></i></span>` },
    { key: 'share_pct', label: 'Share', n: true, sort: r => r.share_pct ?? 0, render: r => `<span class="muted">${pct(r.share_pct, { digits: 1 })}</span>` },
    { key: 'open_interest', label: 'Open interest', n: true, sort: r => num(r.open_interest) ?? 0, render: r => usd(r.open_interest) },
    { key: 'funding', label: 'Funding 8h', tip: fundingTip(data?.markets?.find(m => m.funding?.interval_seconds)?.funding.interval_seconds), n: true, sort: r => r.funding?.rate_8h_pct ?? 0, render: r => fundingCell(r.funding) },
    { key: 'ls', label: 'Long / short positions', sort: r => r.long_position_share_pct ?? 0, render: r => ratio(r.long_positions, r.short_positions) },
    { key: 'taker_buy_share_pct', label: 'Taker buys', n: true, sort: r => r.taker_buy_share_pct ?? 0, render: r => (r.taker_buy_share_pct === null || r.taker_buy_share_pct === undefined ? '—' : pct(r.taker_buy_share_pct, { digits: 1 })) },
    { key: 'traders', label: 'Traders', n: true, sort: r => r.traders ?? 0, render: r => int(r.traders) },
    { key: 'liquidations', label: 'Liquidated', n: true, sort: r => num(r.liquidated) ?? 0, render: r => (r.liquidations ? `${usd(r.liquidated)}<div class="sub">${int(r.liquidations)} liq.</div>` : '<span class="faint">—</span>') }
  ];
  function renderMarkets() {
    const rows = data.markets.filter(m => num(m.volume) > 0 || num(m.open_interest) > 0);
    $('markets').innerHTML = table({ id: 'markets', columns: marketCols(), rows, sortKey: sort.key, sortDir: sort.dir, rowAttrs: r => `class="link" data-href="#/markets/${r.id}"` });
    $('markets-meta').textContent = `${rows.filter(r => r.active !== false).length} active markets · ${w === 'all' ? 'all-time' : w} activity, live prices and positions`;
  }

  // Consensus timing of the blocks behind proposed trades (from the node's
  // execution events): the tape footer shows the median time from a block
  // starting to its finalization; a dimmed row's tooltip gives its own stage.
  const finalMs = [];
  const secs = ms => `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
  const stageTitle = r => (r.votedMs !== undefined ? `Proposed block, voted ${secs(r.votedMs)} after it started executing; final soon` : 'Proposed block, not final yet');
  function renderSpeed() {
    if (!finalMs.length) return;
    const sorted = [...finalMs].sort((a, b) => a - b), mid = sorted[Math.floor(sorted.length / 2)];
    $('tape-meta').innerHTML = `<span class="speed-pill">${ICON.cube} Proposed → final <b class="num" title="Median time from a proposed block starting to execute to its finalization, as seen from the Monad node Plumb reads; last ${sorted.length} blocks with Perpl trades">${secs(mid)}</b></span><span>UTC</span>`;
  }
  function renderTape() {
    const min = Number(minSize);
    const rows = tape.filter(r => (num(r.notional) ?? 0) >= min);
    $('tape-count').textContent = rows.length ? `${int(Math.min(rows.length, 60))} shown` : '';
    if (!rows.length) { $('tape').innerHTML = empty(tape.length ? 'No trades of this size yet' : 'Waiting for trades'); return; }
    $('tape').innerHTML = table({ id: 'tape', compact: true, columns: [
      { key: 't', label: 'Time', render: r => `<span class="muted num">${timeOnly(r.ts)}</span>` },
      { key: 'm', label: 'Market', render: r => mkt(r.market, r.symbol) },
      { key: 's', label: 'Action', render: tradeAction },
      { key: 'p', label: 'Price', n: true, render: r => price(r.price) },
      { key: 'v', label: 'Value', n: true, render: r => usd(r.notional) }
    ], rows: rows.slice(0, 60), rowAttrs: r => `class="link ${r.fresh ? 'flash' : ''} ${r.proposed ? 'proposed' : ''}" data-href="#/wallet/${esc(r.address || r.account)}" ${r.proposed ? `title="${stageTitle(r)}"` : ''}` });
    for (const r of tape) r.fresh = false;
  }
  function renderLiqs(l) {
    $('liqs').innerHTML = l.rows.length ? table({ id: 'liqs', compact: true, columns: [
      { key: 'm', label: 'Market', render: r => mkt(r.market, r.symbol) },
      { key: 's', label: 'Position', render: r => sideTag(r.side) },
      { key: 'v', label: 'Value', n: true, render: r => usd(r.notional) },
      { key: 't', label: 'When', n: true, render: r => `<span class="muted">${ago(r.ts)}</span>` }
    ], rows: l.rows.slice(0, 7), rowAttrs: r => `class="link" data-href="#/wallet/${esc(r.address || r.account)}"` }) : empty('No liquidations yet');
  }
  // Latest movements, or the window's largest depositors / withdrawers with their net.
  function renderFlows(f = flows) {
    if (!f) return;
    flows = f;
    const link = r => `class="link" data-href="#/wallet/${esc(r.address || r.account)}"`;
    if (flowView === 'recent') {
      const rows = (f.recent ?? []).slice(0, 7);
      $('flowlist').innerHTML = rows.length ? table({ id: 'flowlist', compact: true, columns: [
        { key: 'k', label: 'Type', render: r => `<span class="${r.kind === 'deposit' ? 'pos' : 'neg'}">${r.kind === 'deposit' ? 'Deposit' : 'Withdrawal'}</span>` },
        { key: 'a', label: 'Wallet', render: r => addr(r.address, r.account, { star: false }) },
        { key: 'v', label: 'Amount', n: true, render: r => usd(r.amount) },
        { key: 't', label: 'When', n: true, render: r => `<span class="muted">${ago(r.ts)}</span>` }
      ], rows, rowAttrs: link }) : empty('No recent deposits or withdrawals');
      return;
    }
    const inbound = flowView === 'in', rows = ((inbound ? f.top_depositors : f.top_withdrawers) ?? []).slice(0, 7);
    $('flowlist').innerHTML = rows.length ? table({ id: 'flowlist', compact: true, columns: [
      { key: 'a', label: 'Wallet', render: r => addr(r.address, r.account, { star: false }) },
      { key: 'v', label: inbound ? 'Deposited' : 'Withdrew', n: true, render: r => usd(inbound ? r.deposits : r.withdrawals) },
      { key: 'n', label: 'Net', n: true, render: r => `<span class="${num(r.net) >= 0 ? 'pos' : 'neg'}">${usd(r.net, { sign: true })}</span>` }
    ], rows, rowAttrs: link }) : empty(`No ${inbound ? 'deposits' : 'withdrawals'} in this window`);
  }
  function renderWindows() {
    const ws = data.windows;
    const rows = [['24h', '24 hours'], ['7d', '7 days'], ['30d', '30 days'], ['all', 'All-time']].map(([k, label]) => ({ k, label, ...(ws[k] ?? {}) }));
    $('windows').innerHTML = table({ id: 'win', compact: true, columns: [
      { key: 'label', label: 'Window', render: r => `${r.label}${r.k === 'all' && backfill && !backfill.complete ? ' <span class="tag warn" title="History is still being indexed">partial</span>' : ''}${r.k === w ? ' <span class="tag accent">shown</span>' : ''}` },
      { key: 'volume', label: 'Volume', n: true, render: r => usd(r.volume) },
      { key: 'fees', label: 'Fees', n: true, render: r => usd(r.fees) },
      { key: 'traders', label: 'Traders', n: true, render: r => int(r.traders) }
    ], rows, rowAttrs: r => `class="link" data-href="#/?window=${r.k}"` });
  }

  // Market-share context from DefiLlama's open-interest overview (external, labelled as such).
  async function loadLandscape() {
    let l;
    try { l = await get('landscape', { maxAge: 300000 }); } catch { $('landscape-grid').previousElementSibling.remove(); $('landscape-grid').remove(); return; }
    if (!alive) return;
    const src = `<a href="${esc(l.source.url)}" target="_blank" rel="noopener noreferrer">${esc(l.source.name)}</a>, ${ago(Math.round(l.fetched_at / 1000))}`;
    const bar = (v, share) => `${usd(v)}<span class="track"><i style="width:${Math.max(2, Math.min(100, share ?? 0))}%"></i></span>`;
    const name = r => (r.self || r.name === 'Perpl' ? `<span class="mkt"><img class="tk" src="img/venues/perpl.png" alt="" width="16" height="16"><b>${esc(r.name)}</b></span>` : esc(r.name));
    // The five largest venues give the scale; Perpl's own row follows them.
    const top = l.top.slice(0, 5);
    if (l.perpl && l.perpl.rank > top.length) top.push({ rank: l.perpl.rank, name: 'Perpl', oi: l.perpl.oi, share_pct: l.perpl.share_pct });
    $('ls-meta').innerHTML = l.perpl ? `Perpl #${int(l.perpl.rank)} of ${int(l.venues)} · ${pct(l.perpl.share_pct, { digits: 2 })} · ${src}` : src;
    $('ls-all').innerHTML = table({ id: 'ls-all', compact: true, columns: [
      { key: 'r', label: '#', render: r => `<span class="rank">${r.rank}</span>` },
      { key: 'n', label: 'Venue', render: name },
      { key: 'o', label: 'Open interest', n: true, cls: 'cell-bar', render: r => bar(r.oi, r.share_pct / (l.top[0]?.share_pct || 1) * 100) },
      { key: 's', label: 'Share', n: true, render: r => `<span class="muted">${pct(r.share_pct, { digits: 2 })}</span>` }
    ], rows: top, rowAttrs: r => (r.name === 'Perpl' ? 'class="hl"' : '') });
    $('ls-chain-meta').innerHTML = l.perpl?.share_of_chain_pct !== null && l.perpl ? `Perpl ${pct(l.perpl.share_of_chain_pct, { digits: 1 })} of ${esc(l.chain.name)} · ${src}` : src;
    $('ls-chain').innerHTML = table({ id: 'ls-chain', compact: true, emptyText: 'No venues listed', columns: [
      { key: 'n', label: 'Venue', render: name },
      { key: 'o', label: 'Open interest', n: true, cls: 'cell-bar', render: r => bar(r.oi, r.share_pct) },
      { key: 's', label: 'Share', n: true, render: r => `<span class="muted">${pct(r.share_pct, { digits: 1 })}</span>` }
    ], rows: l.chain.venues, rowAttrs: r => (r.self ? 'class="hl"' : '') });
  }

  // Live: finalized trades stream in; proposed ones appear first, dimmed.
  off.push(stream.on('trades', rows => {
    for (const r of rows.slice().reverse()) { const i = tape.findIndex(x => x.proposed && x.tx === r.tx); if (i >= 0) tape.splice(i, 1); tape.unshift({ ...r, fresh: true }); }
    tape.length = Math.min(tape.length, 400); renderTape();
  }));
  // A proposed trade still unmatched 10 finalized blocks later never finalized.
  off.push(stream.on('block', b => { let dropped = false; for (let i = tape.length - 1; i >= 0; i--) if (tape[i].proposed && Number(tape[i].block) <= Number(b.block) - 10) { tape.splice(i, 1); dropped = true; } if (dropped) renderTape(); }));
  off.push(stream.on('stage', s => {
    if (s.stage === 'voted') { for (const r of tape) if (r.proposed && Number(r.block) === s.block) r.votedMs = s.ms; return; }
    if (s.stage === 'finalized') { finalMs.push(s.ms); if (finalMs.length > 50) finalMs.shift(); renderSpeed(); }
  }));
  off.push(stream.on('proposed', p => { for (const r of p.trades) if (!tape.some(x => x.tx === r.tx)) tape.unshift({ ...r, proposed: true, fresh: true }); tape.length = Math.min(tape.length, 400); if (!finalMs.length) $('tape-meta').textContent = 'Proposed + finalized blocks · UTC'; renderTape(); }));
  off.push(stream.on('backfill', p => {
    const finished = backfill && !backfill.complete && p.complete;
    backfill = p;
    if (!alive || !series) return;
    if (finished) loadTrends(true);
    else for (const id of ['oi', 'tvl']) { const n = $(id)?.querySelector('.empty-state'); if (n) n.textContent = historyNote(); }
  }));
  get('health', { maxAge: 30000 }).then(h => { backfill = h.index?.backfill ?? null; }).catch(() => {});
  off.push(stream.on('liquidations', () => get('liquidations?limit=8', { maxAge: 0 }).then(l => alive && renderLiqs(l)).catch(() => {})));
  // Longer windows: the push carries 24h figures only, so it just triggers a throttled refetch.
  off.push(stream.on('protocol', () => {
    if (w === '24h' || !data || !alive || Date.now() - lastLongLoad < LONG_WINDOW_REFRESH_MS) return;
    lastLongLoad = Date.now();
    get(`protocol?window=${w}`, { maxAge: 0 }).then(p => { if (!alive || w === '24h') return; data = p; renderKpis(); renderMarkets(); renderWindows(); }).catch(() => {});
    get(`flows?window=${w}`, { maxAge: 0 }).then(f => alive && renderFlows(f)).catch(() => {});
  }));
  off.push(stream.on('protocol', p => { if (w !== '24h' || !data || !alive) return; data = { ...data, headline: p.headline, current: p.current, markets: data.markets.map(m => { const u = p.markets.find(x => x.id === m.id); return u ? { ...m, mark: u.mark ?? m.mark, volume: u.volume, change_pct: u.change_pct, open_interest: u.open_interest ?? m.open_interest, funding: u.funding ?? m.funding } : m; }) }; renderKpis(); renderMarkets(); }));
  const timer = setInterval(() => { get(seriesPath(), { maxAge: 0 }).then(s => { if (!alive) return; series = s; renderVolume(); if (w !== '24h') load().catch(() => {}); }).catch(() => {}); loadTrends(true); }, 60000);

  load().catch(error => { $('kpis').innerHTML = `<div class="empty-state">Could not load protocol data (${esc(error.message)})</div>`; });
  loadFeeds().catch(() => {});
  loadLandscape();

  return {
    onSeg(name, v) {
      if (name.startsWith('tw:')) { const id = name.slice(3); pw[id] = v; if (v === w) custom.delete(id); else custom.add(id); $(`${id}-win`).innerHTML = winCtl(id); $(id).innerHTML = skChart(); loadTrend(id).catch(() => {}); return; }
      if (name === 'window') setQuery({ window: v === '24h' ? null : v });
      if (name === 'min') { minSize = v; try { localStorage.setItem('ps.minsize', v); } catch { /* storage unavailable */ } $('minsize').innerHTML = segSm('min', MIN_SIZES, minSize); renderTape(); }
      if (name === 'flowv') { flowView = v; $('flowview').innerHTML = segSm('flowv', FLOW_VIEWS, flowView); renderFlows(); }
      if (name === 'bucket') { bucket = v; renderBucket(); get(seriesPath()).then(s => { if (!alive) return; series = s; renderVolume(); renderKpis(); }).catch(() => {}); return; }
      if (name === 'feesv') { feeView = v; $('fees-mode').innerHTML = segSm('feesv', FEE_VIEWS, feeView); renderFees(); }
    },
    onAction(a, t) { if (a === 'treset') { const id = t.dataset.v; custom.delete(id); pw[id] = w; $(`${id}-win`).innerHTML = winCtl(id); $(id).innerHTML = skChart(); loadTrend(id).catch(() => {}); return; } if (a === 'toggle') { t.classList.toggle('off'); toggleSeries($('main-chart'), t.dataset.name); } },
    onSort(id, key) { if (id !== 'markets') return; sort = { key, dir: sort.key === key && sort.dir === 'desc' ? 'asc' : 'desc' }; renderMarkets(); },
    update(q) { const nw = WINDOWS.some(([v]) => v === q.get('window')) ? q.get('window') : '24h'; if (nw === w) return; w = nw; bucket = null; $('win').innerHTML = seg('window', WINDOWS, w);
      for (const id of TRENDS) { if (pw[id] === w) custom.delete(id); if (!custom.has(id) && pw[id] !== w) { pw[id] = w; $(id).innerHTML = skChart(); loadTrend(id).catch(() => {}); } $(`${id}-win`).innerHTML = winCtl(id); }
      load().catch(() => {}); get(`flows?window=${w}`).then(f => alive && renderFlows(f)).catch(() => {}); },
    destroy() { alive = false; clearInterval(timer); off.forEach(f => f()); }
  };
}
