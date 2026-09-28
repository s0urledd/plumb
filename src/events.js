// Exchange log processing: which positions a block range touched, plus the
// funding, liquidation, deleveraging, unwind and parameter history the
// dashboard shows. Position state itself is never derived from events; the
// collector re-reads touched positions from the contract.
import { decodeLog, topicsFor } from './abi.js';

export const POSITION_EVENTS = [
  'PositionOpened', 'PositionOpenedV2', 'PositionIncreased', 'PositionIncreasedV2', 'PositionDecreased', 'PositionClosed',
  'PositionInverted', 'PositionLiquidated', 'PositionDeleveraged', 'PositionDeleveragedV2', 'PositionUnwound', 'PositionUnwoundV2',
  'PositionUnwoundWithoutPayment', 'PositionUnwoundWithoutPaymentV2', 'IncreasePositionCollateral', 'PositionCollateralDecreased',
  'PositionLiquidationCredit', 'BuyToLiquidateSettled'];
export const FUNDING_EVENTS = ['FundingEventCompleted'];
export const PARAM_EVENTS = [
  'ContractAdded', 'ContractAddedV2', 'ContractRemoved', 'ContractPaused', 'MaintenanceMarginFractionUpdated', 'InitialMarginFractionUpdated',
  'MaxOpenInterestUpdated', 'LiquidationParamsUpdated', 'FundingClampPctUpdated', 'FundingSumScalingExpUpdated', 'ExchangeHalted',
  'UnwindPrepared', 'UnwindInitialized', 'UnwindContractTrigger', 'UnwindIterationCompleted', 'UnwindCompleted',
  'UnwindPreparationCleared', 'UnwindInitializationCleared', 'ContractVersionSet', 'FeeParamsUpdated'];
export const VALIDATION_EVENTS = ['CantLiquidatePosAboveMMR', 'CantBuyToLiquidate', 'InsolventPositionCannotBeForcedClose'];
export const ACCOUNT_EVENTS = ['AccountCreated'];
export const WATCHED_EVENTS = [...new Set([...POSITION_EVENTS, ...FUNDING_EVENTS, ...PARAM_EVENTS, ...VALIDATION_EVENTS, ...ACCOUNT_EVENTS])];
export const watchedTopics = topicsFor(WATCHED_EVENTS);

export const logIdentity = (chain, log) => `${chain}:${log.blockHash}:${log.transactionHash}:${log.logIndex}`;
const accountOf = args => args.accountId ?? args.posAccountId;
const meta = log => ({ block: BigInt(log.blockNumber), blockHash: log.blockHash, tx: log.transactionHash, logIndex: Number(BigInt(log.logIndex)) });

// Processes logs already sorted by block, transaction and log index.
export function processLogs(logs, { seen = null, chain = '143' } = {}) {
  const out = { dirty: new Map(), markets: new Set(), funding: [], liquidations: [], deleverages: [], buyToLiquidate: [], unwinds: [], params: [], validation: [], accountsCreated: 0, decoded: 0, unknown: 0, duplicates: 0, lastBlock: null };
  for (const log of logs) {
    if (seen) {
      const key = logIdentity(chain, log);
      if (seen.has(key)) { out.duplicates++; continue; }
      seen.add(key);
    }
    const event = decodeLog(log);
    if (!event) { out.unknown++; continue; }
    out.decoded++;
    const { name, args } = event, at = meta(log);
    out.lastBlock = at.block;
    if (args.perpId !== undefined) out.markets.add(Number(args.perpId));
    if (POSITION_EVENTS.includes(name)) {
      const accountId = accountOf(args);
      if (accountId !== undefined) out.dirty.set(`${args.perpId}:${accountId}`, { perpId: Number(args.perpId), accountId: BigInt(accountId) });
    }
    switch (name) {
      case 'FundingEventCompleted':
        out.funding.push({ ...at, perpId: Number(args.perpId), fundingEventBlock: BigInt(args.fundingEventBlock), specifiedRatePct100k: BigInt(args.specifiedRatePct100k), actualRatePct100k: BigInt(args.actualRatePct100k), fundingPricePNS: BigInt(args.fundingPricePNS), fundingPaymentPNS: BigInt(args.fundingPaymentPNS), fundingSumPNS: BigInt(args.fundingSumPNS), allowOverwrite: Boolean(args.allowOverwrite) });
        break;
      case 'PositionLiquidated':
        out.liquidations.push({ ...at, perpId: Number(args.perpId), accountId: BigInt(args.posAccountId), positionType: Number(args.positionType), markPricePNS: BigInt(args.markPricePNS), exitPricePNS: BigInt(args.liqPricePNS), liquidatedLotLNS: BigInt(args.liqLotLNS), remainingLotLNS: BigInt(args.posLotLNS), deltaPnlCNS: BigInt(args.deltaPnlCNS), fundingCNS: BigInt(args.fundingCNS), positionAmountCNS: BigInt(args.posAmountCNS), remainingDepositCNS: BigInt(args.posDepositCNS), accountAmountCNS: BigInt(args.accAmountCNS), accountBalanceCNS: BigInt(args.accBalanceCNS), onOrderBook: Boolean(args.onOrderBook) });
        break;
      case 'PositionDeleveraged': case 'PositionDeleveragedV2':
        out.deleverages.push({ ...at, perpId: Number(args.perpId), accountId: BigInt(args.accountId), forceClose: Boolean(args.forceClose), positionType: Number(args.positionType), entryPricePNS: BigInt(args.entryPricePNS), markPricePNS: BigInt(args.markPricePNS), deleveragePricePNS: BigInt(args.deleveragePricePNS), deltaPnlCNS: BigInt(args.deltaPnlCNS), fundingCNS: BigInt(args.fundingCNS), startLotLNS: BigInt(args.startLotLNS), endLotLNS: BigInt(args.endLotLNS), startDepositCNS: BigInt(args.startDepositCNS), endDepositCNS: BigInt(args.endDepositCNS), amountCNS: BigInt(args.amountCNS) });
        break;
      case 'BuyToLiquidateSettled':
        out.buyToLiquidate.push({ ...at, perpId: Number(args.perpId), accountId: BigInt(args.accountId), orderType: Number(args.orderType), realizedPricePNS: BigInt(args.realizedPricePNS), lotLNS: BigInt(args.lotLNS), amountCNS: BigInt(args.amountCNS) });
        break;
      case 'CantLiquidatePosAboveMMR': case 'CantBuyToLiquidate': case 'InsolventPositionCannotBeForcedClose':
        out.validation.push({ ...at, name, perpId: Number(args.perpId), accountId: BigInt(args.posAccountId), positionType: Number(args.positionType), markPricePNS: BigInt(args.markPricePNS), liqPricePNS: args.liqPricePNS === undefined ? null : BigInt(args.liqPricePNS), bankruptcyPricePNS: args.bkptPricePNS !== undefined ? BigInt(args.bkptPricePNS) : args.bankruptcyPricePNS !== undefined ? BigInt(args.bankruptcyPricePNS) : null });
        break;
      case 'AccountCreated':
        out.accountsCreated++;
        break;
      default:
        if (name.startsWith('Unwind')) out.unwinds.push({ ...at, name, perpId: Number(args.perpId) });
        else if (PARAM_EVENTS.includes(name)) out.params.push({ ...at, name, perpId: args.perpId === undefined ? null : Number(args.perpId), args: Object.fromEntries(Object.entries(args).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v])) });
    }
  }
  return out;
}
