// Data pipeline status, integrity checks and methodology: what every number
// is, where it comes from and how it is verified.
import { get } from '../api.js';
import { int, esc, ago, dateTime, pct, usd, num } from '../format.js';
import { table, skeleton, empty, mkt } from '../ui.js';

const dot = s => `<span class="status-dot ${s}"></span>`;

export function mount(el) {
  let alive = true;
  // The two short check lists share a row; the per-market table gets the full width.
  el.innerHTML = `<div class="page-head"><div><h1>Data &amp; methodology</h1><div class="sub">How Plumb gets its numbers, and the live checks that compare them with the contract.</div></div></div>
    <div class="stack">
      <section class="panel"><div class="panel-head"><h2>Pipeline</h2><span class="meta" id="gen"></span></div><div class="pipeline" id="pipeline">${skeleton(3)}</div></section>
      <div class="grid g-2">
        <section class="panel st-checks"><div class="panel-head"><h2>Contract snapshot checks</h2><span class="meta">Every poll and periodic full rescan</span></div><div id="checks">${skeleton(3)}</div></section>
        <section class="panel st-checks"><div class="panel-head"><h2>Decoder checks</h2><span class="meta" id="decoder-meta">Since the ingest started</span></div><div id="decoder">${skeleton(4)}</div></section>
      </div>
      <section class="panel"><div class="panel-head"><h2>Integrity checks</h2><span class="meta">Indexed events vs contract counters</span></div><div id="integrity">${skeleton(6)}</div></section>
      <section class="panel"><div class="panel-head"><h2>Definitions</h2></div><div class="doc">
        <h3>Volume</h3>Sum of maker-fill notional (price × size of every <code>MakerOrderFilled</code>), so each match counts once. Notional is computed with integer arithmetic from the market's price and lot decimals.
        <h3>Fees</h3>Maker plus taker fees charged on fills. The exchange splits every fee into an insurance-fund part and a protocol part (<code>insFeeCNS + protFeeCNS</code> on the position event equals the fill fee, checked on every fill that opens, increases or flips a position; reducing fills carry no fee up to contract v1.1.7.4). A builder's share is part of the fill fee and of the protocol part. Fees are gross: rebates and referral shares are paid outside fills.
        <h3>Open interest</h3>Live: long lots × mark price from <code>getPerpetualInfoV2</code> (long and short lots are equal by construction, so this counts each contract once). History: the running sum of lot changes from position events since the exchange was deployed, priced at the last trade; the running sum is compared with the contract's counters below.
        <h3>TVL and flows</h3>Live TVL is the exchange's collateral balance read from the contract. History is deposits − withdrawals (plus protocol balance movements) since deployment; net flow is deposits − withdrawals in the window.
        <h3>Active traders</h3>Distinct accounts with at least one trade (open, increase, decrease, close, flip, or a liquidation executed on the book) in the window.
        <h3>Realized and net PnL</h3>Realized PnL is <code>deltaPnl + funding</code> reported by decrease, close, flip, liquidation and deleveraging events, plus the funding the contract settles when a position is increased. Net PnL subtracts the fees the account paid: fill fees, and on a liquidation the share of the remaining margin that goes to the insurance fund and protocol (the trader keeps 80 % by default).
        <h3>Round trips, win rate, profit factor, drawdown</h3>Perpl holds one position per account and market. A round trip starts when that position leaves zero and ends when it returns to zero (a flip closes one side and opens the other). A win is a trip with positive net PnL; profit factor is gross wins ÷ gross losses; maximum drawdown is the largest peak-to-trough fall of cumulative net PnL over closed trips; hold time uses block timestamps.
        <h3>Liquidation risk</h3>Liquidation and bankruptcy prices follow the Perpl documentation and perpl-sdk (<code>position.rs</code>), recomputed for every open position from contract state; a position's PnL is checked against <code>getPositionsV2</code>.
        <h3>Freshness</h3>Only finalized blocks are indexed, so no stored number is ever rolled back (only the dimmed trades of proposed blocks are provisional). The ingest wakes on the execution-events sidecar, WebSocket heads or a 400 ms timer, reads new finalized blocks with <code>eth_getLogs</code>, commits to ClickHouse about once a second and pushes to this page over server-sent events. Contract state follows each commit; the order book is re-walked every 30 s.
      </div></section>
    </div>`;
  const $ = s => el.querySelector(`#${s}`);
  async function load() {
    const [h, v] = await Promise.all([get('health', { maxAge: 0 }), get('validation', { maxAge: 0 }).catch(() => null)]);
    if (!alive) return;
    const live = h.index?.live, b = h.index?.backfill, r = h.index?.rollups, feed = h.feeds;
    const lag = live?.finalized && live?.to ? Number(live.finalized) - Number(live.to) : null;
    const trigger = feed?.exec_events?.connected ? 'execution events' : feed?.heads?.connected ? 'WebSocket heads' : 'polling';
    $('gen').textContent = `Updated ${new Date().toISOString().slice(11, 19)} UTC`;
    $('pipeline').innerHTML = [
      `<div class="stage"><h3>${dot(lag !== null && lag < 10 ? 'ok' : 'warn')}Live ingest</h3><div class="v">#${int(live?.to)}</div><div class="d">${lag === null ? '—' : `${lag} blocks behind finalized`} · woken by ${trigger}</div><div class="d">${int(live?.commits)} commits · ${int(live?.rows)} rows</div></div>`,
      `<div class="stage"><h3>${dot(b?.running ? 'warn' : b?.failed?.length ? 'bad' : 'ok')}History</h3><div class="v">${b?.pct === null || b?.pct === undefined ? '100%' : pct(b.pct, { digits: 1 })}</div><div class="d">${b?.running ? `indexing · ${int(b.rate_blocks_per_s)} blocks/s` : 'complete'} · ${int(h.index?.coverage?.length)} coverage range(s)</div><div class="d">since block ${esc(h.index?.coverage?.[0]?.from ?? '—')}</div></div>`,
      `<div class="stage"><h3>${dot(r?.lastError ? 'bad' : 'ok')}Hourly rollups</h3><div class="v">${int(r?.hours)} h</div><div class="d">${int(r?.pending)} pending · last run ${r?.lastRunMs ?? '—'} ms</div></div>`,
      `<div class="stage"><h3>${dot(h.snapshot?.status === 'fresh' ? 'ok' : 'warn')}Contract state</h3><div class="v">#${int(h.snapshot?.block)}</div><div class="d">${esc(h.snapshot?.status ?? '')}${h.snapshot?.status_reason ? ` (${esc(h.snapshot.status_reason)})` : ''} · contract ${esc(h.snapshot?.contract_version ?? '—')} · ${int(h.collector?.polls)} polls · ${int(h.collector?.rpc_requests)} RPC requests</div><div class="d">${int(feed?.sse_clients)} live viewers</div></div>`
    ].join('');
    const integ = v?.integrity;
    const ready = integ?.complete && !integ.pending && integ.block;
    if (!ready) $('integrity').innerHTML = empty(integ?.complete ? 'Waiting for the index and the contract snapshot to reach the same block.' : 'Available once the full history is indexed (the running sums need every event since deployment).');
    // A relisted market shares its symbol with the old one; the id tells them apart.
    const seen = integ?.open_interest?.map(x => x.symbol) ?? [], twin = x => seen.filter(y => y === x.symbol).length > 1;
    // The verdict sits beside the market, so a phone sees it before the table scrolls.
    if (ready) $('integrity').innerHTML = `<div class="panel-body faint" style="font-size:12.5px">${esc(integ.method)} Block ${esc(integ.block)}.</div>` + table({ id: 'int', compact: true, columns: [
      { key: 'm', label: 'Market', render: x => `${mkt(x.market, x.symbol)}${twin(x) ? ` <span class="faint">#${esc(x.market)}</span>` : ''}` },
      { key: 'ok', label: 'Result', render: x => (x.ok ? '<span class="tag good">match</span>' : '<span class="tag bad">mismatch</span>') },
      { key: 'l', label: 'Long lots (events / contract)', n: true, render: x => `${esc(x.events_long)} / ${esc(x.contract_long)}` },
      { key: 's', label: 'Short lots (events / contract)', n: true, render: x => `${esc(x.events_short)} / ${esc(x.contract_short)}` }
    ], rows: integ.open_interest }) + (integ.tvl ? `<div class="panel-foot st-tvl"><span>TVL from events ${usd(integ.tvl.events)} · contract ${usd(integ.tvl.contract)}</span>${integ.tvl.ok ? '<span class="tag good">match</span>' : '<span class="tag warn">differs</span>'}</div>` : '');
    const rec = v?.reconciliation, ver = v?.verification;
    $('checks').innerHTML = `<div class="stat-grid" style="grid-template-columns:1fr">
      <div class="stat"><span>${dot(rec?.ok ? 'ok' : 'bad')} Stored positions sum to the contract's open-interest counters</span><span>${rec ? `${rec.ok ? 'OK' : 'mismatch'} · block ${esc(rec.block)}` : '—'}</span></div>
      <div class="stat"><span>${dot(ver?.ok ? 'ok' : ver?.ok === null ? 'warn' : 'bad')} Independent rescan of every account's position bitmap</span><span>${ver ? `${ver.ok ? 'OK' : 'mismatch'} · ${int(ver.accounts)} accounts · ${ver.at ? ago(ver.at / 1000) : ''}` : '—'}</span></div>
      <div class="stat"><span>${dot((v?.pnl_agreement ?? []).every(x => (x.agree ?? 0) === (x.checked ?? 0)) ? 'ok' : 'bad')} Position PnL recomputed and compared with getPositionsV2</span><span>${(v?.pnl_agreement ?? []).reduce((a, x) => a + (x.agree ?? 0), 0)} / ${(v?.pnl_agreement ?? []).reduce((a, x) => a + (x.checked ?? 0), 0)} agree</span></div>
    </div>`;
    const c = h.index?.decoder_checks;
    $('decoder-meta').textContent = c ? `Since the ingest started · ${int(c.logs)} logs` : 'Since the ingest started';
    if (!c) $('decoder').innerHTML = empty('Counted once the ingest has decoded new logs.');
    else $('decoder').innerHTML = `<div class="stat-grid" style="grid-template-columns:1fr">
      <div class="stat"><span>${dot(c.unlinked ? 'warn' : 'ok')} Position events linked to their fill</span><span>${int(c.linked)} / ${int(c.userEvents)}</span></div>
      <div class="stat"><span>${dot(c.lotMismatch ? 'bad' : 'ok')} Fill size equals the position change</span><span>${int(c.lotMismatch)} mismatches</span></div>
      <div class="stat"><span>${dot(c.feeMismatch ? 'bad' : 'ok')} Fill fee equals insurance + protocol fee</span><span>${int(c.feeChecked - c.feeMismatch)} / ${int(c.feeChecked)}</span></div>
      <div class="stat"><span>${dot(c.takerFillsUnlinked ? 'warn' : 'ok')} Liquidations linked to their book fill</span><span>${int(c.forcedLinked)} linked · ${int(c.takerFillsUnlinked)} unlinked fills</span></div>
    </div>`;
  }
  load().catch(error => { $('pipeline').innerHTML = empty(error.message); });
  const timer = setInterval(() => load().catch(() => {}), 5000);
  return { destroy() { alive = false; clearInterval(timer); } };
}
export { dateTime, num };
