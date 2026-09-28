import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { feeSplit, liquidationSplit, rowRevenue, createRevenueParams, DEFAULT_RATES } from '../src/revenue.js';
import { revenueSql, MARKET, REVENUE_COLUMNS, FULL_ON_BOOK, columns } from '../src/aggregates.js';
import { rollupStatements, createRollups, markStale, CARRY } from '../src/rollup.js';
import { DDL, migrate, ROLLUP_VERSION } from '../src/schema.js';
import { rowsFromLogs } from '../src/decode.js';
import { createAnalyticsApi } from '../src/analytics-api.js';
import * as m from '../src/math.js';
import { logBuilder, ev, makeLog } from './helpers/logs.js';

const units = new Map([[1, m.units(1, 5, 6)], [50, m.units(2, 3, 6)]]);
const unitsOf = id => units.get(id) ?? null;
const LONG = 0, SHORT = 1;
const byKind = (rows, kind) => rows.filter(r => r.kind === kind);
const fixture = JSON.parse(readFileSync(new URL('./fixtures/revenue-2026-09-26-zec.json', import.meta.url), 'utf8'));

// Evaluates the per-row SQL of aggregates.revenueSql on one row, with
// ClickHouse's meaning of the functions it uses (integer operands; intDiv
// truncates, and every operand here is non-negative).
const fns = {
  multiIf: (...a) => { for (let i = 0; i + 1 < a.length; i += 2) if (a[i]) return a[i + 1]; return a.at(-1); },
  intDiv: (a, b) => a / b,
  iff: (c, a, b) => (c ? a : b),
  greatest: (a, b) => (a > b ? a : b),
  bitAnd: (a, b) => a & b,
  after: (b, l, cb, cl) => b > cb || (b === cb && l > cl)
};
function sqlEval(expr, row) {
  const js = expr
    .replace(/\(block, log_index\) > \((\d+), (\d+)\)/g, 'after(block, log_index, $1, $2)')
    .replace(/ AND /g, ' && ').replace(/ = /g, ' === ').replace(/\bif\(/g, 'iff(')
    .replace(/\b(\d+)\b/g, '$1n');
  const r = Object.fromEntries(['fee', 'builder_fee', 'pnl', 'funding', 'amount', 'market', 'block', 'log_index', 'flags', 'end_lot'].map(k => [k, BigInt(row[k] ?? 0)]));
  r.kind = row.kind;
  return new Function('f', 'r', `const { multiIf, intDiv, iff, greatest, bitAnd, after } = f; const { kind, fee, builder_fee, pnl, funding, amount, market, block, log_index, flags, end_lot } = r; return ${js};`)(fns, r);
}
const sqlRevenue = (row, sql) => {
  const s = revenueSql(sql);
  if (row.kind === 'decrease' || row.kind === 'close') { const ins = sqlEval(s.reduceIns, row); return { ins, prot: BigInt(row.fee) - ins }; }
  if (row.kind === 'liquidation') return sqlEval(FULL_ON_BOOK, row) ? { ins: sqlEval(s.liqIns, row), prot: sqlEval(s.liqProt, row) } : { ins: 0n, prot: 0n };
  return null;
};

// The four liquidations of the reconciled window, decoded like any other logs.
function fixtureRows() {
  const b = logBuilder();
  for (const q of fixture.liquidations) {
    b.at(q.block).tx()
      .add(...ev.takerFill(BigInt(q.liqPricePNS), BigInt(q.liqLotLNS), BigInt(q.takerFillFeeCNS)))
      .add('PositionLiquidated', { perpId: BigInt(q.perpId), posAccountId: 1n, positionType: q.positionType, markPricePNS: BigInt(q.markPricePNS), liqPricePNS: BigInt(q.liqPricePNS), liqLotLNS: BigInt(q.liqLotLNS), posLotLNS: BigInt(q.posLotLNS), deltaPnlCNS: BigInt(q.deltaPnlCNS), fundingCNS: BigInt(q.fundingCNS), posAmountCNS: BigInt(q.posAmountCNS), posDepositCNS: BigInt(q.posDepositCNS), accAmountCNS: BigInt(q.accAmountCNS), accBalanceCNS: BigInt(q.accBalanceCNS), onOrderBook: q.onOrderBook });
  }
  return byKind(rowsFromLogs(b.logs, { unitsOf }).ev, 'liquidation');
}

test('a fill fee splits with the insurance share rounded up, net of the builder fee', () => {
  assert.deepEqual(feeSplit(1000n), { ins: 150n, prot: 850n });
  assert.deepEqual(feeSplit(1001n), { ins: 151n, prot: 850n }, '150.15 rounds up');
  assert.deepEqual(feeSplit(1n), { ins: 1n, prot: 0n }, 'the smallest charged fee still funds insurance');
  // The builder's share is taken out before the split and stays in the protocol part.
  assert.deepEqual(feeSplit(1000n, 200n), { ins: 120n, prot: 880n });
  assert.deepEqual(feeSplit(1000n, 199n), { ins: 121n, prot: 879n }, '120.15 rounds up');
  assert.deepEqual(feeSplit(500n, 500n), { ins: 0n, prot: 500n });
  assert.deepEqual(feeSplit(0n), { ins: 0n, prot: 0n }, 'reducing fills before v1.7.5 were free');
  assert.deepEqual(feeSplit(1000n, 0n, 20000n), { ins: 200n, prot: 800n });
});

test('a liquidation splits the margin left; the protocol keeps the dust and nothing is split past bankruptcy', () => {
  assert.deepEqual(liquidationSplit(71432396n), { user: 57145916n, ins: 7143239n, prot: 7143241n });
  assert.deepEqual(liquidationSplit(9n), { user: 7n, ins: 0n, prot: 2n });
  assert.deepEqual(liquidationSplit(0n), { user: 0n, ins: 0n, prot: 0n });
  assert.deepEqual(liquidationSplit(-5000n), { user: 0n, ins: 0n, prot: 0n });
  assert.deepEqual(liquidationSplit(100000n, { liqIns: 20000n, liqUser: 70000n }), { user: 70000n, ins: 20000n, prot: 10000n });
});

test('decrease and close rows get the split of their linked fill; opening rows keep their own', () => {
  const b = logBuilder().at(300);
  b.tx()
    .add(...ev.decrease(1, 7, LONG, 100000n, 50000n, 2500000n))
    .add(...ev.makerFill(1, 7, 1000000n, 50000n, 3333n))
    .add(...ev.open(1, 5, LONG, 1000000n, 50000n, { insFeeCNS: 3750000n, protFeeCNS: 21250000n }))
    .add(...ev.takerFill(1000000n, 50000n, 25000000n));
  b.tx()
    .add(...ev.close(1, 8, SHORT, 1000000n, -1000n))
    .add(...ev.takerFill(1000000n, 20000n, 10000001n, 2000000n));
  const rows = rowsFromLogs(b.logs, { unitsOf }).ev;
  const [dec] = byKind(rows, 'decrease'), [open] = byKind(rows, 'open'), [close] = byKind(rows, 'close');
  assert.deepEqual(rowRevenue(dec), { source: 'reducing', ins: 500n, prot: 2833n }, 'ceil(3333 * 0.15) = 500');
  assert.deepEqual(rowRevenue(open), { source: 'opening', ins: 3750000n, prot: 21250000n });
  assert.deepEqual(rowRevenue(close), { source: 'reducing', ins: 1200001n, prot: 8800000n }, 'builder fee 2,000,000 inside the protocol part');
  assert.equal(rowRevenue(byKind(rows, 'maker_fill')[0]), null, 'fills carry no revenue of their own');
  for (const row of [dec, close]) assert.deepEqual(sqlRevenue(row), { ins: rowRevenue(row).ins, prot: rowRevenue(row).prot }, 'the SQL split equals the reference');
});

test('reconciled window: four ZEC liquidations and the window fees give the contract balances exactly', () => {
  const rows = fixtureRows();
  assert.equal(rows.length, 4);
  let ins = 0n, prot = 0n;
  for (const [i, row] of rows.entries()) {
    const q = fixture.liquidations[i];
    const r = rowRevenue(row);
    assert.equal(r.source, 'liquidation');
    // The trader got floor(80 %) of the margin left: the stored liquidation fee is the rest.
    assert.equal(r.ins + r.prot, row.fee, `liquidation ${q.tx}`);
    const x = BigInt(q.deltaPnlCNS) + BigInt(q.fundingCNS) - BigInt(q.posAmountCNS);
    assert.equal(liquidationSplit(x).user, BigInt(q.accAmountCNS));
    assert.deepEqual(sqlRevenue(row), { ins: r.ins, prot: r.prot });
    ins += r.ins; prot += r.prot;
  }
  assert.deepEqual([ins, prot], [12661351n, 12661358n]);
  const f = fixture.market_fees, e = fixture.exchange;
  assert.equal(BigInt(f.opening_insurance) + BigInt(f.reducing_insurance) + ins, BigInt(fixture.insurance_balance_change), 'market 50 insurance balance');
  assert.equal(BigInt(e.opening_protocol) + BigInt(e.reducing_fees) - BigInt(e.reducing_insurance) + prot, BigInt(fixture.protocol_balance_change), 'protocol balance');
});

test('a bankrupt liquidation adds no revenue', () => {
  const b = logBuilder();
  b.tx().add(...ev.takerFill(1000000n, 2000n, 0n)).add(...ev.liquidation(1, 9, LONG, 1000000n, 2000n, 0n, -300000000n, { fundingCNS: -1000000n, posAmountCNS: -200000000n, onOrderBook: true }));
  const [liq] = byKind(rowsFromLogs(b.logs, { unitsOf }).ev, 'liquidation');
  assert.deepEqual(rowRevenue(liq), { source: 'liquidation', ins: 0n, prot: 0n });
  assert.deepEqual(sqlRevenue(liq), { ins: 0n, prot: 0n });
});

test('partial and off-book liquidations are not split: no revenue, counted apart', () => {
  // 70 USD of margin left, 80 % returned: 7 + 7 USD if it were split like the verified case.
  const margin = { posAmountCNS: -100000000n, accAmountCNS: 56000000n };
  const b = logBuilder();
  b.tx().add(...ev.takerFill(5000n, 1000n, 0n)).add(...ev.liquidation(20, 11, SHORT, 5000n, 1000n, 0n, -30000000n, { ...margin, onOrderBook: true }));
  b.tx().add(...ev.takerFill(5000n, 600n, 0n)).add(...ev.liquidation(20, 12, SHORT, 5000n, 600n, 400n, -30000000n, { ...margin, onOrderBook: true }));
  b.tx().add(...ev.liquidation(20, 13, SHORT, 5000n, 1000n, 0n, -30000000n, margin));
  const [full, partial, offBook] = byKind(rowsFromLogs(b.logs, { unitsOf }).ev, 'liquidation');
  assert.deepEqual(rowRevenue(full), { source: 'liquidation', ins: 7000000n, prot: 7000000n });
  for (const row of [partial, offBook]) {
    assert.equal(row.fee, 14000000n, 'the account still pays its liquidation fee');
    assert.deepEqual(rowRevenue(row), { source: 'liquidation', ins: 0n, prot: 0n, unsplit: true });
  }
  for (const row of [full, partial, offBook]) assert.deepEqual(sqlRevenue(row), { ins: rowRevenue(row).ins, prot: rowRevenue(row).prot });
  assert.equal(MARKET.find(([c]) => c === 'liq_unsplit')[1], `countIf(kind = 'liquidation' AND NOT ${FULL_ON_BOOK})`);
});

test('rates follow FeeParamsUpdated and LiquidationParamsUpdated from their block, per market', () => {
  const b = logBuilder().at(500);
  b.tx().add('FeeParamsUpdated', { perpId: 1n, insAmtPer100K: 20000n }).add('LiquidationParamsUpdated', { perpId: 50n, insAmtPer100K: 20000n, liqAmtPer100K: 10000n, userAmtPer100K: 70000n });
  const out = rowsFromLogs(b.logs, { unitsOf });
  assert.deepEqual(out.params.map(p => [p.name, p.market]), [['FeeParamsUpdated', 1], ['LiquidationParamsUpdated', 50]]);
  assert.equal(JSON.parse(out.params[0].args).insAmtPer100K, '20000');
  const p = createRevenueParams();
  assert.deepEqual(p.sql(), { feeIns: '15000', liqIns: '10000', liqUser: '80000' }, 'constants until a change is indexed');
  assert.equal(p.add(out.params), out.params[0].ts);
  assert.equal(p.add(out.params), null, 'a replayed batch changes nothing');
  assert.deepEqual(p.at(1, 499), DEFAULT_RATES);
  assert.equal(p.at(1, 500, 0).feeIns, 15000n, 'not before the event itself');
  assert.equal(p.at(1, 500, 5).feeIns, 20000n);
  assert.equal(p.at(20, 900).feeIns, 15000n, 'other markets keep theirs');
  assert.deepEqual([p.at(50, 900).liqIns, p.at(50, 900).liqUser, p.at(1, 900).liqUser], [20000n, 70000n, 80000n]);
  // The SQL picks the same rates row by row.
  const sql = p.sql();
  const rows = [
    { kind: 'close', market: 1, block: 499, log_index: 9, fee: 1001n, builder_fee: 0n },
    { kind: 'close', market: 1, block: 501, log_index: 0, fee: 1001n, builder_fee: 1n },
    { kind: 'decrease', market: 20, block: 900, log_index: 0, fee: 1001n, builder_fee: 0n },
    { kind: 'liquidation', market: 50, block: 400, log_index: 0, pnl: -100n, funding: 3n, amount: -100300n },
    { kind: 'liquidation', market: 50, block: 600, log_index: 0, pnl: -100n, funding: 3n, amount: -100300n },
    { kind: 'liquidation', market: 1, block: 600, log_index: 0, pnl: -100n, funding: 3n, amount: -100300n }
  ];
  for (const row of rows) {
    const want = rowRevenue(row, p.at(row.market, row.block, row.log_index));
    assert.deepEqual(sqlRevenue(row, sql), { ins: want.ins, prot: want.prot }, `${row.kind} market ${row.market} block ${row.block}`);
  }
  assert.deepEqual(rowRevenue(rows[1], p.at(1, 501)), { source: 'reducing', ins: 200n, prot: 801n });
  assert.ok(rollupStatements(sql).market.includes('multiIf(market = 1 AND (block, log_index) > (500, 0), 20000, 15000)'));
  // Only a change that moves a rate makes rolled-up hours stale.
  assert.equal(p.add([{ name: 'FeeParamsUpdated', block: 700, log_index: 0, ts: 1790000700, market: 1, args: { perpId: '1', insAmtPer100K: '20000' } }]), null);
  assert.equal(p.add([{ name: 'LiquidationParamsUpdated', block: 450, log_index: 0, ts: 1790000450, market: 50, args: '{"perpId":"50","insAmtPer100K":"20000","liqAmtPer100K":"10000","userAmtPer100K":"70000"}' }]), 1790000450, 'an older change found later');
});

test('a market added from now on starts with the rates of its ContractAdded event', () => {
  const added = makeLog('ContractAddedV2', { perpId: 3n, name: 'Test Perp', symbol: 'TST', status: 4, basePricePNS: 100n, priceDecimals: 2n, lotDecimals: 1n, initMarginFracHdths: 1000n, maintMarginFracHdths: 2000n, maxOpenInterestLNS: 10n ** 9n, unityDescentThreshHdths: 0n, overColDescentThreshHdths: 0n, dcpBorrowThreshHdths: 0n, priceTolPer100K: 0n, marginTol: 0n, marginTolDecimals: 0n, refPriceMaxAgeSec: 60n, absFundingClampPctPer100K: 0n, permCancelMinOrders: 0n, permCancelSegment: 0n, insAmtPer100K: 12000n, liqInsAmtPer100K: 5000n, liqUserAmtPer100K: 90000n, btlRestrictBuyers: false, btlPriceThreshPer100K: 0n, btlInsAmtPer100K: 0n, btlUserAmtPer100K: 0n, btlBuyerAmtPer100K: 0n, numPerpetuals: 3n, perpFeeSchedId: 0n }, { block: 99, tx: 99, logIndex: 0 });
  const out = rowsFromLogs([added], { unitsOf });
  assert.equal(out.markets[0].market, 3);
  const p = createRevenueParams(out.params);
  assert.deepEqual(p.at(3, 100), { feeIns: 12000n, liqIns: 5000n, liqUser: 90000n });
  assert.deepEqual(p.at(3, 98), DEFAULT_RATES);
  assert.deepEqual(p.at(1, 100), DEFAULT_RATES);
});

test('the market rollup has every aggregate column; an existing table gains the revenue columns in place', async () => {
  const create = DDL.find(s => s.includes('CREATE TABLE IF NOT EXISTS agg_market_hour'));
  for (const c of columns(MARKET).split(', ')) assert.match(create, new RegExp(`[\\s(,]${c} `), c);
  const alter = DDL.find(s => s.startsWith('ALTER TABLE agg_market_hour'));
  // Amounts are Int64; the unsplit count is a UInt32 like the other counts.
  for (const c of REVENUE_COLUMNS) assert.ok(alter.includes(`ADD COLUMN IF NOT EXISTS ${c} ${c === 'liq_unsplit' ? 'UInt32' : 'Int64'} DEFAULT 0`), c);
  const ran = [];
  await migrate({ database: 'perpl', exec: async sql => { ran.push(sql); } });
  assert.ok(ran.indexOf(alter) > ran.indexOf(create), 'the table exists before it is altered');
  assert.ok(ran.every(s => /^(CREATE (DATABASE|TABLE|MATERIALIZED VIEW) IF NOT EXISTS|ALTER TABLE \w+ (ADD COLUMN IF NOT EXISTS [^,]+(, )?)+$)/.test(s)), 'every statement is idempotent');
  for (const c of REVENUE_COLUMNS) assert.ok(rollupStatements().market.includes(` AS ${c}`), `rolled up: ${c}`);
});

// rollup_hours as FINAL sees it: the latest row per hour wins.
function fakeRollupCh({ v2 = [], touched = [] } = {}) {
  const hours = new Map(v2.map(h => [h, 2]));
  const rolled = [], queries = [];
  const ch = {
    query: async (sql, params = {}) => {
      queries.push(sql);
      if (sql === CARRY.touched) return touched.map(d => ({ d }));
      if (sql.includes('FROM rollup_hours')) return [...hours].filter(([, v]) => v === params.v).map(([h]) => ({ h }));
      return [];
    },
    insert: async (table, rows) => { for (const r of rows) hours.set(r.hour, r.version); },
    exec: async (sql, { from, to, v }) => {
      if (sql.startsWith('INSERT INTO rollup_hours')) { for (const [h, x] of hours) if (x === v && h + HOUR > from) hours.set(h, 0); return; } // markStale
      if (sql.includes('agg_market_hour')) rolled.push([from, to]);
      if (ch.onExec) await ch.onExec();
    }
  };
  return { ch, hours, rolled, queries };
}
const HOUR = 3600, DAY = 86400, START = 1790985600; // a UTC day start
const coverage = { intervals: [{ from: 1n, to: 2n, fromTs: START, toTs: START + 3 * HOUR }], hourCovered: () => true };
const hoursOf = runs => runs.flatMap(([a, b]) => Array.from({ length: (b - a) / HOUR }, (_, i) => a + i * HOUR));

test('version 3 carries over days without reducing fees or liquidations and rolls the rest again, once', async () => {
  assert.deepEqual([ROLLUP_VERSION, CARRY.from, CARRY.to], [3, 2, 3], 'the carry-over is only right from 2 to 3');
  // Two days rolled at version 2; the first has a liquidation or a charged reduce.
  const f = fakeRollupCh({ v2: [START, START + DAY].flatMap(d => Array.from({ length: 24 }, (_, i) => d + i * HOUR)), touched: [START] });
  const cover = { intervals: [{ from: 1n, to: 2n, fromTs: START, toTs: START + 2 * DAY }], hourCovered: () => true };
  const rollups = createRollups({ ch: f.ch, coverage: cover });
  await rollups.load();
  assert.equal(rollups.status.carried, 24);
  await rollups.run(START + 2 * DAY + HOUR);
  assert.deepEqual(f.rolled, [[START, START + DAY]], 'the whole touched day, as one run');
  assert.ok([...f.hours.values()].every(v => v === 3));
  // A restart finds nothing left at version 2 and nothing to roll.
  const again = createRollups({ ch: f.ch, coverage: cover });
  await again.load();
  assert.equal(again.status.carried, 0);
  assert.equal(await again.run(START + 2 * DAY + HOUR), 0);
  assert.equal(f.queries.filter(q => q === CARRY.touched).length, 1, 'the events are scanned only while hours wait at version 2');
});

test('a parameter change found later rolls its hours again; a run it overtakes does not mark them', async () => {
  const f = fakeRollupCh();
  const rollups = createRollups({ ch: f.ch, coverage });
  await rollups.run(START + 4 * HOUR);
  assert.equal(rollups.status.hours, 3);
  // Ingest marks them in the database before it stores the change, then tells the rollups.
  await markStale(f.ch, START + HOUR + 10);
  assert.deepEqual([f.hours.get(START), f.hours.get(START + HOUR), f.hours.get(START + 2 * HOUR)], [3, 0, 0], 'kept across restarts');
  assert.equal(rollups.invalidate(START + HOUR + 10), 2);
  f.rolled.length = 0;
  await rollups.run(START + 4 * HOUR);
  assert.deepEqual(hoursOf(f.rolled), [START + HOUR, START + 2 * HOUR]);
  // A restart before the in-memory step (a crash, or a change found while
  // ingest starts) still rolls them again.
  await markStale(f.ch, START);
  const restarted = createRollups({ ch: f.ch, coverage });
  await restarted.load();
  assert.equal(restarted.status.hours, 0);
  // A change arriving while hours are being rolled: they stay pending.
  rollups.invalidate(START);
  f.ch.onExec = async () => { f.ch.onExec = null; rollups.invalidate(START); };
  await rollups.run(START + 4 * HOUR);
  assert.equal(rollups.status.hours, 0);
  assert.deepEqual([...f.hours.values()], [0, 0, 0]);
  await rollups.run(START + 4 * HOUR);
  assert.equal(rollups.status.hours, 3);
  // A change arriving after a run stamped its hours but before it marks them
  // done: stale again in the database (the stamp may have landed after markStale).
  rollups.invalidate(START);
  const insert = f.ch.insert;
  f.ch.insert = async (table, rows) => { await insert(table, rows); if (rows[0]?.version === 3) { f.ch.insert = insert; rollups.invalidate(START); } };
  await rollups.run(START + 4 * HOUR);
  assert.equal(rollups.status.hours, 0);
  assert.deepEqual([...f.hours.values()], [0, 0, 0]);
});

test('protocol and series report protocol and insurance fees with reducing fills, and revenue by source', async () => {
  const totals = { market: 1, volume: '5000000000', fills: '2', trades: '4', maker_fees: '100', taker_fees: '900', builder_fees: '50', ins_fees: '60', prot_fees: '440', reduce_ins_fees: '75', reduce_prot_fees: '425', liq_ins_fees: '1000', liq_prot_fees: '1002', liq_unsplit: '2', taker_buy: '0', taker_sell: '0', opens: '1', closes: '1', liquidations: '1', liquidated: '0', deleverages: '0', deleveraged: '0', realized: '0', oi_long: '0', oi_short: '0', open_price: '0', high_price: '0', low_price: '0', close_price: '0' };
  const ingest = {
    collateralDecimals: 6, markets: new Map([[1, { symbol: 'BTC', name: 'BTC', priceDecimals: 1, lotDecimals: 5 }]]), unitsOf: () => null,
    status: { live: { to: 5000n, toTs: 1790005000, finalized: null } },
    coverage: { intervals: [{ from: 0n, to: 5000n, fromTs: 1789000000, toTs: 1790005000 }], spanCovered: () => true, contiguousTs: () => 1790005000 },
    progress: () => ({ complete: true })
  };
  const queries = {
    marketTotals: async (from, to, { bucket } = {}) => [bucket ? { ...totals, t: Math.floor(from / bucket) * bucket } : totals],
    protocolTotals: async () => [], traders: async () => [], newTraders: async () => [],
    cumulativeBefore: async () => ({ oi: new Map(), net: 0n }), lastPricesBefore: async () => new Map()
  };
  const api = createAnalyticsApi({ ingest, rollups: {}, queries, collector: { state: { block: null, markets: new Map(), exchangeInfo: null, stats: {} }, reader: {} }, now: () => 1790005000000 });
  const want = {
    protocol: { total: '0.001867', opening_fees: '0.000440', reducing_fees: '0.000425', liquidations: '0.001002' },
    insurance: { total: '0.001135', opening_fees: '0.000060', reducing_fees: '0.000075', liquidations: '0.001000' },
    builder_fees: '0.000050', unsplit_liquidations: 2
  };
  const p = await api.protocol(new URLSearchParams('window=24h'));
  const h = p.headline;
  assert.equal(h.fees.value, '0.001000');
  assert.deepEqual([h.protocol_fees.value, h.insurance_fees.value], ['0.000865', '0.000135'], 'protocol + insurance = fees');
  assert.equal(h.protocol_revenue.value, '0.001867');
  assert.deepEqual(h.revenue, want);
  assert.deepEqual([p.markets[0].protocol_fees, p.markets[0].insurance_fees, p.markets[0].revenue], ['0.000865', '0.000135', want]);
  const s = await api.series(new URLSearchParams('window=24h'));
  const [point, ...rest] = s.points.filter(x => x.fees !== '0.000000');
  assert.equal(rest.length, 0);
  assert.deepEqual([point.protocol_fees, point.insurance_fees, point.revenue], ['0.000865', '0.000135', want]);
  assert.equal(s.points.find(x => x.fees === '0.000000').revenue.protocol.total, '0.000000');
});
