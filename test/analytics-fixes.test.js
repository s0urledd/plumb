import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { roundTrips, performance, insights } from '../src/analytics.js';
import { createCache, createAnalyticsApi } from '../src/analytics-api.js';
import { createQueries } from '../src/query.js';
import { createCollector, collectorOptions } from '../src/collector.js';
import { createFakeExchange, EXCHANGE } from './helpers/fake-exchange.js';

const LONG = 0, SHORT = 1;
let seq = 0;
const row = (kind, market, side, o = {}) => ({ kind, market, side, role: 'taker', block: ++seq, log_index: 0, ts: 1790000000 + seq * 600, lot: 0n, start_lot: 0n, end_lot: 0n, notional: 0n, fee: 0n, builder_fee: 0n, pnl: 0n, funding: 0n, leverage: 1000, ...o });
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

// An analytics API over fake queries and an in-memory collector state.
function analyticsWith(queries, { state = { block: null, markets: new Map(), exchangeInfo: null, stats: {} }, clock = { t: 1790005000000 } } = {}) {
  const ingest = {
    collateralDecimals: 6,
    markets: new Map([[1, { symbol: 'BTC', name: 'BTC', priceDecimals: 1, lotDecimals: 5 }], [20, { symbol: 'ETH', name: 'ETH', priceDecimals: 1, lotDecimals: 5 }]]),
    unitsOf: () => null,
    status: { live: { to: 5000n, toTs: 1790005000, finalized: null } },
    coverage: { intervals: [{ from: 0n, to: 5000n, fromTs: 1789000000, toTs: 1790005000 }], spanCovered: () => true, contiguousTs: () => 1790005000 },
    progress: () => ({ complete: true })
  };
  const findAccounts = async text => [{ account: Number(text), address: '0x' + Number(text).toString(16).padStart(40, '0'), ts: 1789000000 }];
  return createAnalyticsApi({ ingest, rollups: {}, queries: { findAccounts, balanceMoves: async () => [], accountTransfers: async () => null, ...queries }, collector: { state, reader: {} }, now: () => clock.t });
}

test('funding settled when a position is increased is realized on its trip', () => {
  seq = 0;
  const { trips, openTrips, totals } = roundTrips([
    row('open', 1, LONG, { lot: 10n, end_lot: 10n, notional: 1000n, fee: 2n }),
    row('increase', 1, LONG, { lot: 10n, start_lot: 10n, end_lot: 20n, notional: 1000n, fee: 2n, funding: -7n }),
    row('close', 1, LONG, { lot: 20n, start_lot: 20n, notional: 2100n, fee: 3n, pnl: 100n, funding: -3n }),
    row('open', 20, SHORT, { lot: 5n, end_lot: 5n, notional: 500n }),
    row('increase', 20, SHORT, { lot: 5n, start_lot: 5n, end_lot: 10n, notional: 500n, funding: 4n })
  ]);
  assert.deepEqual([trips[0].realized, trips[0].funding, trips[0].net], [90n, -10n, 83n]);
  assert.deepEqual([openTrips[0].realized, openTrips[0].funding], [4n, 4n]);
  assert.deepEqual([totals.realized, totals.funding], [94n, -6n]);
});

test('a liquidation fee counts in fees and net whatever the liquidation role', () => {
  seq = 0;
  const off = roundTrips([
    row('open', 2, SHORT, { lot: 4n, end_lot: 4n, notional: 400n, fee: 1n }),
    row('liquidation', 2, SHORT, { role: 'none', lot: 4n, start_lot: 4n, notional: 450n, fee: 20n, pnl: -300n, funding: -5n })
  ]);
  assert.deepEqual([off.trips[0].fees, off.trips[0].net, off.trips[0].liquidated], [21n, -326n, true]);
  assert.deepEqual([off.totals.fees, off.totals.trades, off.totals.volume, off.totals.liquidations], [21n, 1, 400n, 1], 'fee counted, but not a trade off the book');
  seq = 0;
  const onBook = roundTrips([
    row('open', 2, SHORT, { lot: 4n, end_lot: 4n, notional: 400n, fee: 1n }),
    row('liquidation', 2, SHORT, { lot: 4n, start_lot: 4n, notional: 450n, fee: 20n, pnl: -300n })
  ]).totals;
  assert.deepEqual([onBook.fees, onBook.trades, onBook.volume], [21n, 2, 850n]);
});

test('a partial liquidation does not mark the trip as ended in liquidation', () => {
  seq = 0;
  const { trips } = roundTrips([
    row('open', 1, LONG, { lot: 10n, end_lot: 10n, notional: 1000n }),
    row('liquidation', 1, LONG, { lot: 6n, start_lot: 10n, end_lot: 4n, notional: 540n, pnl: -60n }),
    row('close', 1, LONG, { lot: 4n, start_lot: 4n, notional: 360n, pnl: -40n }),
    row('open', 1, LONG, { lot: 10n, end_lot: 10n, notional: 1000n }),
    row('liquidation', 1, LONG, { lot: 6n, start_lot: 10n, end_lot: 4n, notional: 540n, pnl: -60n }),
    row('liquidation', 1, LONG, { lot: 4n, start_lot: 4n, end_lot: 0n, notional: 350n, pnl: -50n })
  ]);
  assert.deepEqual(trips.map(t => t.liquidated), [false, true]);
  const perf = performance(trips);
  assert.equal(perf.liquidatedTrips, 1);
  assert.ok(insights(perf, []).some(n => n.text === '1 of 2 round trips ended in liquidation.'));
});

test('a flip gives its leverage and event to the new side only', () => {
  seq = 0;
  const { trips, openTrips } = roundTrips([
    row('open', 1, LONG, { lot: 10n, end_lot: 10n, notional: 1000n, leverage: 500 }),
    row('invert', 1, SHORT, { lot: 25n, start_lot: 10n, end_lot: 15n, notional: 2500n, pnl: 30n, leverage: 2000 }),
    row('decrease', 1, SHORT, { lot: 5n, start_lot: 15n, end_lot: 10n, notional: 500n, leverage: 0 })
  ]);
  assert.deepEqual([trips[0].maxLeverage, trips[0].events, trips[0].realized], [500, 1, 30n]);
  assert.deepEqual([openTrips[0].maxLeverage, openTrips[0].events], [2000, 2]);
});

test('medians average the two middle values; a drawdown from zero has a start', () => {
  const trip = (openTs, closeTs, net) => ({ market: 1, side: LONG, openTs, firstTs: openTs, closeTs, closeBlock: closeTs, complete: true, net, realized: net, fees: 0n, entryNotional: 1000n, exitNotional: 1000n });
  const even = performance([trip(0, 600, 10n), trip(1000, 2800, -5n)]);
  assert.equal(even.medianHold, 1200);
  assert.equal(performance([trip(0, 600, 10n), trip(1000, 2800, 5n), trip(3000, 6000, 1n)]).medianHold, 1800);
  // Losses first: the drawdown runs from the curve's first point.
  const dd = performance([trip(0, 600, -50n), trip(1000, 1600, -30n), trip(2000, 2600, 100n)]);
  assert.deepEqual([dd.maxDrawdown, dd.drawdownFrom, dd.drawdownTo], [80n, 600, 1600]);
  // Median entry leverage (1x..6x) is 3.5x.
  seq = 0;
  const rows = [];
  for (let i = 1; i <= 6; i++) rows.push(row('open', 1, LONG, { lot: 1n, end_lot: 1n, notional: 100n, leverage: i * 100 }), row('close', 1, LONG, { lot: 1n, pnl: 1n }));
  assert.ok(insights(performance(roundTrips(rows).trips), rows).some(n => n.text === 'Median leverage on entries: 3.5x.'));
});

test('cache serves a stale value up to twice the TTL, then waits; fresh bypasses it', async () => {
  let t = 0, n = 0;
  const cache = createCache({ now: () => t });
  const compute = async () => ++n;
  assert.equal(await cache.get('k', 10, compute), 1);
  t = 15; assert.equal(await cache.get('k', 10, compute), 1, 'stale while revalidating');
  await new Promise(resolve => setImmediate(resolve));
  t = 20; assert.equal(await cache.get('k', 10, compute), 2, 'refreshed in the background');
  t = 45; assert.equal(await cache.get('k', 10, compute), 3, 'older than twice the TTL: waits for the new value');
  // A refresh in flight is awaited once the value is too old to serve.
  let release;
  const slow = () => new Promise(resolve => { release = () => resolve(++n); });
  t = 57; assert.equal(await cache.get('k', 10, slow), 3);
  t = 70;
  const waiting = cache.get('k', 10, compute);
  assert.equal(await Promise.race([waiting, new Promise(resolve => setImmediate(() => resolve('pending')))]), 'pending');
  release();
  assert.equal(await waiting, 4);
  // `fresh` recomputes a value that is still fresh.
  assert.equal(await cache.get('k', 10, compute, { fresh: true }), 5);
  // An older computation finishing last never replaces a newer value.
  t = 85; assert.equal(await cache.get('k', 10, slow), 5);
  assert.equal(await cache.get('k', 10, compute, { fresh: true }), 6);
  release(); // the older computation resolves to 7
  await new Promise(resolve => setImmediate(resolve));
  t = 86; assert.equal(await cache.get('k', 10, compute), 6);
  // A failed background refresh keeps the value and leaves no unhandled rejection.
  const unhandled = [];
  const onUnhandled = error => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    t = 100; assert.equal(await cache.get('k', 10, async () => { throw new Error('DOWN'); }), 6);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(unhandled.length, 0);
  } finally { process.off('unhandledRejection', onUnhandled); }
});

test('protocol can be computed fresh for the live headline push', async () => {
  let calls = 0;
  const api = analyticsWith({ marketTotals: async () => { calls++; return []; }, protocolTotals: async () => [], traders: async () => [] });
  const q = new URLSearchParams('window=24h');
  await api.protocol(q);
  const first = calls;
  await api.protocol(q);
  assert.equal(calls, first, 'served from the cache');
  await api.protocol(q, { fresh: true });
  assert.equal(calls, 2 * first, 'computed again');
});

test('a market with nothing in the window keeps its contract state and counts zero liquidations', async () => {
  const market = { id: 20, symbol: 'ETH', priceDecimals: 1, lotDecimals: 5, markPNS: 30000n, oraclePNS: 30000n, maintHdths: 2500n, initHdths: 500n, insuranceBalanceCNS: 1000000000n, positionBalanceCNS: 0n, longOpenInterestLNS: 0n, shortOpenInterestLNS: 0n, oiMaxLNS: 30000000n, fundingRatePct100k: 0n, status: 4, positions: new Map() };
  const state = { block: { number: 5000n, hash: '0xab', timestamp: 1790005000 }, exchangeInfo: { collateralDecimals: 6, balanceCNS: 0n, protocolBalanceCNS: 0n, numberOfAccounts: 0n, fundingInterval: 1000n }, markets: new Map([[20, market]]), stats: {} };
  const api = analyticsWith({ marketTotals: async () => [], protocolTotals: async () => [], traders: async () => [] }, { state });
  const row = (await api.protocol(new URLSearchParams('window=24h'))).markets.find(x => x.id === 20);
  assert.equal(row.max_leverage, 5);
  assert.equal(Number(row.insurance), 1000);
  assert.equal(row.liquidations, 0);
  assert.equal(Number(row.liquidated), 0);
  assert.equal(row.active, true);
});

test('wallet trips: incomplete trips have no return; meta belongs to the cached view', async () => {
  seq = 0;
  const rows = [
    row('increase', 1, LONG, { lot: 5n, start_lot: 5n, end_lot: 10n, notional: 500n }), // opened before the window
    row('close', 1, LONG, { lot: 10n, start_lot: 10n, notional: 1100n, pnl: 50n }),
    row('open', 1, LONG, { lot: 10n, end_lot: 10n, notional: 1000n }),
    row('close', 1, LONG, { lot: 10n, start_lot: 10n, notional: 1020n, pnl: 20n })
  ];
  const clock = { t: 1790005000000 };
  const api = analyticsWith({ accountEventCount: async () => rows.length, accountEvents: async () => rows }, { clock });
  const a = await api.walletAnalytics('7');
  assert.deepEqual(a.trips.map(t => [t.complete, t.return_pct]), [[true, 2], [false, null]]);
  clock.t += 1000;
  assert.equal((await api.walletAnalytics('7')).meta.generated_at, a.meta.generated_at);
});

test('wallet summary: first trade is the first trade time, not its day', async () => {
  const clock = { t: 1790005000000 };
  const api = analyticsWith({
    accountMarkets: async () => [{ market: 1, volume: '1000', maker_volume: '0', trades: '2', fees: '1', realized: '5', funding_paid: '0', liquidations: '0', deposits: '0', withdrawals: '0' }],
    accountSeries: async () => [{ t: 1789948800, trades: '2', realized: '5', fees: '1', volume: '1000' }],
    accountTrades: async () => [], accountFlows: async () => [], accountFirstTrade: async () => 1789990123
  }, { clock });
  const p = await api.profile('7');
  assert.equal(p.summary.first_trade, 1789990123);
  assert.equal(p.summary.active_days, 1);
  clock.t += 1000;
  assert.equal((await api.profile('7')).meta.generated_at, p.meta.generated_at);
});

test('wallet period ranks use the value in the same rank table and never exceed it', async () => {
  const fresh = { 8: '9000000', 10: '-100000000' }; // newer than the rank table
  const api = analyticsWith({
    accounts: async (from, to, { account }) => ({ total: 1, rows: [{ account, trades: '4', volume: '2000000', realized: fresh[account], fees: '0', funding_paid: '0', liquidations: '0' }] }),
    accountScores: async () => [{ account: 1, pnl: 5e6, volume: 1e7 }, { account: 7, pnl: 1e6, volume: 5e6 }, { account: 8, pnl: 1e6, volume: 1e6 }, { account: 9, pnl: -1, volume: 1 }]
  });
  const p = await api.walletPeriods('8');
  assert.deepEqual(p.periods.map(x => x.rank), Array(4).fill({ pnl: 2, volume: 3, of: 4 }), 'ties share a rank');
  assert.ok(p.periods.every(x => x.traders === 4 && x.net_pnl === '9.000000'));
  const missing = await api.walletPeriods('10');
  assert.ok(missing.periods.every(x => x.rank === null && x.trades === 4), 'not in the table yet: unranked');
  assert.ok(p.meta.generated_at);
});

test('leaderboard SQL: population per sort, competition rank, stable pages', async () => {
  const seen = [];
  const queries = createQueries({ ch: { query: async sql => { seen.push(sql); return []; } }, rollups: { rolledRuns: () => [] } });
  const keys = { pnl: 'realized - fees', loss: '-\\(realized - fees\\)', volume: 'volume', realized: 'realized', fees: 'fees', trades: 'trades', liquidated: 'liquidated', deposits: 'deposits', withdrawals: 'withdrawals', net_flow: 'deposits - withdrawals' };
  for (const [sort, key] of Object.entries(keys)) {
    await queries.accounts(0, 3600, { sort, limit: 10, offset: 20 });
    const sql = seen.pop();
    // Flow rankings hold only the accounts with that flow, so zero-flow traders do not tie at the bottom.
    const population = { deposits: 'deposits > 0', withdrawals: 'withdrawals > 0', net_flow: 'deposits > 0 OR withdrawals > 0' }[sort] ?? 'trades > 0';
    assert.ok(sql.includes(`) WHERE ${population} ORDER BY`), sort);
    assert.match(sql, new RegExp(`count\\(\\) OVER \\(\\) AS total, rank\\(\\) OVER \\(ORDER BY ${key} DESC\\) AS rank FROM`), sort);
    assert.match(sql, new RegExp(`ORDER BY ${key} DESC, account LIMIT 10 OFFSET 20$`), sort);
  }
  await queries.accountScores(0, 3600);
  assert.match(seen.pop(), /^SELECT account, toFloat64\(realized - fees\) AS pnl, toFloat64\(volume\) AS volume FROM .+ WHERE trades > 0$/s);
  // The API passes the SQL rank through (ties share one).
  const api = analyticsWith({ accounts: async () => ({ total: 3, rows: [{ account: 1, rank: '1' }, { account: 2, rank: '1' }, { account: 3, rank: '3' }] }), addresses: async () => new Map() });
  const board = await api.leaderboard(new URLSearchParams('by=pnl'));
  assert.deepEqual(board.rows.map(r => r.rank), [1, 1, 3]);
  assert.equal(board.total, 3);
});

test('live trade views resolve addresses through a cache of the accounts table', async () => {
  const lookups = [];
  const api = analyticsWith({ addresses: async ids => { lookups.push(ids); return new Map(ids.filter(id => id !== 404).map(id => [id, { address: '0x' + String(id).padStart(40, '0'), created: 0 }])); } });
  const views = await api.tradeViews([{ account: 5, market: 1, kind: 'open', flags: 1 }, { account: 6, market: 1, kind: 'deleverage', flags: 2 }, { account: 5, market: 1, kind: 'close', flags: 0 }]);
  assert.deepEqual(lookups, [[5, 6]]);
  assert.deepEqual(views.map(v => [v.address?.slice(-2), v.on_book, v.force_close]), [['05', true, false], ['06', false, true], ['05', false, false]]);
  const again = await api.tradeViews([{ account: 5, market: 1, kind: 'open' }, { account: 404, market: 1, kind: 'open' }]);
  assert.deepEqual(lookups, [[5, 6], [404]], 'only ids not cached are looked up');
  assert.deepEqual(again.map(v => v.address?.slice(-2) ?? null), ['05', null]);
});

test('integrity compares the index with the contract values read before the query', async () => {
  const state = { block: { number: 100n, timestamp: 1790000100, hash: '0x1' }, markets: new Map([[1, { id: 1, symbol: 'BTC', longOpenInterestLNS: 50n, shortOpenInterestLNS: 50n }]]), exchangeInfo: { balanceCNS: 1000n }, stats: {} };
  const api = analyticsWith({
    cumulativeAtBlock: async (block, ts) => {
      assert.deepEqual([block, ts], [100n, 1790000100]);
      // A collector poll lands while the query runs.
      state.block = { number: 101n, timestamp: 1790000101, hash: '0x2' };
      state.markets.set(1, { id: 1, symbol: 'BTC', longOpenInterestLNS: 60n, shortOpenInterestLNS: 60n });
      state.exchangeInfo = { balanceCNS: 2000n };
      return { oi: new Map([[1, { long: 50n, short: 50n }]]), net: 1000n };
    }
  }, { state });
  const r = await api.integrity();
  assert.equal(r.block, '100');
  assert.deepEqual([r.open_interest[0].ok, r.open_interest[0].contract_long, r.tvl.ok, r.tvl.contract], [true, '0.00050', true, '0.001000']);
});

test('funding map: each bucket is annualised with its own event spacing; no block time, no time-scaled figures', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'plumb-fixes-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fake = createFakeExchange();
  fake.open(1, 5n, 0, 100000n); fake.open(1, 6n, 1, 100000n);
  fake.advance(1000n); // the bootstrap measures one block per second
  const collector = createCollector({ config: { url: 'https://example.invalid', chain: '143', exchange: EXCHANGE }, options: { ...collectorOptions({ HEAD_TAG: 'latest' }), checkpointPath: join(dir, 'cp.json') }, rpc: fake.rpc });
  await collector.bootstrap('test');
  assert.equal(collector.state.stats.blockTimeMs, 1000);
  const rows = [
    { t: 1789900000, market: 1, rate: 2, events: '1', spacing: 3437 },
    { t: 1789986400, market: 1, rate: 2, events: '1', spacing: 2588 },
    { t: 1790000800, market: 1, rate: 2, events: '1', spacing: null }
  ];
  const f = await analyticsWith({ fundingSeries: async () => rows }, { state: collector.state }).fundingOverview(new URLSearchParams('window=7d'));
  const btc = f.markets.find(x => x.id === 1);
  assert.equal(btc.interval_seconds, 8571);
  near(btc.apr_pct, -0.004 * 365 * 86400 / 8571);
  near(btc.rate_8h_pct, -0.004 * 8 * 3600 / 8571);
  const points = f.series.find(s => s.id === 1).points;
  assert.deepEqual(points.map(p => [p.rate_pct, p.interval_seconds]), [[0.002, 3437], [0.002, 2588], [0.002, 8571]]);
  near(points[0].apr_pct, 0.002 * 365 * 86400 / 3437);
  near(points[1].apr_pct, 0.002 * 365 * 86400 / 2588);
  near(points[2].apr_pct, 0.002 * 365 * 86400 / 8571);
  // Unknown block time: no 400 ms guess.
  collector.state.stats.blockTimeMs = null;
  const g = await analyticsWith({ fundingSeries: async () => rows }, { state: collector.state }).fundingOverview(new URLSearchParams('window=7d'));
  const m = g.markets.find(x => x.id === 1);
  assert.deepEqual([m.rate_8h_pct, m.apr_pct, m.interval_seconds], [null, null, null]);
  assert.deepEqual(g.series.find(s => s.id === 1).points.map(p => p.apr_pct === null), [false, false, true]);
});

test('smart money leaders: profitable directional traders only, in rank order', async () => {
  const { pickLeaders } = await import('../src/analytics-api.js');
  const rows = [
    { rank: 1, account: 1, pnl: '900', trades: 20000, maker_share_pct: 95 },   // market maker
    { rank: 2, account: 2, pnl: '800', trades: 400000, maker_share_pct: 40 },  // 13k trades a day over 30 days
    { rank: 3, account: 3, pnl: '700', trades: 120, maker_share_pct: 10 },
    { rank: 4, account: 4, pnl: '600', trades: 50, maker_share_pct: 90 },      // few trades: not called a maker
    { rank: 5, account: 5, pnl: '500', trades: 30, maker_share_pct: 0 },
    { rank: 6, account: 6, pnl: '-10', trades: 30, maker_share_pct: 0 }        // losing
  ];
  const { leaders, excluded } = pickLeaders(rows, { days: 30, top: 2 });
  assert.deepEqual(leaders.map(r => r.account), [3, 4]);
  assert.equal(excluded, 2);
  assert.deepEqual(pickLeaders(rows, { days: 30, top: 10 }).leaders.map(r => r.account), [3, 4, 5]);
});

test('position flow: buckets on the window grid, gaps as zero, totals from the rows', async () => {
  const hour = 3600, seen = [];
  const positionFlow = async (market, from, to, bucket) => {
    seen.push({ market, from, to, bucket });
    const first = Math.floor(from / bucket) * bucket;
    // Two active hours: longs opened 1,000 then 250 closed; shorts mirror it.
    return [
      { t: first + 2 * hour, long_open: 1000e6, long_close: 0, short_open: 1000e6, short_close: 0, opens: 2, closes: 0 },
      { t: first + 5 * hour, long_open: 0, long_close: 250e6, short_open: 0, short_close: 250e6, opens: 0, closes: 2 }
    ];
  };
  const api = analyticsWith({ positionFlow });
  const f = await api.positionFlow('1', new URLSearchParams('window=24h'));
  assert.equal(seen[0].market, 1);
  assert.equal(seen[0].bucket, hour);
  assert.ok(f.times.length >= 24 && f.times.length <= 25);
  assert.equal(f.long_open.length, f.times.length);
  assert.equal(f.long_open[2], '1000.000000');
  assert.equal(f.long_close[5], '250.000000');
  assert.equal(f.long_open[3], '0');
  assert.equal(f.totals.long_open, '1000.000000');
  assert.equal(f.totals.short_close, '250.000000');
  assert.equal(f.totals.opens, 2);
  await assert.rejects(api.positionFlow('777', new URLSearchParams('window=24h')), /MARKET_NOT_FOUND/);
});

test('new traders: no rolled-up hour straddles the window start', async () => {
  const seen = [];
  // Every complete hour rolled up, as the rollup job reports them.
  const rolledRuns = (from, to) => { const out = []; for (let h = Math.ceil(from / 3600) * 3600; h + 3600 <= to; h += 3600) { const last = out.at(-1); if (last && last[1] === h) last[1] = h + 3600; else out.push([h, h + 3600]); } return out; };
  const queries = createQueries({ ch: { query: async sql => { seen.push(sql); return []; } }, rollups: { rolledRuns } });
  await queries.newTraders(5400, 14400, { bucket: 3600, since: 0 });
  const sql = seen.pop();
  const range = (col, a, b) => `(${col} >= toDateTime(${a}, 'UTC') AND ${col} < toDateTime(${b}, 'UTC'))`;
  // The hour holding the window start comes from raw events on both sides of it.
  assert.ok(sql.includes(range('hour', 0, 3600)) && sql.includes(range('hour', 7200, 14400)), sql);
  assert.ok(sql.includes(range('ts', 3600, 5400)) && sql.includes(range('ts', 5400, 7200)), sql);
  assert.ok(!sql.includes(range('hour', 0, 14400)) && !sql.includes(range('hour', 3600, 7200)), sql);
  assert.match(sql, /WHERE first >= toDateTime\(5400, 'UTC'\) AND first < toDateTime\(14400, 'UTC'\)/);
});
