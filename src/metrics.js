// Market risk metrics derived from a pinned-block set of positions.
//
// All sums are exact BigInt in contract units. Ratios are basis points
// (BigInt) unless documented otherwise. Nothing here talks to the network.
import * as m from './math.js';
import { depthWithin, absorption, walkedBps, costToTrade, TRADE_SIZES_USD } from './book.js';

export const DEPTH_BPS = [100n, 200n, 500n, 1000n];

export const SHOCKS_BPS = [50n, 100n, 200n, 300n, 500n, 750n, 1000n, 1500n, 2000n, 3000n, 5000n];
export const MAP_BIN_BPS = 50n;
export const MAP_RANGE_BPS = 3000n;
export const HEALTH_BUCKETS = [10000n, 12500n, 15000n, 20000n, 30000n, 50000n];

const sum = (items, pick) => items.reduce((total, item) => total + pick(item), 0n);
const shareBps = (part, total) => total > 0n ? m.floorDiv(part * 10000n, total) : null;

export function enrichPosition(position, market, u) {
  const type = Number(position.positionType), lot = BigInt(position.lotLNS);
  const entryQ16 = m.entryPriceQ16(type, position.pricePNS, position.priceResiduePNSQ16 ?? 0n);
  const entryNotionalCNS = m.entryNotionalCNS(entryQ16, lot, u);
  const markNotionalCNS = m.notionalCNS(market.markPNS, lot, u);
  const deltaPnlCNS = m.deltaPnlCNS(type, entryQ16, market.markPNS, lot, u);
  const premiumPnlCNS = BigInt(position.premiumPnlCNS);
  const depositCNS = BigInt(position.depositCNS);
  const mmrCNS = m.maintenanceMarginCNS(entryQ16, lot, market.maintHdths, u);
  const fmvCNS = m.fmvCNS(depositCNS, deltaPnlCNS, premiumPnlCNS);
  const liquidationMicroPNS = m.liquidationPriceMicroPNS(type, entryQ16, lot, depositCNS, premiumPnlCNS, mmrCNS, u);
  const bankruptcyMicroPNS = m.bankruptcyPriceMicroPNS(type, entryQ16, lot, depositCNS, premiumPnlCNS, u);
  return {
    accountId: BigInt(position.accountId), positionType: type, side: type === m.LONG ? 'long' : 'short', lotLNS: lot,
    entryQ16, entryNotionalCNS, markNotionalCNS, depositCNS, deltaPnlCNS, premiumPnlCNS, pnlCNS: deltaPnlCNS + premiumPnlCNS,
    contractDeltaPnlCNS: position.deltaPnlCNS === undefined ? null : BigInt(position.deltaPnlCNS),
    contractPnlCNS: position.pnlCNS === undefined ? null : BigInt(position.pnlCNS),
    // The contract computed its deltaPnlCNS at the mark current when the position was read.
    contractAgrees: position.deltaPnlCNS === undefined || position.readMarkPNS === undefined ? null : m.deltaPnlCNS(type, entryQ16, position.readMarkPNS, lot, u) === BigInt(position.deltaPnlCNS),
    mmrCNS, fmvCNS, healthBps: m.healthBps(fmvCNS, mmrCNS), status: m.classify(fmvCNS, mmrCNS),
    liquidationMicroPNS, bankruptcyMicroPNS,
    liquidationDistanceBps: m.distanceBps(type, market.markPNS, liquidationMicroPNS),
    bankruptcyDistanceBps: m.distanceBps(type, market.markPNS, bankruptcyMicroPNS),
    leverageBps: depositCNS > 0n ? m.floorDiv(entryNotionalCNS * 10000n, depositCNS) : null,
    effectiveLeverageBps: fmvCNS > 0n ? m.floorDiv(markNotionalCNS * 10000n, fmvCNS) : null,
    entryBlock: BigInt(position.entryBlock ?? 0n)
  };
}

// Equity of a position at a shocked price.
function fmvAt(p, pricePNS, u) {
  return p.depositCNS + p.premiumPnlCNS + m.deltaPnlCNS(p.positionType, p.entryQ16, pricePNS, p.lotLNS, u);
}

export function liquidationLadder(positions, market, u, shocks = SHOCKS_BPS) {
  return shocks.map(bps => {
    const row = { bps, long: { count: 0, notionalCNS: 0n, shortfallCNS: 0n, pricePNS: m.shockedPricePNS(m.LONG, market.markPNS, bps) }, short: { count: 0, notionalCNS: 0n, shortfallCNS: 0n, pricePNS: m.shockedPricePNS(m.SHORT, market.markPNS, bps) } };
    for (const p of positions) {
      const bucket = row[p.side];
      if (p.liquidationDistanceBps !== null && p.liquidationDistanceBps <= bps) { bucket.count++; bucket.notionalCNS += p.markNotionalCNS; }
      if (p.bankruptcyDistanceBps !== null && p.bankruptcyDistanceBps <= bps) {
        const fmv = fmvAt(p, bucket.pricePNS, u);
        if (fmv < 0n) bucket.shortfallCNS += -fmv;
      }
    }
    // Longs are hit by a fall and shorts by a rise, never both at once: each
    // side keeps its own cover, and the row reports the worse direction.
    for (const bucket of [row.long, row.short]) bucket.insuranceCoverageBps = bucket.shortfallCNS > 0n ? m.floorDiv(BigInt(market.insuranceBalanceCNS) * 10000n, bucket.shortfallCNS) : null;
    row.worstNotionalCNS = m.maxBig(row.long.notionalCNS, row.short.notionalCNS);
    row.worstShortfallCNS = m.maxBig(row.long.shortfallCNS, row.short.shortfallCNS);
    row.insuranceCoverageBps = row.worstShortfallCNS > 0n ? m.floorDiv(BigInt(market.insuranceBalanceCNS) * 10000n, row.worstShortfallCNS) : null;
    return row;
  });
}

// Notional of liquidation prices binned by signed distance from the mark.
export function liquidationMap(positions, market, { binBps = MAP_BIN_BPS, rangeBps = MAP_RANGE_BPS } = {}) {
  const bins = new Map();
  const tails = { below: { count: 0, notionalCNS: 0n }, above: { count: 0, notionalCNS: 0n } };
  const mark = BigInt(market.markPNS) * m.MICRO;
  if (mark <= 0n) return { binBps, rangeBps, bins: [], tails };
  for (const p of positions) {
    if (p.liquidationMicroPNS === 0n && p.side === 'long') { tails.below.count++; tails.below.notionalCNS += p.markNotionalCNS; continue; }
    const signed = m.floorDiv((p.liquidationMicroPNS - mark) * 10000n, mark);
    if (signed < -rangeBps) { tails.below.count++; tails.below.notionalCNS += p.markNotionalCNS; continue; }
    if (signed >= rangeBps) { tails.above.count++; tails.above.notionalCNS += p.markNotionalCNS; continue; }
    const index = m.floorDiv(signed, binBps);
    const bin = bins.get(index) ?? { fromBps: index * binBps, toBps: (index + 1n) * binBps, count: 0, longNotionalCNS: 0n, shortNotionalCNS: 0n };
    bin.count++;
    if (p.side === 'long') bin.longNotionalCNS += p.markNotionalCNS; else bin.shortNotionalCNS += p.markNotionalCNS;
    bins.set(index, bin);
  }
  return { binBps, rangeBps, bins: [...bins.values()].sort((a, b) => Number(a.fromBps - b.fromBps)), tails };
}

export function concentration(positions) {
  const total = sum(positions, p => p.markNotionalCNS);
  const sorted = [...positions].sort((a, b) => (b.markNotionalCNS > a.markNotionalCNS ? 1 : b.markNotionalCNS < a.markNotionalCNS ? -1 : 0));
  const top = n => sum(sorted.slice(0, n), p => p.markNotionalCNS);
  let hhi = 0n;
  if (total > 0n) for (const p of sorted) { const share = m.floorDiv(p.markNotionalCNS * 10000n, total); hhi += share * share; }
  return {
    totalNotionalCNS: total, positions: positions.length,
    top1Bps: shareBps(top(1), total), top5Bps: shareBps(top(5), total), top10Bps: shareBps(top(10), total),
    hhi: total > 0n ? m.floorDiv(hhi, 10000n) : null,
    largest: sorted[0] ? { accountId: sorted[0].accountId, side: sorted[0].side, notionalCNS: sorted[0].markNotionalCNS, liquidationDistanceBps: sorted[0].liquidationDistanceBps } : null
  };
}

export function healthDistribution(positions, buckets = HEALTH_BUCKETS) {
  const edges = [0n, ...buckets, null];
  const rows = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const from = edges[i], to = edges[i + 1];
    const inRange = positions.filter(p => p.healthBps !== null && (p.healthBps >= from || (i === 0 && p.healthBps < 0n)) && (to === null || p.healthBps < to));
    rows.push({ fromBps: from, toBps: to, count: inRange.length, notionalCNS: sum(inRange, p => p.markNotionalCNS) });
  }
  return rows;
}

// Positions most likely to be auto-deleveraged when the opposite side goes
// bankrupt: Perpl selects opposing positions most profitable first.
export function adlQueue(positions, limit = 10) {
  const roe = p => p.depositCNS > 0n ? m.floorDiv(p.pnlCNS * 10000n, p.depositCNS) : (p.pnlCNS > 0n ? 1n << 62n : -(1n << 62n));
  const rank = list => [...list].filter(p => p.pnlCNS > 0n).sort((a, b) => { const d = roe(b) - roe(a); return d > 0n ? 1 : d < 0n ? -1 : (b.pnlCNS > a.pnlCNS ? 1 : b.pnlCNS < a.pnlCNS ? -1 : 0); }).slice(0, limit).map((p, i) => ({ rank: i + 1, accountId: p.accountId, side: p.side, roeBps: roe(p), pnlCNS: p.pnlCNS, markNotionalCNS: p.markNotionalCNS, leverageBps: p.leverageBps }));
  return { long: rank(positions.filter(p => p.side === 'long')), short: rank(positions.filter(p => p.side === 'short')) };
}

// Liquidity summary: firm resting depth within fixed bands and the absorption of
// the ladder's liquidation demand by that depth.
export function liquiditySummary(market, ladder, u) {
  const book = market.book;
  if (!book) return null;
  const depth = { bids: {}, asks: {} };
  for (const bps of DEPTH_BPS) { depth.bids[bps] = depthWithin(book.bids, 'bids', market.markPNS, bps, u); depth.asks[bps] = depthWithin(book.asks, 'asks', market.markPNS, bps, u); }
  return { block: book.block, at: book.at, truncated: book.truncated, walkedBps: { bids: walkedBps(book, 'bids', market.markPNS), asks: walkedBps(book, 'asks', market.markPNS) }, rangeBps: book.rangeBps ?? null, levels: { bids: book.bids.length, asks: book.asks.length }, bestBidPNS: book.bids[0]?.pricePNS ?? null, bestAskPNS: book.asks[0]?.pricePNS ?? null, depth, absorption: absorption(ladder, book, market.markPNS, u), cost: TRADE_SIZES_USD.map(usd => ({ usd, buy: costToTrade(book, 'buy', usd, u), sell: costToTrade(book, 'sell', usd, u) })) };
}

// One-off stress at a signed move: negative moves liquidate longs, positive shorts.
export function stressAt(positions, market, u, signedBps) {
  const bps = m.absBig(BigInt(signedBps));
  const [row] = liquidationLadder(positions, market, u, [bps]);
  const side = BigInt(signedBps) < 0n ? 'long' : 'short';
  const bucket = row[side];
  const hit = positions.filter(p => p.side === side && p.liquidationDistanceBps !== null && p.liquidationDistanceBps <= bps).sort((a, b) => (b.markNotionalCNS > a.markNotionalCNS ? 1 : b.markNotionalCNS < a.markNotionalCNS ? -1 : 0));
  const inRange = market.book && (market.book.rangeBps === undefined || market.book.rangeBps === null || bps <= BigInt(market.book.rangeBps));
  const bookSide = side === 'long' ? 'bids' : 'asks';
  const depth = inRange ? depthWithin(market.book[bookSide], bookSide, market.markPNS, bps, u) : null;
  const walked = inRange ? walkedBps(market.book, bookSide, market.markPNS) : null;
  // Open interest is one side: the share is of the side that is hit.
  const sideNotional = sum(positions.filter(p => p.side === side), p => p.markNotionalCNS);
  return { bps: BigInt(signedBps), side, pricePNS: bucket.pricePNS, count: bucket.count, notionalCNS: bucket.notionalCNS, shortfallCNS: bucket.shortfallCNS, insuranceCoverageBps: bucket.shortfallCNS > 0n ? m.floorDiv(BigInt(market.insuranceBalanceCNS) * 10000n, bucket.shortfallCNS) : null, remainingNotionalCNS: sideNotional - bucket.notionalCNS, shareBps: shareBps(bucket.notionalCNS, sideNotional), depthCNS: depth?.notionalCNS ?? null, depthLevels: depth?.levels ?? null, depthComplete: depth ? walked === null || bps <= walked : null, absorptionBps: depth && bucket.notionalCNS > 0n ? m.floorDiv(depth.notionalCNS * 10000n, bucket.notionalCNS) : null, hit };
}

export function sideSummary(positions) {
  const lot = sum(positions, p => p.lotLNS), deposit = sum(positions, p => p.depositCNS);
  const entryNotional = sum(positions, p => p.entryNotionalCNS);
  return {
    count: positions.length, lotLNS: lot, notionalCNS: sum(positions, p => p.markNotionalCNS), entryNotionalCNS: entryNotional,
    depositCNS: deposit, deltaPnlCNS: sum(positions, p => p.deltaPnlCNS), premiumPnlCNS: sum(positions, p => p.premiumPnlCNS),
    fmvCNS: sum(positions, p => p.fmvCNS), mmrCNS: sum(positions, p => p.mmrCNS),
    averageLeverageBps: deposit > 0n ? m.floorDiv(entryNotional * 10000n, deposit) : null,
    liquidatable: positions.filter(p => p.status === 'liquidatable').length,
    bankrupt: positions.filter(p => p.status === 'bankrupt').length,
    averageEntryPNS: lot > 0n ? m.floorDiv(sum(positions, p => p.entryQ16 * p.lotLNS), lot * m.Q16) : null
  };
}

// market: { id, symbol, markPNS, oraclePNS, lastPNS, maintHdths, initHdths, insuranceBalanceCNS, longOpenInterestLNS, shortOpenInterestLNS, ... }
// A book walked longer ago than bookMaxAgeMs (a failing walk) is not used.
export function marketMetrics(market, rawPositions, u, { bookMaxAgeMs = null, now = Date.now() } = {}) {
  const positions = rawPositions.map(p => enrichPosition(p, market, u));
  const longs = positions.filter(p => p.side === 'long'), shorts = positions.filter(p => p.side === 'short');
  const long = sideSummary(longs), short = sideSummary(shorts);
  const oi = {
    longLNS: long.lotLNS, shortLNS: short.lotLNS, contractLongLNS: BigInt(market.longOpenInterestLNS), contractShortLNS: BigInt(market.shortOpenInterestLNS),
    longNotionalCNS: long.notionalCNS, shortNotionalCNS: short.notionalCNS, totalNotionalCNS: long.notionalCNS + short.notionalCNS,
    maxLNS: market.oiMaxLNS === undefined ? null : BigInt(market.oiMaxLNS)
  };
  oi.reconciled = oi.longLNS === oi.contractLongLNS && oi.shortLNS === oi.contractShortLNS;
  oi.utilisationBps = oi.maxLNS && oi.maxLNS > 0n ? m.floorDiv(oi.longLNS * 10000n, oi.maxLNS) : null;
  const pnlChecked = positions.filter(p => p.contractAgrees !== null);
  const pnlAgreement = { checked: pnlChecked.length, agree: pnlChecked.filter(p => p.contractAgrees).length };
  const totalMmr = long.mmrCNS + short.mmrCNS;
  const ladder = liquidationLadder(positions, market, u);
  const bookStale = Boolean(market.book && bookMaxAgeMs !== null && now - market.book.at > bookMaxAgeMs);
  return {
    id: market.id, symbol: market.symbol,
    positions, long, short, oi,
    ladder,
    liquidity: bookStale ? null : liquiditySummary(market, ladder, u), bookStale,
    adl: adlQueue(positions),
    map: liquidationMap(positions, market),
    concentration: { all: concentration(positions), long: concentration(longs), short: concentration(shorts) },
    health: healthDistribution(positions),
    insurance: {
      balanceCNS: BigInt(market.insuranceBalanceCNS), positionBalanceCNS: BigInt(market.positionBalanceCNS ?? 0n),
      coverageOfNotionalBps: shareBps(BigInt(market.insuranceBalanceCNS), oi.totalNotionalCNS),
      coverageOfMmrBps: totalMmr > 0n ? m.floorDiv(BigInt(market.insuranceBalanceCNS) * 10000n, totalMmr) : null
    },
    basisBps: BigInt(market.oraclePNS ?? 0n) > 0n ? m.floorDiv((BigInt(market.markPNS) - BigInt(market.oraclePNS)) * 10000n, BigInt(market.oraclePNS)) : null,
    validation: { oiReconciled: oi.reconciled, pnlAgreement }
  };
}

export function exchangeTotals(marketsMetrics) {
  const totals = { markets: marketsMetrics.length, positions: 0, liquidatable: 0, bankrupt: 0, notionalCNS: 0n, depositCNS: 0n, fmvCNS: 0n, insuranceCNS: 0n, allReconciled: true };
  // Market-wide moves: every market falls (longs liquidated) or rises (shorts
  // liquidated) by the same amount. Each market's insurance fund covers only
  // that market's shortfall.
  const move = () => ({ notionalCNS: 0n, shortfallCNS: 0n, coveredCNS: 0n });
  totals.moves = { 500: { down: move(), up: move() }, 1000: { down: move(), up: move() } };
  for (const x of marketsMetrics) {
    totals.positions += x.positions.length;
    totals.liquidatable += x.long.liquidatable + x.short.liquidatable;
    totals.bankrupt += x.long.bankrupt + x.short.bankrupt;
    totals.notionalCNS += x.oi.totalNotionalCNS;
    totals.depositCNS += x.long.depositCNS + x.short.depositCNS;
    totals.fmvCNS += x.long.fmvCNS + x.short.fmvCNS;
    totals.insuranceCNS += x.insurance.balanceCNS;
    for (const bps of [500n, 1000n]) {
      const row = x.ladder.find(r => r.bps === bps);
      if (!row) continue;
      for (const [dir, bucket] of [['down', row.long], ['up', row.short]]) {
        const t = totals.moves[bps][dir];
        t.notionalCNS += bucket.notionalCNS; t.shortfallCNS += bucket.shortfallCNS; t.coveredCNS += m.minBig(bucket.shortfallCNS, x.insurance.balanceCNS);
      }
    }
    if (!x.oi.reconciled) totals.allReconciled = false;
  }
  // Headlines take the worse direction of each measure.
  const worse = (bps, key) => (totals.moves[bps].up[key] > totals.moves[bps].down[key] ? 'up' : 'down');
  totals.notionalAt500Bps = totals.moves[500][worse(500, 'notionalCNS')].notionalCNS;
  totals.directionAt1000Bps = worse(1000, 'notionalCNS');
  totals.notionalAt1000Bps = totals.moves[1000][totals.directionAt1000Bps].notionalCNS;
  totals.shortfallDirectionAt1000Bps = worse(1000, 'shortfallCNS');
  const shortfall = totals.moves[1000][totals.shortfallDirectionAt1000Bps];
  totals.shortfallAt1000Bps = shortfall.shortfallCNS;
  totals.coveredAt1000Bps = shortfall.coveredCNS;
  return totals;
}
