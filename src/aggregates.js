// Aggregate definitions shared by the hourly rollups and by window queries
// over raw events, so a number is computed by exactly one SQL expression
// whether it comes from a closed hour or from the last few minutes.
//
//   volume    maker-fill notional (each match once)
//   fees      maker + taker fill fees (= insurance + protocol fee on the
//             position events); a builder's share is part of the fill fee
//             and of the protocol fee, never added on top
//   split     ins_fees / prot_fees: the split opening events carry;
//             reduce_*: the same split of decrease and close fills, derived
//             per row; liq_*: the insurance and protocol shares of each
//             liquidation (revenue.js). Rates are SQL from the parameter
//             history, constants until a change is indexed
//   realized  deltaPnl + funding on decrease, close, invert, liquidation and
//             deleverage events, plus the funding settled when a position is
//             increased (the contract realizes it whenever the lot changes)
//   oi_*      signed lot changes per side; their running sum from the
//             deployment block is the open interest (checked against the
//             contract's counters)
import { createRevenueParams } from './revenue.js';

export const USER = "('open','increase','decrease','close','invert')";
export const REALIZING = "('increase','decrease','close','invert','liquidation','deleverage')";
export const FILLS = "('maker_fill','taker_fill')";
export const REDUCING = "('decrease','close')";
export const ACCOUNT_TRADES = `(kind IN ${USER} OR (kind = 'liquidation' AND role = 'taker'))`;

// Per-row revenue split in SQL, the same arithmetic as revenue.js. `r` holds
// the rates in force as SQL (feeIns, liqIns, liqUser). The liquidation margin
// is 0 past bankruptcy (decode.js stores pnl so), so no share is negative.
export const DEFAULT_RATES_SQL = createRevenueParams().sql();
const LIQ_MARGIN = 'greatest(pnl + funding - amount, 0)';
export const revenueSql = (r = DEFAULT_RATES_SQL) => {
  const liqIns = `intDiv(${LIQ_MARGIN} * ${r.liqIns}, 100000)`;
  return {
    reduceIns: `if(fee > builder_fee, intDiv((fee - builder_fee) * ${r.feeIns} + 99999, 100000), 0)`,
    liqIns,
    liqProt: `${LIQ_MARGIN} - intDiv(${LIQ_MARGIN} * ${r.liqUser}, 100000) - ${liqIns}`
  };
};

// [column, raw expression over ev, merge expression over rollup rows]
export const marketDefs = (r = DEFAULT_RATES_SQL) => { const s = revenueSql(r); return [
  ['volume', "sumIf(notional, kind = 'maker_fill')", 'sum(volume)'],
  ['lots', "sumIf(lot, kind = 'maker_fill')", 'sum(lots)'],
  ['fills', "countIf(kind = 'maker_fill')", 'sum(fills)'],
  ['maker_fees', "sumIf(fee, kind = 'maker_fill')", 'sum(maker_fees)'],
  ['taker_fees', "sumIf(fee, kind = 'taker_fill')", 'sum(taker_fees)'],
  ['builder_fees', `sumIf(builder_fee, kind IN ${FILLS})`, 'sum(builder_fees)'],
  ['ins_fees', "sumIf(ins_fee, kind IN ('open','increase','invert'))", 'sum(ins_fees)'],
  ['prot_fees', "sumIf(prot_fee, kind IN ('open','increase','invert'))", 'sum(prot_fees)'],
  ['reduce_ins_fees', `sumIf(${s.reduceIns}, kind IN ${REDUCING})`, 'sum(reduce_ins_fees)'],
  ['reduce_prot_fees', `sumIf(fee - ${s.reduceIns}, kind IN ${REDUCING})`, 'sum(reduce_prot_fees)'],
  ['liq_ins_fees', `sumIf(${s.liqIns}, kind = 'liquidation')`, 'sum(liq_ins_fees)'],
  ['liq_prot_fees', `sumIf(${s.liqProt}, kind = 'liquidation')`, 'sum(liq_prot_fees)'],
  ['taker_buy', `sumIf(notional, kind IN ${USER} AND role = 'taker' AND buy = 1)`, 'sum(taker_buy)'],
  ['taker_sell', `sumIf(notional, kind IN ${USER} AND role = 'taker' AND buy = 0)`, 'sum(taker_sell)'],
  ['trades', `countIf(kind IN ${USER})`, 'sum(trades)'],
  ['opens', "countIf(kind = 'open')", 'sum(opens)'],
  ['closes', "countIf(kind = 'close')", 'sum(closes)'],
  ['liquidations', "countIf(kind = 'liquidation')", 'sum(liquidations)'],
  ['liquidated', "sumIf(notional, kind = 'liquidation')", 'sum(liquidated)'],
  ['deleverages', "countIf(kind = 'deleverage')", 'sum(deleverages)'],
  ['deleveraged', "sumIf(notional, kind = 'deleverage')", 'sum(deleveraged)'],
  ['realized', `sumIf(pnl + funding, kind IN ${REALIZING})`, 'sum(realized)'],
  ['funding_paid', `sumIf(funding, kind IN ${REALIZING})`, 'sum(funding_paid)'],
  ['oi_long', 'sum(oi_long)', 'sum(oi_long)'],
  ['oi_short', 'sum(oi_short)', 'sum(oi_short)'],
  ['open_price', "argMinIf(price, (block, log_index), kind = 'maker_fill')", 'argMinIf(open_price, open_key, fills > 0)'],
  ['open_key', "minIf(block * 4294967296 + log_index, kind = 'maker_fill')", 'minIf(open_key, fills > 0)'],
  ['high_price', "maxIf(price, kind = 'maker_fill')", 'max(high_price)'],
  ['low_price', "minIf(price, kind = 'maker_fill')", 'minIf(low_price, fills > 0)'],
  ['close_price', "argMaxIf(price, (block, log_index), kind = 'maker_fill')", 'argMaxIf(close_price, close_key, fills > 0)'],
  ['close_key', "maxIf(block * 4294967296 + log_index, kind = 'maker_fill')", 'max(close_key)']
]; };
export const MARKET = marketDefs();
// Rollup columns added after the table was first created (schema.js adds them to existing tables).
export const REVENUE_COLUMNS = ['reduce_ins_fees', 'reduce_prot_fees', 'liq_ins_fees', 'liq_prot_fees'];

export const PROTOCOL = [
  ['deposits', "sumIf(amount, kind = 'deposit')", 'sum(deposits)'],
  ['deposit_count', "countIf(kind = 'deposit')", 'sum(deposit_count)'],
  ['withdrawals', "sumIf(amount, kind = 'withdrawal')", 'sum(withdrawals)'],
  ['withdrawal_count', "countIf(kind = 'withdrawal')", 'sum(withdrawal_count)'],
  ['protocol_in', "sumIf(amount, kind = 'protocol_deposit')", 'sum(protocol_in)'],
  ['protocol_out', "sumIf(amount, kind = 'protocol_withdrawal')", 'sum(protocol_out)'],
  ['new_accounts', "countIf(kind = 'account')", 'sum(new_accounts)']
];

export const ACCOUNT = [
  ['volume', `sumIf(notional, ${ACCOUNT_TRADES})`, 'sum(volume)'],
  ['maker_volume', `sumIf(notional, kind IN ${USER} AND role = 'maker')`, 'sum(maker_volume)'],
  ['trades', `countIf(${ACCOUNT_TRADES})`, 'sum(trades)'],
  ['fees', `sumIf(fee, kind IN ${USER} OR kind = 'liquidation')`, 'sum(fees)'], // trading fees and liquidation fees
  ['realized', `sumIf(pnl + funding, kind IN ${REALIZING})`, 'sum(realized)'],
  ['funding_paid', `sumIf(funding, kind IN ${REALIZING})`, 'sum(funding_paid)'],
  ['liquidations', "countIf(kind = 'liquidation')", 'sum(liquidations)'],
  ['liquidated', "sumIf(notional, kind = 'liquidation')", 'sum(liquidated)'],
  ['deposits', "sumIf(amount, kind = 'deposit')", 'sum(deposits)'],
  ['withdrawals', "sumIf(amount, kind = 'withdrawal')", 'sum(withdrawals)']
];

// Aliases never shadow the raw columns they are computed from.
export const SQL_SETTINGS = { prefer_column_name_to_alias: 1 };
export const raw = defs => defs.map(([c, e]) => `${e} AS ${c}`).join(',\n  ');
export const merged = defs => defs.map(([c, , e]) => `${e} AS ${c}`).join(',\n  ');
export const columns = defs => defs.map(([c]) => c).join(', ');
