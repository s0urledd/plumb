// Integration test against a real ClickHouse (skipped unless CLICKHOUSE_URL is
// set; CI runs one as a service). Ingests synthetic exchange logs through the
// real ingest path, rolls up hours and checks that rollup-backed window
// queries equal raw-event queries, that interrupted commits are repaired and
// that restarts never duplicate rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createClickHouse } from '../src/clickhouse.js';
import { migrate, DDL, KINDS, kindEnum } from '../src/schema.js';
import { REVENUE_COLUMNS } from '../src/aggregates.js';
import { rowRevenue, protocolBalance } from '../src/revenue.js';
import { createIngest, ingestOptions } from '../src/ingest.js';
import { createRollups, CARRY } from '../src/rollup.js';
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
  // Hours rolled at the previous version on the chain's day are rolled again
  // (it has liquidations); the old hour is carried over as it is.
  const rates = ingest.revenueParams;
  assert.equal(rates.at(20, 6000).feeIns, 20000n, 'the rate change was indexed');
  await ch.insert('rollup_hours', [OLD, ...[0, 1, 2].map(k => 1789999200 + k * 3600)].map(hour => ({ hour, version: CARRY.from, computed_at: Date.now() - 1000 })));
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

test('protocol transfers: enum migration in place, topic backfill once, balance rebuilt', { skip: !url && 'set CLICKHOUSE_URL to run' }, async t => {
  const database = `perpl_test_bal_${process.pid}_${Date.now()}`;
  const ch = createClickHouse({ url, user: process.env.CLICKHOUSE_USER || 'default', password: process.env.CLICKHOUSE_PASSWORD || '', database });
  t.after(() => ch.exec(`DROP DATABASE IF EXISTS ${database}`, {}, {}, { db: null }));
  // An index from before the transfer kinds: its event tables have the older enum.
  await ch.exec(`CREATE DATABASE ${database}`, {}, {}, { db: null });
  const oldEnum = kindEnum(Object.fromEntries(Object.entries(KINDS).filter(([, v]) => v < 60)));
  for (const table of ['ev', 'ev_account']) await ch.exec(DDL.find(s => s.includes(`TABLE IF NOT EXISTS ${table} (`)).replace(kindEnum(), oldEnum));
  await ch.insert('ev', [{ block: 1, log_index: 0, tx_index: 0, ts: BLOCK_TS(1), tx: '0x' + 'cd'.repeat(32), kind: 'deposit', account: 5, amount: 1n }]);
  await migrate(ch);
  await migrate(ch);
  for (const r of await ch.query("SELECT table, type FROM system.columns WHERE database = {db:String} AND table IN ('ev', 'ev_account') AND name = 'kind'", { db: database })) assert.ok(r.type.includes("'payout' = 60") && r.type.includes("'residue_to_protocol' = 67"), r.table);
  assert.equal((await ch.first('SELECT kind FROM ev WHERE block = 1')).kind, 'deposit', 'stored rows keep their kind');
  await ch.exec('TRUNCATE TABLE ev'); await ch.exec('TRUNCATE TABLE ev_account');

  // Opens (9 of each 10 fee to the protocol), a protocol deposit and withdrawal,
  // three payouts, a sweep, a transfer to market 1's insurance fund and a
  // residue moved in from market 1's position balance.
  const fake = createFakeExchange();
  const b = logBuilder();
  for (let block = 1000, i = 0; block < 6000; block += 500, i++) {
    b.at(block).tx().add(...ev.makerFill(1, 7, 1000000n, 10n, 0n)).add(...ev.open(1, 100 + i, LONG, 1000000n, 10n, { insFeeCNS: 1n, protFeeCNS: 9n })).add(...ev.takerFill(1000000n, 10n, 10n));
  }
  b.at(1200).tx().add('ProtocolBalanceDeposit', { amountCNS: 1000000000n });
  for (const [block, account] of [[2000, 101], [2600, 102], [4200, 103]]) b.at(block).tx().add('TransferProtocolToAccount', { accountId: BigInt(account), amountCNS: 7000000n, balanceCNS: 7000000n });
  b.at(3000).tx().add('TransferAccountToProtocol', { accountId: 777n, amountCNS: 50000000n, balanceCNS: 0n });
  b.at(3500).tx().add('TransferProtocolToPerp', { perpId: 1n, amountCNS: 5000000n, toInsuranceFund: true });
  b.at(3800).tx().add('ResidueTransferred', { perpId: 1n, residueAmountCNS: 3000000n, positionBalanceCNS: 40000000n });
  b.at(5000).tx().add('ProtocolBalanceWithdraw', { amountCNS: 100000000n });
  for (const log of b.logs) { log.address = EXCHANGE; delete log.blockTimestamp; }
  fake.chain.logs.push(...b.logs);
  fake.chain.head = 6000n;
  const config = { exchange: EXCHANGE, deployBlock: 900n };
  const options = ingestOptions({ LIVE_LOG_RANGE: 700, ARCHIVE_LOG_RANGE: 700, LIVE_BACKFILL_CONCURRENCY: 3 });
  const ingest = createIngest({ ch, config, liveRpc: fake.rpc, options });
  await ingest.init();
  await ingest.liveStep();
  await ingest.backfill();
  assert.equal(ingest.topicProgress().complete, true, 'ranges the ingest read count for the added topics');
  const count = async kind => Number((await ch.first('SELECT count() AS n FROM ev FINAL WHERE kind = {k:String}', { k: kind })).n);
  assert.deepEqual([await count('payout'), await count('sweep'), await count('protocol_to_market'), await count('residue_to_protocol')], [3, 1, 1, 1]);

  const want = 10n * 9n + 1000000000n - 100000000n - 3n * 7000000n + 50000000n - 5000000n + 3000000n;
  const rebuilt = async () => {
    const queries = createQueries({ ch, rollups: { rolledRuns: () => [] }, coverage: ingest.coverage, rates: ingest.revenueParams });
    const rev = await queries.revenueUpTo(BLOCK_TS(6000), 6000n);
    const moves = Object.fromEntries((await queries.balanceMovesAtBlock(6000n)).map(r => [r.kind, { amount: BigInt(r.total) }]));
    return protocolBalance({ revenue: { opening: BigInt(rev.prot_fees), reducing: BigInt(rev.reduce_prot_fees), liquidations: BigInt(rev.liq_prot_fees) }, moves });
  };
  assert.equal(await rebuilt(), want);

  // History indexed before the transfers were read: their rows and topic
  // coverage are missing, except one payout already stored some other way.
  for (const table of ['ev', 'ev_account']) await ch.exec(`ALTER TABLE ${table} DELETE WHERE kind IN ('payout','sweep','protocol_to_market','residue_to_protocol') AND block != 4200`, {}, { mutations_sync: 2 });
  await ch.exec('TRUNCATE TABLE topic_chunks');
  const restarted = createIngest({ ch, config, liveRpc: fake.rpc, options });
  await restarted.init();
  await restarted.liveStep();
  assert.equal(restarted.topicProgress().complete, false);
  await restarted.topicBackfill();
  assert.equal(restarted.topicProgress().complete, true);
  assert.equal(restarted.status.topics.skipped, 1, 'the payout already stored is not inserted again');
  assert.deepEqual([await count('payout'), await count('sweep'), await count('protocol_to_market'), await count('residue_to_protocol')], [3, 1, 1, 1]);
  assert.equal(Number((await ch.first("SELECT count() AS n FROM ev WHERE kind = 'payout'")).n), 3, 'no duplicate even before merges');
  // A second round finds nothing to read.
  const requests = restarted.status.topics.requests;
  await restarted.topicBackfill();
  assert.equal(restarted.status.topics.requests, requests);
  assert.equal(await rebuilt(), want);
});
