// Trader leaderboard over a window: net PnL, volume, losses, liquidations,
// with open positions from the live contract state.
import { get } from '../api.js';
import { usd, int, pct, num, esc, price, ago, duration } from '../format.js';
import { seg, table, addr, pnl, bpsCell, kpi, skeleton, mkt, mktLink, tradeAction, logo, assetOf, ICON, go } from '../ui.js';
import { SEA_ICONS } from '../cohort-icons.js';

const WINDOWS = [['24h', '24H'], ['7d', '7D'], ['30d', '30D'], ['all', 'All']];
const SORTS = [['pnl', 'Top PnL'], ['loss', 'Top losses'], ['volume', 'Volume'], ['fees', 'Fees paid'], ['liquidated', 'Liquidated'], ['net_flow', 'Net inflow'], ['deposits', 'Deposits'], ['withdrawals', 'Withdrawals']];
const FLOW_SORTS = new Set(['net_flow', 'deposits', 'withdrawals']);
// The ranking switches, trading rankings and flows apart, each with its label.
const rankBy = by => `<span class="lb-label">Rank by</span>${seg('by', SORTS.filter(([v]) => !FLOW_SORTS.has(v)), by)}<span class="lb-label flows">Flows</span>${seg('by', SORTS.filter(([v]) => FLOW_SORTS.has(v)), by)}`;
const CO_TABS = [['size', 'By size'], ['pnl', 'By track record']];
const SM_WINDOWS = [['7d', '7D'], ['30d', '30D'], ['all', 'All']];
const SM_SIZES = [['100', '≥$100'], ['1000', '≥$1K'], ['10000', '≥$10K']];

export function mount(el, { query, setQuery }) {
  let w = WINDOWS.some(([v]) => v === query.get('window')) ? query.get('window') : '24h';
  let by = SORTS.some(([v]) => v === query.get('by')) ? query.get('by') : 'pnl';
  let page = 0, alive = true, data = null, cohorts = null, coTab = 'size', coSel = null, smWin = '30d', smMin = '1000';
  const LIMIT = 20;
  el.innerHTML = `
    <div class="page-head"><div><h1>Traders</h1><div class="sub">Rankings of every account that traded, how traders are positioned now, and the latest moves of the most profitable ones.</div></div><div id="win">${seg('window', WINDOWS, w)}</div></div>
    <div class="stack traders-page">
    <div class="kpis k4" id="tkpis">${Array.from({ length: 4 }, () => '<div class="kpi"><div class="skeleton sk-line" style="width:40%"></div><div class="skeleton" style="height:26px;width:60%;margin-top:10px"></div></div>').join('')}</div>
    <section class="panel" id="board"><div class="panel-head lb-head"><div><h2 id="title">Leaderboard</h2><div class="desc" id="meta"></div></div><div class="lb-tools"><input id="lb-search" class="calc-in lb-search" type="search" placeholder="Filter or paste a wallet" autocomplete="off" spellcheck="false" aria-label="Filter traders by address"><a class="btn ghost" id="csv">${ICON.download} CSV</a></div><div class="lb-rank" id="by" role="group" aria-label="Rank traders by">${rankBy(by)}</div></div>
      <div class="panel-body flush" id="list">${skeleton(12)}</div>
      <div class="panel-foot pager"><span id="count"></span><span class="pager-ctl" id="pager"></span></div></section>
    <section class="panel"><div class="panel-head"><div><h2>Positioning by cohort</h2><div class="desc" id="co-desc">Open positions now, grouped by account · click a cohort for its largest wallets</div></div><div id="co-tabs">${seg('co', CO_TABS, coTab)}</div></div>
      <div class="panel-body flush" id="cohorts">${skeleton(4)}</div><div id="co-detail"></div></section>
    <section class="panel"><div class="panel-head"><div><h2>Smart money moves</h2><div class="desc" id="sm-desc">What the most profitable traders are doing now</div></div><div class="sm-ctl"><div id="sm-min">${seg('smm', SM_SIZES, smMin)}</div><div id="sm-win">${seg('smw', SM_WINDOWS, smWin)}</div></div></div>
      <div class="panel-body flush scroll sm-list" id="moves">${skeleton(6)}</div></section>
    </div>`;
  const $ = s => el.querySelector(`#${s}`);
  // At most two rule-based style tags per trader; each title gives the evidence.
  const DAYS = { '24h': 1, '7d': 7, '30d': 30 };
  function styleTags(r) {
    const out = [], trades = r.trades ?? 0, vol = num(r.volume) ?? 0;
    if (trades && vol / trades >= 25000) out.push(['Whale', `average trade ${usd(vol / trades)}`]);
    if (trades >= 100 && (r.maker_share_pct ?? 0) >= 80) out.push(['Maker', `${Math.round(r.maker_share_pct)}% of volume as maker`]);
    if (DAYS[w] && trades / DAYS[w] >= 5000) out.push(['High frequency', `${int(trades / DAYS[w])} trades a day, one every ${Math.round(86400 * DAYS[w] / trades)} s`]);
    return out.slice(0, 2).map(([t, why]) => `<span class="tag" title="${esc(why)}">${t}</span>`).join(' ');
  }
  const COLS = [
    { key: 'rank', label: '#', render: r => `<span class="rank">${r.rank}</span>` },
    { key: 'addr', label: 'Trader', render: r => { const t = styleTags(r); return `${addr(r.address, r.account)}${t ? `<div class="sub tags">${t}</div>` : ''}`; } },
    { key: 'pnl', label: 'Net PnL', tip: 'Realized PnL, funding included, minus fees', n: true, render: r => pnl(r.pnl) },
    { key: 'roi', label: 'PnL / volume', phone: false, n: true, render: r => bpsCell(r.roi_on_volume_bps) }, // in bps, as the KPI above and the wallet page
    { key: 'volume', label: 'Volume', n: true, render: r => usd(r.volume) },
    { key: 'trades', label: 'Trades', phone: false, n: true, render: r => int(r.trades) },
    { key: 'maker', label: 'Maker share', phone: false, n: true, render: r => pct(r.maker_share_pct, { digits: 0 }) },
    { key: 'fees', label: 'Fees', phone: false, n: true, render: r => usd(r.fees) },
    { key: 'liq', label: 'Liquidated', phone: false, n: true, render: r => (num(r.liquidated) > 0 ? `<span class="neg">${usd(r.liquidated)}</span>` : '<span class="faint">—</span>') },
    { key: 'dep', flow: true, label: 'Deposits', n: true, render: r => (num(r.deposits) > 0 ? usd(r.deposits) : '<span class="faint">—</span>') },
    { key: 'wd', flow: true, label: 'Withdrawals', n: true, render: r => (num(r.withdrawals) > 0 ? usd(r.withdrawals) : '<span class="faint">—</span>') },
    { key: 'net', flow: true, label: 'Net flow', n: true, render: r => { const v = (num(r.deposits) ?? 0) - (num(r.withdrawals) ?? 0); return v ? pnl(v) : '<span class="faint">—</span>'; } },
    { key: 'open', label: 'Open now', phone: false, n: true, render: r => (r.open_positions ? `${usd(r.open_notional)}<div class="sub">${r.open_positions} pos · uPnL ${usd(r.unrealized_pnl, { sign: true })}</div>` : '<span class="faint">—</span>') },
    { key: 'markets', label: 'Markets', phone: false, render: r => `<span class="muted">${esc(r.markets.slice(0, 4).join(' · '))}${r.markets.length > 4 ? ` +${r.markets.length - 4}` : ''}</span>` }
  ];
  let seq = 0;
  async function load() {
    const asked = ++seq;
    $('list').innerHTML = skeleton(12);
    const d = await get(`leaderboard?window=${w}&by=${by}&limit=${LIMIT}&offset=${page * LIMIT}`);
    if (!alive || asked !== seq) return; // a newer page or window was asked for meanwhile
    data = d;
    $('title').textContent = SORTS.find(([v]) => v === by)[1];
    $('meta').textContent = `${w === 'all' ? 'All-time' : `Last ${w}`}${data.meta.coverage && !data.meta.coverage.complete ? ' · history still indexing' : ''}`;
    // Flow rankings swap the fee and liquidation columns for the flows themselves.
    const flow = FLOW_SORTS.has(by), columns = COLS.filter(c => (flow ? !['fees', 'liq', 'maker'].includes(c.key) : !c.flow));
    lbColumns = columns; renderList();
    $('csv').href = `/api/v1/leaderboard?window=${w}&by=${by}&limit=200&format=csv`;
    renderPager();
  }
  // Prev is off on the first page and Next on the last; one page needs neither.
  const pages = () => Math.max(1, Math.ceil((data?.total ?? 0) / LIMIT));
  function renderPager() { const n = pages(); $('pager').innerHTML = n > 1 ? `<button class="btn ghost sm" data-action="prev" ${page === 0 ? 'disabled' : ''}>← Prev</button><span class="num">Page ${int(page + 1)} of ${int(n)}</span><button class="btn ghost sm" data-action="next" ${page + 1 >= n ? 'disabled' : ''}>Next →</button>` : ''; }
  // A new page starts at the board's head, not at the foot where Next was.
  function goTo(n) { page = n; renderPager(); load().then(() => { const top = $('board'); if (alive && top.getBoundingClientRect().top < 0) top.scrollIntoView({ block: 'start' }); }).catch(() => {}); }
  // The leaderboard page, filtered by the address typed in its search box.
  let lbColumns = null, filter = '';
  function renderList() {
    if (!data || !lbColumns) return;
    const f = filter.toLowerCase();
    const rows = f ? data.rows.filter(r => String(r.address ?? '').toLowerCase().includes(f) || String(r.account) === f.replace(/^#/, '')) : data.rows;
    $('list').innerHTML = table({ id: 'lb', columns: lbColumns, rows, rowAttrs: r => `class="link" data-href="/wallet/${esc(r.address || r.account)}"`, emptyText: f ? 'Not on this page. Press Enter to open the wallet, if it is a full address or account ID.' : 'No traders in this window' });
    // The count says what is on screen: a filter's matches on this page, or the page's place in the ranking.
    $('count').textContent = !data.total ? '' : f ? `${int(rows.length)} of ${int(data.rows.length)} on this page match` : `${int(data.total)} accounts · showing ${int(page * LIMIT + 1)}–${int(page * LIMIT + data.rows.length)}`;
  }
  $('lb-search').addEventListener('input', e => { filter = e.target.value.trim(); renderList(); });
  $('lb-search').addEventListener('keydown', e => { const q = e.target.value.trim(); if (e.key === 'Enter' && (/^0x[0-9a-fA-F]{40}$/.test(q) || /^\d{1,9}$/.test(q))) go(`/wallet/${q}`); });

  // The latest position changes of the top directional traders (makers and
  // high-frequency accounts left out server-side), ranked by net PnL in smWin.
  // A trader splitting one decision into many fills ("reduce long" eight times
  // in five minutes) shows as one row: the same account, market, action and
  // side within 30 minutes of each other fold together.
  const MOVE_VERBS = { open: 'Open', increase: 'Add', decrease: 'Reduce', close: 'Close', invert: 'Flip to', liquidation: 'Liquidated', deleverage: 'ADL' };
  function foldMoves(rows) {
    const out = [], open = new Map();
    for (const r of rows) {
      const key = `${r.account}|${r.market}|${r.kind}|${r.side}`, g = open.get(key);
      if (g && g.oldest - r.ts <= 1800) { g.count++; g.notional += num(r.notional) || 0; g.size += num(r.size) || 0; g.pnl += num(r.pnl) || 0; g.oldest = r.ts; continue; }
      const next = { ...r, count: 1, notional: num(r.notional) || 0, size: num(r.size) || 0, pnl: num(r.pnl) || 0, oldest: r.ts };
      open.set(key, next); out.push(next);
    }
    return out;
  }
  const moveAction = r => { const side = r.side === 'long' || r.side === 'short' ? r.side : ''; const opening = ['open', 'increase'].includes(r.kind) || (r.kind === 'invert'); const cls = r.kind === 'liquidation' ? 'neg' : (side === 'long') === opening ? 'pos' : 'neg'; return `<span class="${cls}">${MOVE_VERBS[r.kind] ?? r.kind} ${esc(side)}</span>${r.count > 1 ? ` <span class="tag hide-sm" title="${r.count} fills over ${Math.max(1, Math.round((r.ts - r.oldest) / 60))} min">×${r.count}</span>` : ''}`; };
  // The API returns at most this many raw fills; a busy leader can fill them all.
  const MOVE_FILLS = 500;
  async function loadMoves() {
    const m = await get(`traders/moves?window=${smWin}&min=${smMin}&limit=${MOVE_FILLS}`, { maxAge: 8000 });
    if (!alive) return;
    const wl = smWin === 'all' ? 'all-time' : smWin;
    // Cut off by the fill limit, the list covers less than the 7 days asked for: it says how much.
    const oldest = m.rows.at(-1)?.ts, cut = m.rows.length >= MOVE_FILLS && oldest;
    const span = cut ? `the last ${duration(Date.now() / 1000 - oldest)} (the latest ${int(MOVE_FILLS)} fills)` : 'last 7 days';
    $('sm-desc').textContent = `Latest position changes of the ${int(m.leaders)} most profitable directional traders by net PnL (${wl}), ${span}${m.excluded ? ` · ${int(m.excluded)} market-making and high-frequency accounts (by ${wl} activity) left out` : ''}`;
    $('moves').innerHTML = table({ id: 'moves', compact: true, emptyText: 'No moves by these traders in the last 7 days', columns: [
      { key: 't', label: 'When', render: r => `<span class="muted num" title="${esc(new Date(r.ts * 1000).toISOString().replace('T', ' ').slice(0, 19))} UTC">${ago(r.ts)}</span>` },
      { key: 'a', label: 'Trader', phone: false, render: r => `<span class="sm-trader"><span class="rank-pill" title="Rank by net PnL among all traders, ${esc(wl)}">#${int(r.leader.rank)}</span>${addr(r.address, r.account)}</span>` },
      { key: 'x', label: 'Action', render: moveAction },
      { key: 'm', label: 'Market', render: r => mktLink(r.market, r.symbol) },
      { key: 'n', label: 'Notional', n: true, render: r => usd(r.notional) },
      { key: 'p', label: 'Price', phone: false, n: true, render: r => price(r.count > 1 && r.size ? r.notional / r.size : r.price) },
      { key: 'r', label: 'Realized', phone: false, n: true, render: r => (['decrease', 'close', 'invert', 'liquidation', 'deleverage'].includes(r.kind) && num(r.pnl) ? pnl(r.pnl) : '<span class="faint">—</span>') },
      { key: 'l', label: `Net PnL · ${wl}`, phone: false, n: true, render: r => pnl(r.leader.pnl) }
    ], rows: foldMoves(m.rows).slice(0, 30), rowAttrs: r => `class="link" data-href="/wallet/${esc(r.address || r.account)}"` });
  }

  // Traders at a glance for the leaderboard's window.
  async function loadSummary() {
    const t = await get(`traders/summary?window=${w}`, { maxAge: 20000 });
    if (!alive) return;
    const wl = w === 'all' ? 'all-time' : w, partial = t.meta?.coverage && !t.meta.coverage.complete ? ' <span class="tag warn" title="History for this window is still being indexed">partial</span>' : '';
    $('tkpis').innerHTML = [
      kpi({ label: `Traders · ${wl}`, value: int(t.traders), note: `${usd(t.volume)} volume${partial}` }),
      kpi({ label: `Profitable · ${wl}`, value: int(t.profitable), note: `${pct(t.profitable_pct, { digits: 1 })} of traders, after fees` }),
      kpi({ label: `Traders' net PnL · ${wl}`, value: pnl(t.net_pnl), note: 'all traders, after fees', tip: 'Realized PnL with funding, minus fees, summed over every trader in the window.' }),
      kpi({ label: `Median PnL / volume · ${wl}`, value: num(t.median_pnl_per_volume_bps) === null ? '—' : bpsCell(t.median_pnl_per_volume_bps), note: 'the typical trader, per $ traded', tip: 'Net PnL per dollar traded for the median trader: half of traders did better, half worse.' })
    ].join('');
  }

  // Cohorts: who holds the open interest, by size or by track record. One card
  // per cohort: its direction three ways (label, split bar, long/short $), its
  // share of all open notional, and where it is positioned. Purple marks
  // identity; green and red only ever mean long and short.
  const CO_SHADES = ['#6f5cff', '#8f82ff', '#b3aaff', '#d9d4ff'];
  const stroke = paths => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
  const CO_ICON = {
    ...SEA_ICONS, // size tiers: whale, dolphin, fish, shrimp
    top: stroke('<path d="M3 17h18M4 8l4.5 4.5L12 6l3.5 6.5L20 8l-1.5 9h-13z"/>'),
    winner: stroke('<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>'),
    loser: stroke('<path d="M3 7l6 6 4-4 8 8"/><path d="M15 17h6v-6"/>'),
    rekt: stroke('<path d="M12 3a8 8 0 0 0-5 14.2V20h10v-2.8A8 8 0 0 0 12 3z"/><circle cx="9" cy="12" r="1.3"/><circle cx="15" cy="12" r="1.3"/><path d="M10.5 20v-2M13.5 20v-2"/>')
  };
  // Net exposure names its side ("short $142K"): a bare "-$142K" read like a loss.
  const netSide = v => { const n = num(v) ?? 0; return n ? `<span class="${n > 0 ? 'pos' : 'neg'}">${n > 0 ? 'long' : 'short'} ${usd(Math.abs(n))}</span>` : '<span class="faint">flat</span>'; };
  function biasOf(s) {
    if (s === null || s === undefined) return ['No positions', 'flat', ''];
    return s >= 65 ? ['Strong long', 'long', '▲'] : s >= 55 ? ['Long', 'long', '▲'] : s <= 35 ? ['Strong short', 'short', '▼'] : s <= 45 ? ['Short', 'short', '▼'] : ['Neutral', 'flat', '◆'];
  }
  function renderCohorts() {
    if (!cohorts) return;
    const groups = coTab === 'size' ? cohorts.by_size : cohorts.by_pnl;
    const held = g => g.long_notional + g.short_notional, all = groups.reduce((a, g) => a + held(g), 0) || 1;
    // Where the open notional sits, cohort by cohort.
    const strip = `<div class="co-strip"><div class="co-strip-head"><span>Open notional held</span><span class="faint">${usd(all)} long + short</span></div><div class="co-strip-bar">${groups.map((g, i) => (held(g) > 0 ? `<i style="flex:${held(g)};background:${CO_SHADES[i % CO_SHADES.length]}" title="${esc(g.label)}: ${esc(usd(held(g)))} (${pct(held(g) / all * 100, { digits: 1 })})"></i>` : '')).join('')}</div>
      <div class="co-strip-keys">${groups.map((g, i) => `<span><i style="background:${CO_SHADES[i % CO_SHADES.length]}"></i>${esc(g.label)} <b>${pct(held(g) / all * 100, { digits: 0 })}</b></span>`).join('')}</div></div>`;
    const card = (g, i) => {
      const [label, cls, arrow] = biasOf(g.accounts ? g.long_share_pct : null), l = g.long_share_pct ?? 50;
      const markets = g.markets.slice(0, 3).map(m => `<span class="co-mk ${m.long >= m.short ? 'long' : 'short'}">${logo(m.market, m.symbol, 14)}${esc(assetOf(m.symbol))}${m.long >= m.short ? '↑' : '↓'}</span>`).join('');
      return `<button type="button" class="co-card${coSel === g.key ? ' sel' : ''}" data-action="co-pick" data-key="${esc(g.key)}" aria-pressed="${coSel === g.key}">
        <div class="co-top"><span class="co-ic" style="--shade:${CO_SHADES[i % CO_SHADES.length]}">${CO_ICON[g.key] ?? ''}</span><span class="co-id"><b>${esc(g.label)}</b><span>${esc(g.rule)}</span></span><span class="co-pill ${cls}">${arrow} ${label}</span></div>
        <div class="co-count"><b>${int(g.accounts)}</b> wallets<span class="co-ls"><span class="pos">${int(g.net_long_accounts)} long</span> · <span class="neg">${int(g.net_short_accounts)} short</span></span></div>
        <div class="co-bar" title="${pct(l, { digits: 1 })} of this cohort's open notional is long">${g.accounts ? `<i style="width:${l}%"></i><i></i>` : ''}</div>
        <div class="co-ends"><span class="pos">${usd(g.long_notional)} <small>L</small></span><span class="co-share">${pct(l, { digits: 0 })} long</span><span class="neg"><small>S</small> ${usd(g.short_notional)}</span></div>
        <div class="co-stats"><span title="Long minus short open notional">Net exposure<b>${netSide(g.net_notional)}</b></span><span>uPnL<b>${pnl(g.unrealized_pnl)}</b></span><span>In profit<b>${int(g.in_profit)}/${int(g.accounts)}</b></span></div>
        <div class="co-mks">${markets || '<span class="faint">No open positions</span>'}</div>
      </button>`;
    };
    $('cohorts').innerHTML = `<div class="panel-body">${strip}<div class="co-grid">${groups.map(card).join('')}</div></div>`;
    $('co-desc').textContent = coTab === 'size' ? 'Open positions now, grouped by each account\'s total open notional · click a cohort for its wallets' : `Grouped by net PnL over indexed history${cohorts.meta?.coverage && !cohorts.meta.coverage.complete ? ' (history still indexing)' : ''}${cohorts.unranked ? ` · ${int(cohorts.unranked)} accounts without indexed trades left out` : ''}`;
    const g = groups.find(x => x.key === coSel);
    $('co-detail').innerHTML = g ? `<div class="panel-head" style="min-height:0;padding-top:12px"><h2 style="font-size:12.5px;color:var(--text-2);font-weight:500">${esc(g.label)}: largest wallets</h2><button class="btn ghost" data-action="co-close">Close</button></div>${table({ id: 'co-top', compact: true, emptyText: 'No accounts', columns: [
      { key: 'a', label: 'Wallet', render: a => addr(a.address, a.account) },
      { key: 'n', label: 'Open notional', n: true, render: a => usd(a.notional) },
      { key: 'd', label: 'Net exposure', n: true, render: a => netSide(a.net) },
      { key: 'u', label: 'uPnL', phone: false, n: true, render: a => pnl(a.upnl) },
      { key: 'p', label: 'Net PnL (history)', phone: false, n: true, render: a => (a.pnl === null ? '<span class="faint">—</span>' : pnl(a.pnl)) }
    ], rows: g.top, rowAttrs: a => `class="link" data-href="/wallet/${esc(a.address || a.account)}"` })}` : '';
  }
  const loadCohorts = () => get('cohorts', { maxAge: 5000 }).then(c => { if (!alive) return; cohorts = c; renderCohorts(); }).catch(() => { if (!cohorts) $('cohorts').innerHTML = '<div class="empty-state">Live positions unavailable</div>'; });
  loadCohorts();
  const coTimer = setInterval(loadCohorts, 10000);
  loadMoves().catch(() => { $('moves').innerHTML = '<div class="empty-state">Unavailable</div>'; });
  const smTimer = setInterval(() => loadMoves().catch(() => {}), 15000);

  load().catch(error => { $('list').innerHTML = `<div class="empty-state">${esc(error.message)}</div>`; });
  loadSummary().catch(() => { $('tkpis').innerHTML = ''; });
  return {
    onSeg(name, v) { if (name === 'smm') { smMin = v; $('sm-min').innerHTML = seg('smm', SM_SIZES, smMin); $('moves').innerHTML = skeleton(6); loadMoves().catch(() => {}); return; } if (name === 'smw') { smWin = v; $('sm-win').innerHTML = seg('smw', SM_WINDOWS, smWin); $('moves').innerHTML = skeleton(6); loadMoves().catch(() => {}); return; } if (name === 'co') { coTab = v; coSel = null; $('co-tabs').innerHTML = seg('co', CO_TABS, coTab); renderCohorts(); return; } if (name === 'window') setQuery({ window: v === '24h' ? null : v }); if (name === 'by') setQuery({ by: v === 'pnl' ? null : v }); },
    onAction(a, t) { if (a === 'co-pick') { coSel = coSel === t.dataset.key ? null : t.dataset.key; renderCohorts(); return; } if (a === 'co-close') { coSel = null; renderCohorts(); return; } if (a === 'next' && data && page + 1 < pages()) goTo(page + 1); if (a === 'prev' && page > 0) goTo(page - 1); },
    update(q) { w = WINDOWS.some(([v]) => v === q.get('window')) ? q.get('window') : '24h'; by = SORTS.some(([v]) => v === q.get('by')) ? q.get('by') : 'pnl'; page = 0; $('win').innerHTML = seg('window', WINDOWS, w); $('by').innerHTML = rankBy(by); load().catch(() => {}); loadSummary().catch(() => {}); },
    destroy() { alive = false; clearInterval(coTimer); clearInterval(smTimer); }
  };
}
export { mkt };
