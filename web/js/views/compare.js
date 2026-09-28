// Side-by-side comparison of up to five wallets: key metrics in columns and
// their cumulative net PnL on one chart (each wallet keeps its colour).
import { get } from '../api.js';
import { usd, int, pct, num, esc, short, duration, date } from '../format.js';
import { pnl, empty, skeleton, ICON, SLOT_HEX, watch, chartTools } from '../ui.js';
import { lineChart } from '../charts.js';

// Wallet errors from the API, in words.
const ERRORS = { INVALID_ACCOUNT: 'not a full address or account ID', NOT_FOUND: 'no Perpl account', ACCOUNT_NOT_FOUND: 'no Perpl account' };

const COLORS = [SLOT_HEX[0], SLOT_HEX[1], SLOT_HEX[2], SLOT_HEX[3], SLOT_HEX[4]];
// A wallet keeps its colour while it stays on the page, so removing one does not
// recolour the rest; a new one takes the first colour free (kept for the tab).
let slots = {};
try { slots = JSON.parse(sessionStorage.getItem('ps.compare.colors') || '{}'); } catch { slots = {}; }
function colourKeys(keys) {
  const next = {}, taken = new Set();
  for (const k of keys) if (COLORS[slots[k]] && !taken.has(slots[k])) { next[k] = slots[k]; taken.add(slots[k]); }
  for (const k of keys) if (next[k] === undefined) { next[k] = COLORS.findIndex((_, i) => !taken.has(i)); taken.add(next[k]); }
  slots = next;
  try { sessionStorage.setItem('ps.compare.colors', JSON.stringify(slots)); } catch { /* storage unavailable */ }
  return k => COLORS[slots[k]];
}

export function mount(el, { query, navigate }) {
  let keys = (query.get('w') ?? '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 5);
  let alive = true;
  el.innerHTML = `
    <div class="page-head"><div><h1>Compare wallets</h1><div class="sub">Up to five wallets side by side. Add from any wallet page or paste addresses.</div></div>
      <form id="add" style="display:flex;gap:8px;flex:0 1 440px;min-width:0"><div class="search" style="margin:0;flex:1;max-width:none"><input id="add-input" placeholder="Add address or account ID" autocomplete="off" spellcheck="false"></div><button class="btn primary" type="submit">${ICON.plus} Add</button></form></div>
    <div class="stack"><section class="panel" id="table">${skeleton(10)}</section>
    <section class="panel trend cmp-chart"><div class="panel-head"><div class="trend-id"><h2>Cumulative net PnL <span class="info-tip" title="Realized PnL after fees, funding included, summed by UTC day from each wallet's first trade">i</span></h2></div><div class="trend-side"><div class="trend-ctl">${chartTools('chart', 'compare-pnl')}</div><div class="legend dots" id="legend"></div></div></div><div class="panel-body"><div class="chart" id="chart"></div></div></section></div>`;
  const $ = s => el.querySelector(`#${s}`);
  const save = () => { try { sessionStorage.setItem('ps.compare', JSON.stringify(keys)); } catch { /* storage unavailable */ } };

  async function load() {
    if (!keys.length) {
      const suggested = watch.list().slice(0, 5).map(w => w.key);
      $('table').innerHTML = empty(suggested.length ? 'No wallets selected. Your watchlist is below.' : 'No wallets selected. Add an address above or use Compare on a wallet page.');
      if (suggested.length) $('table').innerHTML += `<div class="panel-foot"><span>Watchlist: ${suggested.map(k => `<a href="#/compare?w=${esc(k)}">${esc(short(k))}</a>`).join(' · ')}</span><button class="btn" data-action="all-watch">Compare watchlist</button></div>`;
      $('chart').innerHTML = ''; $('chart').closest('.panel').hidden = true;
      return;
    }
    const r = await get(`compare?wallets=${keys.map(encodeURIComponent).join(',')}`, { maxAge: 5000 });
    if (!alive) return;
    const ws = r.wallets, colour = colourKeys(ws.map(w => w.key));
    $('chart').closest('.panel').hidden = false;
    // Each wallet keeps its colour: a dot in its header, on each of its values on phones, and its chart line.
    const remove = w => `<button class="icon-btn" data-action="remove" data-key="${esc(w.key)}" title="Remove">${ICON.x}</button>`;
    const col = w => w.error ? `<th class="n"><span class="cmp-w"><span class="neg">${esc(short(w.key))}</span>${remove(w)}</span><div class="sub">${esc(ERRORS[w.error] ?? 'not found')}</div></th>` : `<th class="n" style="--c:${colour(w.key)}"><span class="cmp-w"><i></i><a class="mono" href="#/wallet/${esc(w.account.address)}">${esc(short(w.account.address))}</a>${remove(w)}</span><div class="sub">#${esc(w.account.id)}</div></th>`;
    const rows = [
      ['Account value', w => usd(w.portfolio?.account_value)],
      ['Open positions', w => int(w.positions?.length ?? 0)],
      ['Unrealized PnL', w => pnl(w.portfolio?.unrealized_pnl)],
      ['Net PnL (all-time)', w => pnl(w.summary.net_pnl)],
      ['Realized PnL', w => pnl(w.summary.realized)],
      ['Fees paid', w => usd(w.summary.fees)],
      ['Volume', w => usd(w.summary.volume)],
      ['Trades', w => int(w.summary.trades)],
      ['Maker share', w => pct(w.summary.maker_share_pct, { digits: 0 })],
      ['Win rate', w => (w.performance.win_rate_pct === null ? '—' : pct(w.performance.win_rate_pct, { digits: 1 }))],
      ['Profit factor', w => (w.performance.profit_factor === null ? '—' : w.performance.profit_factor.toFixed(2))],
      ['Closed round trips', w => int(w.performance.closed_trips)],
      ['Average win', w => usd(w.performance.average_win)],
      ['Average loss', w => usd(w.performance.average_loss)],
      ['Max drawdown', w => usd(w.performance.max_drawdown)],
      ['Best streak', w => `${int(w.performance.best_streak)}W`],
      ['Worst streak', w => `${int(w.performance.worst_streak)}L`],
      ['Median hold', w => duration(w.performance.median_hold_seconds)],
      ['Long / short trips', w => `${int(w.performance.long.trips)} / ${int(w.performance.short.trips)}`],
      ['Best market', w => (w.performance.best_market ? esc(w.performance.best_market.symbol) : '—')],
      ['Weakest market', w => (w.performance.worst_market ? esc(w.performance.worst_market.symbol) : '—')],
      ['Liquidations', w => int(w.summary.liquidations)],
      ['Net deposits', w => usd(w.summary.net_flow, { sign: true })],
      ['First trade', w => (w.summary.first_trade ? date(w.summary.first_trade) : '—')]
    ];
    // On phones each metric's label sits over its values, up to three a row
    // (four or five wallets take two rows), so no wallet is off-screen.
    // Round-trip rows (win rate to weakest market) of a long history come from its
    // latest events, as the wallet page says; the totals use every event.
    const cut = ws.filter(w => !w.error && w.performance?.based_on?.truncated);
    const note = cut.length ? `<div class="panel-foot"><span>Rows from win rate to weakest market use only the latest events of a long history: ${cut.map(w => `${esc(short(w.account.address))} ${int(w.performance.based_on.events)} of ${int(w.performance.based_on.total_events)} events${w.performance.based_on.since ? ` (since ${date(w.performance.based_on.since)})` : ''}`).join(' · ')}. Totals use full history.</span></div>` : '';
    $('table').innerHTML = `<div class="table-wrap"><table class="t compact cmp" style="--cols:${ws.length > 3 ? Math.ceil(ws.length / 2) : ws.length}"><thead><tr><th class="cmp-m">Metric</th>${ws.map(col).join('')}</tr></thead><tbody>${rows.map(([label, f]) => `<tr><td class="muted cmp-m">${label}</td>${ws.map(w => (w.error ? '<td class="n faint">—</td>' : `<td class="n" style="--c:${colour(w.key)}">${f(w)}</td>`)).join('')}</tr>`).join('')}</tbody></table></div>${note}`;
    // Cumulative PnL on a shared daily axis.
    const full = await Promise.all(ws.map(w => (w.error ? null : get(`wallets/${encodeURIComponent(w.account.address)}`, { maxAge: 10000 }).catch(() => null))));
    if (!alive) return;
    // Every calendar day from the first to the last, so quiet days keep their width.
    const seen = full.flatMap(f => (f?.pnl_daily ?? []).map(p => p.t)), days = [];
    if (seen.length) for (let t = Math.min(...seen); t <= Math.max(...seen); t += 86400) days.push(t);
    const series = full.map((f, i) => { if (!f) return null; const map = new Map(f.pnl_daily.map(p => [p.t, num(p.cumulative)])); let last = null; return { name: short(f.account.address), color: colour(ws[i].key), data: days.map(t => { if (map.has(t)) last = map.get(t); return last; }) }; }).filter(Boolean);
    $('legend').innerHTML = series.map(s => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('');
    if (days.length) lineChart($('chart'), { times: days, series, bucketSeconds: 86400, fmt: v => usd(v, { sign: true }), area: false }); else $('chart').innerHTML = empty('No realized PnL yet');
  }
  $('add').addEventListener('submit', e => { e.preventDefault(); const v = $('add-input').value.trim(); if (!/^(0x[0-9a-fA-F]{40}|\d{1,9})$/.test(v)) return; if (!keys.includes(v)) keys = [...keys, v].slice(-5); save(); navigate('/compare', { w: keys.join(',') }); });
  load().catch(error => { $('table').innerHTML = empty(`Could not load (${error.message})`); });
  return {
    onAction(a, t) {
      if (a === 'remove') { keys = keys.filter(k => k !== t.dataset.key); save(); navigate('/compare', keys.length ? { w: keys.join(',') } : null); }
      if (a === 'all-watch') navigate('/compare', { w: watch.list().slice(0, 5).map(w => w.key).join(',') });
    },
    update(q) { keys = (q.get('w') ?? '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 5); load().catch(() => {}); },
    destroy() { alive = false; }
  };
}
