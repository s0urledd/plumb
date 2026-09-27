// HTTP API and static dashboard. Risk endpoints answer from the collector's
// contract snapshot and carry the block, hash and freshness they describe;
// analytics endpoints answer from the ClickHouse index (analytics-api.js).
import { readFile, stat } from 'node:fs/promises';
import { extname, normalize, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';
import { existsSync } from 'node:fs';
import * as m from './math.js';
import { metrics as computeMetrics } from './state.js';
import { stressAt } from './metrics.js';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2' };
// Third-party assets served from node_modules (self-hosted, no CDN).
const require = createRequire(import.meta.url);
const nodeModules = fileURLToPath(new URL('../node_modules/', import.meta.url));
// Packages with an "exports" map hide their asset files from require.resolve.
const vendorFile = spec => { try { return require.resolve(spec); } catch { const file = join(nodeModules, spec); return existsSync(file) ? file : null; } };
export const VENDOR = {
  '/vendor/echarts.min.js': vendorFile('echarts/dist/echarts.min.js'),
  '/vendor/fonts/geist.woff2': vendorFile('geist/dist/fonts/geist-sans/Geist-Variable.woff2'),
  '/vendor/fonts/geist-mono.woff2': vendorFile('geist/dist/fonts/geist-mono/GeistMono-Variable.woff2')
};
const json = (_, value) => typeof value === 'bigint' ? value.toString() : value;
const dec = (value, decimals) => value === null || value === undefined ? null : m.toDecimalString(value, decimals);
const pct = bps => bps === null || bps === undefined ? null : Number(bps) / 100;
const lev = bps => bps === null || bps === undefined ? null : Number(bps) / 10000;
const micro = (value, decimals) => value === null || value === undefined ? null : m.toDecimalString(value, Number(decimals) + 6);
const clamp = (value, fallback, max) => { const n = Number(value); return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback; };
const csvCell = value => { let text = value === null || value === undefined ? '' : String(value); if (/^[=+\-@\t\r]/.test(text) && !/^-?\d/.test(text)) text = `'${text}`; return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; };
export function toCsv(rows, columns = rows.length ? Object.keys(rows[0]) : []) { return [columns.join(','), ...rows.map(r => columns.map(c => csvCell(r[c])).join(','))].join('\r\n') + '\r\n'; }
export const POSITION_COLUMNS = ['account_id', 'side', 'size', 'notional', 'entry_notional', 'entry_price', 'deposit', 'delta_pnl', 'premium_pnl', 'pnl', 'equity', 'maintenance_margin', 'health_pct', 'status', 'liquidation_price', 'bankruptcy_price', 'liquidation_distance_pct', 'bankruptcy_distance_pct', 'leverage', 'effective_leverage', 'entry_block', 'pnl_matches_contract'];
export const LIQUIDATION_COLUMNS = ['block', 'tx', 'log_index', 'market_id', 'symbol', 'account_id', 'side', 'mark_price', 'exit_price', 'liquidated_size', 'remaining_size', 'liquidated_notional', 'delta_pnl', 'funding', 'position_amount', 'remaining_deposit', 'on_order_book', 'full'];
const safeName = value => String(value ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'market';
const errorCode = error => error ? { code: error.message === 'RPC_UNAVAILABLE_OR_INVALID' ? 'RPC_UNAVAILABLE' : 'INTERNAL_ERROR', at: error.at } : null;
const SECURITY_HEADERS = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
// An SVG opened directly is a document: it gets no scripts and no external loads.
const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'";
const ACCOUNT_CACHE_MS = 15000;
const ACCOUNT_MAX_INFLIGHT = 4;
const ACCOUNT_MAX_QUEUED = 64;

export function createApi({ collector, analytics = null, sse = null, statusOf = () => ({}), onError = () => {}, reference = null, landscape = null, rateLimit = null, webDir = fileURLToPath(new URL('../web/', import.meta.url)), version = '0.2.0', now = () => Date.now() }) {
  const { state } = collector;
  const cd = () => state.exchangeInfo?.collateralDecimals ?? 6;
  const accountCache = new Map();
  const accountInflight = new Map();
  const latestFunding = marketId => { const block = state.block?.number; for (let i = state.history.funding.length - 1; i >= 0; i--) { const f = state.history.funding[i]; if (f.perpId === marketId && (block === undefined || f.fundingEventBlock <= block)) return f; } return null; };
  const priceDec = market => market.priceDecimals;

  function snapshot() {
    const f = collector.freshness(now());
    return { chain_id: state.chain, exchange: state.exchange, block: state.block?.number?.toString() ?? null, block_hash: state.block?.hash ?? null, block_timestamp: state.block?.timestamp ?? null, finalized_block: state.finalized?.number?.toString() ?? null, block_time_ms: state.stats.blockTimeMs ?? null, contract_version: state.exchangeInfo?.version ?? null, status: f.status, status_reason: f.reason ?? null, age_ms: f.ageMs, block_age_ms: f.blockAgeMs ?? null, generated_at: now() };
  }

  function fundingView(market) {
    const interval = state.exchangeInfo?.fundingInterval ?? 0n;
    const blockTimeMs = state.stats.blockTimeMs ?? null;
    const perInterval = m.fundingRateFraction(market.fundingRatePct100k);
    const next = state.block && interval > 0n ? m.nextFundingBlock(state.block.number, interval) : null;
    const intervalMs = blockTimeMs && interval > 0n ? Number(interval) * blockTimeMs : null;
    const perYear = intervalMs ? perInterval * (365 * 86400000 / intervalMs) : null;
    const latest = latestFunding(market.id);
    const announced = state.block ? [...state.history.funding].reverse().find(f => f.perpId === market.id && f.fundingEventBlock > state.block.number) ?? null : null;
    return {
      next_announced: announced ? fundingEntry(announced, market) : null,
      rate_per_interval_pct: perInterval * 100, rate_8h_pct: intervalMs ? perInterval * (8 * 3600000 / intervalMs) * 100 : null, rate_annualized_pct: perYear === null ? null : perYear * 100,
      direction: market.fundingRatePct100k > 0n ? 'longs pay shorts' : market.fundingRatePct100k < 0n ? 'shorts pay longs' : 'flat',
      clamp_pct: Number(market.absFundingClampPctPer100K) / 1000, interval_blocks: interval.toString(), interval_seconds: intervalMs ? Math.round(intervalMs / 1000) : null,
      next_funding_block: next?.toString() ?? null, blocks_to_next: next && state.block ? (next - state.block.number).toString() : null,
      seconds_to_next: next && state.block && blockTimeMs ? Math.round(Number(next - state.block.number) * blockTimeMs / 1000) : null,
      latest_event: latest ? fundingEntry(latest, market) : null
    };
  }

  function fundingEntry(f, market) {
    const scale = Number(market?.fundingSumScalingExp ?? 0) + (market?.priceDecimals ?? 0);
    return { market_id: f.perpId, symbol: market?.symbol ?? null, funding_event_block: f.fundingEventBlock.toString(), emitted_block: f.block.toString(), tx: f.tx, rate_pct: m.fundingRateFraction(f.actualRatePct100k) * 100, specified_rate_pct: m.fundingRateFraction(f.specifiedRatePct100k) * 100, funding_price: market ? dec(f.fundingPricePNS, market.priceDecimals) : f.fundingPricePNS.toString(), payment_per_unit: market ? dec(f.fundingPaymentPNS, scale) : f.fundingPaymentPNS.toString(), funding_sum: market ? dec(f.fundingSumPNS, scale) : f.fundingSumPNS.toString(), overwrite: f.allowOverwrite };
  }

  function liquidationEntry(l) {
    const market = state.markets.get(l.perpId);
    const pd = market?.priceDecimals ?? 0, ld = market?.lotDecimals ?? 0;
    return { block: l.block.toString(), tx: l.tx, log_index: l.logIndex, market_id: l.perpId, symbol: market?.symbol ?? null, account_id: l.accountId.toString(), side: l.positionType === 0 ? 'long' : 'short', mark_price: dec(l.markPricePNS, pd), exit_price: dec(l.exitPricePNS, pd), liquidated_size: dec(l.liquidatedLotLNS, ld), remaining_size: dec(l.remainingLotLNS, ld), liquidated_notional: market ? dec(m.notionalCNS(l.exitPricePNS, l.liquidatedLotLNS, m.units(pd, ld, cd())), cd()) : null, delta_pnl: dec(l.deltaPnlCNS, cd()), funding: dec(l.fundingCNS, cd()), position_amount: dec(l.positionAmountCNS, cd()), remaining_deposit: dec(l.remainingDepositCNS, cd()), on_order_book: l.onOrderBook, full: l.remainingLotLNS === 0n };
  }

  function positionView(p, market) {
    const pd = priceDec(market), c = cd();
    return { account_id: p.accountId.toString(), side: p.side, size: dec(p.lotLNS, market.lotDecimals), notional: dec(p.markNotionalCNS, c), entry_notional: dec(p.entryNotionalCNS, c), entry_price: micro(p.entryQ16 * m.MICRO / m.Q16, pd), deposit: dec(p.depositCNS, c), delta_pnl: dec(p.deltaPnlCNS, c), premium_pnl: dec(p.premiumPnlCNS, c), pnl: dec(p.pnlCNS, c), equity: dec(p.fmvCNS, c), maintenance_margin: dec(p.mmrCNS, c), health_pct: pct(p.healthBps), status: p.status, liquidation_price: micro(p.liquidationMicroPNS, pd), bankruptcy_price: micro(p.bankruptcyMicroPNS, pd), liquidation_distance_pct: pct(p.liquidationDistanceBps), bankruptcy_distance_pct: pct(p.bankruptcyDistanceBps), leverage: lev(p.leverageBps), effective_leverage: lev(p.effectiveLeverageBps), entry_block: p.entryBlock.toString(), pnl_matches_contract: p.contractAgrees };
  }

  function sideView(x, market) { const c = cd(); return { count: x.count, size: dec(x.lotLNS, market.lotDecimals), notional: dec(x.notionalCNS, c), entry_notional: dec(x.entryNotionalCNS, c), deposit: dec(x.depositCNS, c), delta_pnl: dec(x.deltaPnlCNS, c), premium_pnl: dec(x.premiumPnlCNS, c), equity: dec(x.fmvCNS, c), maintenance_margin: dec(x.mmrCNS, c), average_leverage: lev(x.averageLeverageBps), liquidatable: x.liquidatable, bankrupt: x.bankrupt }; }
  function ladderView(rows, market) { const c = cd(), pd = priceDec(market); return rows.map(r => ({ shock_pct: pct(r.bps), long: { count: r.long.count, notional: dec(r.long.notionalCNS, c), shortfall: dec(r.long.shortfallCNS, c), price: dec(r.long.pricePNS, pd), insurance_coverage_pct: pct(r.long.insuranceCoverageBps) }, short: { count: r.short.count, notional: dec(r.short.notionalCNS, c), shortfall: dec(r.short.shortfallCNS, c), price: dec(r.short.pricePNS, pd), insurance_coverage_pct: pct(r.short.insuranceCoverageBps) }, worst_notional: dec(r.worstNotionalCNS, c), worst_shortfall: dec(r.worstShortfallCNS, c), insurance_coverage_pct: pct(r.insuranceCoverageBps) })); }
  function mapView(map) { const c = cd(); return { bin_pct: pct(map.binBps), range_pct: pct(map.rangeBps), bins: map.bins.map(b => ({ from_pct: pct(b.fromBps), to_pct: pct(b.toBps), count: b.count, long_notional: dec(b.longNotionalCNS, c), short_notional: dec(b.shortNotionalCNS, c) })), tails: { below: { count: map.tails.below.count, notional: dec(map.tails.below.notionalCNS, c) }, above: { count: map.tails.above.count, notional: dec(map.tails.above.notionalCNS, c) } } }; }
  function liquidityView(x, market, full = false) {
    if (!x.liquidity) return null;
    const c = cd(), pd = priceDec(market), L = x.liquidity;
    const band = table => Object.fromEntries(Object.entries(table).map(([bps, d]) => [String(Number(bps) / 100), { notional: dec(d.notionalCNS, c), size: dec(d.lotLNS, market.lotDecimals), levels: d.levels }]));
    const at = bps => L.absorption?.find(r => r.bps === bps);
    // `complete: false` means the walk hit its level cap first: cover is a lower bound.
    const cover = row => row ? { long_pct: pct(row.long.coverageBps), short_pct: pct(row.short.coverageBps), min_pct: pct([row.long.coverageBps, row.short.coverageBps].filter(v => v !== null).sort((a, b) => (a < b ? -1 : 1))[0] ?? null), complete: row.long.complete && row.short.complete } : null;
    const spread = L.bestBidPNS && L.bestAskPNS && L.bestBidPNS > 0n ? Number((L.bestAskPNS - L.bestBidPNS) * 2000000n / (L.bestAskPNS + L.bestBidPNS)) / 100 : null; // against the mid
    const view = { book_block: L.block.toString(), age_blocks: state.block ? (state.block.number - L.block).toString() : null, truncated: L.truncated, levels: L.levels, best_bid: dec(L.bestBidPNS, pd), best_ask: dec(L.bestAskPNS, pd), spread_bps: spread, depth: { bids: band(L.depth.bids), asks: band(L.depth.asks) }, cover_at_2pct: cover(at(200n)), cover_at_5pct: cover(at(500n)), cover_at_10pct: cover(at(1000n)) };
    view.range_pct = L.rangeBps === null || L.rangeBps === undefined ? null : pct(L.rangeBps);
    // Market-order cost against the mid at a few sizes (unfilled: the book read holds less).
    view.cost_to_trade = (L.cost ?? []).map(c => ({ usd: c.usd, buy_bps: c.buy?.filled ? c.buy.bps : null, sell_bps: c.sell?.filled ? c.sell.bps : null, buy_filled_usd: c.buy?.filledUsd ?? 0, sell_filled_usd: c.sell?.filledUsd ?? 0 }));
    view.walked_pct = { bids: L.walkedBps?.bids === null || L.walkedBps?.bids === undefined ? null : pct(L.walkedBps.bids), asks: L.walkedBps?.asks === null || L.walkedBps?.asks === undefined ? null : pct(L.walkedBps.asks) };
    if (full) view.absorption = L.absorption.map(r => ({ shock_pct: pct(r.bps), beyond_range: Boolean(r.beyondRange), long: { demand: dec(r.long.demandCNS, c), depth: dec(r.long.depthCNS, c), levels: r.long.levels, cover_pct: pct(r.long.coverageBps), complete: r.long.complete }, short: { demand: dec(r.short.demandCNS, c), depth: dec(r.short.depthCNS, c), levels: r.short.levels, cover_pct: pct(r.short.coverageBps), complete: r.short.complete } }));
    return view;
  }
  function adlView(x) { const c = cd(); const row = p => ({ rank: p.rank, account_id: p.accountId.toString(), side: p.side, roe_pct: pct(p.roeBps), pnl: dec(p.pnlCNS, c), notional: dec(p.markNotionalCNS, c), leverage: lev(p.leverageBps) }); return { method: 'Estimated order: profitable positions ranked by unrealised PnL relative to their deposit. Perpl documents only that auto-deleveraging takes opposing positions most profitable first and selects them off-chain.', long: x.adl.long.map(row), short: x.adl.short.map(row) }; }
  function bookView(entry) {
    const { market, metrics: x } = entry; const book = market.book;
    if (!book) throw Object.assign(new Error('BOOK_UNAVAILABLE'), { status: 404 });
    const c = cd(), pd = priceDec(market), u = m.units(pd, market.lotDecimals, c);
    const level = l => ({ price: dec(l.pricePNS, pd), size: dec(l.lotLNS, market.lotDecimals), notional: dec(m.notionalCNS(l.pricePNS, l.lotLNS, u), c), expired_size: dec(l.expiringLNS, market.lotDecimals) });
    return { market_id: market.id, symbol: market.symbol, mark: dec(market.markPNS, pd), stale: Boolean(x.bookStale), liquidity: liquidityView(x, market, true), bids: book.bids.slice(0, 40).map(level), asks: book.asks.slice(0, 40).map(level), requests: book.requests };
  }
  // Where open positions were entered, long and short, against the mark: a
  // profile of entry prices, each side's size-weighted average entry and how
  // many of its positions are in profit now.
  function entriesView(entry, bins = 32) {
    const { market, metrics: x } = entry;
    const pd = priceDec(market), mark = Number(dec(market.markPNS, pd));
    const rows = x.positions.map(p => positionView(p, market)).map(v => ({ side: v.side, price: Number(v.entry_price), size: Number(v.size), entry: Number(v.entry_notional), pnl: Number(v.pnl) })).filter(r => r.price > 0 && r.size > 0);
    const side = s => {
      const list = rows.filter(r => r.side === s);
      const size = list.reduce((a, r) => a + r.size, 0), notional = list.reduce((a, r) => a + r.entry, 0);
      const up = list.filter(r => r.pnl > 0);
      return { count: list.length, entry_notional: notional.toFixed(2), average_entry: size ? (notional / size).toPrecision(8) : null, in_profit: up.length, in_profit_pct: list.length ? Math.round(up.length / list.length * 1000) / 10 : null, upnl: list.reduce((a, r) => a + r.pnl, 0).toFixed(2) };
    };
    // The range covers the 2nd to 98th percentile of entries and the mark;
    // entries outside it are counted in the edge bins.
    const prices = rows.map(r => r.price).sort((a, b) => a - b);
    const q = f => prices[Math.min(prices.length - 1, Math.max(0, Math.floor(f * (prices.length - 1))))];
    let lo = prices.length ? Math.min(q(0.02), mark) : mark * 0.9, hi = prices.length ? Math.max(q(0.98), mark) : mark * 1.1;
    if (hi <= lo) { lo = mark * 0.98; hi = mark * 1.02; }
    const pad = (hi - lo) * 0.03; lo -= pad; hi += pad;
    const width = (hi - lo) / bins;
    const out = Array.from({ length: bins }, (_, i) => ({ lo: lo + i * width, hi: lo + (i + 1) * width, long: 0, short: 0, long_count: 0, short_count: 0 }));
    for (const r of rows) {
      const b = out[Math.min(bins - 1, Math.max(0, Math.floor((r.price - lo) / width)))];
      if (r.side === 'long') { b.long += r.entry; b.long_count++; } else { b.short += r.entry; b.short_count++; }
    }
    const fmt = v => Number(v.toPrecision(8));
    return { market_id: market.id, symbol: market.symbol, block: state.block.number.toString(), mark: dec(market.markPNS, pd), positions: rows.length, long: side('long'), short: side('short'), bins: out.map(b => ({ lo: fmt(b.lo), hi: fmt(b.hi), long: b.long.toFixed(2), short: b.short.toFixed(2), long_count: b.long_count, short_count: b.short_count })) };
  }
  function stressView(entry, query) {
    const { market, metrics: x, units } = entry;
    const move = Number(query.get('move_pct'));
    if (!Number.isFinite(move) || Math.abs(move) > 95) throw Object.assign(new Error('INVALID_MOVE'), { status: 400 });
    const bps = BigInt(Math.round(move * 100));
    if (bps === 0n) throw Object.assign(new Error('INVALID_MOVE'), { status: 400 });
    const r = stressAt(x.positions, x.bookStale ? { ...market, book: null } : market, units, bps);
    const c = cd(), pd = priceDec(market);
    return { market_id: market.id, symbol: market.symbol, price_decimals: pd, lot_decimals: market.lotDecimals, block: state.block.number.toString(), move_pct: move, side: r.side, price: dec(r.pricePNS, pd), mark: dec(market.markPNS, pd), liquidated: { count: r.count, notional: dec(r.notionalCNS, c), share_of_oi_pct: pct(r.shareBps) }, shortfall: dec(r.shortfallCNS, c), insurance_coverage_pct: pct(r.insuranceCoverageBps), remaining_notional: dec(r.remainingNotionalCNS, c), liquidity: r.depthCNS === null ? null : { depth: dec(r.depthCNS, c), levels: r.depthLevels, absorption_pct: pct(r.absorptionBps), complete: r.depthComplete, book_block: market.book?.block !== undefined ? market.book.block.toString() : null }, positions_hit: r.hit.slice(0, 20).map(p => positionView(p, market)) };
  }
  // Contract reads for account balances run a few at a time; the rest wait
  // their turn (a compare page asks for several at once) up to a bounded queue.
  let accountActive = 0;
  const accountWaiting = [];
  async function withAccountSlot(fn) {
    if (accountActive >= ACCOUNT_MAX_INFLIGHT) {
      if (accountWaiting.length >= ACCOUNT_MAX_QUEUED) throw Object.assign(new Error('BUSY'), { status: 503 });
      await new Promise(resolve => accountWaiting.push(resolve));
    }
    accountActive++;
    try { return await fn(); } finally { accountActive--; accountWaiting.shift()?.(); }
  }
  // Balances and open positions of one account at the snapshot block: the
  // positions are taken before the balance read, which is pinned to their block.
  async function accountState(accountId) {
    const key = String(accountId);
    const block = state.block.number, computed = computeMetrics(state);
    let cached = accountCache.get(key);
    if (!cached || now() - cached.at >= ACCOUNT_CACHE_MS || cached.block !== block) {
      if (accountCache.size > 500) accountCache.clear();
      const flight = `${key}:${block}`;
      let pending = accountInflight.get(flight);
      if (!pending) {
        pending = withAccountSlot(() => collector.reader.call('getAccountById', [BigInt(accountId)], block))
          .then(info => ({ at: now(), block, id: BigInt(info.accountId), address: info.accountAddr, balanceCNS: BigInt(info.balanceCNS), lockedBalanceCNS: BigInt(info.lockedBalanceCNS), frozen: Number(info.frozen) }))
          .finally(() => accountInflight.delete(flight));
        accountInflight.set(flight, pending);
      }
      cached = await pending;
      accountCache.set(key, cached);
    }
    const c = cd(), id = BigInt(accountId);
    const positions = [];
    for (const entry of computed.markets) { const p = entry.metrics.positions.find(q => q.accountId === id); if (p) positions.push({ market: entry.market.id, symbol: entry.market.symbol, mark: dec(entry.market.markPNS, entry.market.priceDecimals), ...positionView(p, entry.market) }); }
    const sum = f => positions.reduce((a, p) => a + Number(p[f] ?? 0), 0);
    const closest = positions.filter(p => p.liquidation_distance_pct !== null).sort((a, b) => a.liquidation_distance_pct - b.liquidation_distance_pct)[0] ?? null;
    // The balance includes what open orders lock (available = balance - locked).
    const available = cached.balanceCNS > cached.lockedBalanceCNS ? cached.balanceCNS - cached.lockedBalanceCNS : 0n;
    const value = Number(dec(cached.balanceCNS, c)) + sum('equity'), notional = sum('notional');
    return {
      block: cached.block.toString(),
      portfolio: { block: cached.block.toString(), balance: dec(cached.balanceCNS, c), locked_balance: dec(cached.lockedBalanceCNS, c), available_balance: dec(available, c), frozen: cached.frozen !== 0, positions: positions.length, position_margin: sum('deposit').toFixed(c), unrealized_pnl: sum('pnl').toFixed(c), account_value: value.toFixed(c), notional: notional.toFixed(c), margin_usage_pct: value > 0 ? Number((sum('deposit') / value * 100).toFixed(2)) : null, leverage: value > 0 ? Number((notional / value).toFixed(2)) : null, closest_liquidation: closest ? { market: closest.market, symbol: closest.symbol, side: closest.side, distance_pct: closest.liquidation_distance_pct, liquidation_price: closest.liquidation_price } : null },
      positions
    };
  }
  function seriesView(query) {
    const hours = Math.min(Math.max(Number(query.get('hours')) || 24, 1), 168);
    const marketId = /^\d{1,6}$/.test(query.get('market') ?? '') ? query.get('market') : null;
    const since = (state.block?.timestamp ?? Math.floor(now() / 1000)) - hours * 3600;
    const c = cd();
    const points = state.series.points.filter(p => p.ts >= since).map(p => {
      const base = { block: p.block.toString(), ts: p.ts };
      if (marketId) { const mk = p.markets[marketId]; const market = state.markets.get(Number(marketId)); return mk ? { ...base, mark: market ? dec(mk.markPNS, market.priceDecimals) : mk.markPNS.toString(), notional: dec(mk.notionalCNS, c), at_10pct: dec(mk.at1000, c), shortfall_10pct: dec(mk.shortfall1000, c), insurance: dec(mk.insuranceCNS, c), funding_rate_pct: m.fundingRateFraction(mk.fundingRatePct100k) * 100, positions: mk.positions, bid_depth_2pct: dec(mk.bidDepth200, c), ask_depth_2pct: dec(mk.askDepth200, c) } : null; }
      return { ...base, notional: dec(p.totals.notionalCNS, c), at_5pct: dec(p.totals.at500, c), at_10pct: dec(p.totals.at1000, c), shortfall_10pct: dec(p.totals.shortfall1000, c), insurance: dec(p.totals.insuranceCNS, c), positions: p.totals.positions, liquidatable: p.totals.liquidatable };
    }).filter(Boolean);
    return { market_id: marketId ? Number(marketId) : null, hours, every_blocks: state.series.everyBlocks.toString(), points };
  }
  function concentrationView(x) { const c = cd(); return { positions: x.positions, total_notional: dec(x.totalNotionalCNS, c), top1_pct: pct(x.top1Bps), top5_pct: pct(x.top5Bps), top10_pct: pct(x.top10Bps), hhi: x.hhi === null ? null : Number(x.hhi), largest: x.largest ? { account_id: x.largest.accountId.toString(), side: x.largest.side, notional: dec(x.largest.notionalCNS, c), liquidation_distance_pct: pct(x.largest.liquidationDistanceBps) } : null }; }

  function marketSummary({ market, metrics: x }) {
    const c = cd(), pd = priceDec(market);
    const at = bps => x.ladder.find(r => r.bps === bps);
    const age = state.block ? state.block.timestamp - market.markTimestamp : null;
    return {
      id: market.id, symbol: market.symbol, name: market.name, status: market.status, active: market.status === 4 && market.unwind.status === 4, price_decimals: market.priceDecimals, lot_decimals: market.lotDecimals,
      prices: { mark: dec(market.markPNS, pd), oracle: dec(market.oraclePNS, pd), last: dec(market.lastPNS, pd), basis_pct: pct(x.basisBps), mark_age_seconds: age, mark_stale: age !== null && age > market.refPriceMaxAgeSec, oracle_used: !market.ignOracle },
      open_interest: { long_size: dec(x.oi.longLNS, market.lotDecimals), short_size: dec(x.oi.shortLNS, market.lotDecimals), long_notional: dec(x.oi.longNotionalCNS, c), short_notional: dec(x.oi.shortNotionalCNS, c), total_notional: dec(x.oi.totalNotionalCNS, c), max_size: x.oi.maxLNS === null ? null : dec(x.oi.maxLNS, market.lotDecimals), utilisation_pct: pct(x.oi.utilisationBps), reconciled: x.oi.reconciled },
      positions: { count: x.positions.length, long: x.long.count, short: x.short.count, liquidatable: x.long.liquidatable + x.short.liquidatable, bankrupt: x.long.bankrupt + x.short.bankrupt },
      long: sideView(x.long, market), short: sideView(x.short, market),
      margin: { max_leverage: Number(market.initHdths) / 100, dynamic_max_leverage: Number(market.dynamicInitHdths) / 100, initial_margin_pct: Number(market.initHdths) > 0 ? 10000 / Number(market.initHdths) : null, maintenance_margin_pct: Number(market.maintHdths) > 0 ? 10000 / Number(market.maintHdths) : null, maintenance_fraction_hdths: market.maintHdths.toString(), initial_fraction_hdths: market.initHdths.toString() },
      insurance: { balance: dec(x.insurance.balanceCNS, c), position_balance: dec(x.insurance.positionBalanceCNS, c), coverage_of_notional_pct: pct(x.insurance.coverageOfNotionalBps), coverage_of_maintenance_pct: pct(x.insurance.coverageOfMmrBps), liquidation_split: { trader_pct: Number(market.liquidation.userPer100K) / 1000, insurance_pct: Number(market.liquidation.insurancePer100K) / 1000, protocol_pct: Number(market.liquidation.protocolPer100K) / 1000 } },
      risk: { notional_at_5pct: dec(at(500n)?.worstNotionalCNS ?? 0n, c), notional_at_10pct: dec(at(1000n)?.worstNotionalCNS ?? 0n, c), shortfall_at_10pct: dec(at(1000n)?.worstShortfallCNS ?? 0n, c), insurance_coverage_at_10pct: pct(at(1000n)?.insuranceCoverageBps ?? null), long_notional_at_10pct: dec(at(1000n)?.long.notionalCNS ?? 0n, c), short_notional_at_10pct: dec(at(1000n)?.short.notionalCNS ?? 0n, c) },
      concentration: concentrationView(x.concentration.all),
      liquidity: liquidityView(x, market), book_stale: Boolean(x.bookStale),
      funding: fundingView(market),
      unwind_status: market.unwind.status, orders: market.numOrders.toString(),
      validation: { oi_reconciled: x.validation.oiReconciled, pnl_checked: x.validation.pnlAgreement.checked, pnl_agree: x.validation.pnlAgreement.agree },
      reference: reference ? reference.compare(market, latestFunding(market.id)?.fundingSumPNS ?? null) : null
    };
  }

  function marketDetail(entry, query) {
    const { market, metrics: x } = entry;
    const limit = clamp(query.get('limit'), 25, 500);
    const sorted = [...x.positions].sort((a, b) => (b.markNotionalCNS > a.markNotionalCNS ? 1 : b.markNotionalCNS < a.markNotionalCNS ? -1 : 0));
    return { ...marketSummary(entry), ladder: ladderView(x.ladder, market), liquidation_map: mapView(x.map), liquidity: liquidityView(x, market, true), adl_queue: adlView(x), health: x.health.map(h => ({ from_pct: pct(h.fromBps), to_pct: pct(h.toBps), count: h.count, notional: dec(h.notionalCNS, cd()) })), concentration_by_side: { long: concentrationView(x.concentration.long), short: concentrationView(x.concentration.short) }, top_positions: sorted.slice(0, limit).map(p => positionView(p, market)), funding_history: state.history.funding.filter(f => f.perpId === market.id).slice(-48).map(f => fundingEntry(f, market)), recent_liquidations: state.history.liquidations.filter(l => l.perpId === market.id).slice(-25).reverse().map(liquidationEntry) };
  }

  function positionsList(entry, query, { defaultLimit = 50, maxLimit = 1000 } = {}) {
    const { market, metrics: x } = entry;
    const side = query.get('side'), sort = query.get('sort') || 'notional', limit = clamp(query.get('limit'), defaultLimit, maxLimit);
    let list = x.positions.filter(p => !side || p.side === side);
    const comparators = { notional: (a, b) => b.markNotionalCNS - a.markNotionalCNS, risk: (a, b) => (a.liquidationDistanceBps ?? 1n << 62n) - (b.liquidationDistanceBps ?? 1n << 62n), pnl: (a, b) => b.pnlCNS - a.pnlCNS, size: (a, b) => b.lotLNS - a.lotLNS };
    if (!Object.hasOwn(comparators, sort) || !['long', 'short', null].includes(side)) throw Object.assign(new Error('INVALID_SORT'), { status: 400 });
    const cmp = comparators[sort];
    list = list.sort((a, b) => Number(cmp(a, b) > 0n) - Number(cmp(a, b) < 0n));
    return { market_id: market.id, symbol: market.symbol, sort, side: side ?? null, total: list.length, positions: list.slice(0, limit).map(p => positionView(p, market)) };
  }
  // A market-wide 10 % fall liquidates longs into the bids, a rise shorts into
  // the asks. Depth in one market or on one side absorbs nothing elsewhere, so
  // each market counts at most its own demand.
  function overviewLiquidity(computed) {
    const c = cd();
    const down = { demand: 0n, absorbed: 0n }, up = { demand: 0n, absorbed: 0n };
    let markets = 0, complete = true, weakest = null;
    for (const { market, metrics: x } of computed.markets) {
      const row = x.liquidity?.absorption?.find(r => r.bps === 1000n);
      if (!row || row.beyondRange) continue;
      markets++;
      for (const [d, side, name] of [[down, row.long, 'long'], [up, row.short, 'short']]) {
        if (side.demandCNS <= 0n) continue;
        d.demand += side.demandCNS; d.absorbed += m.minBig(side.depthCNS, side.demandCNS); complete &&= side.complete;
        if (side.coverageBps !== null && (!weakest || side.coverageBps < weakest.bps)) weakest = { market: market.id, symbol: market.symbol, side: name, bps: side.coverageBps, complete: side.complete };
      }
    }
    const share = d => (d.demand > 0n ? m.floorDiv(d.absorbed * 10000n, d.demand) : null);
    const view = d => ({ demand: dec(d.demand, c), absorbed: dec(d.absorbed, c), absorbed_pct: pct(share(d)) });
    const shares = [share(down), share(up)].filter(v => v !== null);
    return { markets_with_book: markets, fall_10pct: view(down), rise_10pct: view(up), absorbed_at_10pct_pct: shares.length ? pct(shares.reduce((a, b) => (a < b ? a : b))) : null, weakest: weakest ? { market: weakest.market, symbol: weakest.symbol, side: weakest.side, cover_pct: pct(weakest.bps), complete: weakest.complete } : null, complete };
  }

  function overview() {
    const computed = computeMetrics(state);
    const t = computed.totals, c = cd();
    return {
      exchange: { version: state.exchangeInfo.version, halted: state.exchangeInfo.halted, accounts: state.exchangeInfo.numberOfAccounts.toString(), collateral_token: state.exchangeInfo.collateralToken, collateral_decimals: c, exchange_balance: dec(state.exchangeInfo.balanceCNS, c), protocol_balance: dec(state.exchangeInfo.protocolBalanceCNS, c), funding_interval_blocks: state.exchangeInfo.fundingInterval.toString(), block_time_ms: state.stats.blockTimeMs ?? null },
      totals: { markets: t.markets, positions: t.positions, liquidatable: t.liquidatable, bankrupt: t.bankrupt, total_notional: dec(t.notionalCNS, c), total_deposit: dec(t.depositCNS, c), total_equity: dec(t.fmvCNS, c), insurance_total: dec(t.insuranceCNS, c), notional_at_5pct: dec(t.notionalAt500Bps, c), notional_at_10pct: dec(t.notionalAt1000Bps, c), direction_at_10pct: t.directionAt1000Bps === 'up' ? 'rise' : 'fall', shortfall_at_10pct: dec(t.shortfallAt1000Bps, c), insurance_coverage_at_10pct: t.shortfallAt1000Bps > 0n ? pct(m.floorDiv(t.coveredAt1000Bps * 10000n, t.shortfallAt1000Bps)) : null, uncovered_at_10pct: dec(t.shortfallAt1000Bps - t.coveredAt1000Bps, c), moves: Object.fromEntries([500, 1000].flatMap(bps => [['down', 'fall'], ['up', 'rise']].map(([k, name]) => { const v = t.moves[bps][k]; return [`${name}_${bps / 100}pct`, { notional: dec(v.notionalCNS, c), shortfall: dec(v.shortfallCNS, c), uncovered: dec(v.shortfallCNS - v.coveredCNS, c) }]; }))), all_reconciled: t.allReconciled, liquidity: overviewLiquidity(computed) },
      series_points: state.series.points.length,
      markets: computed.markets.map(marketSummary)
    };
  }

  function validation() {
    const computed = computeMetrics(state);
    return {
      bootstrap: state.bootstrap ? { block: state.bootstrap.block.toString(), hash: state.bootstrap.hash, at: state.bootstrap.at, reason: state.bootstrap.reason } : null,
      reconciliation: state.reconciliation ? { block: state.reconciliation.block?.toString() ?? null, ok: state.reconciliation.ok, markets: state.reconciliation.markets, mismatches: state.reconciliation.mismatches, at: state.reconciliation.at } : null,
      verification: state.verification ? { ...state.verification, error: state.verification.error ? errorCode({ message: state.verification.error }).code : undefined, block: state.verification.block?.toString(), accounts: state.verification.accounts?.toString() } : null,
      pnl_agreement: computed ? computed.markets.map(x => ({ market_id: x.market.id, symbol: x.market.symbol, checked: x.metrics.validation.pnlAgreement.checked, agree: x.metrics.validation.pnlAgreement.agree })) : [],
      metrics: {
        open_interest: { status: 'validated', method: 'Sum of paged getPositionsV2 per side equals getPerpetualInfoV2 counters at every poll; independent account-bitmap rescan periodically.' },
        delta_pnl: { status: 'validated', method: 'Recomputed from effective entry price, size and mark; compared with getPositionsV2.deltaPnlCNS for every open position (truncation toward zero).' },
        premium_pnl: { status: 'validated', method: 'Taken from the contract; funding formula checked across live funding events (see docs/validation-gate.md).' },
        liquidation_price: { status: 'formula', method: 'Perpl documentation and perpl-sdk position.rs: entry + side * (MMR - deposit - premium) / size, MMR = entry notional / maintenance fraction. Compared with contract diagnostics when available.' },
        liquidation_ladder: { status: 'derived', method: 'Positions whose liquidation price lies within each adverse move of the mark; shortfall is the negative equity beyond bankruptcy at that price if no liquidation executes first.' },
        funding: { status: 'validated', method: 'FundingEventCompleted events and getFundingSumAtBlock; rate = fundingRatePct100k / 1e5 per funding interval.' },
        insurance: { status: 'on-chain', method: 'getPerpetualInfoV2.insuranceBalanceCNS per market.' },
        concentration: { status: 'derived', method: 'Shares of mark notional across positions; HHI on notional shares.' }
      },
      rpc: { ...collector.reader.stats },
      collector: { ...state.stats, options: { poll_ms: collector.options.pollMs, log_range: collector.options.logRange.toString(), verify_every_blocks: collector.options.verifyEveryBlocks.toString(), backfill_blocks: collector.options.backfillBlocks.toString() } }
    };
  }

  function referenceView() {
    if (!reference) return { enabled: false };
    return { enabled: true, error: reference.error, fetched_at: reference.last?.at ?? null, chain_id: reference.last?.chainId ?? null, markets: [...state.markets.values()].map(market => ({ id: market.id, symbol: market.symbol, comparison: reference.compare(market, latestFunding(market.id)?.fundingSumPNS ?? null) })) };
  }

  const risk = true;
  // Positions carry the account's address when the index (or the contract) knows it.
  async function withAddresses(rows) {
    if (!analytics?.addressesOf || !rows?.length) return rows;
    const map = await analytics.addressesOf([...new Set(rows.map(r => Number(r.account_id)))]).catch(() => new Map());
    for (const r of rows) r.address = map.get(Number(r.account_id))?.address ?? null;
    return rows;
  }
  const A = name => { if (!analytics) throw Object.assign(new Error('ANALYTICS_UNAVAILABLE'), { status: 503 }); return analytics[name]; };
  const routes = [
    ['GET', /^\/api\/v1\/health$/, () => ({ ok: true, version, snapshot: snapshot(), collector: { polls: state.stats.polls, errors: state.stats.errors, last_error: errorCode(state.stats.lastError), last_poll_ms: state.stats.lastPollMs, uptime_ms: now() - state.stats.startedAt, rpc_requests: collector.reader.stats.requests }, ...statusOf(), memory: { rss_mb: Math.round(process.memoryUsage().rss / 1048576), heap_mb: Math.round(process.memoryUsage().heapUsed / 1048576) } })],
    // Protocol analytics (ClickHouse index + live contract state).
    ['GET', /^\/api\/v1\/protocol$/, (_, q) => A('protocol')(q)],
    ['GET', /^\/api\/v1\/cohorts$/, () => A('cohorts')(), risk],
    ['GET', /^\/api\/v1\/traders\/summary$/, (_, q) => A('traderSummary')(q)],
    ['GET', /^\/api\/v1\/protocol\/series$/, (_, q) => A('series')(q)],
    ['GET', /^\/api\/v1\/trades$/, (_, q) => A('trades')(q)],
    ['GET', /^\/api\/v1\/liquidations$/, async (_, q) => { const body = await A('liquidations')(q); return q.get('format') === 'csv' ? { csv: toCsv(body.rows), filename: `plumb-liquidations-${body.meta.block ?? 'unknown'}.csv` } : body; }],
    ['GET', /^\/api\/v1\/funding$/, (_, q) => A('fundingOverview')(q)],
    ['GET', /^\/api\/v1\/flows$/, (_, q) => A('flows')(q)],
    ['GET', /^\/api\/v1\/leaderboard$/, async (_, q) => { const body = await A('leaderboard')(q); return q.get('format') === 'csv' ? { csv: toCsv(body.rows.map(r => ({ ...r, markets: r.markets.join(' ') }))), filename: `plumb-leaderboard-${body.meta.window}-${body.meta.sort}.csv` } : body; }],
    ['GET', /^\/api\/v1\/search$/, (_, q) => A('search')(q)],
    ['GET', /^\/api\/v1\/wallets\/(0x[0-9a-fA-F]{40}|[1-9]\d{0,8})$/, match => A('profile')(match[1])],
    ['GET', /^\/api\/v1\/wallets\/(0x[0-9a-fA-F]{40}|[1-9]\d{0,8})\/analytics$/, match => A('walletAnalytics')(match[1])],
    ['GET', /^\/api\/v1\/wallets\/(0x[0-9a-fA-F]{40}|[1-9]\d{0,8})\/periods$/, match => A('walletPeriods')(match[1])],
    ['GET', /^\/api\/v1\/wallets\/(0x[0-9a-fA-F]{40}|[1-9]\d{0,8})\/trades$/, async (match, q) => { const body = await A('walletTrades')(match[1], q); return q.get('format') === 'csv' ? { csv: toCsv(body.rows), filename: `plumb-wallet-${body.account.id}-trades.csv` } : body; }],
    ['GET', /^\/api\/v1\/compare$/, (_, q) => A('compare')(q)],
    ['GET', /^\/api\/v1\/integrity$/, () => A('integrity')()],
    // Risk (contract snapshot).
    ['GET', /^\/api\/v1\/overview$/, () => ({ snapshot: snapshot(), ...overview() }), risk],
    ['GET', /^\/api\/v1\/markets$/, () => ({ snapshot: snapshot(), markets: computeMetrics(state).markets.map(marketSummary) }), risk],
    ['GET', /^\/api\/v1\/markets\/(\d+)$/, async (match, query) => { const market = marketDetail(entryFor(match[1]), query); await withAddresses(market.top_positions); return { snapshot: snapshot(), market }; }, risk],
    ['GET', /^\/api\/v1\/markets\/(\d+)\/positions$/, (match, query) => { const csv = query.get('format') === 'csv'; const body = { snapshot: snapshot(), ...positionsList(entryFor(match[1]), query, csv ? { defaultLimit: 5000, maxLimit: 5000 } : {}) }; return csv ? { csv: toCsv(body.positions, POSITION_COLUMNS), filename: `plumb-${safeName(body.symbol)}-positions-${body.snapshot.block}.csv` } : body; }, risk],
    ['GET', /^\/api\/v1\/markets\/(\d+)\/entries$/, match => ({ snapshot: snapshot(), ...entriesView(entryFor(match[1])) })],
    ['GET', /^\/api\/v1\/markets\/(\d+)\/flow$/, (match, q) => A('positionFlow')(match[1], q)],
    ['GET', /^\/api\/v1\/markets\/(\d+)\/stress$/, async (match, query) => { const view = stressView(entryFor(match[1]), query); await withAddresses(view.positions_hit); return { snapshot: snapshot(), ...view }; }, risk],
    ['GET', /^\/api\/v1\/markets\/(\d+)\/book$/, match => ({ snapshot: snapshot(), ...bookView(entryFor(match[1])) }), risk],
    ['GET', /^\/api\/v1\/markets\/(\d+)\/ladder$/, match => { const e = entryFor(match[1]); return { snapshot: snapshot(), market_id: e.market.id, symbol: e.market.symbol, ladder: ladderView(e.metrics.ladder, e.market), liquidation_map: mapView(e.metrics.map) }; }, risk],
    ['GET', /^\/api\/v1\/markets\/(\d+)\/funding$/, async (match, query) => { const e = entryFor(match[1]); const history = analytics ? await analytics.funding(e.market.id, query) : null; return { snapshot: snapshot(), market_id: e.market.id, symbol: e.market.symbol, current: fundingView(e.market), history: history?.rows ?? state.history.funding.filter(f => f.perpId === e.market.id).slice(-48).map(f => fundingEntry(f, e.market)) }; }, risk],
    ['GET', /^\/api\/v1\/series$/, (_, query) => ({ snapshot: snapshot(), ...seriesView(query) }), risk],
    ['GET', /^\/api\/v1\/validation$/, async () => ({ snapshot: snapshot(), ...validation(), integrity: analytics ? await analytics.integrity().catch(() => null) : null }), risk],
    ['GET', /^\/api\/v1\/reference$/, () => ({ snapshot: snapshot(), ...referenceView() }), risk],
    ['GET', /^\/api\/v1\/landscape$/, async () => { if (!landscape) throw Object.assign(new Error('LANDSCAPE_DISABLED'), { status: 404 }); return landscape.get(); }],
    ['GET', /^\/api\/v1\/events$/, () => ({ snapshot: snapshot(), parameter_changes: state.history.params.slice(-100).reverse().map(p => ({ ...p, block: p.block.toString() })), unwinds: state.history.unwinds.slice(-50).reverse().map(u => ({ ...u, block: u.block.toString() })), diagnostics: state.history.validation.slice(-50).reverse().map(v => ({ ...v, block: v.block.toString(), accountId: v.accountId.toString(), markPricePNS: v.markPricePNS.toString(), liqPricePNS: v.liqPricePNS?.toString() ?? null, bankruptcyPricePNS: v.bankruptcyPricePNS?.toString() ?? null })) }), risk]
  ];

  function entryFor(id) {
    const entry = computeMetrics(state)?.markets.find(x => x.market.id === Number(id));
    if (!entry) throw Object.assign(new Error('MARKET_NOT_FOUND'), { status: 404 });
    return entry;
  }

  async function serveStatic(pathname, req, res) {
    if (Object.hasOwn(VENDOR, pathname)) {
      const file = VENDOR[pathname];
      if (!file) return send(res, 404, { error: 'NOT_FOUND' });
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'public, max-age=86400, immutable', 'content-length': body.length, 'access-control-allow-origin': '*', ...SECURITY_HEADERS });
      return res.end(body);
    }
    const relative = pathname === '/' ? 'index.html' : normalize(pathname).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
    const file = join(webDir, relative);
    if (!file.startsWith(webDir) || relative.includes('..')) return send(res, 404, { error: 'NOT_FOUND' });
    try {
      const info = await stat(file);
      if (!info.isFile()) return send(res, 404, { error: 'NOT_FOUND' });
      // Dashboard files are revalidated on every load (a cheap 304 when
      // unchanged), so a deploy never leaves a browser mixing old and new modules.
      const etag = `W/"${info.size.toString(36)}-${Math.floor(info.mtimeMs).toString(36)}"`;
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag, 'cache-control': 'no-cache' }); return res.end(); }
      const raw = await readFile(file);
      const zip = /\.(html|js|css|svg|json)$/.test(file) && /\bgzip\b/.test(req.headers['accept-encoding'] ?? '') && raw.length > 1024;
      const body = zip ? gzipSync(raw) : raw;
      const csp = extname(file) === '.html' ? CSP : extname(file) === '.svg' ? SVG_CSP : null;
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache', etag, 'content-length': body.length, ...(zip ? { 'content-encoding': 'gzip', vary: 'accept-encoding' } : {}), ...SECURITY_HEADERS, ...(csp ? { 'content-security-policy': csp } : {}) });
      res.end(body);
    } catch { send(res, 404, { error: 'NOT_FOUND' }); }
  }

  function send(res, status, body, extra = {}, req = null) {
    if (body && typeof body.csv === 'string') { res.writeHead(status, { 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*', 'content-disposition': `attachment; filename="${body.filename}"`, 'x-snapshot-block': state.block?.number?.toString() ?? '', ...SECURITY_HEADERS }); return res.end(body.csv); }
    const text = JSON.stringify(body, json);
    const zip = req && text.length > 2048 && /\bgzip\b/.test(req.headers['accept-encoding'] ?? '');
    const payload = zip ? gzipSync(text) : text;
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*', 'x-snapshot-block': state.block?.number?.toString() ?? '', ...(zip ? { 'content-encoding': 'gzip', vary: 'accept-encoding' } : {}), ...SECURITY_HEADERS, ...extra });
    res.end(payload);
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return req.method === 'GET' || req.method === 'HEAD' ? serveStatic(url.pathname, req, res) : send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    if (rateLimit && url.pathname !== '/api/v1/health') {
      const r = rateLimit.check(req, url.pathname, url.searchParams);
      if (!r.ok) return send(res, 429, { error: 'RATE_LIMITED', retry_after_s: r.retryAfterS }, { 'retry-after': String(r.retryAfterS) });
    }
    if (url.pathname === '/api/v1/stream' && req.method === 'GET') return sse ? sse.open(req, res, SECURITY_HEADERS) : send(res, 503, { error: 'STREAM_UNAVAILABLE' });
    const route = routes.find(([method, pattern]) => method === req.method && pattern.test(url.pathname));
    if (!route) return send(res, 404, { error: 'NOT_FOUND' });
    try {
      if (route[3] && (!state.block || !state.exchangeInfo)) return send(res, 503, { error: 'SYNCING', snapshot: snapshot() }, { 'retry-after': '5' });
      send(res, 200, await route[2](url.pathname.match(route[1]), url.searchParams), {}, req);
    } catch (error) {
      const status = error.status ?? (error.message === 'RPC_UNAVAILABLE_OR_INVALID' ? 503 : 500);
      if (status === 500) onError(error, url.pathname);
      send(res, status, { error: error.status ? error.message : status === 503 ? 'RPC_UNAVAILABLE' : 'INTERNAL_ERROR' });
    }
  }

  return { handle, accountState, routes: routes.map(([method, pattern]) => `${method} ${pattern.source}`) };
}
