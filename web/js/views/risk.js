// Risk: what live positions would do under a price move. Liquidation ladder,
// shortfall against insurance, order-book cover and an interactive stress
// test, all from contract state at the collector's latest finalized block.
import { get } from '../api.js';
import { usd, int, price, pct, num, esc, size, multiple } from '../format.js';
import { kpi, table, mktLink, sideTag, addr, pnl, skeleton, skChart, empty } from '../ui.js';
import { mirrored, COLORS } from '../charts.js';

// Depth read up to the walk's level cap is a lower bound; a no-break space
// keeps the sign with its figure when a note wraps.
const atLeast = complete => (complete === false ? '≥\u00a0' : '');
// Book cover always reads as a percentage (rounded down, so a thin book never
// reads as full); past 999 % the exact multiple moves to the title.
const cover = (v, complete) => { const n = num(v); return n === null ? '—' : n >= 1000 ? `<span title="Order-book depth is ${complete === false ? 'at least ' : ''}${multiple(n)} what this move would liquidate">&gt;999%</span>` : atLeast(complete) + multiple(n); };
// Insurance against shortfall always reads as a multiple, rounded down so a
// fund short of its shortfall never reads as 1×.
const times = v => { const n = num(v); return n === null ? '—' : n >= 10000 ? `${int(Math.floor(n / 100))}×` : n >= 1000 ? `${(Math.floor(n / 10) / 10).toFixed(1)}×` : `${(Math.floor(n) / 100).toFixed(2)}×`; };
const signed = v => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)}%`;
// The ladder's sides, named in the card head as on the market page.
const LADDER_KEY = [['Longs (price down)', COLORS.long], ['Shorts (price up)', COLORS.short]].map(([name, color]) => `<span><i style="background:${color}"></i>${name}</span>`).join('');

// The move in the address, 0 included (a plain || would turn 0 into the default).
const moveOf = (q, fallback) => { const v = q.get('move'); return v !== null && v !== '' && Number.isFinite(Number(v)) ? Math.max(-50, Math.min(50, Math.round(Number(v)))) : fallback; };

export function mount(el, { query, setQuery }) {
  let alive = true, overview = null;
  let marketId = Number(query.get('market')) || null, move = moveOf(query, -10);
  el.innerHTML = `
    <div class="page-head"><div><h1>Risk</h1><div class="sub">Liquidation exposure of every open position, from contract state at the latest finalized block read (about every second; order book every 30 s).</div></div><span class="meta faint" id="block"></span></div>
    <div class="stack">
      <div class="kpis rk-kpis" id="kpis"></div>
      <div class="grid g-main">
        <section class="panel rk-stress"><div class="panel-head"><h2>Stress test</h2><select id="mkt" class="btn ghost" aria-label="Market"></select></div>
          <div class="panel-body"><div style="display:flex;align-items:center;gap:14px"><span class="faint num" style="width:48px">−50%</span><input id="move" class="range" type="range" min="-50" max="50" step="1" value="${move}" aria-label="Price move"><span class="faint num" style="width:48px;text-align:right">+50%</span></div>
          <div style="text-align:center;margin-top:6px;font-size:13px" class="muted">Mark moves <b id="move-label" class="num" style="color:var(--text)"></b> to <b id="move-price" class="num" style="color:var(--text)"></b></div></div>
          <div id="stress">${skeleton(5)}</div></section>
        <section class="panel rk-ladder"><div class="panel-head"><div><h2>Liquidation ladder</h2><div class="desc" id="ladder-meta"></div></div><div class="legend dots" id="ladder-lg"></div></div><div class="panel-body"><div class="chart" id="ladder">${skChart()}</div></div></section>
      </div>
      <section class="panel"><div class="panel-head"><h2>Largest positions exposed</h2><span class="meta" id="hit-meta"></span></div><div class="panel-body flush" id="hit">${skeleton(6)}</div></section>
      <section class="panel"><div class="panel-head"><h2>By market</h2><span class="meta">Each market’s worse direction: longs exposed to a fall or shorts to a rise; shortfall is equity below zero at that price</span></div><div class="panel-body flush" id="table">${skeleton(8)}</div></section>
    </div>`;
  const $ = s => el.querySelector(`#${s}`);

  async function load({ fresh = false } = {}) {
    overview = await get('overview', { maxAge: fresh ? 0 : 3000 });
    if (!alive) return;
    const t = overview.totals;
    // Every section below is drawn from this block and the same order-book read.
    const books = overview.markets.map(m => Number(m.liquidity?.book_block ?? 0)).filter(Boolean);
    $('block').textContent = `Contract state at block ${int(overview.snapshot.block)}${books.length ? ` · order books read at ${int(Math.max(...books))}` : ''}`;
    $('kpis').innerHTML = [
      // Labels stay short enough for one line beside the tip on a phone.
      kpi({ label: 'Position notional', value: usd(t.total_notional), note: `${int(t.positions)} positions`, tip: 'All open positions valued at the mark price, longs plus shorts (open interest counts one side).' }),
      kpi({ label: 'At risk, 5% move', value: usd(t.notional_at_5pct), note: `${pct(num(t.notional_at_5pct) / num(t.total_notional) * 100, { digits: 1 })} of notional`, tip: 'Notional reaching liquidation if all markets fell or rose 5%, whichever is more. A static shock, not a forecast.' }),
      kpi({ label: 'At risk, 10% move', value: usd(t.notional_at_10pct), note: `${pct(num(t.notional_at_10pct) / num(t.total_notional) * 100, { digits: 1 })} of notional · if all markets ${esc(t.direction_at_10pct ?? 'move')}` }),
      kpi({ label: 'Shortfall, 10%', value: `<span class="${num(t.shortfall_at_10pct) > 0 ? 'neg' : ''}">${usd(t.shortfall_at_10pct)}</span>`, note: 'potential bad debt · worse direction', tip: 'Equity below zero if all markets fell or rose 10%, whichever is worse, before any liquidation.' }),
      kpi({ label: 'Insurance funds', value: usd(t.insurance_total), note: t.insurance_coverage_at_10pct !== null && t.insurance_coverage_at_10pct !== undefined ? `${multiple(t.insurance_coverage_at_10pct)} of that shortfall covered` : 'no shortfall at 10%', tip: 'Sum of all market insurance funds. Each fund covers only its own market’s shortfall, so the share covered caps at 100%.' }),
      kpi({ label: 'Absorbed, 10%', value: t.liquidity?.absorbed_at_10pct_pct !== null && t.liquidity?.absorbed_at_10pct_pct !== undefined ? atLeast(t.liquidity.complete) + multiple(t.liquidity.absorbed_at_10pct_pct) : '—', note: t.liquidity?.weakest ? `weakest: ${esc(t.liquidity.weakest.symbol)} ${t.liquidity.weakest.side === 'long' ? 'longs' : 'shorts'} ${cover(t.liquidity.weakest.cover_pct, t.liquidity.weakest.complete)}` : 'depth vs liquidation demand', tip: 'Share of the liquidations from a 10% move in all markets that each market’s own book could fill, worse direction, capped at 100%. A ≥ marks a floor: part of a book was not read.' })
    ].join('');
    const markets = overview.markets.filter(m => m.positions.count > 0).sort((a, b) => num(b.open_interest.total_notional) - num(a.open_interest.total_notional));
    if (!marketId || !markets.some(m => m.id === marketId)) marketId = markets[0]?.id ?? null;
    $('mkt').innerHTML = markets.map(m => `<option value="${m.id}" ${m.id === marketId ? 'selected' : ''}>${esc(m.symbol)}</option>`).join('');
    $('table').innerHTML = table({ id: 'risk', columns: [
      { key: 'm', label: 'Market', render: r => mktLink(r.id, r.symbol) },
      { key: 'oi', label: 'Notional', n: true, render: r => usd(r.open_interest.total_notional) },
      { key: 'pos', label: 'Positions', phone: false, n: true, render: r => `${int(r.positions.count)}<div class="sub">${int(r.positions.long)}L · ${int(r.positions.short)}S</div>` },
      { key: 'a5', label: 'At risk 5%', phone: false, n: true, render: r => usd(r.risk.notional_at_5pct) },
      { key: 'a10', label: 'At risk 10%', n: true, render: r => usd(r.risk.notional_at_10pct) },
      { key: 'sf', label: 'Shortfall 10%', n: true, render: r => (num(r.risk.shortfall_at_10pct) > 0 ? `<span class="neg">${usd(r.risk.shortfall_at_10pct)}</span>` : '<span class="faint">$0</span>') },
      { key: 'ins', label: 'Insurance', phone: false, n: true, render: r => usd(r.insurance.balance) },
      { key: 'cov', label: 'Insurance / shortfall', phone: false, n: true, tip: 'The market’s insurance fund as a multiple of its shortfall after a 10% move', render: r => (r.risk.insurance_coverage_at_10pct === null ? '<span class="faint">no shortfall</span>' : times(r.risk.insurance_coverage_at_10pct)) },
      // The weaker side, named: the stress test above shows one side at a time.
      { key: 'book', label: 'Book cover 10%', phone: false, n: true, tip: 'Order-book depth as a share of what a 10% move would liquidate, on the weaker side', render: r => { if (r.book_stale) return '<span class="faint" title="The last order-book read is too old to use">stale</span>'; if (!r.liquidity) return '<span class="faint" title="No order-book read for this market yet">not read</span>'; const c = r.liquidity.cover_at_10pct; if (c?.min_pct === null || c?.min_pct === undefined) return '<span class="faint" title="No position would reach liquidation in a 10% move">nothing to absorb</span>'; const weak = c.short_pct === c.min_pct ? 'shorts, +10%' : 'longs, −10%'; return `${cover(c.min_pct, c.complete)}<div class="sub" title="Longs in a fall or shorts in a rise, whichever the book covers less">${weak}</div>`; } },
      { key: 'top', label: 'Top 5 share', phone: false, n: true, render: r => pct(r.concentration.top5_pct, { digits: 0 }) },
      { key: 'mm', label: 'Maint. margin', phone: false, n: true, render: r => (r.margin.maintenance_margin_pct ? pct(r.margin.maintenance_margin_pct, { digits: 2 }) : '—') }
    ], rows: markets, rowAttrs: r => `class="link" data-action="pick" data-id="${r.id}"` });
    await Promise.all([ladder(), stress()]);
  }
  // The ladder is redrawn only when its figures change, and in place, so the
  // bars move to new values on the 5 s refresh instead of growing from zero.
  let drawn = null;
  async function ladder() {
    if (!marketId) return;
    const id = marketId, r = await get(`markets/${id}/ladder`, { maxAge: 5000 });
    if (!alive || id !== marketId) return; // another market was picked meanwhile
    $('ladder-meta').textContent = `${r.symbol} · notional exposed at each move`;
    const labels = r.ladder.map(x => `${x.shock_pct}%`), long = r.ladder.map(x => num(x.long.notional)), short = r.ladder.map(x => num(x.short.notional));
    const key = JSON.stringify([labels, long, short]);
    if (key === drawn) return;
    drawn = key;
    $('ladder-lg').innerHTML = labels.length ? LADDER_KEY : '';
    if (!labels.length) { $('ladder').innerHTML = empty('No positions'); return; }
    mirrored($('ladder'), { labels, long, short, legend: false });
  }
  let stressTimer = null, stressSeq = 0, resyncing = false;
  async function stress() {
    const seq = ++stressSeq;
    if (!marketId) { $('stress').innerHTML = $('hit').innerHTML = empty('No open positions'); return; }
    $('move-label').textContent = signed(move);
    if (move === 0) { $('stress').innerHTML = empty('Move the slider to simulate a price change'); $('hit').innerHTML = empty('No move selected'); $('hit-meta').textContent = ''; $('move-price').textContent = price(overview?.markets.find(m => m.id === marketId)?.prices?.mark); return; } // no move: the mark as it is
    const r = await get(`markets/${marketId}/stress?move_pct=${move}`, { maxAge: 0 });
    if (!alive || seq !== stressSeq) return; // superseded by a newer slider position
    // The order book is re-read about every 30 s. If the table above was drawn
    // from the previous read, redraw it once so both show the same book.
    const row = overview?.markets.find(m => m.id === marketId);
    const tableBook = row?.liquidity?.book_block ?? null, stressBook = r.liquidity?.book_block ?? null;
    if (tableBook && stressBook && tableBook !== stressBook && !resyncing) { resyncing = true; try { await load({ fresh: true }); } finally { resyncing = false; } return; }
    $('move-price').textContent = price(r.price);
    const absorbed = r.liquidity?.absorption_pct, range = row?.liquidity ? row.liquidity.range_pct ?? null : null;
    // Past the band the book walk covers, depth is unknown rather than zero:
    // one row says so instead of two dashes.
    const book = r.liquidity
      ? `<div class="stat"><span>Book depth to absorb</span><span>${atLeast(r.liquidity.complete) + usd(r.liquidity.depth)}</span></div><div class="stat"><span>Absorption</span><span>${absorbed === null || absorbed === undefined ? '<span class="faint">nothing to absorb</span>' : cover(absorbed, r.liquidity.complete)}</span></div>`
      : `<div class="stat rk-wide"><span>Book depth to absorb</span>${range === null ? '<span class="faint">no order book read</span>' : `<span class="faint" title="The order book is read to ${esc(range)}% either side of the mark; depth past that is unknown, not zero.">not read past ±${esc(range)}%</span>`}</div>`;
    $('stress').innerHTML = `<div class="stat-grid">
        <div class="stat"><span>Positions exposed</span><span>${int(r.liquidated.count)}</span></div><div class="stat"><span>Notional exposed</span><span>${usd(r.liquidated.notional)}</span></div>
        <div class="stat"><span>Share of ${r.side === 'short' ? 'short' : 'long'} open interest</span><span>${pct(r.liquidated.share_of_oi_pct, { digits: 1 })}</span></div><div class="stat"><span>Side exposed</span><span>${sideTag(r.side)}</span></div>
        <div class="stat"><span>Shortfall (bad debt)</span><span class="${num(r.shortfall) > 0 ? 'neg' : ''}">${usd(r.shortfall)}</span></div><div class="stat"><span>Insurance covers</span><span>${r.insurance_coverage_pct === null ? '<span class="faint">no shortfall</span>' : `<span title="The market’s insurance fund as a multiple of this shortfall">${times(r.insurance_coverage_pct)}</span>`}</span></div>
        ${book}
      </div>
      <div class="panel-foot risk-foot"><span>A static price shock: positions whose liquidation price lies inside the move. Real liquidations depend on the path, the book and keepers.</span><span class="faint num">Positions at block ${int(r.block)}${stressBook ? ` · book read at ${int(stressBook)}` : ''}</span></div>`;
    const hits = r.positions_hit.slice(0, 8);
    $('hit-meta').textContent = `${r.symbol} ${signed(move)}${hits.length ? ` · ${hits.length < r.liquidated.count ? `${int(hits.length)} largest of ${int(r.liquidated.count)}` : `${int(hits.length)} positions`}` : ''}`;
    $('hit').innerHTML = hits.length ? table({ id: 'hit', compact: true, columns: [
      { key: 'a', label: 'Trader', render: p => addr(p.address, p.account_id) },
      { key: 's', label: 'Side', render: p => sideTag(p.side) },
      { key: 'n', label: 'Notional', n: true, render: p => usd(p.notional) },
      { key: 'l', label: 'Leverage', phone: false, n: true, render: p => (p.leverage ? `${p.leverage.toFixed(1)}x` : '—') },
      { key: 'lp', label: 'Liq. price', phone: false, n: true, render: p => price(p.liquidation_price) },
      { key: 'd', label: 'Liq. distance', n: true, render: p => pct(p.liquidation_distance_pct, { digits: 1 }) },
      { key: 'u', label: 'uPnL', phone: false, n: true, render: p => pnl(p.pnl) }
    ], rows: hits }) : empty('No position reaches its liquidation price at this move');
  }
  $('mkt').addEventListener('change', e => { marketId = Number(e.target.value); setQuery({ market: marketId }); });
  $('move').addEventListener('input', e => { move = Number(e.target.value); $('move-label').textContent = signed(move); clearTimeout(stressTimer); stressTimer = setTimeout(() => { stress().catch(() => {}); }, 120); });
  $('move').addEventListener('change', () => setQuery({ move }));
  const timer = setInterval(() => load().catch(() => {}), 5000); // contract state, cached per block on the server
  load().catch(error => { $('kpis').innerHTML = `<div class="empty-state">${esc(error.message)}</div>`; });
  return {
    onAction(a, t) { if (a === 'pick') { marketId = Number(t.dataset.id); $('mkt').value = String(marketId); setQuery({ market: marketId }); } },
    update(q) { marketId = Number(q.get('market')) || marketId; move = moveOf(q, move); $('move').value = String(move); ladder().catch(() => {}); stress().catch(() => {}); },
    destroy() { alive = false; clearInterval(timer); clearTimeout(stressTimer); }
  };
}
export { size };
