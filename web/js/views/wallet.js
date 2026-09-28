// Wallet profile: portfolio and open positions (live contract state), PnL
// history, trader analytics (win rate, profit factor, drawdown, streaks,
// hold time, best/worst markets), behaviour notes, trades, round trips, flows.
import { get, stream } from '../api.js';
import { usd, usdFull, int, price, pct, num, esc, size, duration, date, dateTime, ago, short, signClass } from '../format.js';
import { kpi, tabs, table, mktLink, sideTag, pnl, pctCell, bpsCell, skeleton, skChart, empty, watch, ICON, EXPLORER, toast, chartTools, alertsLink, alertsBotReady } from '../ui.js';
import { lineChart, signedBars, COLORS } from '../charts.js';

const twinLink = rows => { const ids = {}; for (const r of rows) (ids[r.symbol] ??= new Set()).add(r.market); return r => `${mktLink(r.market, r.symbol)}${ids[r.symbol]?.size > 1 ? ` <span class="faint" title="Relisted market: the same asset under a new market id">#${esc(r.market)}</span>` : ''}`; };
const TABS = [['overview', 'Overview'], ['positions', 'Positions'], ['trades', 'Trade history'], ['trips', 'Round trips'], ['flows', 'Deposits & withdrawals']];
const KIND = { open: 'Open', increase: 'Add', decrease: 'Reduce', close: 'Close', invert: 'Flip', liquidation: 'Liquidated', deleverage: 'ADL', unwind: 'Unwind' };
// "Aug 30 → Sep 6, 2026": the year once when both ends share it, so the range fits a KPI note.
const dateSpan = (a, b) => { const x = date(a), y = date(b); return `${x.slice(-4) === y.slice(-4) ? x.slice(0, -6) : x} → ${y}`; };

export function mount(el, { params, query, setQuery, navigate }) {
  const key = params[0];
  let tab = TABS.some(([v]) => v === query.get('tab')) ? query.get('tab') : 'overview';
  let pnlMode = 'cumulative', data = null, an = null, periods = null, alive = true, trades = [], next = null;
  el.innerHTML = `<div class="stack"><section class="panel"><div class="panel-body" style="padding-top:16px">${skeleton(3)}</div></section><div class="kpis k7">${Array.from({ length: 7 }, () => '<div class="kpi"><div class="skeleton sk-line"></div></div>').join('')}</div>${skChart()}</div>`;
  const $ = s => el.querySelector(`#${s}`);

  // The bot's name comes with /health; the button appears once it is known.
  const alertsButton = address => (alertsLink(address) ? `<a class="btn ghost" data-alerts href="${esc(alertsLink(address))}" target="_blank" rel="noopener noreferrer" title="Position changes and near-liquidation warnings in Telegram">${ICON.bell} Alerts</a>` : '');
  alertsBotReady.then(() => { const box = el.querySelector('.wallet-actions'); if (alive && data && box && !box.querySelector('[data-alerts]')) box.querySelector('[data-action="watch"]')?.insertAdjacentHTML('beforebegin', alertsButton(data.account.address)); });
  function head(d) {
    const a = d.account, starred = watch.has(a.address);
    const since = d.summary.first_trade ? `first trade ${date(d.summary.first_trade)} · ${int(d.summary.active_days)} active days · last ${ago(d.summary.last_trade)}` : 'no trades indexed yet';
    return `<div class="page-head"><div class="wallet-head">
        <div class="wallet-id"><div class="sub"><a href="#/traders">Traders</a> / Wallet</div><div class="big"><span class="addr-full">${esc(a.address)}</span><span class="addr-short">${esc(short(a.address))}</span></div>
          <div class="sub">Account #${esc(a.id)} · ${esc(since)}</div></div></div>
        <div class="wallet-actions">
          <button class="btn ghost" data-copy="${esc(a.address)}">${ICON.copy} Copy</button>
          <a class="btn ghost" href="${EXPLORER}/address/${esc(a.address)}" target="_blank" rel="noopener noreferrer">${ICON.ext} Explorer</a>
          <button class="btn ghost" data-action="compare">${ICON.plus} Compare</button>
          <button class="btn ghost" data-action="share" title="Download a summary card (PNG)">${ICON.image} Share</button>
          ${alertsButton(a.address)}
          <button class="btn ${starred ? '' : 'primary'}" data-action="watch">${starred ? ICON.star + ' Watching' : ICON.starOff + ' Watch'}</button>
        </div></div>`;
  }
  function kpis(d) {
    const p = d.portfolio, perf = an?.performance, s = d.summary;
    const wait = '<span class="skeleton" style="display:inline-block;width:72px;height:22px;vertical-align:middle"></span>';
    return `<div class="kpis k7">${[
      kpi({ label: 'Account value', value: usd(p?.account_value), note: p ? `${int(p.positions)} open · ${p.leverage ?? 0}x lev.` : 'live state unavailable', tip: 'Live balance, including funds locked by orders, plus open positions\' margin and unrealized PnL.' }),
      kpi({ label: 'Unrealized PnL', value: pnl(p?.unrealized_pnl), note: p?.closest_liquidation ? `closest liq. ${pct(p.closest_liquidation.distance_pct, { digits: 1 })} away` : '' }),
      kpi({ label: 'Net PnL', value: pnl(s.net_pnl), note: `after ${usd(s.fees)} fees`, tip: `All-time realized PnL with funding (${usd(s.realized, { sign: true })}), minus fees (${usd(s.fees)}).` }),
      kpi({ label: 'Win rate', value: !perf ? wait : perf.win_rate_pct === null ? '—' : pct(perf.win_rate_pct, { digits: 1 }), note: perf ? `${int(perf.wins)}W · ${int(perf.losses)}L of ${int(perf.closed_trips)} trips` : 'analysing round trips…' }),
      kpi({ label: 'Profit factor', value: !perf ? wait : perf.profit_factor === null ? '—' : perf.profit_factor.toFixed(2), note: perf ? `avg win ${usd(perf.average_win)} · loss ${usd(perf.average_loss)}` : '' }),
      kpi({ label: 'Volume', value: usd(s.volume), note: `${int(s.trades)} trades · ${pct(s.maker_share_pct, { digits: 0 })} maker` }),
      kpi({ label: 'Max drawdown', value: !perf ? wait : `<span class="${num(perf.max_drawdown) > 0 ? 'neg' : ''}">${usd(perf.max_drawdown)}</span>`, note: perf?.drawdown_to ? dateSpan(perf.drawdown_from, perf.drawdown_to) : 'on closed round trips' })
    ].join('')}</div>`;
  }
  const POS_COLS = [
    { key: 'm', label: 'Market', render: r => mktLink(r.market, r.symbol) },
    { key: 's', label: 'Side', render: r => sideTag(r.side) },
    { key: 'size', label: 'Size', n: true, render: r => size(r.size) },
    { key: 'notional', label: 'Notional', n: true, render: r => usd(r.notional) },
    { key: 'entry', label: 'Entry', n: true, render: r => price(r.entry_price) },
    { key: 'mark', label: 'Mark', n: true, render: r => price(r.mark) },
    { key: 'lev', label: 'Leverage', n: true, render: r => (r.leverage ? `${Number(r.leverage).toFixed(1)}x` : '—') },
    { key: 'upnl', label: 'uPnL', n: true, render: r => pnl(r.pnl) },
    { key: 'liq', label: 'Liq. price', n: true, render: r => (num(r.liquidation_price) > 0 ? price(r.liquidation_price) : '<span class="faint" title="No liquidation price: the margin covers any price move">none</span>') },
    { key: 'dist', label: 'Distance', n: true, render: r => (r.liquidation_distance_pct === null || !(num(r.liquidation_price) > 0) ? '<span class="faint">—</span>' : `<span class="${r.liquidation_distance_pct < 5 ? 'neg' : r.liquidation_distance_pct < 15 ? '' : 'muted'}">${pct(r.liquidation_distance_pct, { digits: 1 })}</span>`) },
    { key: 'margin', label: 'Margin', n: true, render: r => usd(r.deposit) }
  ];
  const TRADE_COLS = [
    { key: 'ts', label: 'Time (UTC)', render: r => `<span class="muted num">${dateTime(r.ts)}</span>` },
    { key: 'm', label: 'Market', render: r => mktLink(r.market, r.symbol) },
    { key: 'k', label: 'Action', render: r => `${esc(KIND[r.kind] ?? r.kind)} ${sideTag(r.side)}` },
    { key: 'role', label: 'Role', render: r => `<span class="muted">${esc(r.role === 'none' ? '—' : r.role)}</span>` },
    { key: 'p', label: 'Price', n: true, render: r => price(r.price) },
    { key: 'sz', label: 'Size', n: true, render: r => size(r.size) },
    { key: 'n', label: 'Notional', n: true, render: r => usd(r.notional) },
    { key: 'pnl', label: 'Realized', n: true, render: r => (['decrease', 'close', 'invert', 'liquidation', 'deleverage'].includes(r.kind) ? pnl(r.pnl) : '<span class="faint">—</span>') },
    { key: 'fee', label: 'Fee', n: true, render: r => (num(r.fee) ? usd(r.fee) : '<span class="faint">0</span>') },
    { key: 'tx', label: 'Tx', render: r => `<a class="faint mono" href="${EXPLORER}/tx/${esc(r.tx)}" target="_blank" rel="noopener noreferrer">${esc(r.tx.slice(0, 8))}…</a>` }
  ];

  function perfPanel(perf, s) {
    const stat = (a, b) => `<div class="stat"><span>${a}</span><span>${b}</span></div>`;
    return `<div class="stat-grid">
      ${stat('Closed round trips', int(perf.closed_trips))}${stat('Expectancy / trip', pnl(perf.expectancy))}
      ${stat('Largest win', pnl(perf.largest_win))}${stat('Largest loss', pnl(perf.largest_loss))}
      ${stat('Best streak', `${int(perf.best_streak)} ${perf.best_streak === 1 ? 'win' : 'wins'}`)}${stat('Worst streak', `${int(perf.worst_streak)} ${perf.worst_streak === 1 ? 'loss' : 'losses'}`)}
      ${stat('Median hold', duration(perf.median_hold_seconds))}${stat('Average hold', duration(perf.average_hold_seconds))}
      ${stat('Winners held', duration(perf.median_win_hold_seconds))}${stat('Losers held', duration(perf.median_loss_hold_seconds))}
      ${stat('Long trips', `${int(perf.long.trips)} · ${perf.long.win_rate_pct === null ? '—' : pct(perf.long.win_rate_pct, { digits: 0 })} win`)}${stat('Short trips', `${int(perf.short.trips)} · ${perf.short.win_rate_pct === null ? '—' : pct(perf.short.win_rate_pct, { digits: 0 })} win`)}
      ${stat('Long net PnL', pnl(perf.long.net_pnl))}${stat('Short net PnL', pnl(perf.short.net_pnl))}
      ${stat('Best market', perf.best_market ? `${esc(perf.best_market.symbol)} · ${pnl(perf.best_market.net_pnl)}` : '—')}${stat(num(perf.worst_market?.net_pnl) > 0 ? 'Weakest market' : 'Worst market', perf.worst_market ? `${esc(perf.worst_market.symbol)} · ${pnl(perf.worst_market.net_pnl)}` : '—')}
      ${stat('Funding (net)', pnl(s.funding))}${stat('Liquidated trips', int(perf.liquidated_trips))}
    </div>${perf.based_on.truncated ? `<div class="panel-foot"><span>Round-trip analytics use the latest ${int(perf.based_on.events)} of ${int(perf.based_on.total_events)} events (since ${date(perf.based_on.since)}); totals use full history.</span></div>` : ''}`;
  }
  function heatmap(grid) {
    const max = Math.max(1, ...grid.flat());
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return `<div class="panel-body"><div class="heat">${grid.map((row, d) => `<span>${days[d]}</span>${row.map((c, h) => `<i title="${days[d]} ${String(h).padStart(2, '0')}:00 UTC · ${c} trades" style="background:rgba(162,164,255,${c ? 0.12 + 0.88 * c / max : 0.04})"></i>`).join('')}`).join('')}<span></span>${Array.from({ length: 24 }, (_, h) => `<span style="text-align:center">${h % 6 === 0 ? h : ''}</span>`).join('')}</div></div>`;
  }

  // The tabs sit on the page and each tab lays out its own cards, so no card
  // is drawn inside another.
  function render() {
    const d = data;
    el.innerHTML = `${head(d)}<div class="stack wallet-page"><div id="kpi-row">${kpis(d)}</div>
      <div class="wallet-tabs">${tabs('tab', TABS, tab)}</div><div class="stack" id="tab-body"></div></div>`;
    showTab();
    renderTab();
  }
  // Marks the open tab and, where the strip scrolls sideways (phones), brings
  // it into view without moving the page.
  function showTab() {
    const strip = el.querySelector('.wallet-tabs .tabs'); if (!strip) return;
    strip.querySelectorAll('[data-tab="tab"]').forEach(b => b.classList.toggle('on', b.dataset.v === tab));
    const s = strip.getBoundingClientRect(), b = strip.querySelector('.on').getBoundingClientRect();
    strip.scrollLeft += Math.max(0, b.right - s.right) - Math.max(0, s.left - b.left);
  }
  const perfSkeleton = () => `<div class="panel-body">${Array.from({ length: 7 }, () => '<div class="skeleton sk-line"></div>').join('')}</div>`;
  function marketRows(d) {
    const perf = new Map((an?.performance.markets ?? []).map(x => [x.market, x]));
    return d.markets.map(m => ({ ...m, trips: perf.get(m.market)?.trips ?? null, win_rate_pct: perf.get(m.market)?.win_rate_pct ?? null }));
  }
  function renderTab() {
    const d = data, body = $('tab-body');
    const block = int(d.portfolio?.block ?? d.meta.block);
    if (tab === 'overview') {
      body.innerHTML = `
        ${d.positions.length ? `<section class="panel"><div class="panel-head"><h2>Open positions</h2><span class="meta">Contract state at block ${block}</span></div><div class="panel-body flush">${table({ id: 'pos', columns: POS_COLS, rows: d.positions })}</div></section>` : ''}
        <section class="panel"><div class="panel-head"><h2>By period</h2><span class="meta">Rolling windows · rank among every account that traded in the window</span></div>
          <div class="panel-body flush" id="periods">${periods ? periodsTable() : skeleton(4)}</div></section>
        <div class="grid g-main">
          <section class="panel trend pnl-card"><div class="panel-head"><div class="trend-id"><h2>Net PnL <span class="info-tip" title="Realized PnL with funding, minus fees, per UTC day. Open positions count once reduced or closed.">i</span></h2><div class="head-value" id="pnl-v"></div></div>
            <div class="trend-side"><div class="trend-ctl">${chartTools('pnl-chart', `wallet-${d.account.id}-pnl`)}<div class="seg sm"><button data-action="pnl-cum" class="${pnlMode === 'cumulative' ? 'on' : ''}">Cumulative</button><button data-action="pnl-daily" class="${pnlMode === 'daily' ? 'on' : ''}">Daily</button><button data-action="pnl-cal" class="${pnlMode === 'calendar' ? 'on' : ''}">Calendar</button></div></div><div class="legend dots" id="pnl-lg"></div></div></div>
            <div class="panel-body"><div class="chart" id="pnl-chart"></div></div></section>
          <section class="panel"><div class="panel-head"><h2>Performance</h2><span class="meta">Closed round trips, net of fees</span></div><div id="perf">${an ? perfPanel(an.performance, d.summary) : perfSkeleton()}</div></section>
        </div>
        <div class="grid g-2">
          <section class="panel"><div class="panel-head"><h2>Behaviour</h2><span class="meta">Rule-based, from this wallet's trades</span></div>
            <div id="insights">${an ? insightsHtml() : perfSkeleton()}</div></section>
          <section class="panel"><div class="panel-head"><h2>By market</h2><span class="meta" title="Volume and net PnL are all-time; win rate and trips count closed round trips only">Volume, PnL all-time · win rate, trips from analysed trips</span></div><div class="panel-body flush">${table({ id: 'mk', compact: true, columns: [
            { key: 'm', label: 'Market', render: twinLink(d.markets) },
            { key: 'v', label: 'Volume', n: true, render: r => usd(r.volume) },
            { key: 'p', label: 'Net PnL', n: true, render: r => pnl(r.net_pnl) },
            { key: 'w', label: 'Win rate', n: true, render: r => (r.win_rate_pct === null ? '—' : pct(r.win_rate_pct, { digits: 0 })) },
            { key: 't', label: 'Trips', n: true, render: r => (r.trips === null ? '—' : int(r.trips)) }
          ], rows: marketRows(d), emptyText: 'No trades' })}</div></section>
        </div>`;
      drawPnl();
    } else if (tab === 'positions') {
      const p = d.portfolio;
      body.innerHTML = `${p ? `<section class="panel"><div class="panel-head"><h2>Account</h2><span class="meta">Contract state at block ${block}</span></div><div class="stat-grid acct-grid">
          <div class="stat"><span>Balance</span><span>${usdFull(p.balance)}</span></div><div class="stat"><span>Available</span><span>${usdFull(p.available_balance ?? p.balance)}</span></div><div class="stat"><span>Locked by orders</span><span>${usdFull(p.locked_balance)}</span></div>
          <div class="stat"><span>Position margin</span><span>${usdFull(p.position_margin)}</span></div><div class="stat"><span>Account value</span><span>${usdFull(p.account_value)}</span></div>
          <div class="stat"><span>Margin usage</span><span>${pct(p.margin_usage_pct, { digits: 1 })}</span></div><div class="stat"><span>Effective leverage</span><span>${p.leverage ?? 0}x</span></div>
          <div class="stat"><span>Unrealized PnL</span><span class="${signClass(p.unrealized_pnl)}">${num(p.unrealized_pnl) > 0 ? '+' : ''}${usdFull(p.unrealized_pnl)}</span></div>
        </div></section>` : ''}<section class="panel"><div class="panel-head"><h2>Open positions</h2><span class="meta">${int(d.positions.length)} open</span></div><div class="panel-body flush">${table({ id: 'pos', columns: POS_COLS, rows: d.positions, emptyText: 'No open positions' })}</div></section>`;
    } else if (tab === 'trades') {
      body.innerHTML = `<section class="panel"><div class="panel-head"><div><h2>Trade history</h2><div class="desc">Newest first · every position change with its fill</div></div><a class="btn ghost" href="/api/v1/wallets/${esc(d.account.address)}/trades?format=csv&limit=10000">${ICON.download} CSV</a></div><div class="panel-body flush" id="trade-list">${skeleton(8)}</div><div class="panel-foot"><span id="trade-count"></span><button class="btn ghost" data-action="more" id="more">Load more</button></div></section>`;
      if (trades.length) renderTrades(); else loadTrades();
    } else if (tab === 'trips') {
      if (!an) { body.innerHTML = `<section class="panel">${perfSkeleton()}</section>`; return; }
      const tripRows = [...an.open_trips.map(t => ({ ...t, open: true })), ...an.trips];
      // The list holds the latest closed trips only; the totals above count them all.
      const closedAll = an.performance?.closed_trips ?? an.trips.length, capped = an.trips.length < closedAll;
      body.innerHTML = `<section class="panel"><div class="panel-head"><div><h2>Round trips</h2><div class="desc">Open trips first, then ${capped ? `the latest ${int(an.trips.length)} of ${int(closedAll)} closed trips` : 'closed trips'}, newest close first</div></div></div>` + table({ id: 'trips', columns: [
        { key: 'm', label: 'Market', render: twinLink(tripRows) },
        { key: 's', label: 'Side', render: r => sideTag(r.side) },
        { key: 'c', label: 'Closed', render: r => (r.open ? '<span class="faint">open</span>' : `<span class="muted num">${dateTime(r.close_ts)}</span>`) },
        { key: 'o', label: 'Opened', render: r => `<span class="muted num">${r.open_ts ? dateTime(r.open_ts) : `before ${dateTime(r.first_ts)}`}</span>` },
        { key: 'h', label: 'Held', n: true, render: r => duration(r.hold_seconds) },
        { key: 'sz', label: 'Max size', n: true, render: r => size(r.max_size) },
        { key: 'e', label: 'Entry notional', n: true, render: r => usd(r.entry_notional) },
        { key: 'lev', label: 'Max lev.', n: true, render: r => (r.max_leverage ? `${r.max_leverage.toFixed(1)}x` : '—') },
        { key: 'p', label: 'Net PnL', n: true, render: r => pnl(r.net_pnl) },
        { key: 'r', label: 'Return', n: true, render: r => pctCell(r.return_pct) },
        { key: 'f', label: 'Outcome', render: r => (r.open ? '<span class="tag" title="Still open: Net PnL counts only what is realized so far, after fees">open</span>' : r.liquidated ? '<span class="tag bad">liquidated</span>' : r.deleveraged ? '<span class="tag warn">ADL</span>' : num(r.net_pnl) > 0 ? '<span class="tag good">win</span>' : num(r.net_pnl) < 0 ? '<span class="tag">loss</span>' : '<span class="tag">flat</span>') }
      ], rows: tripRows, rowAttrs: r => (r.open ? 'title="Still open"' : ''), emptyText: 'No round trips yet' }) + '</section>';
    } else if (tab === 'flows') {
      body.innerHTML = `<section class="panel"><div class="panel-head"><h2>Deposits and withdrawals</h2><span class="meta">Newest first</span></div><div class="stat-grid" style="border-bottom:1px solid var(--line)"><div class="stat"><span>Total deposits</span><span class="pos">${usdFull(d.summary.deposits)}</span></div><div class="stat"><span>Total withdrawals</span><span class="neg">${usdFull(d.summary.withdrawals)}</span></div></div>` + table({ id: 'flows', columns: [
        { key: 't', label: 'Time (UTC)', render: r => `<span class="muted num">${dateTime(r.ts)}</span>` },
        { key: 'k', label: 'Type', render: r => `<span class="${r.kind === 'deposit' ? 'pos' : 'neg'}">${r.kind === 'deposit' ? 'Deposit' : 'Withdrawal'}</span>` },
        { key: 'a', label: 'Amount', n: true, render: r => usdFull(r.amount) },
        { key: 'b', label: 'Balance after', n: true, render: r => usdFull(r.balance_after) },
        { key: 'tx', label: 'Tx', render: r => `<a class="faint mono" href="${EXPLORER}/tx/${esc(r.tx)}" target="_blank" rel="noopener noreferrer">${esc(r.tx.slice(0, 10))}…</a>` }
      ], rows: d.flows, emptyText: 'No deposits or withdrawals indexed' }) + '</section>';
    }
  }
  // Daily net PnL as a calendar (weeks × weekdays, UTC), green and red by
  // size relative to the largest day; the last weeks with activity, as many
  // as fit the card at 16px cells (up to 26), so a phone shows the latest
  // weeks unscrolled. The cells then grow into the rest of the card (up to
  // 32px), so a short history does not sit small in a large card.
  // w, h: the room for the cells. Returns the grid and its green and red day
  // counts (for the header).
  function pnlCalendar(rows, w, h) {
    const weeks = Math.max(8, Math.min(26, Math.floor(w / 19))); // 16px cells, 3px gaps
    const byDay = new Map(rows.map(r => [Math.floor(r.t / 86400), r]));
    const lastDay = Math.floor(rows.at(-1).t / 86400);
    const end = lastDay + (6 - ((lastDay + 3) % 7)); // Sunday closing the last week (day 0 was a Thursday)
    const start = Math.max(end - weeks * 7 + 1, Math.floor(rows[0].t / 86400) - ((Math.floor(rows[0].t / 86400) + 3) % 7));
    const max = Math.max(1, ...rows.filter(r => Math.floor(r.t / 86400) >= start).map(r => Math.abs(num(r.net_pnl) ?? 0)));
    const cells = [], months = [], today = Math.floor(Date.now() / 86400000);
    let green = 0, red = 0;
    for (let d = start; d <= end; d++) {
      const r = byDay.get(d), v = num(r?.net_pnl) ?? 0, dateText = date(d * 86400);
      if (r && v > 0) green++; else if (r && v < 0) red++;
      const a = r ? 0.18 + 0.82 * Math.min(1, Math.abs(v) / max) : 0;
      const bg = !r ? NO_DAY : v >= 0 ? `rgba(129,199,132,${a})` : `rgba(246,90,110,${a})`;
      // The days after today that close the week hold its place, blank: they have not happened.
      cells.push(d > today ? '<i></i>' : `<i style="background:${bg}" title="${esc(dateText)}${r ? ` · ${esc(usd(v, { sign: true }))} · ${int(r.trades)} trades` : ' · no closed trades'}"></i>`);
      // A month is named at its first week; the first column only when its month has weeks left, so two names never touch.
      if ((d - start) % 7 === 0) { const day = new Date(d * 86400000).getUTCDate(); months.push(day <= 7 || (d === start && day <= 21) ? esc(dateText.split(' ')[0]) : ''); }
    }
    const shown = Math.round((end - start + 1) / 7), cell = Math.max(16, Math.min(32, Math.floor(w / shown) - 3, Math.floor(h / 7) - 3));
    const html = `<div class="panel-body"><div class="cal-wrap" style="--cell:${cell}px"><div class="cal-days"><span></span>${['Mon', '', 'Wed', '', 'Fri', '', 'Sun'].map(x => `<span>${x}</span>`).join('')}</div><div><div class="cal-months">${months.map(m => `<span>${m}</span>`).join('')}</div><div class="cal">${cells.join('')}</div></div></div>
      <div class="cal-foot faint">UTC days, colour scaled to the largest day</div></div>`;
    return { html, green, red, weeks: shown };
  }
  // A 1200×630 summary card drawn on a canvas (nothing leaves the browser).
  function shareCard() {
    const d = data, perf = an?.performance, s = d.summary;
    const c = Object.assign(document.createElement('canvas'), { width: 1200, height: 630 }), g = c.getContext('2d');
    const font = (w, px) => `${w} ${px}px Geist, ui-sans-serif, system-ui, sans-serif`;
    const grad = g.createRadialGradient(600, -120, 40, 600, -120, 900); grad.addColorStop(0, '#1d1540'); grad.addColorStop(1, '#000000');
    g.fillStyle = grad; g.fillRect(0, 0, 1200, 630);
    g.strokeStyle = 'rgba(255,255,255,0.08)'; g.strokeRect(24.5, 24.5, 1151, 581);
    g.fillStyle = '#a2a4ff'; g.font = font(600, 30); g.fillText('Plumb', 64, 92);
    g.fillStyle = 'rgba(224,225,255,0.7)'; g.font = font(400, 22); g.fillText('Perpl trader profile · Monad', 170, 92);
    g.fillStyle = '#ffffff'; g.font = `500 26px 'Geist Mono', ui-monospace, monospace`; g.fillText(d.account.address, 64, 160);
    const net = num(s.net_pnl) ?? 0;
    g.fillStyle = 'rgba(224,225,255,0.7)'; g.font = font(400, 22); g.fillText('Net PnL, all time (after fees)', 64, 240);
    g.fillStyle = net >= 0 ? '#81c784' : '#f65a6e'; g.font = font(600, 84); g.fillText(usd(net, { sign: true }), 64, 330);
    const stats = [
      ['Volume', usd(s.volume)], ['Trades', int(s.trades)],
      ['Win rate', perf?.win_rate_pct === null || perf?.win_rate_pct === undefined ? '—' : pct(perf.win_rate_pct, { digits: 1 })],
      ['Profit factor', perf?.profit_factor === null || perf?.profit_factor === undefined ? '—' : perf.profit_factor.toFixed(2)],
      ['Max drawdown', perf ? usd(perf.max_drawdown) : '—'], ['Best market', perf?.best_market?.symbol ?? '—']
    ];
    stats.forEach(([k, v], i) => { const x = 64 + (i % 3) * 360, y = 420 + Math.floor(i / 3) * 90; g.fillStyle = 'rgba(224,225,255,0.6)'; g.font = font(400, 20); g.fillText(k, x, y); g.fillStyle = '#ffffff'; g.font = font(500, 34); g.fillText(String(v), x, y + 42); });
    g.fillStyle = 'rgba(255,255,255,0.42)'; g.font = font(400, 18);
    g.fillText(`${location.host} · from Monad chain data · ${new Date().toISOString().slice(0, 10)}`, 64, 590);
    const a = Object.assign(document.createElement('a'), { href: c.toDataURL('image/png'), download: `plumb-${d.account.address.slice(0, 10)}.png` });
    document.body.append(a); a.click(); a.remove();
  }
  // Trend header: all-time net PnL large, then what the chosen view adds;
  // dots name the colours of the bars and calendar cells.
  const DAY_KEYS = [{ name: 'Profit day', color: COLORS.long }, { name: 'Loss day', color: COLORS.short }];
  const NO_DAY = 'rgba(255,255,255,0.07)'; // a calendar day without closes, and its key dot
  function pnlHead(rows, note = '', keys = []) {
    const v = $('pnl-v'), lg = $('pnl-lg');
    const since = data.summary.first_trade ?? rows[0]?.t;
    if (v) v.innerHTML = `<div class="hv">${pnl(data.summary.net_pnl)}</div><div class="hn">${note || `all-time, after fees${since ? ` · since ${esc(date(since))}` : ''}`}</div>`;
    // ring: a key colour too faint to see on the card as a bare dot gets an outline.
    if (lg) lg.innerHTML = keys.map(s => `<span><i style="background:${s.color}${s.ring ? ';box-shadow:inset 0 0 0 1px rgba(255,255,255,0.28)' : ''}"></i>${esc(s.name)}</span>`).join('');
  }
  function drawPnl() {
    const node = $('pnl-chart');
    if (!node) return;
    const rows = data.pnl_daily ?? [];
    if (!rows.length) { pnlHead(rows); node.innerHTML = empty('No realized PnL yet'); return; }
    if (pnlMode === 'calendar') {
      node.__chart?.dispose(); node.__chart = null; node.innerHTML = '';
      // Measured empty: the room less day names, month row, key line and padding.
      const cal = pnlCalendar(rows, node.clientWidth - 70, node.clientHeight - 84);
      node.innerHTML = cal.html;
      pnlHead(rows, `<span class="pos">${int(cal.green)} profit</span> · <span class="neg">${int(cal.red)} loss</span> days in the ${int(cal.weeks)} weeks shown`, [...DAY_KEYS, { name: 'No closed trades', color: NO_DAY, ring: true }]);
      return;
    }
    if (pnlMode === 'daily') {
      const days = rows.filter(r => r.trades).map(r => num(r.net_pnl) ?? 0);
      pnlHead(rows, days.length ? `best day ${pnl(Math.max(...days))} · worst day ${pnl(Math.min(...days))}` : '', DAY_KEYS);
    } else pnlHead(rows);
    if (!node.__chart) node.innerHTML = '';
    if (pnlMode === 'cumulative') {
      const last = num(rows.at(-1).cumulative);
      // One point per calendar day (days without closes carry the total), so gaps look like gaps in time.
      const byDay = new Map(rows.map(r => [Math.floor(r.t / 86400), num(r.cumulative)]));
      const times = [], vals = []; let carry = null;
      for (let d = Math.floor(rows[0].t / 86400); d <= Math.floor(rows.at(-1).t / 86400); d++) { if (byDay.has(d)) carry = byDay.get(d); times.push(d * 86400); vals.push(carry); }
      lineChart(node, { times, series: [{ name: 'Cumulative net PnL', color: last >= 0 ? COLORS.long : COLORS.short, data: vals }], bucketSeconds: 86400, fmt: v => usd(v, { sign: true }) });
    } else {
      // Every calendar day too, as the cumulative line: days without closes have no bar, and the time scale holds between views.
      const byDay = new Map(rows.map(r => [Math.floor(r.t / 86400), num(r.net_pnl)]));
      const days = []; for (let d = Math.floor(rows[0].t / 86400); d <= Math.floor(rows.at(-1).t / 86400); d++) days.push(d);
      signedBars(node, { times: days.map(d => d * 86400), values: days.map(d => byDay.get(d) ?? null), bucketSeconds: 86400, name: 'Net PnL' });
    }
  }
  async function loadTrades() {
    const r = await get(`wallets/${encodeURIComponent(data.account.address)}/trades?limit=100${next ? `&before=${next}` : ''}`, { maxAge: 0 });
    if (!alive) return;
    trades.push(...r.rows); next = r.next;
    renderTrades();
  }
  function renderTrades() {
    const list = $('trade-list'); if (!list) return;
    list.innerHTML = table({ id: 'tr', compact: true, columns: TRADE_COLS, rows: trades, emptyText: 'No trades' });
    $('trade-count').textContent = `${int(trades.length)} shown`;
    $('more').hidden = !next;
  }

  const PERIOD_LABEL = { '24h': '24 hours', '7d': '7 days', '30d': '30 days', all: 'All time' };
  const rankCell = (n, of) => (n ? `<span class="rank-pill${n <= 10 ? ' lead' : ''}">#${int(n)}</span><span class="faint rank-of">of ${int(of)}</span>` : '<span class="faint">—</span>');
  function periodsTable() {
    return table({ id: 'periods', compact: true, columns: [
      { key: 'w', label: 'Period', render: r => `${PERIOD_LABEL[r.window] ?? esc(r.window)}${r.coverage_complete ? '' : ' <span class="tag warn" title="History for this window is still being indexed">partial</span>'}` },
      { key: 'v', label: 'Volume', n: true, render: r => (r.trades ? usd(r.volume) : '<span class="faint">—</span>') },
      { key: 't', label: 'Trades', n: true, render: r => (r.trades ? int(r.trades) : '<span class="faint">0</span>') },
      { key: 'p', label: 'Net PnL', n: true, render: r => (r.trades ? pnl(r.net_pnl) : '<span class="faint">—</span>') },
      { key: 'e', label: 'PnL / volume', n: true, render: r => bpsCell(r.pnl_per_volume_bps) },
      { key: 'rp', label: 'Rank by PnL', n: true, render: r => rankCell(r.rank?.pnl, r.rank?.of) },
      { key: 'rv', label: 'Rank by volume', n: true, render: r => rankCell(r.rank?.volume, r.rank?.of) }
    ], rows: periods.periods });
  }
  const loadPeriods = () => get(`wallets/${encodeURIComponent(key)}/periods`, { maxAge: 20000 }).then(p => { if (!alive) return; periods = p; const n = $('periods'); if (n) n.innerHTML = periodsTable(); markPartial(); }).catch(() => { const n = $('periods'); if (n && !periods) n.innerHTML = empty('Period totals unavailable'); });

  // While history is indexing, the header's all-time figures say so.
  function markPartial() {
    const all = periods?.periods?.find(x => x.window === 'all');
    const sub = el.querySelector('.wallet-id .sub:last-child');
    if (all && all.coverage_complete === false && sub && !sub.querySelector('.tag')) sub.insertAdjacentHTML('beforeend', ' <span class="tag warn" title="Wallet history is still being indexed, so all-time totals are incomplete">partial history</span>');
  }
  function insightsHtml() {
    return `<div class="insights">${an.insights.length ? an.insights.map(i => `<div class="insight"><span class="tag accent">${esc(i.tag)}</span><span>${esc(i.text)}</span></div>`).join('') : '<span class="faint">Not enough closed trades yet.</span>'}</div>
      <div class="panel-head" style="min-height:32px;padding-top:0"><h2 style="font-size:12.5px;color:var(--text-2);font-weight:500">Activity by weekday and hour (UTC)</h2></div>${heatmap(an.activity ?? [])}`;
  }
  // Analytics arrive after the page: fill the waiting parts in place.
  function applyAnalytics() {
    if (!data || !an) return;
    const row = $('kpi-row'); if (row) row.innerHTML = kpis(data);
    const perf = $('perf'); if (perf) perf.innerHTML = perfPanel(an.performance, data.summary);
    const ins = $('insights'); if (ins) ins.innerHTML = insightsHtml();
    if (tab === 'trips' || tab === 'overview') renderTab();
  }
  const loadAnalytics = () => get(`wallets/${encodeURIComponent(key)}/analytics`, { maxAge: 20000 }).then(a => { if (!alive) return; an = a; applyAnalytics(); }).catch(() => {});
  get(`wallets/${encodeURIComponent(key)}`, { maxAge: 3000 }).then(d => { if (!alive) return; data = d; render(); loadAnalytics(); loadPeriods(); }).catch(error => {
    el.innerHTML = `<div class="page-head"><div><div class="sub"><a href="#/traders">Traders</a> / Wallet</div><h1 class="mono">${esc(short(key))}</h1></div></div><section class="panel">${empty(error.status === 404 ? 'No Perpl account for this address (checked in the index and on the contract).' : `Could not load wallet (${error.message})`)}</section>`;
  });
  function refresh() { if (!data || tab === 'trades') return; get(`wallets/${encodeURIComponent(key)}`, { maxAge: 0 }).then(d => { if (!alive) return; data = d; const scroll = window.scrollY; render(); window.scrollTo({ top: scroll }); loadAnalytics(); loadPeriods(); }).catch(() => {}); }
  // Marks move uPnL continuously: poll. A trade or liquidation of this account refreshes at once.
  const timer = setInterval(refresh, 20000);
  let pending = null;
  const mine = rows => data && rows.some(r => String(r.account) === String(data.account.id));
  const soon = () => { if (!pending) pending = setTimeout(() => { pending = null; refresh(); }, 1200); };
  const off = [stream.on('trades', rows => { if (mine(rows)) soon(); }), stream.on('liquidations', rows => { if (mine(rows)) soon(); })];
  return {
    onTab(name, v) { if (name !== 'tab') return; tab = v; showTab(); setQuery({ tab: v === 'overview' ? null : v }); },
    onAction(a) {
      if (a === 'pnl-cum' || a === 'pnl-daily' || a === 'pnl-cal') { pnlMode = { 'pnl-cum': 'cumulative', 'pnl-daily': 'daily', 'pnl-cal': 'calendar' }[a]; el.querySelectorAll('[data-action^="pnl-"]').forEach(b => b.classList.toggle('on', b.dataset.action === a)); drawPnl(); }
      if (a === 'more') loadTrades().catch(() => {});
      if (a === 'share' && data) { if (!an) toast('Analytics still loading; card uses totals only'); shareCard(); }
      if (a === 'watch' && data) { const on = watch.toggle(data.account.address, `#${data.account.id}`); toast(on ? 'Added to watchlist' : 'Removed from watchlist'); render(); }
      if (a === 'compare' && data) { let list = []; try { list = JSON.parse(sessionStorage.getItem('ps.compare') || '[]'); } catch { list = []; } if (!list.includes(data.account.address)) list.push(data.account.address); list = list.slice(-5); try { sessionStorage.setItem('ps.compare', JSON.stringify(list)); } catch { /* storage unavailable */ } navigate('/compare', { w: list.join(',') }); }
    },
    update(q) { const t = TABS.some(([v]) => v === q.get('tab')) ? q.get('tab') : 'overview'; if (t !== tab) tab = t; if (data) renderTab(); },
    destroy() { alive = false; clearInterval(timer); clearTimeout(pending); off.forEach(f => f()); }
  };
}
