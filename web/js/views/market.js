// One market: price candles and volume, positioning, funding history,
// liquidation ladder from live positions, top traders and recent trades.
import { get, stream } from '../api.js';
import { usd, int, price, pct, num, esc, size, timeOnly, dateTime, duration } from '../format.js';
import { kpi, seg, table, mkt, sideTag, addr, ratio, pnl, pctCell, fundingCell, fundingTip, tradeAction, skeleton, skChart, empty, colorOf, chartTools, logo } from '../ui.js';
import { candles, signedBars, mirrored, flowBars, entryProfile } from '../charts.js';

const WINDOWS = [['24h', '24H'], ['7d', '7D'], ['30d', '30D'], ['all', 'All']];

export function mount(el, { params, query, setQuery }) {
  const id = Number(params[0]);
  let w = WINDOWS.some(([v]) => v === query.get('window')) ? query.get('window') : '24h';
  let alive = true, row = null, risk = null, showLevels = true;
  const LEVEL_TOGGLE = [['on', 'Liq. levels'], ['off', 'Off']];
  el.innerHTML = `
    <div class="page-head">
      <div><div class="sub"><a href="#/markets">Markets</a> /</div><h1 id="title">Market #${id}</h1><div class="sub" id="subtitle"></div></div>
      <div id="win">${seg('window', WINDOWS, w)}</div>
    </div>
    <div class="stack">
      <div class="kpis" id="kpis"></div>
      <div class="grid g-main">
        <section class="panel"><div class="panel-head"><h2>Price and volume</h2><span class="head-right"><span class="meta" id="c-meta"></span><span id="lvl-toggle">${seg('lvl', LEVEL_TOGGLE, 'on').replace('class="seg"', 'class="seg sm"')}</span>${chartTools('candles', `market-${id}-candles`)}</span></div><div class="panel-body"><div class="chart lg" id="candles">${skChart()}</div></div></section>
        <section class="panel"><div class="panel-head"><h2>Positioning</h2><span class="meta">Live positions</span></div><div id="positioning">${skeleton(8)}</div></section>
      </div>
      <div class="grid g-2">
        <section class="panel"><div class="panel-head"><div><h2>Position flow</h2><div class="desc">Open interest opened (up) and closed (down) per period</div></div><div class="head-right">${chartTools('flow', `market-${id}-flow`)}<div class="head-value" id="flow-v"></div></div></div><div class="panel-head" style="min-height:0;padding-top:0"><div class="legend"><span><i style="background:var(--long)"></i>Longs opened</span><span><i style="background:var(--long);opacity:.5"></i>Longs closed</span><span><i style="background:var(--short)"></i>Shorts opened</span><span><i style="background:var(--short);opacity:.5"></i>Shorts closed</span><span><i style="background:#fff;height:2px"></i>Net change</span></div></div><div class="panel-body"><div class="chart sm" id="flow">${skChart()}</div></div></section>
        <section class="panel"><div class="panel-head"><div><h2>Entry prices</h2><div class="desc">Open positions by the price they were entered at, longs right and shorts left</div></div><div class="head-right">${chartTools('entries', `market-${id}-entries`, { csv: false })}<div class="head-value" id="entries-v"></div></div></div><div class="panel-body"><div class="chart sm" id="entries">${skChart()}</div></div></section>
      </div>
      <div class="grid g-2">
        <section class="panel"><div class="panel-head"><h2>Funding rate</h2><span class="head-right"><span class="meta" id="f-meta"></span>${chartTools('funding', `market-${id}-funding`)}</span></div><div class="panel-body"><div class="chart sm" id="funding">${skChart()}</div></div></section>
        <section class="panel"><div class="panel-head"><h2>Liquidation ladder</h2><span class="head-right"><span class="meta">Notional whose liquidation price an adverse move of the mark would cross</span>${chartTools('ladder', `market-${id}-ladder`, { csv: false })}</span></div><div class="panel-body"><div class="chart sm" id="ladder">${skChart()}</div></div></section>
      </div>
      <section class="panel"><div class="panel-head"><div><h2>Largest positions</h2><div class="desc">Open now, from contract state · closest to liquidation highlighted</div></div><span class="meta" id="pos-meta"></span></div><div class="panel-body flush" id="positions">${skeleton(6)}</div></section>
      <div class="grid g-2">
        <section class="panel"><div class="panel-head"><div><h2>Order book</h2><div class="desc">Resting orders read from the contract · bars: cumulative depth</div></div><span class="meta" id="book-meta"></span></div><div class="panel-body flush" id="book">${skeleton(10)}</div></section>
        <section class="panel fill"><div class="panel-head"><h2>Recent trades</h2><span class="meta">Aggressor side</span></div><div class="panel-body flush scroll" id="trades">${skeleton(6)}</div></section>
      </div>
      <div class="grid g-2">
        <section class="panel"><div class="panel-head"><h2>Top traders</h2><span class="meta" id="lb-meta"></span></div><div class="panel-body flush" id="lb">${skeleton(6)}</div></section>
        <section class="panel"><div class="panel-head"><div><h2>Position calculator</h2><div class="desc">Liquidation price and PnL under this market's margin rules</div></div></div><div class="panel-body" id="calc">${skeleton(5)}</div></section>
      </div>
    </div>`;
  const BOOK_LEVELS = 12;
  let calc = { side: 'long', usd: 1000, lev: 5, entry: null, exit: null };
  const $ = s => el.querySelector(`#${s}`);

  let levels = null; // liquidation bands from contract state, drawn on the candles
  async function load() {
    const [p, s, lv] = await Promise.all([get(`protocol?window=${w}`), get(`protocol/series?window=${w}&market=${id}`), get(`markets/${id}/liq-levels`, { maxAge: 10000 }).catch(() => null)]);
    levels = lv;
    if (!alive) return;
    row = p.markets.find(m => m.id === id) ?? null;
    if (!row) { el.querySelector('.stack').innerHTML = empty('Market not found'); return; }
    $('title').innerHTML = `<span class="mkt" style="gap:10px">${logo(id, row.symbol, 24)}${esc(row.symbol)}<span class="muted" style="font-size:14px;font-weight:400;margin-left:2px">${esc(row.name && row.name !== row.symbol ? row.name : 'Perpetual')}</span></span>`;
    $('subtitle').innerHTML = `Mark <b class="num" style="color:var(--text)">${price(row.mark ?? row.close)}</b> · ${pctCell(row.change_pct)} ${w} · max leverage ${(row.max_leverage ?? risk?.margin?.max_leverage) ? `${row.max_leverage ?? risk.margin.max_leverage}x` : '—'}${row.active === false ? ' · <span class="tag warn" title="Not open for trading; the mark is the last one the contract holds">inactive · last mark</span>' : ''}`;
    $('kpis').innerHTML = [
      kpi({ label: `Volume ${w}`, value: usd(row.volume), note: `${pct(row.share_pct, { digits: 1 })} of exchange` }),
      kpi({ label: 'Open interest', value: usd(row.open_interest), note: row.oi_cap_pct !== undefined && row.oi_cap_pct !== null ? `${pct(row.oi_cap_pct, { digits: 1 })} of cap` : '' }),
      kpi({ label: 'Funding 8h', tip: fundingTip(row.funding?.interval_seconds), value: row.funding ? fundingCell(row.funding, { apr: false }) : '—', note: !row.funding ? '' : num(row.funding.rate_8h_pct) === 0 ? 'flat · no payments this interval' : `${pct(row.funding.apr_pct, { digits: 1, sign: true })} APR · ${row.funding.rate_8h_pct > 0 ? 'longs pay' : 'shorts pay'}` }),
      kpi({ label: 'Traders', value: int(row.traders), note: `${int(row.fills)} trades` }),
      kpi({ label: 'Taker buy share', value: pct(row.taker_buy_share_pct, { digits: 1 }), note: `${usd(row.taker_buy)} bought · ${usd(row.taker_sell)} sold` }),
      kpi({ label: 'Liquidated', value: usd(row.liquidated), note: `${int(row.liquidations)} events` })
    ].join('');
    const pts = s.points.filter(x => x.close !== null);
    $('c-meta').textContent = `${s.meta.bucket} candles from fills · UTC${showLevels && levels?.levels?.length ? ' · bands: where open positions would be liquidated (click one for its largest wallet)' : ''}`;
    const node = $('candles'); node.innerHTML = '';
    // No volume in the window (an inactive market carries its last close): say so instead of a flat line.
    if (!pts.length || !s.points.some(x => num(x.volume) > 0)) node.innerHTML = empty(row.active === false ? 'This market is not open for trading' : 'No trades in this window');
    else {
      let prev = null;
      const ohlc = s.points.map(x => { const c = num(x.close), o = num(x.open) ?? prev ?? c, h = num(x.high) ?? Math.max(o, c), l = num(x.low) ?? Math.min(o, c); prev = c; return c === null ? '-' : [o, c, l, h]; });
      candles(node, { times: s.times, ohlc, volume: s.points.map(x => num(x.volume)), bucketSeconds: s.meta.bucket_seconds, priceFmt: v => price(v).replace(/\.0+$/, ''), volColor: colorOf(id) + '99', zoom: true,
        levels: showLevels ? levels?.levels ?? null : null, mark: num(levels?.mark), onLevel: l => { const t = l.top; if (t) location.hash = `#/wallet/${t.address || t.account_id}`; } });
    }
  }
  // Exact flows from position events: what other dashboards infer from price and open interest.
  async function loadFlow() {
    const f = await get(`markets/${id}/flow?window=${w}`, { maxAge: 5000 });
    if (!alive) return;
    const t = f.totals, node = $('flow'); node.innerHTML = '';
    const netChange = num(t.long_open) - num(t.long_close);
    $('flow-v').innerHTML = `<div class="hv"><span class="${netChange >= 0 ? 'pos' : 'neg'}">${usd(netChange, { sign: true })}</span></div><div class="hn">${usd(num(t.long_open) + num(t.short_open))} opened · ${usd(num(t.long_close) + num(t.short_close))} closed · ${w === 'all' ? 'all-time' : w}</div>`;
    if (!f.times.length || !(num(t.long_open) + num(t.short_open) + num(t.long_close) + num(t.short_close))) { node.innerHTML = empty('No position changes in this window'); return; }
    flowBars(node, { times: f.times, longOpen: f.long_open, longClose: f.long_close, shortOpen: f.short_open, shortClose: f.short_close, bucketSeconds: f.meta.bucket_seconds });
  }
  // Where the open positions were entered, from contract state.
  async function loadEntries() {
    const e = await get(`markets/${id}/entries`, { maxAge: 10000 });
    if (!alive) return;
    const node = $('entries'); node.innerHTML = '';
    const L = e.long, S = e.short;
    $('entries-v').innerHTML = e.positions ? `<div class="hn"><span class="pos">Longs avg ${price(L.average_entry)}</span> · ${pct(L.in_profit_pct, { digits: 0 })} in profit</div><div class="hn"><span class="neg">Shorts avg ${price(S.average_entry)}</span> · ${pct(S.in_profit_pct, { digits: 0 })} in profit</div>` : '';
    if (!e.positions) { node.innerHTML = empty('No open positions'); return; }
    entryProfile(node, { bins: e.bins, mark: num(e.mark), priceFmt: v => price(v) });
  }
  async function loadRisk() {
    const r = await get(`markets/${id}`, { maxAge: 3000 });
    if (!alive) return;
    risk = r.market;
    const L = risk.long, S = risk.short;
    $('positioning').innerHTML = `
      <div class="panel-body" style="padding-top:4px">${ratio(L.count, S.count)}</div>
      <div class="stat-grid">
        <div class="stat"><span>Long positions</span><span class="pos">${int(L.count)}</span></div><div class="stat"><span>Short positions</span><span class="neg">${int(S.count)}</span></div>
        <div class="stat"><span>Long notional</span><span>${usd(L.notional)}</span></div><div class="stat"><span>Short notional</span><span>${usd(S.notional)}</span></div>
        <div class="stat"><span>Long avg lev.</span><span>${L.average_leverage ? L.average_leverage.toFixed(1) + 'x' : '—'}</span></div><div class="stat"><span>Short avg lev.</span><span>${S.average_leverage ? S.average_leverage.toFixed(1) + 'x' : '—'}</span></div>
        <div class="stat"><span>Long uPnL</span><span>${pnl(num(L.delta_pnl) + num(L.premium_pnl))}</span></div><div class="stat"><span>Short uPnL</span><span>${pnl(num(S.delta_pnl) + num(S.premium_pnl))}</span></div>
        <div class="stat"><span>Liquidatable now</span><span>${int(risk.positions.liquidatable)}</span></div><div class="stat"><span>Insurance fund</span><span>${usd(risk.insurance.balance)}</span></div>
        <div class="stat"><span>Largest position</span><span>${usd(risk.concentration?.largest?.notional)}</span></div><div class="stat"><span>Top 5 share</span><span>${pct(risk.concentration?.top5_pct, { digits: 1 })}</span></div>
      </div>${costTable(risk.liquidity)}`;
    renderPositions(risk.top_positions ?? []);
    if (!$('calc')?.contains(document.activeElement)) renderCalc(); // not while someone types in it
    const ladder = risk.ladder ?? [];
    const lnode = $('ladder'); lnode.innerHTML = '';
    if (ladder.length && (L.count + S.count) > 0) mirrored(lnode, { labels: ladder.map(x => `${x.shock_pct}%`), long: ladder.map(x => num(x.long.notional)), short: ladder.map(x => num(x.short.notional)) });
    else lnode.innerHTML = empty('No open positions');
  }
  // The largest open positions by notional; each row opens the wallet.
  function renderPositions(rows) {
    const shown = rows.slice(0, 15);
    $('pos-meta').textContent = rows.length ? `Top ${shown.length} by notional` : '';
    $('positions').innerHTML = table({ id: 'pos', compact: true, emptyText: 'No open positions', columns: [
      { key: 'a', label: 'Account', render: r => addr(r.address, r.account_id) },
      { key: 's', label: 'Side', render: r => sideTag(r.side) },
      { key: 'n', label: 'Notional', n: true, render: r => usd(r.notional) },
      { key: 'e', label: 'Entry', n: true, render: r => price(r.entry_price) },
      { key: 'l', label: 'Leverage', n: true, render: r => (r.leverage ? `${Number(r.leverage).toFixed(1)}x` : '—') },
      { key: 'u', label: 'uPnL', n: true, render: r => pnl(r.pnl) },
      { key: 'q', label: 'Liq. price', n: true, render: r => price(r.liquidation_price) },
      { key: 'd', label: 'To liq.', n: true, render: r => (r.liquidation_distance_pct === null ? '—' : `<span class="${r.liquidation_distance_pct < 5 ? 'neg' : r.liquidation_distance_pct < 15 ? 'warn-text' : 'muted'}">${pct(r.liquidation_distance_pct, { digits: 1 })}</span>`) }
    ], rows: shown, rowAttrs: r => `class="link" data-href="#/wallet/${esc(r.address || r.account_id)}"` });
  }
  // Order book: asks above, bids below, each level with its cumulative depth
  // from the touch; the bar width is that depth against the deeper side.
  async function loadBook() {
    // A delisted market has no book to read.
    if (row?.active === false) { $('book').innerHTML = empty('No order book: this market is not open for trading'); $('book-meta').textContent = ''; return; }
    const b = await get(`markets/${id}/book`, { maxAge: 10000 }).catch(error => ({ error }));
    if (!alive) return;
    const node = $('book');
    if (b.error || (!b.bids?.length && !b.asks?.length)) { node.innerHTML = empty(b.error?.status === 404 ? 'No order book for this market' : 'Order book unavailable'); $('book-meta').textContent = ''; return; }
    const cum = side => { let run = 0; return side.slice(0, BOOK_LEVELS).map(l => ({ ...l, cum: (run += num(l.notional) || 0) })); };
    const asks = cum(b.asks), bids = cum(b.bids);
    const max = Math.max(asks.at(-1)?.cum ?? 0, bids.at(-1)?.cum ?? 0) || 1;
    const line = (l, side) => `<div class="book-row ${side}"><i style="width:${(l.cum / max * 100).toFixed(1)}%"></i><span class="num">${price(l.price)}</span><span class="num">${size(l.size)}</span><span class="num muted">${usd(l.cum)}</span></div>`;
    const L = b.liquidity ?? {};
    const spread = L.spread_bps === null || L.spread_bps === undefined ? '—' : `${L.spread_bps.toFixed(L.spread_bps < 1 ? 2 : 1)} bps`;
    // The book's own midpoint; the mark follows the oracle and can sit outside the touch.
    const bestBid = num(L.best_bid ?? b.bids[0]?.price), bestAsk = num(L.best_ask ?? b.asks[0]?.price);
    const mid = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : null;
    node.innerHTML = `<div class="book"><div class="book-row head"><span>Price</span><span>Size</span><span>Total</span></div>
      ${asks.slice().reverse().map(l => line(l, 'ask')).join('')}
      <div class="book-mid"><span class="num">${mid ? price(mid) : price(b.mark)}</span><span class="faint">${mid ? 'mid' : 'mark'} · spread ${spread}${mid ? ` · mark ${price(b.mark)}` : ''}</span></div>
      ${bids.map(l => line(l, 'bid')).join('')}</div>`;
    $('book-meta').textContent = b.stale ? 'stale read' : L.age_blocks !== null && L.age_blocks !== undefined ? `read ${int(L.age_blocks)} blocks ago` : '';
  }

  // Position calculator. Perpl liquidates a position when its equity falls to
  // the maintenance margin of its notional at the mark; with the deposit at
  // entry notional / leverage and no fees or funding, that price is
  //   long:  E·(1 − 1/L) / (1 − m)      short: E·(1 + 1/L) / (1 + m)
  function renderCalc() {
    const node = $('calc'); if (!node || !risk) return;
    const m = (risk.margin?.maintenance_margin_pct ?? 0) / 100, maxLev = risk.margin?.max_leverage ?? 1;
    const mark = num(risk.prices?.mark ?? row?.mark ?? row?.close);
    if (!mark) { node.innerHTML = empty('No price for this market'); return; }
    if (calc.entry === null) calc.entry = mark;
    if (calc.exit === null) calc.exit = mark * (calc.side === 'long' ? 1.05 : 0.95);
    calc.lev = Math.min(Math.max(1, calc.lev), maxLev);
    const E = calc.entry, L = calc.lev, qty = calc.usd / E, margin = calc.usd / L, long = calc.side === 'long';
    const liq = long ? E * (1 - 1 / L) / (1 - m) : E * (1 + 1 / L) / (1 + m);
    const dist = (long ? (mark - liq) / mark : (liq - mark) / mark) * 100;
    const pnlAtExit = (long ? calc.exit - E : E - calc.exit) * qty;
    const field = (k, label, value, step, extra = '') => `<label class="calc-f"><span>${label}</span><input class="calc-in num" data-k="${k}" type="number" step="${step}" value="${value}" ${extra}></label>`;
    node.innerHTML = `<div class="calc">
      <div class="calc-top">${`<div class="seg sm" role="group"><button data-action="calc-side" data-v="long" class="${long ? 'on' : ''}">Long</button><button data-action="calc-side" data-v="short" class="${long ? '' : 'on'}">Short</button></div>`}
        <span class="faint">Max ${maxLev}x · maintenance margin ${pct(m * 100, { digits: 2 })}</span></div>
      <div class="calc-grid">
        ${field('usd', 'Size (USD)', calc.usd, 100, 'min="1"')}
        ${field('lev', `Leverage (1–${maxLev}x)`, calc.lev, 1, `min="1" max="${maxLev}"`)}
        ${field('entry', 'Entry price', +E.toPrecision(8), 'any', 'min="0"')}
        ${field('exit', 'Exit price', +calc.exit.toPrecision(8), 'any', 'min="0"')}
      </div>
      <div class="stat-grid calc-out">
        <div class="stat"><span>Margin</span><span>${usd(margin)}</span></div>
        <div class="stat"><span>Quantity</span><span>${size(qty)}</span></div>
        <div class="stat"><span>Liquidation price</span><span class="${dist < 5 ? 'neg' : dist < 15 ? 'warn-text' : ''}">${liq > 0 ? price(liq) : '—'}</span></div>
        <div class="stat"><span>From mark</span><span>${liq > 0 ? `${pct(dist, { digits: 1 })} ${long ? 'down' : 'up'}` : '—'}</span></div>
        <div class="stat"><span>PnL at exit</span><span>${pnl(pnlAtExit)}</span></div>
        <div class="stat"><span>Return on margin</span><span class="${pnlAtExit >= 0 ? 'pos' : 'neg'}">${pct(pnlAtExit / margin * 100, { digits: 1, sign: true })}</span></div>
      </div>
      <div class="faint calc-note">An estimate before fees and funding. Live positions carry their own deposit, so their liquidation prices (above) differ slightly.</div></div>`;
  }
  // The view container outlives this page: the listener is removed in destroy().
  const onCalcChange = e => {
    const k = e.target.closest?.('.calc-in')?.dataset.k; if (!k) return;
    const v = Number(e.target.value); if (!Number.isFinite(v) || v <= 0) return;
    calc[k] = v; renderCalc();
  };
  el.addEventListener('change', onCalcChange);

  // What a market order costs against the on-chain book, from the mid.
  function costTable(L) {
    const rows = L?.cost_to_trade ?? [];
    if (!rows.length) return '';
    const fmt = v => `${v.toFixed(Math.abs(v) < 1 ? 2 : 1)} bps`;
    const bps = (v, filled) => (v === null ? `<span class="faint" title="The book read holds ${usd(filled)} on this side">&gt; book</span>` : fmt(v));
    return `<div class="panel-head" style="min-height:0;padding-top:14px"><h2 style="font-size:12.5px;color:var(--text-2);font-weight:500">Cost of a market order</h2><span class="meta">vs mid · spread ${L.spread_bps === null || L.spread_bps === undefined ? '—' : fmt(L.spread_bps)}</span></div>
      ${table({ id: 'cost', compact: true, columns: [
        { key: 's', label: 'Size', render: r => `$${r.usd >= 1000 ? `${r.usd / 1000}K` : r.usd}` },
        { key: 'b', label: 'Buy', n: true, render: r => bps(r.buy_bps, r.buy_filled_usd) },
        { key: 'x', label: 'Sell', n: true, render: r => bps(r.sell_bps, r.sell_filled_usd) }
      ], rows })}`;
  }
  async function loadFunding() {
    const f = await get(`markets/${id}/funding?limit=500`, { maxAge: 30000 });
    if (!alive) return;
    // Last seven days of funding events (one per interval), signed.
    const cutoff = Date.now() / 1000 - 7 * 86400;
    const rows = (f.history ?? []).filter(r => r.ts >= cutoff).slice().reverse();
    const node = $('funding'); node.innerHTML = '';
    $('f-meta').textContent = row?.active === false ? 'Last 7 days · not open for trading' : f.current ? `Last 7 days · now ${num(f.current.rate_per_interval_pct) === 0 ? '0%' : pct(f.current.rate_per_interval_pct, { digits: 4, sign: true })} per ${f.current.interval_blocks ? `${int(f.current.interval_blocks)} blocks (${duration(f.current.interval_seconds)})` : duration(f.current.interval_seconds)} · next in ${duration(f.current.seconds_to_next)}` : 'Last 7 days';
    if (rows.length) signedBars(node, { times: rows.map(r => r.ts), values: rows.map(r => r.rate_pct), bucketSeconds: 3600, dayTicks: true, name: 'Funding rate', fmt: v => pct(v, { digits: 4, sign: true }), yFmt: v => `${Number(v).toFixed(3)}%` });
    else node.innerHTML = empty(row?.active === false ? 'No funding: this market is not open for trading' : 'No funding events in the last 7 days');
  }
  async function loadFeeds() {
    const [t, lb] = await Promise.all([get(`trades?market=${id}&limit=60`, { maxAge: 1000 }), get(`leaderboard?window=${w}&market=${id}&limit=10`)]);
    if (!alive) return;
    renderTrades(t.rows);
    $('lb-meta').textContent = `By net PnL · ${w}`;
    $('lb').innerHTML = table({ id: 'lb', compact: true, columns: [
      { key: 'r', label: '#', render: r => `<span class="rank">${r.rank}</span>` },
      { key: 'a', label: 'Trader', render: r => addr(r.address, r.account) },
      { key: 'p', label: 'Net PnL', n: true, render: r => pnl(r.pnl) },
      { key: 'v', label: 'Volume', n: true, render: r => usd(r.volume) }
    ], rows: lb.rows, rowAttrs: r => `class="link" data-href="#/wallet/${esc(r.address || r.account)}"` });
  }
  let tape = [];
  function renderTrades(rows) {
    tape = rows;
    $('trades').innerHTML = table({ id: 't', compact: true, columns: [
      { key: 't', label: 'Time', render: r => `<span class="muted num">${timeOnly(r.ts)}</span>` },
      { key: 's', label: 'Action', render: tradeAction },
      { key: 'p', label: 'Price', n: true, render: r => price(r.price) },
      { key: 'v', label: 'Notional', n: true, render: r => usd(r.notional) },
      { key: 'a', label: 'Trader', render: r => addr(r.address, r.account, { star: false }) }
    ], rows: tape.slice(0, 60), rowAttrs: r => `class="${r.fresh ? 'flash' : ''}"` });
  }
  const off = stream.on('trades', rows => { const mine = rows.filter(r => r.market === id); if (!mine.length) return; tape = [...mine.reverse().map(r => ({ ...r, fresh: true })), ...tape].slice(0, 60); renderTrades(tape); tape.forEach(r => { r.fresh = false; }); });
  const timer = setInterval(() => { loadRisk().catch(() => {}); loadBook().catch(() => {}); loadEntries().catch(() => {}); if (w === '24h') { load().catch(() => {}); loadFlow().catch(() => {}); } }, 20000);
  loadFlow().catch(() => { $('flow').innerHTML = empty('Unavailable'); });
  loadEntries().catch(() => { $('entries').innerHTML = empty('Unavailable'); });
  // The book and funding panels need the market row (active or not) first.
  const ready = load();
  ready.then(() => loadBook()).catch(error => { $('kpis').innerHTML = `<div class="empty-state">${esc(error.message)}</div>`; });
  loadRisk().catch(() => { $('positioning').innerHTML = empty('Live positions unavailable'); $('ladder').innerHTML = empty('Unavailable'); });
  ready.catch(() => {}).then(() => loadFunding()).catch(() => { $('funding').innerHTML = empty('Unavailable'); });
  loadFeeds().catch(() => {});
  return {
    onSeg(name, v) { if (name === 'lvl') { showLevels = v === 'on'; $('lvl-toggle').innerHTML = seg('lvl', LEVEL_TOGGLE, v).replace('class="seg"', 'class="seg sm"'); load().catch(() => {}); return; } if (name === 'window') setQuery({ window: v === '24h' ? null : v }); },
    onAction(a, t) { if (a === 'calc-side') { calc.side = t.dataset.v; calc.exit = null; renderCalc(); } },
    update(q) { w = WINDOWS.some(([v]) => v === q.get('window')) ? q.get('window') : '24h'; $('win').innerHTML = seg('window', WINDOWS, w); load().catch(() => {}); loadFeeds().catch(() => {}); loadFlow().catch(() => {}); },
    destroy() { alive = false; el.removeEventListener('change', onCalcChange); off(); clearInterval(timer); }
  };
}
export { dateTime, sideTag };
