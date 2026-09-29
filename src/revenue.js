// Protocol revenue by source. The exchange splits every charged fill fee and
// the margin a liquidation leaves between the market's insurance fund and the
// protocol. These rules reproduced the contract's protocolBalanceCNS and every
// market's insuranceBalanceCNS with zero residual on 16 block ranges and 24
// hourly checkpoints, 25-28 Sep 2026 (docs/methodology.md, "Protocol revenue"):
//
//   * fill fee, opening or reducing: ins = ceil((fee - builderFee) * insAmtPer100K / 100000),
//     protocol = fee - ins, so a builder's share stays inside the protocol part.
//     Opening events (open, increase, invert) carry this split themselves;
//     decrease and close carry none and get it from their linked fill.
//     Reducing fills are charged only from contract v1.7.5 (block 107,355,313).
//   * full liquidation on the book: X = deltaPnl + funding - posAmount (the
//     margin left); user = floor(X * user / 100000) (the event's accAmountCNS),
//     insurance = floor(X * ins / 100000), protocol = X - user - insurance (it
//     keeps the rounding dust, so liqAmtPer100K is not read).
//
// Not verified (none observed), so no rule is assumed: a bankrupt liquidation
// (X <= 0) counts 0; partial and off-book liquidations count 0 and are
// reported as unsplit (the contract has a separate buy-to-liquidate split);
// deleverages and buy-to-liquidate settlements count nothing. Payouts
// (TransferProtocolToAccount), sweeps (TransferAccountToProtocol) and protocol
// balance deposits and withdrawals move the balance but are never revenue.

// The protocol balance (getExchangeInfo protocolBalanceCNS) from launch is
// revenue (the protocol's shares above) plus these row kinds, each with its
// sign; builder fees stay inside it. Reproduced with the same zero residual.
// The last five were never observed: their effect is the one the ABI names.
export const BALANCE_MOVES = Object.freeze({
  protocol_deposit: 1n, protocol_withdrawal: -1n, payout: -1n, sweep: 1n,
  insurance_to_protocol: 1n, positions_to_protocol: 1n, recycle_fee: 1n, protocol_to_market: -1n, protocol_to_recycle: -1n
});
export const BALANCE_KINDS = Object.keys(BALANCE_MOVES);
// `revenue`: { opening, reducing, liquidations } (the protocol's shares);
// `moves`: kind -> { amount } (totals of BALANCE_KINDS rows).
export function protocolBalance({ revenue, moves }) {
  let total = revenue.opening + revenue.reducing + revenue.liquidations;
  for (const [kind, sign] of Object.entries(BALANCE_MOVES)) total += sign * (moves[kind]?.amount ?? 0n);
  return total;
}
// The rules were checked from 25 Sep 2026 12:03 UTC on; shares derived
// before rest on them unchecked (the protocol balance check says how much).
export const CHECKED_FROM_TS = 1790337780;

// A market's rates: set when it is added, then changed by the two updates.
export const REVENUE_PARAM_EVENTS = ['FeeParamsUpdated', 'LiquidationParamsUpdated', 'ContractAdded', 'ContractAddedV2'];
const PER = 100000n;

// Rates in force on every market from 25 Sep 2026 (getInsuranceProtocolSplit,
// getLiquidationInfo), used where no change is indexed. FeeParamsUpdated and
// the rates a market was added with were not indexed before, so history uses
// 15000 until a change is seen. Reducing fills were free before v1.7.5, but
// from then (23 Sep 15:20 UTC) to the first check (25 Sep 12:03 UTC) their
// split rests on 15000 unchecked. Liquidations before a market's first
// indexed LiquidationParamsUpdated use 10000 / 80000 (not verified before 25 Sep).
export const DEFAULT_RATES = Object.freeze({ feeIns: 15000n, liqIns: 10000n, liqUser: 80000n });

export function feeSplit(fee, builderFee = 0n, insPer100K = DEFAULT_RATES.feeIns) {
  const net = fee - builderFee;
  const ins = net > 0n ? (net * insPer100K + PER - 1n) / PER : 0n;
  return { ins, prot: fee - ins };
}

export function liquidationSplit(x, { liqIns = DEFAULT_RATES.liqIns, liqUser = DEFAULT_RATES.liqUser } = {}) {
  if (x <= 0n) return { user: 0n, ins: 0n, prot: 0n };
  const user = x * liqUser / PER, ins = x * liqIns / PER;
  return { user, ins, prot: x - user - ins };
}

// The margin a stored liquidation row leaves: decode.js keeps deltaPnl as pnl
// and posAmount as amount, and past bankruptcy stores pnl so that this is 0.
export const liquidationMargin = row => { const x = BigInt(row.pnl) + BigInt(row.funding) - BigInt(row.amount); return x > 0n ? x : 0n; };
// On the book (FLAG.ON_BOOK) with nothing left: the verified case (aggregates.FULL_ON_BOOK).
export const fullOnBook = row => (Number(row.flags) & 1) === 1 && BigInt(row.end_lot) === 0n;

// Revenue of one stored ev row: { source, ins, prot }, or null for rows that carry none.
export function rowRevenue(row, rates = DEFAULT_RATES) {
  switch (row.kind) {
    case 'open': case 'increase': case 'invert': return { source: 'opening', ins: BigInt(row.ins_fee), prot: BigInt(row.prot_fee) };
    case 'decrease': case 'close': return { source: 'reducing', ...feeSplit(BigInt(row.fee), BigInt(row.builder_fee), rates.feeIns) };
    case 'liquidation': {
      if (!fullOnBook(row)) return { source: 'liquidation', ins: 0n, prot: 0n, unsplit: true };
      const { ins, prot } = liquidationSplit(liquidationMargin(row), rates);
      return { source: 'liquidation', ins, prot };
    }
    default: return null;
  }
}

// Fee and liquidation rates per market over time, from FeeParamsUpdated,
// LiquidationParamsUpdated and ContractAdded rows (the params table, or a
// decoded batch).
export function createRevenueParams(rows = []) {
  const changes = []; // { market, block, log_index, ts, feeIns?, liqIns?, liqUser? }, in chain order
  const seen = new Set();
  const big = v => { try { return BigInt(v); } catch { return null; } };
  // Returns the earliest time from which a new row changes the rates (null if none does).
  function add(list) {
    let since = null;
    for (const r of list) {
      if (!REVENUE_PARAM_EVENTS.includes(r.name)) continue;
      const key = `${r.block}:${r.log_index}`;
      if (seen.has(key)) continue;
      let a;
      try { a = typeof r.args === 'string' ? JSON.parse(r.args) : r.args; } catch { continue; }
      const c = { market: Number(r.market), block: Number(r.block), log_index: Number(r.log_index), ts: Number(r.ts) };
      if (r.name === 'FeeParamsUpdated') c.feeIns = big(a?.insAmtPer100K);
      else if (r.name === 'LiquidationParamsUpdated') { c.liqIns = big(a?.insAmtPer100K); c.liqUser = big(a?.userAmtPer100K); }
      else Object.assign(c, { feeIns: big(a?.insAmtPer100K), liqIns: big(a?.liqInsAmtPer100K), liqUser: big(a?.liqUserAmtPer100K) });
      if (c.feeIns === null || c.liqIns === null || c.liqUser === null || ![c.market, c.block, c.log_index].every(Number.isSafeInteger)) continue;
      const before = at(c.market, c.block, c.log_index);
      seen.add(key); changes.push(c);
      changes.sort((x, y) => x.block - y.block || x.log_index - y.log_index);
      if (['feeIns', 'liqIns', 'liqUser'].some(k => c[k] !== undefined && c[k] !== before[k]) && (since === null || c.ts < since)) since = c.ts;
    }
    return since;
  }
  // Rates for a row of `market` at (block, logIndex).
  function at(market, block, logIndex = 0) {
    const r = { ...DEFAULT_RATES };
    [market, block, logIndex] = [market, block, logIndex].map(Number);
    for (const c of changes) {
      if (c.block > block || (c.block === block && c.log_index >= logIndex)) break;
      if (c.market !== market) continue;
      for (const k of ['feeIns', 'liqIns', 'liqUser']) if (c[k] !== undefined) r[k] = c[k];
    }
    return r;
  }
  // The same as SQL over ev rows: constants, or the latest change before the row.
  function sql() {
    const pick = field => {
      const arms = changes.filter(c => c[field] !== undefined).reverse().map(c => `market = ${c.market} AND (block, log_index) > (${c.block}, ${c.log_index}), ${c[field]}`);
      return arms.length ? `multiIf(${arms.join(', ')}, ${DEFAULT_RATES[field]})` : String(DEFAULT_RATES[field]);
    };
    return { feeIns: pick('feeIns'), liqIns: pick('liqIns'), liqUser: pick('liqUser') };
  }
  add(rows);
  return { add, at, sql, get size() { return changes.length; } };
}
