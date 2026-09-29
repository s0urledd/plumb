// Protocol and wallet analytics endpoints over the ClickHouse index, merged
// with the live contract state held by the risk collector (open interest,
// TVL, positions, funding). Responses are cached briefly per window and
// recomputed in the background, so requests are served from memory.
import { BALANCE_MOVES, BALANCE_KINDS, protocolBalance, CHECKED_FROM_TS } from './revenue.js';
import * as m from './math.js';
import { WINDOWS, BUCKETS, DEFAULT_BUCKET } from './query.js';
import { roundTrips, performance, insights, activityGrid } from './analytics.js';
import { metrics as computeMetrics } from './state.js';
import { cohortTable } from './cohorts.js';

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const HOUR = 3600, DAY = 86400, YEAR = 365 * DAY; // funding is annualised over 365 days

// A value is served for ttlMs, then (up to twice that age) served stale while
// it is recomputed in the background; older values, and `fresh` requests,
// wait for a new computation. A computation never replaces a newer one.
export function createCache({ now = () => Date.now(), max = 500 } = {}) {
  const store = new Map(); // key -> { at, value, seq, pending }
  let seq = 0;
  async function get(key, ttlMs, compute, { fresh = false } = {}) {
    const hit = store.get(key);
    const age = hit && hit.value !== undefined ? now() - hit.at : Infinity;
    if (!fresh && age < ttlMs) return hit.value;
    const stale = !fresh && age < 2 * ttlMs;
    if (!fresh && hit?.pending) return stale ? hit.value : hit.pending;
    const n = ++seq;
    const pending = compute().then(value => {
      const cur = store.get(key);
      if (!cur || n > cur.seq) store.set(key, { at: now(), value, seq: n, pending: cur?.pending === pending ? null : cur?.pending ?? null });
      else if (cur.pending === pending) cur.pending = null;
      return value;
    }, error => { const cur = store.get(key); if (cur?.pending === pending) cur.pending = null; if (cur && cur.value === undefined && !cur.pending) store.delete(key); throw error; });
    if (stale) pending.catch(() => {}); // a failed background refresh keeps the stale value
    if (!store.has(key) && store.size >= max) store.delete(store.keys().next().value);
    store.set(key, { at: hit?.at ?? 0, value: hit?.value, seq: hit?.seq ?? 0, pending });
    return stale ? hit.value : pending;
  }
  return { get, clear: () => store.clear(), size: () => store.size };
}

// Directional leaders from a PnL leaderboard: profitable accounts, market
// makers (mostly maker fills) and high-frequency accounts (5,000+ trades a day)
// left out, the first `top` kept in rank order.
export function pickLeaders(rows, { days, top }) {
  const maker = r => r.trades >= 100 && (r.maker_share_pct ?? 0) >= 80;
  const fast = r => r.trades / days >= 5000;
  const profitable = rows.filter(r => Number(r.pnl) > 0);
  return { leaders: profitable.filter(r => !maker(r) && !fast(r)).slice(0, top), excluded: profitable.filter(r => maker(r) || fast(r)).length };
}

export function createAnalyticsApi({ ch = null, ingest, rollups, queries, collector, accountState = null, now = () => Date.now(), maxTripEvents = 150000 }) {
  const { state } = collector;
  const cache = createCache({ now });
  const cd = () => ingest.collateralDecimals;
  const dec = (v, d = cd()) => (v === null || v === undefined ? null : m.toDecimalString(BigInt(v), d));
  const B = v => BigInt(v ?? 0);
  const meta = mk => ingest.markets.get(Number(mk)) ?? null;
  const symbol = id => meta(id)?.symbol ?? `#${id}`;
  const price = (v, id) => { const x = meta(id); return x ? dec(v, x.priceDecimals) : null; };
  const size = (v, id) => { const x = meta(id); return x ? dec(v, x.lotDecimals) : null; };
  const unitsOf = id => ingest.unitsOf(Number(id));
  const pctChange = (a, b) => (b === 0n ? null : Number((a - b) * 1000000n / (b < 0n ? -b : b)) / 10000);
  const share = (a, b) => (b > 0n ? Number(a * 1000000n / b) / 10000 : null);

  // --- account addresses ----------------------------------------------------
  // AccountCreated events give id -> address; while history is still being
  // indexed (or for any id not seen yet) the contract answers instead, and
  // the answer is stored like an indexed row.
  async function addresses(ids) {
    const map = await queries.addresses(ids);
    const missing = ids.filter(id => !map.has(id) && id > 0).slice(0, 200);
    if (missing.length && state.block) {
      try {
        const block = state.block.number;
        const infos = await collector.reader.multi(missing.map(id => ({ name: 'getAccountById', args: [BigInt(id)] })), block);
        const rows = [];
        infos.forEach((info, i) => { const addr = String(info.accountAddr ?? '').toLowerCase(); if (/^0x[0-9a-f]{40}$/.test(addr) && !/^0x0{40}$/.test(addr)) { map.set(missing[i], { address: addr, created: null }); rows.push({ account: missing[i], address: addr, block: Number(block), ts: state.block.timestamp, tx: '' }); } });
        if (rows.length && ch) await ch.insert('accounts', rows).catch(() => {});
      } catch { /* contract lookup is best effort */ }
    }
    return map;
  }
  async function accountByAddress(address) {
    if (!state.block) return null;
    try {
      const info = await collector.reader.call('getAccountByAddr', [address], state.block.number);
      const id = Number(info.accountId);
      if (!id) return null;
      if (ch) await ch.insert('accounts', [{ account: id, address, block: Number(state.block.number), ts: state.block.timestamp, tx: '' }]).catch(() => {});
      return { id, address, created: null };
    } catch { return null; }
  }

  // --- windows ------------------------------------------------------------
  const headTs = () => ingest.status.live.toTs ?? Math.floor(now() / 1000);
  const firstTs = () => { const iv = ingest.coverage.intervals; return iv.length ? iv[0].fromTs : headTs(); };
  function windowOf(query) {
    const w = query.get('window') || '24h';
    if (!Object.hasOwn(WINDOWS, w)) throw bad('INVALID_WINDOW');
    return w;
  }
  function rangeOf(w, to = headTs() + 1) {
    const len = WINDOWS[w];
    const from = len === null ? firstTs() : to - len;
    return { from, to };
  }
  function coverageOf(from, to) {
    const cov = ingest.coverage;
    const complete = cov.spanCovered(from, to - 1);
    return { complete, covered_since_deploy: cov.contiguousTs(), backfill: ingest.progress() };
  }
  function metaOf(extra = {}) {
    return { block: ingest.status.live.to?.toString() ?? null, ts: ingest.status.live.toTs, finalized_block: ingest.status.live.finalized?.toString() ?? null, generated_at: now(), ...extra };
  }

  // --- protocol -------------------------------------------------------------
  function sumMarkets(rows) {
    const t = { volume: 0n, fills: 0, maker_fees: 0n, taker_fees: 0n, builder_fees: 0n, ins_fees: 0n, prot_fees: 0n, reduce_ins_fees: 0n, reduce_prot_fees: 0n, liq_ins_fees: 0n, liq_prot_fees: 0n, liq_unsplit: 0, taker_buy: 0n, taker_sell: 0n, trades: 0, opens: 0, closes: 0, liquidations: 0, liquidated: 0n, deleverages: 0, deleveraged: 0n, realized: 0n };
    for (const r of rows) for (const k of Object.keys(t)) t[k] += typeof t[k] === 'bigint' ? B(r[k]) : Number(r[k]);
    return t;
  }
  async function windowTotals(from, to) {
    const [markets, protocol, traders, marketTraders] = await Promise.all([queries.marketTotals(from, to), queries.protocolTotals(from, to), queries.traders(from, to), queries.traders(from, to, { by: 'market' })]);
    const p = protocol[0] ?? {};
    return { markets, t: sumMarkets(markets), p: { deposits: B(p.deposits), withdrawals: B(p.withdrawals), deposit_count: Number(p.deposit_count ?? 0), withdrawal_count: Number(p.withdrawal_count ?? 0), protocol_in: B(p.protocol_in), protocol_out: B(p.protocol_out), new_accounts: Number(p.new_accounts ?? 0) }, traders: Number(traders[0]?.traders ?? 0), marketTraders: new Map(marketTraders.map(r => [Number(r.market), Number(r.traders)])) };
  }
  // Fees charged on fills; the exchange splits each into an insurance-fund
  // part and a protocol part: carried by opening events (checked at ingest),
  // derived for decreases and closes, so protocol + insurance == fees.
  const feesOf = t => t.maker_fees + t.taker_fees;
  const protFeesOf = t => B(t.prot_fees) + B(t.reduce_prot_fees), insFeesOf = t => B(t.ins_fees) + B(t.reduce_ins_fees);
  const protRevenueOf = t => protFeesOf(t) + B(t.liq_prot_fees);
  // Balance transfer rows (query balanceMoves) by kind, every kind present.
  const movesOf = rows => { const out = Object.fromEntries(BALANCE_KINDS.map(k => [k, { amount: 0n, count: 0 }])); for (const r of rows ?? []) if (out[r.kind]) { out[r.kind].amount += B(r.total); out[r.kind].count += Number(r.n); } return out; };
  // Revenue by source (revenue.js); builder fees are inside the protocol's fee share, owed to builders.
  // Liquidations whose split is not verified (partial, off the book) count 0 and are counted apart.
  const revenueOf = (t, c = cd()) => {
    const part = (open, reduce, liq) => ({ total: dec(B(open) + B(reduce) + B(liq), c), opening_fees: dec(open ?? 0, c), reducing_fees: dec(reduce ?? 0, c), liquidations: dec(liq ?? 0, c) });
    return { protocol: part(t.prot_fees, t.reduce_prot_fees, t.liq_prot_fees), insurance: part(t.ins_fees, t.reduce_ins_fees, t.liq_ins_fees), builder_fees: dec(t.builder_fees ?? 0, c), unsplit_liquidations: Number(t.liq_unsplit ?? 0) };
  };

  function current() {
    const computed = computeMetrics(state);
    if (!computed) return null;
    const c = cd();
    let oi = 0n, insurance = 0n, longs = 0, shorts = 0;
    const markets = new Map();
    for (const { market, metrics: x } of computed.markets) {
      const u = m.units(market.priceDecimals, market.lotDecimals, c);
      const one = m.notionalCNS(market.markPNS, market.longOpenInterestLNS, u); // long lots == short lots
      oi += one; insurance += market.insuranceBalanceCNS; longs += x.long.count; shorts += x.short.count;
      markets.set(market.id, { market, x, oi: one });
    }
    return { block: state.block.number, oi, tvl: state.exchangeInfo.balanceCNS, insurance, protocol: state.exchangeInfo.protocolBalanceCNS, accounts: state.exchangeInfo.numberOfAccounts, positions: longs + shorts, longs, shorts, markets, fundingInterval: state.exchangeInfo.fundingInterval, blockTimeMs: state.stats.blockTimeMs || null };
  }
  // Spread and the mean cost of buying and of selling $10K at market, in bps
  // from the mid, read from the on-chain book (null when it holds less).
  function tradeCost(L) {
    if (!L?.bestBidPNS || !L?.bestAskPNS) return { spread_bps: null, cost_10k_bps: null };
    const bid = Number(L.bestBidPNS), ask = Number(L.bestAskPNS);
    const k10 = L.cost?.find(x => x.usd === 10000);
    const mean = k10?.buy?.filled && k10?.sell?.filled ? (k10.buy.bps + k10.sell.bps) / 2 : null;
    return { spread_bps: Math.round((ask - bid) / ((ask + bid) / 2) * 1000000) / 100, cost_10k_bps: mean === null ? null : Math.round(mean * 100) / 100 };
  }
  // Time-scaled figures need the measured block time (null until known).
  function fundingOf(market, cur) {
    const perInterval = m.fundingRateFraction(market.fundingRatePct100k);
    const intervalMs = cur.blockTimeMs ? Number(cur.fundingInterval) * cur.blockTimeMs : null;
    return { rate_pct: perInterval * 100, rate_8h_pct: intervalMs ? perInterval * (8 * 3600000 / intervalMs) * 100 : null, apr_pct: intervalMs ? perInterval * (YEAR * 1000 / intervalMs) * 100 : null, interval_seconds: intervalMs ? Math.round(intervalMs / 1000) : null };
  }

  // `fresh` computes now instead of serving a cached value (live headline push).
  async function protocol(query, { fresh = false } = {}) {
    const w = windowOf(query);
    return cache.get(`protocol:${w}`, w === '24h' ? 2000 : 8000, async () => {
      const { from, to } = rangeOf(w);
      const len = to - from;
      const [cur, prev, windows, moves, prevMoves] = await Promise.all([
        windowTotals(from, to),
        WINDOWS[w] === null ? null : windowTotals(from - len, from).catch(() => null),
        Promise.all(['24h', '7d', '30d', 'all'].map(async x => { if (x === w) return null; const r = rangeOf(x); const [mk, tr] = await Promise.all([queries.marketTotals(r.from, r.to), queries.traders(r.from, r.to)]); return [x, sumMarkets(mk), Number(tr[0]?.traders ?? 0)]; })),
        queries.balanceMoves(from, to).then(movesOf),
        WINDOWS[w] === null ? null : queries.balanceMoves(from - len, from).then(movesOf).catch(() => null)
      ]);
      const c = cd();
      const hl = (a, b) => ({ value: dec(a, c), prev: b === null ? null : dec(b, c), change_pct: b === null ? null : pctChange(a, b) });
      const hn = (a, b) => ({ value: a, prev: b, change_pct: b === null || b === 0 ? null : Math.round((a - b) / b * 10000) / 100 });
      const T = cur.t, P = prev?.t ?? null, pp = prev?.p ?? null;
      const multi = { '24h': null, '7d': null, '30d': null, all: null };
      for (const entry of windows) if (entry) multi[entry[0]] = { volume: dec(entry[1].volume, c), fees: dec(feesOf(entry[1]), c), trades: entry[1].trades, traders: entry[2] };
      multi[w] = { volume: dec(T.volume, c), fees: dec(feesOf(T), c), trades: T.trades, traders: cur.traders };
      const live = current();
      // Contract state, the same for a market whether it traded in the window or not.
      const liveOf = (id, lm) => ({
        mark: price(lm.market.markPNS, id), open_interest: dec(lm.oi, c), oi_share_pct: share(lm.oi, live.oi),
        long_positions: lm.x.long.count, short_positions: lm.x.short.count, long_position_share_pct: lm.x.long.count + lm.x.short.count ? Math.round(lm.x.long.count / (lm.x.long.count + lm.x.short.count) * 10000) / 100 : null,
        long_leverage: lm.x.long.averageLeverageBps === null ? null : Number(lm.x.long.averageLeverageBps) / 10000, short_leverage: lm.x.short.averageLeverageBps === null ? null : Number(lm.x.short.averageLeverageBps) / 10000,
        oi_cap_pct: lm.x.oi.utilisationBps === null ? null : Number(lm.x.oi.utilisationBps) / 100, max_leverage: Number(lm.market.initHdths) / 100,
        funding: fundingOf(lm.market, live), insurance: dec(lm.market.insuranceBalanceCNS, c), active: lm.market.status === 4,
        ...tradeCost(lm.x.liquidity)
      });
      const markets = cur.markets.map(r => {
        const id = Number(r.market), lm = live?.markets.get(id);
        const vol = B(r.volume), open = B(r.open_price), close = B(r.close_price);
        return {
          id, symbol: symbol(id), name: meta(id)?.name ?? null,
          volume: dec(vol, c), share_pct: share(vol, T.volume), trades: Number(r.trades), fills: Number(r.fills), traders: cur.marketTraders.get(id) ?? 0,
          fees: dec(B(r.maker_fees) + B(r.taker_fees), c), protocol_fees: dec(protFeesOf(r), c), insurance_fees: dec(insFeesOf(r), c), revenue: revenueOf(r, c),
          open: open > 0n ? price(open, id) : null, close: close > 0n ? price(close, id) : null, high: B(r.high_price) > 0n ? price(r.high_price, id) : null, low: B(r.low_price) > 0n ? price(r.low_price, id) : null,
          change_pct: open > 0n && close > 0n ? pctChange(close, open) : null,
          taker_buy: dec(r.taker_buy, c), taker_sell: dec(r.taker_sell, c), taker_buy_share_pct: share(B(r.taker_buy), B(r.taker_buy) + B(r.taker_sell)),
          liquidations: Number(r.liquidations), liquidated: dec(r.liquidated, c), realized: dec(r.realized, c),
          ...(lm ? liveOf(id, lm) : {})
        };
      });
      // A listed market with nothing in the window: zero activity (not unknown) and its contract state.
      for (const [id, lm] of live?.markets ?? []) if (!markets.some(x => x.id === id)) markets.push({ id, symbol: symbol(id), name: meta(id)?.name ?? null, volume: dec(0n, c), share_pct: 0, trades: 0, fills: 0, traders: 0, fees: dec(0n, c), protocol_fees: dec(0n, c), insurance_fees: dec(0n, c), revenue: revenueOf({}, c), liquidations: 0, liquidated: dec(0n, c), ...liveOf(id, lm) });
      markets.sort((a, b) => Number(b.volume) - Number(a.volume) || Number(b.open_interest ?? 0) - Number(a.open_interest ?? 0));
      return {
        meta: metaOf({ window: w, from, to, coverage: coverageOf(from, to), previous_complete: prev ? ingest.coverage.spanCovered(from - len, from - 1) : null }),
        headline: {
          volume: hl(T.volume, P?.volume ?? null), fees: hl(feesOf(T), P ? feesOf(P) : null),
          protocol_fees: hl(protFeesOf(T), P ? protFeesOf(P) : null), insurance_fees: hl(insFeesOf(T), P ? insFeesOf(P) : null), builder_fees: dec(T.builder_fees, c),
          protocol_revenue: hl(protRevenueOf(T), P ? protRevenueOf(P) : null), revenue: revenueOf(T, c),
          trades: hn(T.trades, P?.trades ?? null), traders: hn(cur.traders, prev?.traders ?? null), new_accounts: hn(cur.p.new_accounts, pp?.new_accounts ?? null),
          liquidations: hn(T.liquidations, P?.liquidations ?? null), liquidated: hl(T.liquidated, P?.liquidated ?? null), deleverages: T.deleverages,
          deposits: hl(cur.p.deposits, pp?.deposits ?? null), withdrawals: hl(cur.p.withdrawals, pp?.withdrawals ?? null), net_flow: hl(cur.p.deposits - cur.p.withdrawals, pp ? pp.deposits - pp.withdrawals : null),
          taker_buy_share_pct: share(T.taker_buy, T.taker_buy + T.taker_sell), realized_pnl: dec(T.realized, c),
          take_rate_bps: T.volume > 0n ? Number(feesOf(T) * 1000000n / T.volume) / 100 : null,
          // Paid out of the protocol balance to traders, and swept into it from accounts: not revenue.
          protocol_payouts: hl(moves.payout.amount, prevMoves ? prevMoves.payout.amount : null), payout_count: moves.payout.count,
          protocol_sweeps: dec(moves.sweep.amount, c)
        },
        windows: multi,
        current: live ? { block: live.block.toString(), open_interest: dec(live.oi, c), tvl: dec(live.tvl, c), insurance: dec(live.insurance, c), protocol_balance: dec(live.protocol, c), accounts: live.accounts.toString(), positions: live.positions, long_positions: live.longs, short_positions: live.shorts, long_position_share_pct: live.positions ? Math.round(live.longs / live.positions * 10000) / 100 : null } : null,
        markets
      };
    }, { fresh });
  }

  function bucketOf(w, query) {
    const b = query.get('bucket') || DEFAULT_BUCKET[w];
    if (!Object.hasOwn(BUCKETS, b)) throw bad('INVALID_BUCKET');
    const seconds = BUCKETS[b];
    if (WINDOWS[w] !== null && WINDOWS[w] / seconds > 800) throw bad('BUCKET_TOO_SMALL');
    if (WINDOWS[w] === null && (headTs() - firstTs()) / seconds > 2000) throw bad('BUCKET_TOO_SMALL');
    return { name: b, seconds };
  }

  // Positioning flow for one market: open interest opened and closed on each
  // side per bucket. A long open is a long position opened or added to; a long
  // close is one reduced, closed, flipped or liquidated. Exact, not inferred
  // from price and open interest.
  async function positionFlow(id, query) {
    const w = windowOf(query), bucket = bucketOf(w, query), market = Number(id);
    if (!meta(market)) throw Object.assign(new Error('MARKET_NOT_FOUND'), { status: 404 });
    return cache.get(`flow:${market}:${w}:${bucket.name}`, w === '24h' ? 5000 : 30000, async () => {
      const range = rangeOf(w), c = cd();
      const start = Math.floor(range.from / bucket.seconds) * bucket.seconds;
      const rows = await queries.positionFlow(market, range.from, range.to, bucket.seconds);
      const byT = new Map(rows.map(r => [Number(r.t), r]));
      const times = [];
      for (let t = start; t < range.to; t += bucket.seconds) times.push(t);
      const col = k => times.map(t => { const r = byT.get(t); return r ? dec(BigInt(Math.round(Number(r[k]))), c) : '0'; });
      const sum = k => rows.reduce((a, r) => a + Number(r[k]), 0);
      return {
        meta: metaOf({ window: w, from: range.from, to: range.to, bucket: bucket.name, bucket_seconds: bucket.seconds, market, coverage: coverageOf(range.from, range.to) }),
        symbol: symbol(market), times,
        long_open: col('long_open'), long_close: col('long_close'), short_open: col('short_open'), short_close: col('short_close'),
        totals: { long_open: dec(BigInt(Math.round(sum('long_open'))), c), long_close: dec(BigInt(Math.round(sum('long_close'))), c), short_open: dec(BigInt(Math.round(sum('short_open'))), c), short_close: dec(BigInt(Math.round(sum('short_close'))), c), opens: sum('opens'), closes: sum('closes') }
      };
    });
  }
  async function series(query) {
    const w = windowOf(query);
    const bucket = bucketOf(w, query);
    const marketFilter = /^\d{1,5}$/.test(query.get('market') ?? '') ? Number(query.get('market')) : null;
    return cache.get(`series:${w}:${bucket.name}:${marketFilter}`, w === '24h' ? 3000 : 15000, async () => {
      const range = rangeOf(w);
      // Buckets are labelled on the bucket grid, but the data starts at the window's
      // own start: the first bucket is partial, so chart sums equal the headline.
      const start = Math.floor(range.from / bucket.seconds) * bucket.seconds, from = range.from, to = range.to;
      const [rows, flows, traderRows, base, lastPrices, newRows, moveRows] = await Promise.all([
        queries.marketTotals(from, to, { bucket: bucket.seconds }),
        queries.protocolTotals(from, to, { bucket: bucket.seconds }),
        queries.traders(from, to, { bucket: bucket.seconds }),
        queries.cumulativeBefore(from),
        queries.lastPricesBefore(from),
        marketFilter === null ? queries.newTraders(from, to, { bucket: bucket.seconds, since: firstTs() }) : [],
        marketFilter === null ? queries.balanceMoves(from, to, { bucket: bucket.seconds, kinds: ['payout'] }) : []
      ]);
      const c = cd();
      const baseComplete = ingest.coverage.contiguousTs() !== null && ingest.coverage.contiguousTs() >= from;
      const times = [];
      for (let t = start; t < to; t += bucket.seconds) times.push(t);
      const byT = new Map(times.map(t => [t, []]));
      for (const r of rows) { const list = byT.get(Number(r.t)); if (list) list.push(r); }
      const flowT = new Map(flows.map(r => [Number(r.t), r]));
      const tradersT = new Map(traderRows.map(r => [Number(r.t), Number(r.traders)]));
      const newT = new Map(newRows.map(r => [Number(r.t), Number(r.n)]));
      const payoutT = new Map(moveRows.map(r => [Number(r.t), B(r.total)]));
      const lots = new Map([...base.oi].map(([id, v]) => [id, v.long]));
      const prices = new Map(lastPrices);
      let tvl = base.net;
      const perMarket = new Map();
      const points = times.map(t => {
        const list = byT.get(t);
        const pick = marketFilter === null ? list : list.filter(r => Number(r.market) === marketFilter);
        const s = sumMarkets(pick);
        for (const r of list) {
          const id = Number(r.market);
          lots.set(id, (lots.get(id) ?? 0n) + B(r.oi_long));
          if (Number(r.fills) > 0 && B(r.close_price) > 0n) prices.set(id, B(r.close_price));
          if (marketFilter === null) { const arr = perMarket.get(id) ?? []; arr.push([t, B(r.volume), B(r.liquidated), B(r.maker_fees) + B(r.taker_fees)]); perMarket.set(id, arr); }
        }
        let oi = 0n;
        for (const [id, l] of lots) { if (marketFilter !== null && id !== marketFilter) continue; const u = unitsOf(id), p = prices.get(id); if (u && p) oi += m.notionalCNS(p, l, u); }
        const f = flowT.get(t);
        const netFlow = f ? B(f.deposits) - B(f.withdrawals) : 0n;
        tvl += f ? netFlow + B(f.protocol_in) - B(f.protocol_out) : 0n;
        const point = { t, volume: dec(s.volume, c), trades: s.trades, fees: dec(feesOf(s), c), protocol_fees: dec(protFeesOf(s), c), insurance_fees: dec(insFeesOf(s), c), revenue: revenueOf(s, c), taker_buy: dec(s.taker_buy, c), taker_sell: dec(s.taker_sell, c), liquidations: s.liquidations, liquidated: dec(s.liquidated, c), realized_pnl: dec(s.realized, c), open_interest: baseComplete ? dec(oi, c) : null };
        if (marketFilter === null) Object.assign(point, { traders: tradersT.get(t) ?? 0, new_traders: newT.get(t) ?? 0, deposits: dec(f?.deposits ?? 0, c), withdrawals: dec(f?.withdrawals ?? 0, c), net_flow: dec(netFlow, c), new_accounts: Number(f?.new_accounts ?? 0), tvl: baseComplete ? dec(tvl, c) : null, protocol_payouts: dec(payoutT.get(t) ?? 0n, c) });
        else { const r = pick[0]; Object.assign(point, { open: r && B(r.open_price) > 0n ? price(r.open_price, marketFilter) : null, high: r && B(r.high_price) > 0n ? price(r.high_price, marketFilter) : null, low: r && B(r.low_price) > 0n ? price(r.low_price, marketFilter) : null, close: prices.get(marketFilter) ? price(prices.get(marketFilter), marketFilter) : null }); }
        return point;
      });
      const column = (arr, i) => { const byT = new Map(arr.map(x => [x[0], x[i]])); return times.map(t => dec(byT.get(t) ?? 0n, c)); };
      const byMarket = marketFilter === null ? [...perMarket].map(([id, arr]) => ({ id, symbol: symbol(id), total: dec(arr.reduce((a, x) => a + x[1], 0n), c), volume: column(arr, 1), liquidated: column(arr, 2), fees: column(arr, 3) })).sort((a, b) => Number(b.total) - Number(a.total)) : null;
      return { meta: metaOf({ window: w, from, to, bucket: bucket.name, bucket_seconds: bucket.seconds, market: marketFilter, coverage: coverageOf(from, to), cumulative_complete: baseComplete }), times, points, by_market: byMarket };
    });
  }

  // --- feeds ------------------------------------------------------------------
  function tradeView(r, addressOf = null) {
    const id = Number(r.market), c = cd();
    return { block: String(r.block), log_index: Number(r.log_index), ts: Number(r.ts), tx: r.tx, kind: r.kind, market: id, symbol: symbol(id), account: Number(r.account), address: addressOf?.get(Number(r.account))?.address ?? null, side: Number(r.side) === 0 ? 'long' : Number(r.side) === 1 ? 'short' : null, buy: Number(r.buy) === 1, role: r.role, price: B(r.price) > 0n ? price(r.price, id) : null, size: size(r.lot, id), notional: dec(r.notional, c), fee: dec(r.fee, c), pnl: dec(B(r.pnl) + B(r.funding), c), leverage: Number(r.leverage) ? Number(r.leverage) / 100 : null, remaining: size(r.end_lot, id), mark: B(r.mark) > 0n ? price(r.mark, id) : null, on_book: (Number(r.flags) & 1) === 1, force_close: (Number(r.flags) & 2) === 2 };
  }
  // Live feed rows with addresses: an account's address never changes, so
  // ids are looked up in the accounts table once and kept (bounded).
  const known = new Map(); // id -> { address }
  async function tradeViews(rows) {
    const ids = [...new Set(rows.map(r => Number(r.account)))].filter(id => id > 0 && !known.has(id));
    if (ids.length) for (const [id, v] of await queries.addresses(ids).catch(() => new Map())) { if (known.size >= 20000) known.delete(known.keys().next().value); known.set(id, { address: v.address }); }
    return rows.map(r => tradeView(r, known));
  }
  async function liquidations(query) {
    const limit = Math.min(Math.max(Number(query.get('limit')) || 100, 1), query.get('format') === 'csv' ? 10000 : 500);
    const offset = Math.min(Math.max(Math.floor(Number(query.get('offset')) || 0), 0), 1000000);
    const market = /^\d{1,5}$/.test(query.get('market') ?? '') ? Number(query.get('market')) : null;
    // With a window, the rows stay inside it (newest first, a page at `offset`),
    // with the window's total and its largest liquidation.
    const w = query.get('window') ? windowOf(query) : null;
    const sinceTs = w && w !== 'all' ? rangeOf(w).from : null;
    return cache.get(`liq:${limit}:${offset}:${market}:${w}`, 3000, async () => {
      const [rows, total] = await Promise.all([queries.recent(['liquidation', 'deleverage'], { limit, offset, market, sinceTs }), w ? queries.recentCount(['liquidation', 'deleverage'], { market, sinceTs }) : null]);
      const largestRow = w ? (await queries.recent(['liquidation'], { limit: 1, market, sinceTs, order: 'size' }))[0] ?? null : null;
      const addr = await addresses([...new Set(rows.map(r => Number(r.account)))]);
      const { from, to } = rangeOf('24h');
      const day = sumMarkets(await queries.marketTotals(from, to));
      return { meta: metaOf(), last_24h: { count: day.liquidations, notional: dec(day.liquidated, cd()), deleverages: day.deleverages }, rows: rows.map(r => tradeView(r, addr)), ...(w ? { window: w, total, offset, largest: largestRow ? tradeView(largestRow, await addresses([Number(largestRow.account)])) : null } : {}) };
    });
  }
  async function trades(query) {
    const limit = Math.min(Math.max(Number(query.get('limit')) || 50, 1), 200);
    const market = /^\d{1,5}$/.test(query.get('market') ?? '') ? Number(query.get('market')) : null;
    return cache.get(`trades:${limit}:${market}`, 1000, async () => {
      const rows = await queries.recent(['open', 'increase', 'decrease', 'close', 'invert', 'liquidation'], { limit: limit * 2, market, sinceTs: headTs() - 7 * DAY });
      const takers = rows.filter(r => r.role === 'taker').slice(0, limit); // one row per aggressor
      const addr = await addresses([...new Set(takers.map(r => Number(r.account)))]);
      return { meta: metaOf(), rows: takers.map(r => tradeView(r, addr)) };
    });
  }
  async function funding(marketId, query) {
    const id = Number(marketId);
    if (!ingest.markets.has(id)) throw bad('MARKET_NOT_FOUND', 404);
    const limit = Math.min(Math.max(Number(query.get('limit')) || 200, 1), 2000);
    return cache.get(`funding:${id}:${limit}`, 10000, async () => {
      const rows = await queries.fundingHistory(id, { limit });
      const live = current();
      return { meta: metaOf(), market: id, symbol: symbol(id), current: live?.markets.get(id) ? fundingOf(live.markets.get(id).market, live) : null, rows: rows.map(r => ({ funding_block: String(r.funding_block), ts: Number(r.ts), tx: r.tx, rate_pct: Number(r.actual_rate) / 1000, specified_rate_pct: Number(r.specified_rate) / 1000, price: price(r.price, id) })) };
    });
  }
  async function fundingOverview(query) {
    const w = query.get('window') && Object.hasOwn(WINDOWS, query.get('window')) ? query.get('window') : '7d';
    return cache.get(`funding-overview:${w}`, 15000, async () => {
      const { from, to } = rangeOf(w);
      const bucket = w === '24h' ? HOUR : w === '7d' ? 4 * HOUR : DAY;
      const rows = await queries.fundingSeries(Math.floor(from / bucket) * bucket, to, bucket);
      const live = current();
      const markets = [...(live?.markets ?? new Map())].map(([id, lm]) => ({ id, symbol: symbol(id), ...fundingOf(lm.market, live), long_positions: lm.x.long.count, short_positions: lm.x.short.count, open_interest: dec(lm.oi, cd()) }));
      // Each bucket is annualised with the spacing of its own funding events
      // (block times change), or today's interval when none is known.
      const intervalOf = new Map(markets.map(x => [x.id, x.interval_seconds]));
      const series = new Map();
      for (const r of rows) {
        const id = Number(r.market), rate = Number(r.rate) / 1000, spacing = Number(r.spacing) || intervalOf.get(id) || null;
        const arr = series.get(id) ?? [];
        arr.push({ t: Number(r.t), rate_pct: rate, apr_pct: spacing ? rate * YEAR / spacing : null, interval_seconds: spacing ? Math.round(spacing) : null });
        series.set(id, arr);
      }
      return { meta: metaOf({ window: w, bucket_seconds: bucket }), markets, series: [...series].map(([id, points]) => ({ id, symbol: symbol(id), points })) };
    });
  }

  async function flows(query) {
    const w = windowOf(query);
    return cache.get(`flows:${w}`, 10000, async () => {
      const { from, to } = rangeOf(w);
      const [dep, wd] = await Promise.all([queries.accounts(from, to, { sort: 'deposits', limit: 10 }), queries.accounts(from, to, { sort: 'withdrawals', limit: 10 })]);
      const addr = await addresses([...new Set([...dep.rows, ...wd.rows].map(r => Number(r.account)))]);
      const c = cd();
      const view = r => ({ account: Number(r.account), address: addr.get(Number(r.account))?.address ?? null, deposits: dec(r.deposits, c), withdrawals: dec(r.withdrawals, c), net: dec(B(r.deposits) - B(r.withdrawals), c) });
      const recentRows = await queries.recent(['deposit', 'withdrawal'], { limit: 30 });
      const addr2 = await addresses([...new Set(recentRows.map(r => Number(r.account)))]);
      return { meta: metaOf({ window: w, coverage: coverageOf(from, to) }), top_depositors: dep.rows.filter(r => B(r.deposits) > 0n).map(view), top_withdrawers: wd.rows.filter(r => B(r.withdrawals) > 0n).map(view), recent: recentRows.map(r => ({ ts: Number(r.ts), block: String(r.block), tx: r.tx, kind: r.kind, account: Number(r.account), address: addr2.get(Number(r.account))?.address ?? null, amount: dec(r.amount, c), balance_after: dec(r.balance, c) })) };
    });
  }

  // --- leaderboard ---------------------------------------------------------------
  function openPositions(accountId) {
    const computed = computeMetrics(state);
    let count = 0, notional = 0n, upnl = 0n;
    if (computed) for (const { metrics: x } of computed.markets) { const p = x.positions.find(q => q.accountId === BigInt(accountId)); if (p) { count++; notional += p.markNotionalCNS; upnl += p.pnlCNS; } }
    return { count, notional, upnl };
  }
  // Smart money: the latest position changes of the most profitable
  // directional traders in a window (top 50 by net PnL, market makers and
  // high-frequency accounts left out: their flow is inventory, not views).
  const SMART_TOP = 50, MOVE_WINDOW_S = 7 * 86400;
  async function smartMoves(query) {
    const w = ['7d', '30d', 'all'].includes(query.get('window')) ? query.get('window') : '30d';
    const limit = Math.min(Math.max(Number(query.get('limit')) || 40, 1), 500);
    // Moves smaller than min USD are left out (default $1K): some leaders trade dust.
    const min = Math.min(Math.max(Math.floor(Number(query.get('min') ?? 1000)) || 0, 0), 10000000);
    return cache.get(`smart:${w}:${limit}:${min}`, 10000, async () => {
      const board = await leaderboard(new URLSearchParams(`window=${w}&by=pnl&limit=200`));
      const days = w === '7d' ? 7 : w === '30d' ? 30 : Math.max(1, (headTs() - firstTs()) / 86400);
      const { leaders, excluded } = pickLeaders(board.rows, { days, top: SMART_TOP });
      const byId = new Map(leaders.map(r => [Number(r.account), r]));
      const rows = await queries.movesOf([...byId.keys()], { sinceTs: headTs() - MOVE_WINDOW_S, limit, minNotional: BigInt(min) * 10n ** BigInt(cd()) });
      const views = await tradeViews(rows);
      return {
        meta: metaOf({ window: w, min_usd: min }),
        leaders: leaders.length, excluded,
        rows: views.map(v => { const l = byId.get(v.account); return { ...v, leader: { rank: l.rank, pnl: l.pnl, volume: l.volume } }; })
      };
    });
  }
  async function leaderboard(query) {
    const w = windowOf(query);
    const sort = query.get('by') || 'pnl';
    const limit = Math.min(Math.max(Number(query.get('limit')) || 50, 1), 200);
    const offset = Math.min(Math.max(Number(query.get('offset')) || 0, 0), 10000);
    const market = /^\d{1,5}$/.test(query.get('market') ?? '') ? Number(query.get('market')) : null;
    return cache.get(`lb:${w}:${sort}:${limit}:${offset}:${market}`, w === '24h' ? 5000 : 20000, async () => {
      const { from, to } = rangeOf(w);
      const { total, rows } = await queries.accounts(from, to, { sort, limit, offset, market });
      const addr = await addresses(rows.map(r => Number(r.account)));
      const c = cd();
      return {
        meta: metaOf({ window: w, from, to, sort, market, coverage: coverageOf(from, to) }), total,
        rows: rows.map(r => { const id = Number(r.account), open = openPositions(id); const vol = B(r.volume), net = B(r.realized) - B(r.fees); return { rank: Number(r.rank), account: id, address: addr.get(id)?.address ?? null, pnl: dec(net, c), realized: dec(r.realized, c), fees: dec(r.fees, c), volume: dec(vol, c), maker_share_pct: share(B(r.maker_volume), vol), trades: Number(r.trades), roi_on_volume_bps: vol > 0n ? Number(net * 100000000n / vol) / 10000 : null, liquidations: Number(r.liquidations), liquidated: dec(r.liquidated, c), deposits: dec(r.deposits, c), withdrawals: dec(r.withdrawals, c), markets: (r.markets ?? []).map(Number).map(symbol), open_positions: open.count, open_notional: dec(open.notional, c), unrealized_pnl: dec(open.upnl, c) }; })
      };
    });
  }

  // --- wallets ------------------------------------------------------------------
  // Keys the contract does not know are remembered briefly, so repeated
  // lookups of a mistyped address cost no RPC call (indexed accounts are
  // always checked first, so a new account is found as soon as it is ingested).
  const misses = new Map();
  const knownMiss = key => { const until = misses.get(key); if (until > Date.now()) return true; misses.delete(key); return false; };
  const notFound = key => { if (misses.size >= 10000) misses.delete(misses.keys().next().value); misses.set(key, Date.now() + 30000); return bad('ACCOUNT_NOT_FOUND', 404); };
  async function resolve(key) {
    const text = String(key).trim().toLowerCase();
    if (/^0x[0-9a-f]{40}$/.test(text)) {
      const hit = (await queries.findAccounts(text))[0];
      if (hit) return { id: Number(hit.account), address: hit.address, created: Number(hit.ts) };
      if (knownMiss(text)) throw bad('ACCOUNT_NOT_FOUND', 404);
      const live = await accountByAddress(text);
      if (!live) throw notFound(text);
      return live;
    }
    if (/^[1-9]\d{0,8}$/.test(text)) {
      const hit = (await queries.findAccounts(text))[0];
      if (hit) return { id: Number(hit.account), address: hit.address, created: Number(hit.ts) };
      if (knownMiss(text)) throw bad('ACCOUNT_NOT_FOUND', 404);
      const found = (await addresses([Number(text)])).get(Number(text));
      if (!found) throw notFound(text);
      return { id: Number(text), address: found.address, created: null };
    }
    throw bad('INVALID_ACCOUNT');
  }
  async function search(query) {
    const q = String(query.get('q') ?? '').trim();
    if (q.length < 1 || q.length > 42) throw bad('INVALID_QUERY');
    let rows = (await queries.findAccounts(q, { limit: 8 })).map(r => ({ account: Number(r.account), address: r.address, created: Number(r.ts) }));
    if (!rows.length && /^0x[0-9a-fA-F]{40}$/.test(q)) { const live = await accountByAddress(q.toLowerCase()); if (live) rows = [{ account: live.id, address: live.address, created: null }]; }
    if (!rows.length && /^[1-9]\d{0,8}$/.test(q)) { const found = (await addresses([Number(q)])).get(Number(q)); if (found) rows = [{ account: Number(q), address: found.address, created: null }]; }
    return { meta: metaOf(), rows };
  }

  // Wallet page, fast part: totals, per-market sums and daily PnL come from
  // the rollups; positions and balances from the contract (never cached).
  async function profile(key) {
    const acct = await resolve(key);
    const c = cd();
    const view = await cache.get(`wallet:${acct.id}`, 4000, async () => {
      const all = rangeOf('all');
      const [marketRows, daily, recentRows, flowRows, firstTrade, transfers] = await Promise.all([queries.accountMarkets(acct.id, all.from, all.to), queries.accountSeries(acct.id, all.from, all.to, DAY), queries.accountTrades(acct.id, { limit: 100 }), queries.accountFlows(acct.id, { limit: 100 }), queries.accountFirstTrade(acct.id), queries.accountTransfers(acct.id)]);
      const sums = { volume: 0n, maker: 0n, trades: 0, fees: 0n, realized: 0n, funding: 0n, liquidations: 0, deposits: 0n, withdrawals: 0n };
      for (const r of marketRows) { sums.volume += B(r.volume); sums.maker += B(r.maker_volume); sums.trades += Number(r.trades); sums.fees += B(r.fees); sums.realized += B(r.realized); sums.funding += B(r.funding_paid); sums.liquidations += Number(r.liquidations); sums.deposits += B(r.deposits); sums.withdrawals += B(r.withdrawals); }
      const active = daily.filter(r => Number(r.trades) > 0);
      let cum = 0n;
      const addr = new Map([[acct.id, { address: acct.address }]]);
      return {
        meta: metaOf({ coverage: { complete: ingest.coverage.contiguousTs() !== null, backfill: ingest.progress() } }),
        account: { id: acct.id, address: acct.address, created: acct.created },
        summary: { volume: dec(sums.volume, c), trades: sums.trades, realized: dec(sums.realized, c), fees: dec(sums.fees, c), net_pnl: dec(sums.realized - sums.fees, c), funding: dec(sums.funding, c), liquidations: sums.liquidations, deposits: dec(sums.deposits, c), withdrawals: dec(sums.withdrawals, c), net_flow: dec(sums.deposits - sums.withdrawals, c), first_trade: firstTrade, last_trade: recentRows.length ? Number(recentRows[0].ts) : null, active_days: active.length, maker_share_pct: share(sums.maker, sums.volume), payouts_received: dec(transfers?.payouts ?? 0, c), payout_count: Number(transfers?.payout_count ?? 0), swept_to_protocol: dec(transfers?.sweeps ?? 0, c) },
        markets: marketRows.filter(r => Number(r.market) !== 0 && Number(r.trades) > 0).map(r => ({ market: Number(r.market), symbol: symbol(Number(r.market)), volume: dec(r.volume, c), trades: Number(r.trades), realized: dec(r.realized, c), fees: dec(r.fees, c), net_pnl: dec(B(r.realized) - B(r.fees), c), liquidations: Number(r.liquidations) })).sort((a, b) => Number(b.volume) - Number(a.volume)),
        pnl_daily: daily.map(r => { const net = B(r.realized) - B(r.fees); cum += net; return { t: Number(r.t), net_pnl: dec(net, c), realized: dec(r.realized, c), fees: dec(r.fees, c), volume: dec(r.volume, c), trades: Number(r.trades), cumulative: dec(cum, c) }; }),
        recent_trades: recentRows.map(r => tradeView(r, addr)),
        flows: flowRows.map(r => ({ ts: Number(r.ts), block: String(r.block), tx: r.tx, kind: r.kind, amount: dec(r.amount, c), balance_after: dec(r.balance, c) }))
      };
    });
    const live = accountState ? await accountState(view.account.id).catch(() => null) : null;
    return { ...view, portfolio: live?.portfolio ?? null, positions: live?.positions ?? [] };
  }

  // Wallet page, analytics part: round trips over the account's events
  // (latest maxTripEvents), performance, behaviour notes and activity.
  async function walletAnalytics(key) {
    const acct = await resolve(key);
    const c = cd();
    return cache.get(`wallet-analytics:${acct.id}`, 30000, async () => {
      const [total, rows] = await Promise.all([queries.accountEventCount(acct.id), queries.accountEvents(acct.id, { limit: maxTripEvents })]);
      const { trips, openTrips } = roundTrips(rows);
      const perf = performance(trips);
      const tripView = t => ({ market: t.market, symbol: symbol(t.market), side: t.side === 0 ? 'long' : 'short', open_ts: t.openTs, first_ts: t.firstTs, close_ts: t.closeTs, hold_seconds: t.complete && t.closeTs !== null ? t.closeTs - t.openTs : null, entry_notional: dec(t.entryNotional, c), exit_notional: dec(t.exitNotional, c), max_size: size(t.maxLot, t.market), realized: dec(t.realized, c), fees: dec(t.fees, c), funding: dec(t.funding, c), net_pnl: dec(t.net, c), return_pct: t.complete && t.entryNotional > 0n ? Number(t.net * 1000000n / t.entryNotional) / 10000 : null, max_leverage: t.maxLeverage ? t.maxLeverage / 100 : null, complete: t.complete, liquidated: t.liquidated, deleveraged: t.deleveraged, events: t.events });
      return {
        meta: metaOf(),
        account: { id: acct.id, address: acct.address },
        performance: {
          based_on: { events: rows.length, total_events: total, truncated: total > rows.length, since: rows.length ? Number(rows[0].ts) : null },
          closed_trips: perf.closedTrips, wins: perf.wins, losses: perf.losses, win_rate_pct: perf.winRate === null ? null : Math.round(perf.winRate * 10000) / 100,
          profit_factor: perf.profitFactor, net_pnl: dec(perf.net, c), gross_profit: dec(perf.grossProfit, c), gross_loss: dec(perf.grossLoss, c), expectancy: dec(perf.expectancy, c),
          average_win: dec(perf.averageWin, c), average_loss: dec(perf.averageLoss, c), largest_win: dec(perf.largestWin, c), largest_loss: dec(perf.largestLoss, c),
          max_drawdown: dec(perf.maxDrawdown, c), drawdown_from: perf.drawdownFrom, drawdown_to: perf.drawdownTo,
          best_streak: perf.bestStreak, worst_streak: perf.worstStreak, current_streak: perf.currentStreak,
          average_hold_seconds: perf.averageHold, median_hold_seconds: perf.medianHold, median_win_hold_seconds: perf.medianWinHold, median_loss_hold_seconds: perf.medianLossHold,
          long: { trips: perf.long.trips, win_rate_pct: perf.long.win_rate === null ? null : Math.round(perf.long.win_rate * 10000) / 100, net_pnl: dec(perf.long.net, c) },
          short: { trips: perf.short.trips, win_rate_pct: perf.short.win_rate === null ? null : Math.round(perf.short.win_rate * 10000) / 100, net_pnl: dec(perf.short.net, c) },
          liquidated_trips: perf.liquidatedTrips, deleveraged_trips: perf.deleveragedTrips,
          best_market: perf.bestMarket ? { market: perf.bestMarket.market, symbol: symbol(perf.bestMarket.market), net_pnl: dec(perf.bestMarket.net, c), trips: perf.bestMarket.trips } : null,
          worst_market: perf.worstMarket ? { market: perf.worstMarket.market, symbol: symbol(perf.worstMarket.market), net_pnl: dec(perf.worstMarket.net, c), trips: perf.worstMarket.trips } : null,
          markets: perf.markets.map(x => ({ market: x.market, symbol: symbol(x.market), trips: x.trips, wins: x.wins, win_rate_pct: x.trips ? Math.round(x.wins / x.trips * 10000) / 100 : null, net_pnl: dec(x.net, c) }))
        },
        insights: insights(perf, rows, { symbol }),
        activity: activityGrid(rows),
        trip_curve: perf.curve.slice(-2000).map(p => ({ t: p.ts, equity: dec(p.equity, c) })),
        trips: trips.slice(-200).reverse().map(tripView),
        open_trips: openTrips.map(tripView)
      };
    });
  }

  // Every trading account's net PnL and volume per window, sorted, shared by
  // all wallet pages and refreshed each minute; a rank is a binary search.
  // An account is ranked by its own values in the same table, so its rank
  // never exceeds the table's size.
  const PERIODS = ['24h', '7d', '30d', 'all'];
  function scores(w) {
    return cache.get(`scores:${w}`, 60000, async () => {
      const { from, to } = rangeOf(w);
      const rows = await queries.accountScores(from, to);
      const desc = (a, b) => b - a;
      return { of: new Map(rows.map(r => [Number(r.account), { pnl: Number(r.pnl), volume: Number(r.volume) }])), pnl: rows.map(r => Number(r.pnl)).sort(desc), volume: rows.map(r => Number(r.volume)).sort(desc) };
    });
  }
  // 1 + the number of values strictly greater (ties share a rank).
  const rankIn = (sorted, value) => { let lo = 0, hi = sorted.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] > value) lo = mid + 1; else hi = mid; } return lo + 1; };

  // One account over rolling windows: activity, net PnL, closed trips and
  // where it ranks among every account that traded in the same window.
  async function walletPeriods(key) {
    const acct = await resolve(key);
    const c = cd();
    return cache.get(`wallet-periods:${acct.id}`, 30000, async () => {
      const periods = await Promise.all(PERIODS.map(async w => {
        const { from, to } = rangeOf(w);
        const [{ rows }, table] = await Promise.all([queries.accounts(from, to, { account: acct.id, limit: 1 }), scores(w)]);
        const r = rows[0], own = table.of.get(acct.id);
        const view = { window: w, from, to, coverage_complete: ingest.coverage.spanCovered(from, to - 1), traders: table.pnl.length };
        if (!r || !Number(r.trades)) return { ...view, trades: 0, volume: '0', net_pnl: '0', realized: '0', fees: '0', liquidations: 0, rank: null };
        const net = B(r.realized) - B(r.fees);
        return { ...view, trades: Number(r.trades), volume: dec(r.volume, c), net_pnl: dec(net, c), realized: dec(r.realized, c), fees: dec(r.fees, c), funding: dec(r.funding_paid, c), liquidations: Number(r.liquidations), pnl_per_volume_bps: B(r.volume) > 0n ? Number(net * 100000000n / B(r.volume)) / 10000 : null, rank: own ? { pnl: rankIn(table.pnl, own.pnl), volume: rankIn(table.volume, own.volume), of: table.pnl.length } : null };
      }));
      return { meta: metaOf(), account: { id: acct.id, address: acct.address }, periods };
    });
  }

  async function walletTrades(key, query) {
    const acct = await resolve(key);
    const before = /^\d{1,12}:\d{1,9}$/.test(query.get('before') ?? '') ? query.get('before') : null;
    const limit = Math.min(Math.max(Number(query.get('limit')) || 100, 1), query.get('format') === 'csv' ? 10000 : 500);
    const market = /^\d{1,5}$/.test(query.get('market') ?? '') ? Number(query.get('market')) : null;
    const rows = await queries.accountTrades(acct.id, { before, limit, market });
    const addr = new Map([[acct.id, { address: acct.address }]]);
    const list = rows.map(r => tradeView(r, addr));
    return { meta: metaOf(), account: { id: acct.id, address: acct.address }, next: rows.length === limit ? `${rows.at(-1).block}:${rows.at(-1).log_index}` : null, rows: list };
  }

  async function compare(query) {
    const keys = String(query.get('wallets') ?? '').split(',').map(s => s.trim()).filter(Boolean);
    if (!keys.length || keys.length > 10) throw bad('INVALID_WALLETS');
    const out = await Promise.all(keys.map(k => Promise.all([profile(k), walletAnalytics(k)]).then(([p, a]) => ({ key: k, ...p, performance: a.performance })).catch(error => ({ key: k, error: error.status ? error.message : 'UNAVAILABLE' }))));
    return { meta: metaOf(), wallets: out };
  }

  // --- data integrity -------------------------------------------------------------
  // Event-derived open interest and TVL at the ingested head against the
  // contract's own counters (the collector reads them every poll).
  // Only a finished comparison is cached: right after a start the contract
  // state or the index may not have reached a common block yet.
  async function integrity() {
    const complete = ingest.coverage.contiguousTs() !== null && ingest.coverage.intervals.length === 1;
    if (!complete) return { complete, open_interest: [], tvl: null };
    if (!state.block || ingest.status.live.to === null || ingest.status.live.to < state.block.number) return { complete, pending: true, open_interest: [], tvl: null };
    return cache.get('integrity', 60000, async () => {
      // The contract side is read before the query: a poll meanwhile moves the state to another block.
      const block = state.block.number, blockTs = state.block.timestamp, balance = state.exchangeInfo.balanceCNS;
      const markets = [...state.markets.values()].map(x => ({ id: x.id, symbol: x.symbol, long: x.longOpenInterestLNS, short: x.shortOpenInterestLNS }));
      const cum = await queries.cumulativeAtBlock(block, blockTs);
      const checks = markets.map(market => {
        const ev = cum.oi.get(market.id) ?? { long: 0n, short: 0n };
        return { market: market.id, symbol: market.symbol, events_long: size(ev.long, market.id), contract_long: size(market.long, market.id), events_short: size(ev.short, market.id), contract_short: size(market.short, market.id), ok: ev.long === market.long && ev.short === market.short };
      });
      const protocolBalance = await protocolBalanceCheck(block, blockTs, state.exchangeInfo.protocolBalanceCNS);
      return { complete, block: block.toString(), method: 'Running sums of indexed events up to the contract snapshot block compared with the contract counters read at that same block.', protocol_balance: protocolBalance, open_interest: checks, tvl: { events: dec(cum.net, cd()), contract: dec(balance, cd()), ok: cum.net === balance } };
    });
  }

  // The protocol balance rebuilt from launch: the protocol's revenue shares
  // plus every transfer that moves the balance (revenue.js BALANCE_MOVES),
  // against the contract's own figure at the same block. Pending until the
  // topic backfill has read the transfers over the whole history.
  async function protocolBalanceCheck(block, blockTs, contract) {
    const scan = ingest.topicProgress?.();
    if (!scan?.complete) return { status: 'pending', scanned_pct: scan?.pct ?? null };
    return balanceAgainst(block, blockTs, contract);
  }
  // The same comparison at any indexed block, with the contract read at that
  // block (node or archive): finds when a difference appeared.
  async function protocolBalanceAt(key) {
    if (!/^\d{1,12}$/.test(String(key ?? ''))) throw bad('INVALID_BLOCK');
    const block = BigInt(key);
    const top = ingest.coverage.intervals.at(-1)?.to ?? null;
    if (block < ingest.coverage.intervals[0]?.from || top === null || block > top) throw bad('BLOCK_NOT_INDEXED');
    const scan = ingest.topicProgress?.();
    if (!scan?.complete) return { status: 'pending', scanned_pct: scan?.pct ?? null };
    const [ts, contract] = await Promise.all([queries.tsAtBlock(block), ingest.protocolBalanceAt(block)]);
    if (ts === null) throw bad('BLOCK_NOT_INDEXED');
    return balanceAgainst(block, ts, contract);
  }
  async function balanceAgainst(block, blockTs, contract) {
    const c = cd();
    const [rev, moveRows, unsplit] = await Promise.all([queries.revenueUpTo(blockTs, block), queries.balanceMovesAtBlock(block), queries.unsplitAtBlock(block)]);
    const revenue = { opening: B(rev.prot_fees), reducing: B(rev.reduce_prot_fees), liquidations: B(rev.liq_prot_fees) };
    const moves = movesOf(moveRows);
    const events = protocolBalance({ revenue, moves });
    const diff = events - B(contract);
    return {
      status: diff === 0n ? 'match' : 'differs', block: block.toString(),
      events: dec(events, c), contract: dec(contract, c), difference: dec(diff, c),
      revenue: { opening_fees: dec(revenue.opening, c), reducing_fees: dec(revenue.reducing, c), liquidations: dec(revenue.liquidations, c) },
      moves: Object.fromEntries(Object.entries(BALANCE_MOVES).map(([kind, sign]) => [kind, { amount: dec(moves[kind].amount, c), count: moves[kind].count, sign: Number(sign) }])),
      // Shares no rule was checked for: counted as no revenue.
      unverified: { liquidations: Number(unsplit?.liquidations ?? 0), liquidation_fees: dec(unsplit?.fees ?? 0, c), buy_to_liquidate: Number(unsplit?.btl ?? 0) },
      checked_from: CHECKED_FROM_TS
    };
  }

  // Traders in a window at a glance: how many traded, how many are up after
  // fees, the total, and the median PnL per unit of volume (from the shared
  // per-window score table, refreshed each minute). Every fill has a maker and
  // a taker account, so the traders' summed volume is halved to match the
  // exchange volume elsewhere.
  async function traderSummary(query) {
    const w = windowOf(query);
    const table = await scores(w);
    const scale = 10 ** cd(), rows = [...table.of.values()];
    const profitable = rows.filter(r => r.pnl > 0).length;
    const ratios = rows.filter(r => r.volume > 0).map(r => r.pnl / r.volume).sort((a, b) => a - b);
    const median = ratios.length ? (ratios.length % 2 ? ratios[(ratios.length - 1) / 2] : (ratios[ratios.length / 2 - 1] + ratios[ratios.length / 2]) / 2) : null;
    const { from, to } = rangeOf(w);
    return {
      meta: metaOf({ window: w, from, to, coverage: coverageOf(from, to) }),
      traders: rows.length, profitable, profitable_pct: rows.length ? Math.round(profitable / rows.length * 10000) / 100 : null,
      net_pnl: (rows.reduce((a, r) => a + r.pnl, 0) / scale).toFixed(2), volume: (rows.reduce((a, r) => a + r.volume, 0) / scale / 2).toFixed(2),
      median_pnl_per_volume_bps: median === null ? null : Math.round(median * 1e6) / 100
    };
  }
  // Open interest by cohort: live positions grouped by account size and by
  // track record (net PnL over the indexed history), with the largest wallets.
  async function cohorts() {
    return cache.get('cohorts', 5000, async () => {
      const computed = computeMetrics(state);
      if (!computed || !state.block) throw Object.assign(new Error('SYNCING'), { status: 503 });
      const c = cd(), scale = 10 ** c, positions = [];
      for (const { market, metrics: x } of computed.markets) for (const q of x.positions) positions.push({ account: Number(q.accountId), market: market.id, symbol: market.symbol, side: q.side, notional: Number(dec(q.markNotionalCNS, c)), upnl: Number(dec(q.pnlCNS, c)) });
      const table = await scores('all');
      const t = cohortTable(positions, id => { const v = table.of.get(id)?.pnl; return v === undefined ? undefined : v / scale; });
      const groups = [...t.by_size, ...t.by_pnl];
      const addr = await addresses([...new Set(groups.flatMap(g => g.top.map(a => a.account)))]);
      for (const g of groups) for (const a of g.top) a.address = addr.get(a.account)?.address ?? null;
      const { from, to } = rangeOf('all');
      return { meta: metaOf({ window: 'all', from, to, coverage: coverageOf(from, to) }), block: state.block.number.toString(), ...t };
    });
  }
  return { protocolBalanceAt, addressesOf: addresses, resolveAccount: resolve, symbolOf: symbol, smartMoves, positionFlow, protocol, series, liquidations, trades, funding, fundingOverview, cohorts, traderSummary, flows, leaderboard, search, profile, walletAnalytics, walletPeriods, walletTrades, compare, integrity, cache, tradeView, tradeViews, rangeOf };
}
