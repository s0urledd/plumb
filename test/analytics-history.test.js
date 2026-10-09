import test from 'node:test';
import assert from 'node:assert/strict';
import { roundTrips, performance, insights, activityGrid, walletAnalyzer, eventTally } from '../src/analytics.js';
import { tradeHistory } from './helpers/trade-history.js';

// Performance as it was computed over the whole trip list before histories were
// read in pages; the tally must give the same figures.
const median = s => { const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
function reference(trips) {
  const closed = trips.filter(t => t.closeTs !== null).sort((a, b) => a.closeBlock - b.closeBlock);
  const wins = closed.filter(t => t.net > 0n), losses = closed.filter(t => t.net < 0n);
  const grossProfit = wins.reduce((a, t) => a + t.net, 0n), grossLoss = -losses.reduce((a, t) => a + t.net, 0n);
  let equity = 0n, peak = 0n, maxDrawdown = 0n, drawdownStart = closed[0]?.closeTs ?? null, worstFrom = null, worstTo = null;
  const curve = [];
  for (const t of closed) {
    equity += t.net;
    if (equity > peak) { peak = equity; drawdownStart = t.closeTs; }
    const dd = peak - equity;
    if (dd > maxDrawdown) { maxDrawdown = dd; worstFrom = drawdownStart; worstTo = t.closeTs; }
    curve.push({ ts: t.closeTs, equity });
  }
  let streak = 0, bestStreak = 0, worstStreak = 0;
  for (const t of closed) {
    if (t.net > 0n) { streak = streak > 0 ? streak + 1 : 1; bestStreak = Math.max(bestStreak, streak); }
    else if (t.net < 0n) { streak = streak < 0 ? streak - 1 : -1; worstStreak = Math.min(worstStreak, streak); }
  }
  const holds = closed.filter(t => t.complete).map(t => t.closeTs - t.openTs).sort((a, b) => a - b);
  const winHolds = wins.filter(t => t.complete).map(t => t.closeTs - t.openTs).sort((a, b) => a - b);
  const lossHolds = losses.filter(t => t.complete).map(t => t.closeTs - t.openTs).sort((a, b) => a - b);
  const byMarket = new Map();
  for (const t of closed) {
    const x = byMarket.get(t.market) ?? { market: t.market, trips: 0, wins: 0, net: 0n, realized: 0n, fees: 0n, volume: 0n, longs: 0, shorts: 0 };
    x.trips++; x.net += t.net; x.realized += t.realized; x.fees += t.fees; x.volume += t.entryNotional + t.exitNotional;
    if (t.net > 0n) x.wins++; if (t.side === 0) x.longs++; else x.shorts++;
    byMarket.set(t.market, x);
  }
  const markets = [...byMarket.values()].sort((a, b) => (b.net > a.net ? 1 : b.net < a.net ? -1 : 0));
  const sideStats = side => { const list = closed.filter(t => t.side === side); const w = list.filter(t => t.net > 0n).length; return { trips: list.length, wins: w, win_rate: list.length ? w / list.length : null, net: list.reduce((a, t) => a + t.net, 0n) }; };
  const sum = list => list.reduce((a, t) => a + t.net, 0n);
  return {
    closedTrips: closed.length, wins: wins.length, losses: losses.length, breakeven: closed.length - wins.length - losses.length,
    winRate: closed.length ? wins.length / closed.length : null,
    grossProfit, grossLoss, profitFactor: grossLoss > 0n ? Number(grossProfit * 10000n / grossLoss) / 10000 : null,
    net: sum(closed), realized: closed.reduce((a, t) => a + t.realized, 0n), fees: closed.reduce((a, t) => a + t.fees, 0n),
    averageWin: wins.length ? grossProfit / BigInt(wins.length) : null, averageLoss: losses.length ? grossLoss / BigInt(losses.length) : null,
    expectancy: closed.length ? sum(closed) / BigInt(closed.length) : null,
    largestWin: wins.length ? wins.reduce((a, t) => (t.net > a ? t.net : a), 0n) : null, largestLoss: losses.length ? losses.reduce((a, t) => (t.net < a ? t.net : a), 0n) : null,
    maxDrawdown, drawdownFrom: worstFrom, drawdownTo: worstTo, curve,
    bestStreak, worstStreak: -worstStreak, currentStreak: streak,
    averageHold: holds.length ? Math.round(holds.reduce((a, b) => a + b, 0) / holds.length) : null, medianHold: median(holds),
    medianWinHold: median(winHolds), medianLossHold: median(lossHolds),
    long: sideStats(0), short: sideStats(1),
    liquidatedTrips: closed.filter(t => t.liquidated).length, deleveragedTrips: closed.filter(t => t.deleveraged).length,
    bestMarket: markets[0] ?? null, worstMarket: markets.length > 1 ? markets.at(-1) : null, markets
  };
}

test('the history fixture covers every kind of trip', () => {
  const { trips, openTrips } = roundTrips(tradeHistory(6000));
  assert.ok(trips.length > 1000);
  for (const flag of ['liquidated', 'deleveraged']) assert.ok(trips.some(t => t[flag]), flag);
  assert.ok(trips.some(t => !t.complete), 'a trip opened before the history');
  assert.ok(trips.some(t => t.net > 0n) && trips.some(t => t.net < 0n));
  assert.ok(openTrips.length > 0);
});

test('the performance tally gives the figures of the whole-list computation', () => {
  for (const n of [0, 1, 40, 6000]) {
    const { trips } = roundTrips(tradeHistory(n));
    assert.deepEqual(performance(trips), reference(trips), `${n} events`);
  }
});

test('a history read in pages gives the same trips, figures, notes and heatmap as one read', () => {
  const rows = tradeHistory(6000);
  const whole = roundTrips(rows), perf = performance(whole.trips);
  for (const size of [1, 37, 1000, 6000]) {
    const an = walletAnalyzer({ keepTrips: 200, curveTail: 2000 });
    for (let i = 0; i < rows.length; i += size) an.add(rows.slice(i, i + size));
    const r = an.result();
    assert.deepEqual(r.trips, whole.trips.slice(-200), `pages of ${size}: trips`);
    assert.deepEqual(r.openTrips, whole.openTrips, `pages of ${size}: open trips`);
    assert.deepEqual({ ...r.perf, curve: null }, { ...perf, curve: null }, `pages of ${size}: performance`);
    assert.deepEqual(r.perf.curve, perf.curve.slice(-2000), `pages of ${size}: curve`);
    assert.deepEqual(insights(r.perf, r.events), insights(perf, rows), `pages of ${size}: notes`);
    assert.deepEqual(r.events.grid, activityGrid(rows), `pages of ${size}: heatmap`);
    assert.equal(r.count, rows.length);
    assert.equal(r.firstTs, rows[0].ts);
  }
});

test('counted entry leverage gives the median of the sorted entries, odd and even', () => {
  const rows = tradeHistory(3000);
  for (const n of [5, 6, 7, 400, 401, 3000]) {
    const part = rows.slice(0, n);
    const levs = part.filter(r => (r.kind === 'open' || r.kind === 'increase') && Number(r.leverage) > 0).map(r => Number(r.leverage) / 100).sort((a, b) => a - b);
    assert.equal(eventTally().add(part).medianLeverage(), median(levs), `${n} events`);
  }
  assert.equal(eventTally().add([]).medianLeverage(), null);
});
