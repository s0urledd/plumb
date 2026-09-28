// Integration test against a real ClickHouse (skipped unless CLICKHOUSE_URL is
// set; CI runs one as a service). Ingests synthetic exchange logs through the
// real ingest path, rolls up hours and checks that rollup-backed window
// queries equal raw-event queries, that interrupted commits are repaired and
// that restarts never duplicate rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createClickHouse } from '../src/clickhouse.js';
import { migrate, DDL } from '../src/schema.js';
import { REVENUE_COLUMNS } from '../src/aggregates.js';
import { rowRevenue } from '../src/revenue.js';
import { createIngest, ingestOptions } from '../src/ingest.js';
import { createRollups } from '../src/rollup.js';
import { createQueries } from '../src/query.js';
import { createFakeExchange, EXCHANGE } from './helpers/fake-exchange.js';
import { logBuilder, ev, BLOCK_TS } from './helpers/logs.js';

const url = process.env.CLICKHOUSE_URL;
const LONG = 0, SHORT = 1;

// A liquidation on market 20 on the book leaving 70 USD of margin (X), of
// which the trader gets `returned`.
const liquidation = (b, block, returned) => b.at(block).tx().add(...ev.takerFill(5000n, 1000n, 0n)).add(...ev.liquidation(20, 11, SHORT, 5000n, 1000n, 0n, -30000000n, { posAmountCNS: -100000000n, accAmountCNS: returned, onOrderBook: true }));

function syntheticChain() {
  const fake = createFakeExchange();
  const b = logBuilder();
  // Three hours of trading on markets 1 (BTC-like) and 20, one match every ~5 minutes.
  // Closes on market 20 are charged (with a builder share); its fee and
  // liquidation rates change at block 5000, between two liquidations.
  for (let block = 1000, i = 0; block < 11800; block += 300, i++) {
    b.at(block).tx()
      .add(...ev.increase(1, 7, SHORT, 1000000n, 100000n + BigInt(i) * 10n, 100000n + BigInt(i + 1) * 10n, { insFeeCNS: 0n, protFeeCNS: 3n }))
      .add(...ev.makerFill(1, 7, 1000000n + BigInt(i) * 100n, 10n, 3n))
      .add(...ev.open(1, 100 + i, LONG, 1000000n + BigInt(i) * 100n, 10n, { insFeeCNS: 1n, protFeeCNS: 9n }))
      .add(...ev.takerFill(1000000n + BigInt(i) * 100n, 10n, 10n));
    if (i % 3 === 0) b.tx().add(...ev.deposit(100 + i, 5000000n));
    if (i % 5 === 0) b.at(block + 1).tx().add(...ev.makerFill(20, 8, 5000n, 1000n, 0n)).add(...ev.close(20, 9, SHORT, 5000n, -1000n)).add(...ev.takerFill(5000n, 1000n, 1001n, 7n));
    if (i === 3) liquidation(b, block + 100, 56000000n); // 80 % of X returned
    if (i === 13) b.at(block + 100).tx().add('FeeParamsUpdated', { perpId: 20n, insAmtPer100K: 20000n }).add('LiquidationParamsUpdated', { perpId: 20n, insAmtPer100K: 20000n, liqAmtPer100K: 10000n, userAmtPer100K: 70000n });
  }
  liquidation(b, 11600, 49000000n); // 70 % from block 5000
  for (const log of b.logs) { log.address = EXCHANGE; delete log.blockTimestamp; } // headers supply the time
  fake.chain.logs.push(...b.logs);
  fake.chain.head = 12000n;
  return fake;
}

test('ClickHouse ingest, rollups, windows, repair and restart', { skip: !url && 'set CLICKHOUSE_URL to run' }, async t => {
  const database = `perpl_test_${process.pid}_${Date.now()}`;
  const ch = createClickHouse({ url, user: process.env.CLICKHOUSE_USER || 'default', password: process.env.CLICKHOUSE_PASSWORD || '', database });
  t.after(() => ch.exec(`DROP DATABASE IF EXISTS ${database}`, {}, {}, { db: null }));
  // An index from before rollup version 3: its market rollup table lacks the
  // revenue columns, which the migration adds in place (twice is harmless).
  // Its one rolled hour, two days before the synthetic chain, has no events.
  const OLD = 1789999200 - 2 * 86400;
  await ch.exec(`CREATE DATABASE ${database}`, {}, {}, { db: null });
  await ch.exec(DDL.find(s => s.includes('TABLE IF NOT EXISTS agg_market_hour')).replace(/\n\s*reduce_ins_fees[^\n]*/, ''));
  await ch.insert('agg_market_hour', [{ hour: OLD, market: 1, volume: 5, computed_at: OLD * 1000 }]);
  await migrate(ch);
  await migrate(ch);
  const cols = (await ch.query("SELECT name FROM system.columns WHERE database = {db:String} AND table = 'agg_market_hour'", { db: database })).map(r => r.name);
  for (const c of REVENUE_COLUMNS) assert.ok(cols.includes(c), c);
  assert.equal(Number((await ch.first('SELECT liq_prot_fees AS v FROM agg_market_hour')).v), 0, 'rows rolled before read 0');
  const fake = syntheticChain();
  const config = { exchange: EXCHANGE, deployBlock: 900n };
  const options = ingestOptions({ LIVE_LOG_RANGE: 700, ARCHIVE_LOG_RANGE: 700, LIVE_BACKFILL_CONCURRENCY: 3 });
  const ingest = createIngest({ ch, config, liveRpc: fake.rpc, options });
  await ingest.init();
  await ingest.liveStep();
  await ingest.backfill();
  assert.deepEqual(ingest.coverage.intervals.map(x => [x.from, x.to]), [[900n, 12000n]]);
  assert.equal(ingest.progress().complete, true);
  const makerFills = Number((await ch.first("SELECT count() AS n FROM ev WHERE kind = 'maker_fill'")).n);
  assert.equal(makerFills, 36 + 8, 'one BTC maker fill per 300 blocks plus one market-20 fill every fifth');
  assert.equal(ingest.status.checks.unlinked, 0);
  assert.equal(ingest.status.checks.feeMismatch, 0);

  // Every closed hour rolls up, and rollup-backed windows equal raw windows.
  // Hours rolled at version 2 on the chain's day are rolled again (it has
  // charged closes and liquidations); the old hour is carried over as it is.
  const rates = ingest.revenueParams;
  assert.equal(rates.at(20, 6000).feeIns, 20000n, 'the rate change was indexed');
  await ch.insert('rollup_hours', [OLD, ...[0, 1, 2].map(k => 1789999200 + k * 3600)].map(hour => ({ hour, version: 2, computed_at: Date.now() - 1000 })));
  const rollups = createRollups({ ch, coverage: ingest.coverage, rates });
  await rollups.run(BLOCK_TS(20000));
  assert.equal(rollups.status.carried, 1);
  assert.ok(rollups.isRolled(OLD));
  const old = await ch.first("SELECT volume, liq_prot_fees, liq_unsplit FROM agg_market_hour FINAL WHERE hour = toDateTime({h:UInt32}, 'UTC')", { h: OLD });
  assert.deepEqual([old.volume, old.liq_prot_fees, old.liq_unsplit].map(Number), [5, 0, 0], 'a carried hour keeps its figures and reads 0 in the new columns');
  assert.ok(rollups.status.hours >= 2, `rolled ${rollups.status.hours} hours`);
  const withRollups = createQueries({ ch, rollups, coverage: ingest.coverage, rates });
  const rawOnly = createQueries({ ch, rollups: { rolledRuns: () => [] }, coverage: ingest.coverage, rates });
  const from = BLOCK_TS(950), to = BLOCK_TS(11900);
  const strip = rows => rows.map(r => ({ ...r }));
  assert.deepEqual(strip(await withRollups.marketTotals(from, to)), strip(await rawOnly.marketTotals(from, to)));
  // The revenue split summed in ClickHouse equals revenue.js row by row, with
  // the rates in force at each row: 8 closes (3 before the change) and two liquidations.
  const want = { reduce_ins_fees: 0n, reduce_prot_fees: 0n, liq_ins_fees: 0n, liq_prot_fees: 0n };
  for (const r of await ch.query("SELECT kind, market, block, log_index, fee, builder_fee, ins_fee, prot_fee, pnl, funding, amount, flags, end_lot FROM ev WHERE kind IN ('decrease','close','liquidation')")) {
    const x = rowRevenue(r, rates.at(Number(r.market), Number(r.block), Number(r.log_index)));
    if (x.source === 'reducing') { want.reduce_ins_fees += x.ins; want.reduce_prot_fees += x.prot; } else { want.liq_ins_fees += x.ins; want.liq_prot_fees += x.prot; }
  }
  assert.deepEqual(want, { reduce_ins_fees: 3n * 150n + 5n * 199n, reduce_prot_fees: 8n * 1001n - 3n * 150n - 5n * 199n, liq_ins_fees: 7000000n + 14000000n, liq_prot_fees: 7000000n + 7000000n });
  const got = { reduce_ins_fees: 0n, reduce_prot_fees: 0n, liq_ins_fees: 0n, liq_prot_fees: 0n };
  for (const r of await withRollups.marketTotals(from, to)) for (const k of Object.keys(got)) got[k] += BigInt(r[k]);
  assert.deepEqual(got, want);
  assert.deepEqual(strip(await withRollups.protocolTotals(from, to)), strip(await rawOnly.protocolTotals(from, to)));
  assert.deepEqual(await withRollups.traders(from, to), await rawOnly.traders(from, to));
  assert.deepEqual(await withRollups.accounts(from, to, { sort: 'volume', limit: 5 }), await rawOnly.accounts(from, to, { sort: 'volume', limit: 5 }));
  const series = await withRollups.marketTotals(Math.floor(from / 3600) * 3600, to, { bucket: 3600 });
  assert.ok(series.length >= 3);
  // Open interest from events equals the positions opened (each open adds 10 lots long).
  const cum = await withRollups.cumulativeBefore(to + 1);
  assert.equal(cum.oi.get(1).long, 360n);

  // A crash between the event insert and the coverage insert leaves rows that the next start removes.
  await ch.insert('ev', [{ block: 12500, log_index: 0, tx_index: 0, ts: BLOCK_TS(12500), tx: '0x' + 'ab'.repeat(32), kind: 'deposit', account: 5, amount: 1n }]);
  const restarted = createIngest({ ch, config, liveRpc: fake.rpc, options });
  await restarted.init();
  assert.equal(restarted.status.repaired, 1);
  assert.equal(Number((await ch.first('SELECT count() AS n FROM ev WHERE block > 12000')).n), 0);

  // Resuming adds nothing twice.
  const before = Number((await ch.first('SELECT count() AS n FROM ev')).n);
  await restarted.liveStep();
  await restarted.backfill();
  assert.equal(Number((await ch.first('SELECT count() AS n FROM ev')).n), before);
});
