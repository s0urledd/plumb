// Exchange log decoding for the ClickHouse index.
//
// Every event the index needs has only static ABI types, so logs are decoded
// by slicing 32-byte words (about 20x faster than a generic decoder, which
// matters for the tens of millions of historical logs). ContractAdded carries
// strings and parameter events are rare, so those go through viem.
//
// Semantics (verified against live mainnet logs, see docs/methodology.md):
//   * each user position event (open, increase, decrease, close, invert) is
//     immediately followed in the same transaction by the fill that caused
//     it: MakerOrderFilled for the same account and market, or
//     TakerOrderFilled; the fill carries the trade price, size and fee;
//   * PositionInverted.positionType is the side AFTER the inversion;
//   * volume counts every match once: the sum of maker-fill notional;
//   * fees charged = maker + taker fill fees (= insurance + protocol fee on
//     the position event); a builder's share is included in the fill fee and
//     in the protocol fee (perpl-sdk: "must not add it on top"). Decrease
//     and close carry no split: the linked fill's fee and builder fee stored
//     on the row give it when windows and rollups are summed (revenue.js),
//     with the rates of FeeParamsUpdated, LiquidationParamsUpdated and
//     ContractAdded, all kept as parameter rows;
//   * the protocol balance also moves by transfers that are not revenue:
//     payouts to accounts, sweeps from accounts, and transfers with a
//     market's insurance fund or positions and with the recycle balance, and
//     a market's position-balance residue moved to it at an upgrade
//     (BALANCE_EVENTS, one row kind each).
import { toEventSelector } from 'viem';
import { eventsAbi, decodeLog, topicsFor } from './abi.js';
import * as m from './math.js';
import { FLAG } from './schema.js';

export const TRADE_EVENTS = ['PositionOpened', 'PositionOpenedV2', 'PositionIncreased', 'PositionIncreasedV2', 'PositionDecreased', 'PositionClosed', 'PositionInverted'];
export const FORCED_EVENTS = ['PositionLiquidated', 'PositionDeleveraged', 'PositionDeleveragedV2', 'PositionUnwound', 'PositionUnwoundV2', 'PositionUnwoundWithoutPayment', 'PositionUnwoundWithoutPaymentV2'];
export const FILL_EVENTS = ['MakerOrderFilled', 'MakerOrderFilledV2', 'TakerOrderFilled', 'TakerOrderFilledV2'];
export const FLOW_EVENTS = ['CollateralDeposit', 'CollateralWithdrawal', 'ProtocolBalanceDeposit', 'ProtocolBalanceWithdraw'];
export const OTHER_EVENTS = ['AccountCreated', 'FundingEventCompleted', 'BuyToLiquidateSettled', 'IncreasePositionCollateral', 'PositionCollateralDecreased', 'PositionLiquidationCredit', 'InsurancePaymentForSettlement'];
export const MARKET_EVENTS = ['ContractAdded', 'ContractAddedV2'];
export const PARAM_EVENTS = [
  'ContractRemoved', 'ContractPaused', 'MaintenanceMarginFractionUpdated', 'InitialMarginFractionUpdated', 'MaxOpenInterestUpdated',
  'LiquidationParamsUpdated', 'FundingClampPctUpdated', 'FundingSumScalingExpUpdated', 'ExchangeHalted', 'UnwindPrepared', 'UnwindInitialized',
  'UnwindContractTrigger', 'UnwindIterationCompleted', 'UnwindCompleted', 'UnwindPreparationCleared', 'UnwindInitializationCleared', 'ContractVersionSet',
  'FeeParamsUpdated', 'BuyToLiquidateParamsUpdated'];
export const BALANCE_EVENTS = ['TransferProtocolToAccount', 'TransferAccountToProtocol', 'TransferPerpInsToProtocol', 'TransferPerpPosToProtocol', 'TransferProtocolToPerp', 'TransferProtocolToRecycleBal', 'RecycleFeeToProtocol', 'ResidueTransferred'];
export const TRANSFER_KINDS = ['payout', 'sweep', 'insurance_to_protocol', 'positions_to_protocol', 'protocol_to_market', 'protocol_to_recycle', 'recycle_fee', 'residue_to_protocol']; // their row kinds
export const INGEST_EVENTS = [...TRADE_EVENTS, ...FORCED_EVENTS, ...FILL_EVENTS, ...FLOW_EVENTS, ...OTHER_EVENTS, ...MARKET_EVENTS, ...PARAM_EVENTS, ...BALANCE_EVENTS];
// Events added after history was indexed: the topic backfill (ingest.js)
// reads them alone over the blocks indexed before. The balance transfers,
// and the rates of FeeParamsUpdated and ContractAdded, whose parameter rows
// were not stored before either. A new name starts the set's coverage empty,
// so adding an event (ResidueTransferred, in 'protocol-v2') reads the whole
// history again; rows already stored are skipped.
export const TOPIC_SET = { name: 'protocol-v3', events: [...BALANCE_EVENTS, 'FeeParamsUpdated', 'BuyToLiquidateParamsUpdated', 'ContractAdded', 'ContractAddedV2'] };
export const topicSetTopics = topicsFor(TOPIC_SET.events);

const STATIC = /^(u?int\d*|bool|address)$/;
const specs = new Map(); // topic0 -> { name, inputs, fast }
for (const item of eventsAbi) {
  if (!INGEST_EVENTS.includes(item.name)) continue;
  specs.set(toEventSelector(item), { name: item.name, inputs: item.inputs, fast: item.inputs.every(i => STATIC.test(i.type) && !i.indexed) });
}
for (const name of INGEST_EVENTS) if (![...specs.values()].some(s => s.name === name)) throw new Error(`UNKNOWN_EVENT:${name}`);
export const ingestTopics = [...specs.keys()];

const U256 = 1n << 256n, I256_MAX = (1n << 255n) - 1n;
function word(data, i) { return data.slice(2 + i * 64, 66 + i * 64); }
function decodeWord(type, w) {
  if (type === 'bool') return w.charCodeAt(63) === 49; // '1'
  if (type === 'address') return '0x' + w.slice(24);
  const v = BigInt('0x' + w);
  if (type.startsWith('int')) return v > I256_MAX ? v - U256 : v;
  return v;
}

// { name, args } for ingest topics, null for anything else.
export function decodeFast(log) {
  const spec = specs.get(log.topics?.[0]);
  if (!spec) return null;
  if (!spec.fast) return decodeLog(log);
  const data = log.data;
  if (data.length < 2 + spec.inputs.length * 64) throw new Error(`SHORT_LOG_DATA:${spec.name}`);
  const args = {};
  for (let i = 0; i < spec.inputs.length; i++) args[spec.inputs[i].name] = decodeWord(spec.inputs[i].type, word(data, i));
  return { name: spec.name, args };
}

const n = v => Number(v);
const LONG = m.LONG, SHORT = m.SHORT;
const hexNum = v => typeof v === 'number' ? v : Number(BigInt(v));

function base(log) {
  return { block: hexNum(log.blockNumber), log_index: hexNum(log.logIndex), tx_index: hexNum(log.transactionIndex), ts: hexNum(log.blockTimestamp), tx: log.transactionHash };
}
function blank(b, kind) {
  return { ...b, kind, market: 0, account: 0, side: -1, role: 'none', buy: -1, price: 0n, lot: 0n, start_lot: 0n, end_lot: 0n, notional: 0n, fee: 0n, ins_fee: 0n, prot_fee: 0n, builder_fee: 0n, pnl: 0n, funding: 0n, deposit: 0n, amount: 0n, balance: 0n, leverage: 0, mark: 0n, flags: 0, oi_long: 0n, oi_short: 0n };
}
const oiDelta = (row, side, lots) => { if (side === LONG) row.oi_long += lots; else if (side === SHORT) row.oi_short += lots; };
const param = (b, name, a) => ({ block: b.block, log_index: b.log_index, ts: b.ts, tx: b.tx, name, market: a.perpId === undefined ? -1 : n(a.perpId), args: JSON.stringify(a, (_, v) => typeof v === 'bigint' ? v.toString() : v) });

// Converts ordered logs (whole blocks, sorted by block and log index) into
// table rows. unitsOf(marketId) returns math.units(...) or null; markets
// announced by ContractAdded in the same batch are registered on the fly.
export function rowsFromLogs(logs, { unitsOf, collateralDecimals = 6 } = {}) {
  const out = { ev: [], markets: [], accounts: [], funding: [], params: [], missingMarkets: new Set(), stats: { logs: logs.length, decoded: 0, userEvents: 0, linked: 0, unlinked: 0, lotMismatch: 0, feeChecked: 0, feeMismatch: 0, forcedLinked: 0, forcedLotMismatch: 0, takerFillsUnlinked: 0 } };
  const local = new Map();
  const units = id => local.get(id) ?? unitsOf(id);
  const notional = (row, price, lot) => {
    const u = units(row.market);
    if (!u) { out.missingMarkets.add(row.market); return 0n; }
    return m.notionalCNS(price, lot, u);
  };
  let pending = null; // user position row awaiting its fill
  let forced = null;  // liquidation still waiting for its taker fill
  let orphan = null;  // taker fill with no position event yet (liquidation on the book)

  for (const log of logs) {
    const decoded = decodeFast(log);
    if (!decoded) continue;
    out.stats.decoded++;
    const { name, args: a } = decoded;
    const b = base(log);
    if (pending && pending.tx !== b.tx) { finishUnlinked(pending); pending = null; }
    if (forced && forced.tx !== b.tx) forced = null;
    if (orphan && orphan.tx !== b.tx) { out.stats.takerFillsUnlinked++; orphan = null; }
    let row = null;
    switch (name) {
      case 'PositionOpened': case 'PositionOpenedV2': {
        row = blank(b, 'open');
        Object.assign(row, { market: n(a.perpId), account: n(a.accountId), side: n(a.positionType), price: a.pricePNS, lot: a.lotLNS, end_lot: a.lotLNS, deposit: a.depositCNS, leverage: n(a.leverageHdths), ins_fee: a.insFeeCNS, prot_fee: a.protFeeCNS });
        row.buy = row.side === LONG ? 1 : 0;
        oiDelta(row, row.side, a.lotLNS);
        break;
      }
      case 'PositionIncreased': case 'PositionIncreasedV2': {
        row = blank(b, 'increase');
        // Changing the lot realizes the funding accrued so far (premium PnL).
        Object.assign(row, { market: n(a.perpId), account: n(a.accountId), side: n(a.positionType), price: a.pricePNS, start_lot: a.startLotLNS, end_lot: a.endLotLNS, lot: a.endLotLNS - a.startLotLNS, deposit: a.endDepositCNS, leverage: n(a.leverageHdths), funding: a.premiumPnlSettledCNS, ins_fee: a.insFeeCNS, prot_fee: a.protFeeCNS });
        row.buy = row.side === LONG ? 1 : 0;
        oiDelta(row, row.side, row.lot);
        break;
      }
      case 'PositionDecreased': {
        row = blank(b, 'decrease');
        Object.assign(row, { market: n(a.perpId), account: n(a.accountId), side: n(a.positionType), start_lot: a.startLotLNS, end_lot: a.endLotLNS, lot: a.startLotLNS - a.endLotLNS, deposit: a.endDepositCNS, pnl: a.deltaPnlCNS, funding: a.fundingCNS });
        row.buy = row.side === SHORT ? 1 : 0;
        oiDelta(row, row.side, -row.lot);
        break;
      }
      case 'PositionClosed': {
        // No size on the event: the linked fill supplies it (and the OI delta).
        row = blank(b, 'close');
        Object.assign(row, { market: n(a.perpId), account: n(a.accountId), side: n(a.positionType), price: a.pricePNS, pnl: a.deltaPnlCNS, funding: a.fundingCNS });
        row.buy = row.side === SHORT ? 1 : 0;
        break;
      }
      case 'PositionInverted': {
        // positionType is the new side; startLot was held on the other side.
        row = blank(b, 'invert');
        const side = n(a.positionType);
        Object.assign(row, { market: n(a.perpId), account: n(a.accountId), side, price: a.pricePNS, start_lot: a.startLotLNS, end_lot: a.endLotLNS, lot: a.startLotLNS + a.endLotLNS, deposit: a.endDepositCNS, leverage: n(a.leverageHdths), pnl: a.deltaPnlCNS, funding: a.fundingCNS, ins_fee: a.insFeeCNS, prot_fee: a.protFeeCNS });
        row.buy = side === LONG ? 1 : 0;
        oiDelta(row, side === LONG ? SHORT : LONG, -a.startLotLNS);
        oiDelta(row, side, a.endLotLNS);
        break;
      }
      case 'PositionLiquidated': {
        row = blank(b, 'liquidation');
        Object.assign(row, { market: n(a.perpId), account: n(a.posAccountId), side: n(a.positionType), price: a.liqPricePNS, mark: a.markPricePNS, lot: a.liqLotLNS, end_lot: a.posLotLNS, start_lot: a.liqLotLNS + a.posLotLNS, pnl: a.deltaPnlCNS, funding: a.fundingCNS, amount: a.posAmountCNS, deposit: a.posDepositCNS, balance: a.accBalanceCNS, flags: a.onOrderBook ? FLAG.ON_BOOK : 0 });
        row.buy = row.side === SHORT ? 1 : 0;
        row.notional = notional(row, row.price, row.lot);
        oiDelta(row, row.side, -row.lot);
        // The event's deltaPnl is what closing at the exit price would give. The
        // trader gets back only part of the margin left (accAmount; 80 % by
        // default), the rest goes to the insurance fund and protocol: that part
        // is the liquidation fee. A loss beyond the removed deposit
        // (posAmount = -deposit) falls on the insurance fund, not the trader.
        const residual = a.deltaPnlCNS + a.fundingCNS - a.posAmountCNS;
        if (residual > 0n) row.fee = residual > a.accAmountCNS ? residual - a.accAmountCNS : 0n;
        else row.pnl = a.posAmountCNS - a.fundingCNS;
        break;
      }
      case 'PositionDeleveraged': case 'PositionDeleveragedV2': {
        row = blank(b, 'deleverage');
        Object.assign(row, { market: n(a.perpId), account: n(a.accountId), side: n(a.positionType), price: a.deleveragePricePNS, mark: a.markPricePNS, start_lot: a.startLotLNS, end_lot: a.endLotLNS, lot: a.startLotLNS - a.endLotLNS, pnl: a.deltaPnlCNS, funding: a.fundingCNS, deposit: a.endDepositCNS, amount: a.amountCNS, balance: a.balanceCNS, flags: a.forceClose ? FLAG.FORCE_CLOSE : 0 });
        row.buy = row.side === SHORT ? 1 : 0;
        row.notional = notional(row, row.price, row.lot);
        oiDelta(row, row.side, -row.lot);
        break;
      }
      case 'PositionUnwound': case 'PositionUnwoundV2': case 'PositionUnwoundWithoutPayment': case 'PositionUnwoundWithoutPaymentV2': {
        row = blank(b, 'unwind');
        const paid = name.startsWith('PositionUnwoundWithout') ? 0 : 1;
        Object.assign(row, { market: n(a.perpId), account: n(a.accountId), side: n(a.positionType), price: a.pricePNS, mark: a.markPricePNS, lot: a.lotLNS, start_lot: a.lotLNS, deposit: a.depositCNS, amount: paid ? a.paymentCNS : a.amountOwedCNS, balance: paid ? a.balanceCNS : 0n, pnl: a.positionFmvCNS - a.depositCNS, flags: paid ? 0 : FLAG.WITHOUT_PAYMENT });
        row.buy = row.side === SHORT ? 1 : 0;
        row.notional = notional(row, row.price, row.lot);
        oiDelta(row, row.side, -row.lot);
        break;
      }
      case 'MakerOrderFilled': case 'MakerOrderFilledV2': {
        row = blank(b, 'maker_fill');
        Object.assign(row, { market: n(a.perpId), account: n(a.accountId), price: a.pricePNS, lot: a.lotLNS, fee: a.feeCNS, builder_fee: a.builderFeeCNS ?? 0n, amount: a.amountCNS, balance: a.balanceCNS });
        row.notional = notional(row, row.price, row.lot);
        if (pending && pending.account === row.account && pending.market === row.market) link(pending, row, 'maker');
        pending = null;
        break;
      }
      case 'TakerOrderFilled': case 'TakerOrderFilledV2': {
        row = blank(b, 'taker_fill');
        Object.assign(row, { price: a.entryPricePNS, lot: a.lotLNS, fee: a.feeCNS, builder_fee: a.builderFeeCNS ?? 0n, amount: a.amountCNS, balance: a.balanceCNS });
        if (pending) { row.market = pending.market; row.account = pending.account; row.buy = pending.buy; link(pending, row, 'taker'); row.notional = notional(row, row.price, row.lot); }
        else if (forced) { linkForced(forced, row); forced = null; }
        else orphan = row; // a liquidation on the book reports its taker fill first
        pending = null;
        break;
      }
      case 'CollateralDeposit': row = blank(b, 'deposit'); Object.assign(row, { account: n(a.accountId), amount: a.amountCNS, balance: a.balanceCNS }); break;
      case 'CollateralWithdrawal': row = blank(b, 'withdrawal'); Object.assign(row, { account: n(a.accountId), amount: a.amountCNS, balance: a.balanceCNS }); break;
      case 'ProtocolBalanceDeposit': row = blank(b, 'protocol_deposit'); row.amount = a.amountCNS; break;
      case 'ProtocolBalanceWithdraw': row = blank(b, 'protocol_withdrawal'); row.amount = a.amountCNS; break;
      // Protocol balance transfers; balance is the account's (or the recycle balance) after.
      case 'TransferProtocolToAccount': row = blank(b, 'payout'); Object.assign(row, { account: n(a.accountId), amount: a.amountCNS, balance: a.balanceCNS }); break;
      case 'TransferAccountToProtocol': row = blank(b, 'sweep'); Object.assign(row, { account: n(a.accountId), amount: a.amountCNS, balance: a.balanceCNS }); break;
      case 'TransferPerpInsToProtocol': row = blank(b, 'insurance_to_protocol'); Object.assign(row, { market: n(a.perpId), amount: a.amountCNS }); break;
      case 'TransferPerpPosToProtocol': row = blank(b, 'positions_to_protocol'); Object.assign(row, { market: n(a.perpId), amount: a.amountCNS }); break;
      case 'TransferProtocolToPerp': row = blank(b, 'protocol_to_market'); Object.assign(row, { market: n(a.perpId), amount: a.amountCNS, flags: a.toInsuranceFund ? FLAG.TO_INSURANCE : 0 }); break;
      case 'TransferProtocolToRecycleBal': row = blank(b, 'protocol_to_recycle'); row.amount = a.amountCNS; break;
      case 'RecycleFeeToProtocol': row = blank(b, 'recycle_fee'); Object.assign(row, { market: n(a.perpId), amount: a.recycleFeeCNS, balance: a.recycleBalanceCNS }); break;
      // A market's position-balance residue moved to the protocol (seen at contract upgrades); balance is the market's position balance after.
      case 'ResidueTransferred': row = blank(b, 'residue_to_protocol'); Object.assign(row, { market: n(a.perpId), amount: a.residueAmountCNS, balance: a.positionBalanceCNS }); break;
      case 'AccountCreated':
        row = blank(b, 'account'); row.account = n(a.id);
        out.accounts.push({ account: n(a.id), address: String(a.account).toLowerCase(), block: b.block, ts: b.ts, tx: b.tx });
        break;
      case 'BuyToLiquidateSettled': row = blank(b, 'btl'); Object.assign(row, { market: n(a.perpId), account: n(a.accountId), price: a.realizedPricePNS, lot: a.lotLNS, amount: a.amountCNS, balance: a.balanceCNS }); row.notional = notional(row, row.price, row.lot); break;
      case 'IncreasePositionCollateral': row = blank(b, 'collateral_add'); Object.assign(row, { market: n(a.perpId), account: n(a.accountId), deposit: a.positionDepositCNS, amount: a.amountCNS, balance: a.balanceCNS }); break;
      case 'PositionCollateralDecreased': row = blank(b, 'collateral_remove'); Object.assign(row, { market: n(a.perpId), account: n(a.accountId), side: n(a.positionType), mark: a.markPricePNS, deposit: a.endDepositCNS, amount: a.decreaseCNS, balance: a.balanceCNS }); break;
      case 'PositionLiquidationCredit': row = blank(b, 'liquidation_credit'); Object.assign(row, { market: n(a.perpId), account: n(a.accountId), deposit: a.endDepositCNS, amount: a.endDepositCNS - a.startDepositCNS }); break;
      case 'InsurancePaymentForSettlement': row = blank(b, 'insurance_payment'); Object.assign(row, { market: n(a.perpId), account: n(a.accountId), amount: a.insPaymentCNS }); break;
      case 'FundingEventCompleted':
        out.funding.push({ market: n(a.perpId), funding_block: a.fundingEventBlock, block: b.block, log_index: b.log_index, ts: b.ts, tx: b.tx, specified_rate: a.specifiedRatePct100k, actual_rate: a.actualRatePct100k, price: a.fundingPricePNS, payment: a.fundingPaymentPNS, sum: a.fundingSumPNS, overwrite: a.allowOverwrite ? 1 : 0 });
        break;
      case 'ContractAdded': case 'ContractAddedV2': {
        const market = n(a.perpId);
        out.markets.push({ market, name: a.name, symbol: a.symbol, price_decimals: n(a.priceDecimals), lot_decimals: n(a.lotDecimals), base_price: a.basePricePNS, max_oi: a.maxOpenInterestLNS, init_margin_hdths: n(a.initMarginFracHdths), maint_margin_hdths: n(a.maintMarginFracHdths), block: b.block, ts: b.ts, source: 'event' });
        local.set(market, m.units(n(a.priceDecimals), n(a.lotDecimals), collateralDecimals));
        out.params.push(param(b, name, a)); // the fee and liquidation rates the market starts with
        break;
      }
      default:
        if (PARAM_EVENTS.includes(name)) out.params.push(param(b, name, a));
    }
    if (!row) continue;
    if (row.kind === 'liquidation') {
      if (orphan) { linkForced(row, orphan); orphan = null; } else forced = row;
    } else if (row.kind !== 'maker_fill' && row.kind !== 'taker_fill') {
      forced = null;
      if (orphan) { out.stats.takerFillsUnlinked++; orphan = null; }
    }
    if (TRADE_EVENTS.includes(name)) {
      out.stats.userEvents++;
      if (pending) finishUnlinked(pending);
      pending = row;
    }
    out.ev.push(row);
  }
  if (pending) finishUnlinked(pending);
  if (orphan) out.stats.takerFillsUnlinked++;
  return out;

  // The liquidated position is the taker of its own fill.
  function linkForced(liq, fill) {
    fill.market = liq.market; fill.account = liq.account; fill.buy = liq.buy;
    fill.notional = notional(fill, fill.price, fill.lot);
    liq.role = 'taker'; liq.fee += fill.fee; liq.builder_fee = fill.builder_fee;
    if (fill.lot !== liq.lot) out.stats.forcedLotMismatch++;
    out.stats.forcedLinked++;
  }

  function link(pos, fill, role) {
    pos.role = role;
    if (pos.kind !== 'close' && fill.lot !== pos.lot) out.stats.lotMismatch++;
    // Building fills charge a fee that the position event splits exactly.
    if (pos.kind === 'open' || pos.kind === 'increase' || pos.kind === 'invert') { out.stats.feeChecked++; if (pos.ins_fee + pos.prot_fee !== fill.fee) out.stats.feeMismatch++; }
    pos.price = fill.price; pos.lot = fill.lot; pos.fee = fill.fee; pos.builder_fee = fill.builder_fee;
    if (pos.kind === 'close') { pos.start_lot = fill.lot; oiDelta(pos, pos.side, -fill.lot); }
    pos.notional = notional(pos, pos.price, pos.lot);
    out.stats.linked++;
  }
  // Without a fill the event's own price and size stand (close has none).
  function finishUnlinked(pos) {
    if (pos.role !== 'none') return;
    pos.flags |= FLAG.UNLINKED;
    out.stats.unlinked++;
    if (pos.lot > 0n && pos.price > 0n) pos.notional = notional(pos, pos.price, pos.lot);
  }
}
