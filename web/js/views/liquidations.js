// Liquidations: window totals, liquidated notional over time by side, and the
// full feed (on-book liquidations and auto-deleveraging), live.
import { get, stream } from '../api.js';
import { usd, int, price, esc, dateTime, ago, num, size } from '../format.js';
import { kpi, seg, table, mktLink, sideTag, addr, pnl, skeleton, skChart, empty, ICON, colorOf, hasColor, OTHER_HEX, assignColors, chartTools, mergeByAsset } from '../ui.js';
import { stackedBars } from '../charts.js';

const WINDOWS = [['24h', '24H'], ['7d', '7D'], ['30d', '30D'], ['all', 'All']];
const BUCKETS = { 3600: 'Per hour', 14400: 'Per 4 hours', 86400: 'Per day', 604800: 'Per week' };

export function mount(el, { query, setQuery }) {
  let w = WINDOWS.some(([v]) => v === query.get('window')) ? query.get('window') : '24h';
  let market = query.get('market') ?? '';
  let alive = true, markets = [], adl = null; // { key: filters counted under, n }
  el.innerHTML = `
    <div class="page-head"><div><h1>Liquidations</h1><div class="sub">Forced closes from exchange events: liquidations on the order book and auto-deleveraging.</div></div><div id="win">${seg('window', WINDOWS, w)}</div></div>
    <div class="stack"><div class="kpis k4" id="kpis"></div>
      <section class="panel lq-chart"><div class="panel-head"><div><h2>Liquidated notional <span class="info-tip" title="Notional liquidated per period, by market, with the running total as a line. Excludes ADL and force closes.">i</span></h2><div class="desc" id="chart-desc"></div></div><div class="head-right"><div class="legend dots" id="legend"></div>${chartTools('chart', 'liquidations')}</div></div><div class="panel-body"><div class="chart" id="chart">${skChart()}</div></div></section>
      <section class="panel"><div class="panel-head"><h2>Feed</h2><div class="lq-feed-ctl"><span class="meta" id="feed-meta" title="Includes ADL and force closes, so it can exceed the liquidation count above."></span><select id="mf" class="btn ghost" aria-label="Market filter"><option value="">All markets</option></select><a class="btn ghost" id="csv">${ICON.download} CSV</a></div></div><div class="panel-body flush" id="feed">${skeleton(10)}</div></section></div>`;
  const $ = s => el.querySelector(`#${s}`);
  // The feed pages through every event of the window, newest first, fifty at a time.
  const PAGE = 50;
  let page = 0;
  const feedPath = (n = page) => `liquidations?limit=${PAGE}&offset=${n * PAGE}&window=${w}${market ? `&market=${market}` : ''}`;
  // Responses for a window or market that has since changed are dropped.
  const filters = () => `${w}|${market}`;
  async function load() {
    const mq = market ? `&market=${market}` : '', asked = filters();
    const [p, s, l] = await Promise.all([get(`protocol?window=${w}`), get(`protocol/series?window=${w}${mq}`), get(feedPath(0))]);
    if (!alive || asked !== filters()) return;
    markets = p.markets;
    assignColors([...p.markets].sort((a, b) => num(b.volume) - num(a.volume)).map(m => ({ id: m.id, symbol: m.symbol })));
    const h = p.headline, row = market ? p.markets.find(m => String(m.id) === market) ?? null : null, wl = w === 'all' ? 'all-time' : w;
    // A market filter narrows the KPIs and the chart too, not only the feed. A
    // market with nothing in the window had no liquidations and no volume, not unknowns.
    const liquidated = row ? row.liquidated ?? 0 : h.liquidated.value, count = row ? row.liquidations ?? 0 : h.liquidations.value, volume = row ? row.volume ?? 0 : h.volume.value;
    const largest = l.largest ?? null; // the largest inside the window, from the server
    // ADL and force closes: the headline counts them for all markets only, so
    // one market's are its feed events less its liquidations.
    adl = { key: asked, n: row ? Math.max(0, num(l.total) - (num(count) ?? 0)) : market ? null : num(h.deleverages) };
    $('kpis').innerHTML = [
      kpi({ label: `Liquidated · ${wl}${row ? ` · ${row.symbol}` : ''}`, value: usd(liquidated), delta: row || w === 'all' || p.meta.previous_complete === false ? undefined : h.liquidated.change_pct, basis: 'vs prev', basisTitle: `Compared with the previous ${wl}`, invert: true, note: `${int(count)} ${num(count) === 1 ? 'liquidation' : 'liquidations'}` }),
      // With no volume there is no share to take: the note says why.
      kpi({ label: 'Share of volume', value: num(volume) ? `${(num(liquidated) / num(volume) * 100).toFixed(2)}%` : '—', note: num(volume) ? `of ${usd(volume)} traded` : `no trades in ${wl}` }),
      kpi({ label: 'ADL, force closes', value: int(adl.n), note: 'closed by the protocol', tip: 'Closes forced by the protocol, full or partial: auto-deleveraging against a bankrupt position, or a force close at the mark price.' }),
      kpi({ label: `Largest · ${wl}`, value: largest ? usd(largest.notional) : '—', note: largest ? `${esc(largest.symbol)} ${esc(largest.side ?? '')} · ${ago(largest.ts)}` : 'none in this window' })
    ].join('');
    const node = $('chart'); node.innerHTML = '';
    let list;
    if (row) list = [{ name: row.symbol, color: colorOf(row.id), data: s.points.map(x => num(x.liquidated)) }].filter(x => x.data.some(v => v > 0));
    else {
      const withLiq = mergeByAsset(s.by_market ?? [], ['liquidated']).filter(m => m.liquidated.some(v => num(v) > 0));
      const top = withLiq.filter(m => hasColor(m.id)), rest = withLiq.filter(m => !hasColor(m.id));
      list = top.map(m => ({ name: m.symbol, color: colorOf(m.id), data: m.liquidated.map(num) }));
      if (rest.length) list.push({ name: 'Other', color: OTHER_HEX, data: s.times.map((_, i) => rest.reduce((a, m) => a + num(m.liquidated[i]), 0)) });
    }
    $('legend').innerHTML = list.map(x => `<span><i style="background:${x.color}"></i>${esc(x.name)}</span>`).join('') + (list.length ? '<span><i style="background:#fff"></i>Cumulative</span>' : '');
    $('chart-desc').textContent = list.length ? `${BUCKETS[s.meta.bucket_seconds] ?? 'Per period'}${row ? '' : ' by market'} · line: running total` : '';
    if (list.length) stackedBars(node, { times: s.times, series: list, bucketSeconds: s.meta.bucket_seconds, cumulative: true, zoom: true }); else node.innerHTML = empty('No liquidations in this window');
    // The delisted original and its relisting share a name: the old one says so.
    $('mf').innerHTML = `<option value="">All markets</option>${markets.filter(m => m.liquidations || m.id === Number(market)).map(m => `<option value="${m.id}" ${String(m.id) === market ? 'selected' : ''}>${esc(m.symbol)}${m.active === false ? ' (inactive)' : ''}</option>`).join('')}`;
    $('csv').href = `/api/v1/liquidations?limit=10000&window=${w}&format=csv${mq}`;
    page = 0;
    renderFeed(l);
  }
  function renderFeed(l) {
    const rows = l.rows, total = l.total ?? rows.length, pages = Math.max(1, Math.ceil(total / PAGE));
    // The feed has ADL and force closes too, so it runs longer than the liquidation
    // count above. A redraw under filters not yet loaded leaves the count out.
    const n = adl?.key === filters() ? adl.n : null;
    $('feed-meta').textContent = `${int(total)} events${n ? ` · incl. ${int(n)} ADL and force close${n === 1 ? '' : 's'}` : ''} · ${w === 'all' ? 'all-time' : w}`;
    const first = total ? page * PAGE + 1 : 0, last = page * PAGE + rows.length;
    const pager = pages > 1 ? `<div class="panel-foot pager"><span>${int(first)}–${int(last)} of ${int(total)}</span><span class="pager-ctl"><button class="btn ghost sm" data-action="prev" ${page === 0 ? 'disabled' : ''}>← Prev</button><span class="num">Page ${int(page + 1)} of ${int(pages)}</span><button class="btn ghost sm" data-action="next" ${page + 1 >= pages ? 'disabled' : ''}>Next →</button></span></div>` : '';
    $('feed').innerHTML = table({ id: 'liq', columns: [
      { key: 't', label: 'Time (UTC)', render: r => `<span class="muted num">${dateTime(r.ts)}</span>` },
      { key: 'm', label: 'Market', render: r => mktLink(r.market, r.symbol) },
      { key: 'k', label: 'Type', render: r => (r.kind === 'deleverage' ? (r.force_close ? '<span class="tag warn">Force close</span>' : '<span class="tag warn">ADL</span>') : `<span class="tag">${r.on_book ? 'Order book' : 'Liquidation'}</span>`) },
      { key: 's', label: 'Position', render: r => sideTag(r.side) },
      { key: 'a', label: 'Trader', render: r => addr(r.address, r.account) },
      { key: 'sz', label: 'Size', n: true, render: r => size(r.size) },
      { key: 'p', label: 'Price', n: true, render: r => price(r.price) },
      { key: 'mk', label: 'Mark', n: true, render: r => price(r.mark) },
      { key: 'n', label: 'Notional', n: true, render: r => usd(r.notional) },
      { key: 'pnl', label: 'Realized', n: true, render: r => pnl(r.pnl) },
      { key: 'rem', label: 'Remaining', n: true, render: r => (num(r.remaining) ? size(r.remaining) : '<span class="faint">closed</span>') }
    ], rows, rowAttrs: r => `class="link ${r.fresh ? 'flash' : ''}" data-href="/wallet/${esc(r.address || r.account)}"`, emptyText: 'No liquidations indexed in this range' }) + pager;
  }
  async function goTo(n) {
    const asked = filters();
    const l = await get(feedPath(n), { maxAge: 3000 });
    if (!alive || asked !== filters()) return;
    page = n; renderFeed(l);
    const top = $('feed').closest('section');
    if (top.getBoundingClientRect().top < 0) top.scrollIntoView({ block: 'start' });
  }
  $('mf').addEventListener('change', e => setQuery({ market: e.target.value || null }));
  const off = stream.on('liquidations', () => { if (page !== 0) return; const asked = filters(); get(feedPath(0), { maxAge: 0 }).then(l => { if (alive && page === 0 && asked === filters()) renderFeed({ ...l, rows: l.rows.map((r, i) => ({ ...r, fresh: i === 0 })) }); }).catch(() => {}); });
  load().catch(error => { $('feed').innerHTML = empty(error.message); });
  return {
    onAction(a) { if (a === 'prev' && page > 0) goTo(page - 1).catch(() => {}); if (a === 'next') goTo(page + 1).catch(() => {}); },
    onSeg(name, v) { if (name === 'window') setQuery({ window: v === '24h' ? null : v }); },
    update(q) { w = WINDOWS.some(([v]) => v === q.get('window')) ? q.get('window') : '24h'; market = q.get('market') ?? ''; $('win').innerHTML = seg('window', WINDOWS, w); load().catch(() => {}); },
    destroy() { alive = false; off(); }
  };
}
