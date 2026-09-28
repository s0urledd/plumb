// ClickHouse schema. Every table is a ReplacingMergeTree keyed by the natural
// identity of its rows, so replaying a block range can never double count
// once parts merge; the ingest additionally keeps ranges disjoint (see
// ingest.js) so the large event table is exact without FINAL.
//
// Amounts are contract integers: CNS (collateral, 6 decimals on Perpl), PNS
// (price), LNS (size). Notional is computed at ingest with exact integer
// math (math.notionalCNS) from the market's decimals.
import { REVENUE_COLUMNS } from './aggregates.js';

export const KINDS = {
  open: 1, increase: 2, decrease: 3, close: 4, invert: 5,
  liquidation: 6, deleverage: 7, unwind: 8,
  maker_fill: 10, taker_fill: 11,
  deposit: 20, withdrawal: 21, protocol_deposit: 22, protocol_withdrawal: 23,
  account: 30,
  funding: 40,
  btl: 50, collateral_add: 51, collateral_remove: 52, liquidation_credit: 53, insurance_payment: 54
};
const kindEnum = `Enum8(${Object.entries(KINDS).map(([k, v]) => `'${k}' = ${v}`).join(', ')})`;

const evColumns = `
  block UInt64 CODEC(Delta, ZSTD(1)),
  log_index UInt32 CODEC(ZSTD(1)),
  tx_index UInt32 CODEC(ZSTD(1)),
  ts DateTime('UTC') CODEC(Delta, ZSTD(1)),
  tx String CODEC(ZSTD(3)),
  kind ${kindEnum},
  market UInt16,
  account UInt32 CODEC(ZSTD(1)),
  side Int8 DEFAULT -1,
  role Enum8('none' = 0, 'maker' = 1, 'taker' = 2),
  buy Int8 DEFAULT -1,
  price UInt64 CODEC(ZSTD(1)),
  lot UInt64 CODEC(ZSTD(1)),
  start_lot UInt64 CODEC(ZSTD(1)),
  end_lot UInt64 CODEC(ZSTD(1)),
  notional Int64 CODEC(ZSTD(1)),
  fee Int64 CODEC(ZSTD(1)),
  ins_fee Int64 CODEC(ZSTD(1)),
  prot_fee Int64 CODEC(ZSTD(1)),
  builder_fee Int64 CODEC(ZSTD(1)),
  pnl Int64 CODEC(ZSTD(1)),
  funding Int64 CODEC(ZSTD(1)),
  deposit Int64 CODEC(ZSTD(1)),
  amount Int64 CODEC(ZSTD(1)),
  balance Int64 CODEC(ZSTD(1)),
  leverage UInt32 CODEC(ZSTD(1)),
  mark UInt64 CODEC(ZSTD(1)),
  flags UInt8,
  oi_long Int64 CODEC(ZSTD(1)),
  oi_short Int64 CODEC(ZSTD(1))`;

// Flags on ev rows.
export const FLAG = { ON_BOOK: 1, FORCE_CLOSE: 2, UNLINKED: 4, WITHOUT_PAYMENT: 8 };

// Amounts are Int64; the count of unsplit liquidations is a count like the others (a UInt64
// count unioned with an Int64 rollup column becomes a Variant that sum() rejects).
const revenueType = c => (c === 'liq_unsplit' ? 'UInt32' : 'Int64');
const revenueColumns = REVENUE_COLUMNS.map(c => `${c} ${revenueType(c)} DEFAULT 0`).join(', ');

// Version 3 adds the reducing-fee split and the liquidation shares
// (rollup.js carries over the hours they do not change).
export const ROLLUP_VERSION = 3;

export const DDL = [
  `CREATE TABLE IF NOT EXISTS ev (${evColumns}
  ) ENGINE = ReplacingMergeTree
  PARTITION BY toYYYYMM(ts)
  ORDER BY (block, log_index)
  SETTINGS non_replicated_deduplication_window = 1000`,

  // Same rows ordered by account for wallet pages (fills excluded: position
  // events already carry the linked fill's price, size and fee).
  `CREATE TABLE IF NOT EXISTS ev_account (${evColumns}
  ) ENGINE = ReplacingMergeTree
  PARTITION BY toYYYYMM(ts)
  ORDER BY (account, block, log_index)`,
  `CREATE MATERIALIZED VIEW IF NOT EXISTS ev_account_mv TO ev_account AS
  SELECT * FROM ev WHERE account != 0 AND kind NOT IN ('maker_fill', 'taker_fill')`,

  // Coverage: one row per ingested block range. A live session keeps its
  // from_block and the row with the highest to_block survives merges.
  `CREATE TABLE IF NOT EXISTS chunks (
    from_block UInt64, to_block UInt64,
    from_ts DateTime('UTC'), to_ts DateTime('UTC'),
    logs UInt64, rows UInt64,
    source LowCardinality(String),
    at DateTime64(3, 'UTC') DEFAULT now64(3)
  ) ENGINE = ReplacingMergeTree(to_block) ORDER BY from_block`,

  `CREATE TABLE IF NOT EXISTS markets (
    market UInt16, name String, symbol String,
    price_decimals UInt8, lot_decimals UInt8,
    base_price UInt64, max_oi UInt64, init_margin_hdths UInt32, maint_margin_hdths UInt32,
    block UInt64, ts DateTime('UTC'), source LowCardinality(String)
  ) ENGINE = ReplacingMergeTree(block) ORDER BY market`,

  `CREATE TABLE IF NOT EXISTS accounts (
    account UInt32, address String, block UInt64, ts DateTime('UTC'), tx String
  ) ENGINE = ReplacingMergeTree ORDER BY account`,

  `CREATE TABLE IF NOT EXISTS funding (
    market UInt16, funding_block UInt64, block UInt64, log_index UInt32, ts DateTime('UTC'), tx String,
    specified_rate Int64, actual_rate Int64, price UInt64, payment Int64, sum Int64, overwrite UInt8
  ) ENGINE = ReplacingMergeTree ORDER BY (market, funding_block, block, log_index)`,

  `CREATE TABLE IF NOT EXISTS params (
    block UInt64, log_index UInt32, ts DateTime('UTC'), tx String,
    name LowCardinality(String), market Int32, args String
  ) ENGINE = ReplacingMergeTree ORDER BY (block, log_index)`,

  // Hourly rollups over closed, fully covered hours. Rebuilt whole (never
  // summed into), so recomputing an hour replaces it.
  `CREATE TABLE IF NOT EXISTS agg_market_hour (
    hour DateTime('UTC'), market UInt16,
    volume Int64, lots UInt64, fills UInt32,
    maker_fees Int64, taker_fees Int64, builder_fees Int64, ins_fees Int64, prot_fees Int64,
    ${revenueColumns},
    taker_buy Int64, taker_sell Int64,
    trades UInt32, opens UInt32, closes UInt32,
    liquidations UInt32, liquidated Int64, deleverages UInt32, deleveraged Int64,
    realized Int64, funding_paid Int64,
    oi_long Int64, oi_short Int64,
    open_price UInt64, open_key UInt64, high_price UInt64, low_price UInt64, close_price UInt64, close_key UInt64,
    traders UInt32,
    computed_at DateTime64(3, 'UTC')
  ) ENGINE = ReplacingMergeTree(computed_at) ORDER BY (hour, market)`,
  // Added in rollup version 3; rows rolled before read 0 until rolled again.
  `ALTER TABLE agg_market_hour ${REVENUE_COLUMNS.map(c => `ADD COLUMN IF NOT EXISTS ${c} ${revenueType(c)} DEFAULT 0`).join(', ')}`,

  `CREATE TABLE IF NOT EXISTS agg_hour (
    hour DateTime('UTC'),
    deposits Int64, deposit_count UInt32, withdrawals Int64, withdrawal_count UInt32,
    protocol_in Int64, protocol_out Int64,
    new_accounts UInt32, traders UInt32, depositors UInt32,
    computed_at DateTime64(3, 'UTC')
  ) ENGINE = ReplacingMergeTree(computed_at) ORDER BY hour`,

  // Per account and market (market 0 carries deposits and withdrawals).
  `CREATE TABLE IF NOT EXISTS agg_account_hour (
    hour DateTime('UTC'), account UInt32, market UInt16,
    volume Int64, maker_volume Int64, trades UInt32, fees Int64, realized Int64, funding_paid Int64,
    liquidations UInt32, liquidated Int64, deposits Int64, withdrawals Int64,
    computed_at DateTime64(3, 'UTC'),
    INDEX account_idx account TYPE bloom_filter GRANULARITY 2
  ) ENGINE = ReplacingMergeTree(computed_at) ORDER BY (hour, account, market)`,

  `CREATE TABLE IF NOT EXISTS rollup_hours (
    hour DateTime('UTC'), version UInt32, computed_at DateTime64(3, 'UTC')
  ) ENGINE = ReplacingMergeTree(computed_at) ORDER BY hour`,

  // Contract state sampled by the collector (mark prices, open interest,
  // insurance, TVL) for history that events alone cannot give.
  `CREATE TABLE IF NOT EXISTS snapshots (
    ts DateTime('UTC'), block UInt64, market UInt16,
    mark UInt64, oracle UInt64, long_oi UInt64, short_oi UInt64,
    funding_rate Int64, insurance Int64, positions UInt32, longs UInt32, shorts UInt32
  ) ENGINE = ReplacingMergeTree ORDER BY (market, ts)`,
  `CREATE TABLE IF NOT EXISTS exchange_snapshots (
    ts DateTime('UTC'), block UInt64, tvl Int64, protocol_balance Int64, accounts UInt32
  ) ENGINE = ReplacingMergeTree ORDER BY ts`,

  `CREATE TABLE IF NOT EXISTS kv (
    key String, value String, at DateTime64(3, 'UTC') DEFAULT now64(3)
  ) ENGINE = ReplacingMergeTree(at) ORDER BY key`
];

export async function migrate(ch) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ch.database)) throw new Error('INVALID_DATABASE_NAME');
  await ch.exec(`CREATE DATABASE IF NOT EXISTS ${ch.database}`, {}, {}, { db: null });
  for (const statement of DDL) await ch.exec(statement);
}
