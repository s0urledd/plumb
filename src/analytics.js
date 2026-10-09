// Wallet trader analytics from an account's event rows (ev_account order):
// round trips, realized PnL, win rate, profit factor, drawdown, streaks, hold
// time, per-market and per-side results and rule-based behaviour notes.
//
// Perpl keeps one position per account and market, so a round trip is the
// life of that position: it starts when the size leaves zero (open, or the
// new side of an inversion) and ends when it returns to zero (close, the old
// side of an inversion, a full liquidation, deleveraging or unwind). A trip
// already open when the history window starts is marked incomplete and left
// out of hold-time statistics. PnL is realized (delta PnL + funding, including
// the funding settled when a position is increased) net of the fees paid on
// the trip's fills and liquidations.
const B = v => (typeof v === 'bigint' ? v : BigInt(v ?? 0));
const LONG = 0, SHORT = 1;
const USER = new Set(['open', 'increase', 'decrease', 'close', 'invert']);
const REALIZING = new Set(['increase', 'decrease', 'close', 'invert', 'liquidation', 'deleverage']);
const ENDING = new Set(['close', 'invert', 'liquidation', 'deleverage', 'unwind']);

function newTrip(r, side, complete) {
  return { market: Number(r.market), side, openTs: complete ? Number(r.ts) : null, firstTs: Number(r.ts), openBlock: Number(r.block), closeTs: null, closeBlock: null, entryNotional: 0n, exitNotional: 0n, maxLot: 0n, realized: 0n, funding: 0n, fees: 0n, events: 0, complete, liquidated: false, deleveraged: false, maxLeverage: 0 };
}

// The walk over an account's events in chain order: the trip open in each
// market and the running totals, each trip handed to `close` as it ends. Rows
// may come a page at a time; a trip open at the end of a page carries on.
function tripWalker(close) {
  const open = new Map(); // market -> trip
  const totals = { realized: 0n, fees: 0n, funding: 0n, volume: 0n, trades: 0, liquidations: 0 };
  const end = (trip, r) => { trip.closeTs = Number(r.ts); trip.closeBlock = Number(r.block); trip.net = trip.realized - trip.fees; close(trip); };
  function add(rows) {
    for (const r of rows) {
      const kind = r.kind;
      if (!USER.has(kind) && !ENDING.has(kind)) continue;
      const market = Number(r.market), side = Number(r.side);
      const notional = B(r.notional), fee = B(r.fee); // builder share included
      const funding = REALIZING.has(kind) ? B(r.funding) : 0n, realized = REALIZING.has(kind) ? B(r.pnl) + funding : 0n;
      if (USER.has(kind) || (kind === 'liquidation' && r.role === 'taker')) { totals.volume += notional; totals.trades++; }
      if (USER.has(kind) || kind === 'liquidation') totals.fees += fee; // a liquidation's fee whatever its role
      if (kind === 'liquidation') totals.liquidations++;
      totals.realized += realized; totals.funding += funding;

      let trip = open.get(market);
      if (kind === 'open') {
        if (trip) end(trip, r); // defensive: missed close
        trip = newTrip(r, side, true); open.set(market, trip);
      }
      const oldSide = kind === 'invert' ? 1 - side : side;
      if (!trip) { trip = newTrip(r, oldSide, false); open.set(market, trip); }
      // Realize on the current trip (an increase settles the funding accrued so far).
      trip.realized += realized; trip.funding += funding;
      // A flip's event and leverage belong to the new side only.
      if (kind !== 'invert') { trip.events++; if (Number(r.leverage) > trip.maxLeverage) trip.maxLeverage = Number(r.leverage); }
      if (kind === 'open' || kind === 'increase') { trip.entryNotional += notional; trip.fees += fee; if (B(r.end_lot) > trip.maxLot) trip.maxLot = B(r.end_lot); continue; }
      if (kind === 'invert') {
        // The fill closes start_lot and opens end_lot on the other side; its fee
        // is charged for building the new position.
        const lot = B(r.lot), start = B(r.start_lot), endLot = B(r.end_lot);
        const closing = lot > 0n ? notional * start / lot : 0n;
        trip.exitNotional += closing;
        if (!trip.complete && trip.maxLot < start) trip.maxLot = start;
        end(trip, r);
        const next = newTrip(r, side, true);
        next.entryNotional = notional - closing; next.fees = fee; next.maxLot = endLot; next.events = 1; next.maxLeverage = Number(r.leverage);
        open.set(market, next);
        continue;
      }
      trip.fees += fee;
      trip.exitNotional += notional;
      if (!trip.complete && trip.maxLot < B(r.start_lot)) trip.maxLot = B(r.start_lot);
      const ended = kind === 'close' || kind === 'unwind' || B(r.end_lot) === 0n;
      if (kind === 'liquidation' && ended) trip.liquidated = true; // a partial liquidation leaves the trip open
      if (kind === 'deleverage') trip.deleveraged = true;
      if (ended) { end(trip, r); open.delete(market); }
    }
  }
  return { add, totals, openTrips: () => [...open.values()].map(t => ({ ...t, net: t.realized - t.fees })) };
}

export function roundTrips(rows) {
  const trips = [];
  const walk = tripWalker(t => trips.push(t));
  walk.add(rows);
  return { trips, openTrips: walk.openTrips(), totals: walk.totals };
}

const median = sorted => { const n = sorted.length; return n ? (n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2) : null; };

// Performance over closed trips added in close order. Only counts, sums, hold
// times and the last `curveTail` points of the equity curve are kept, so a
// history of a million trips stays small.
export function performanceTally({ curveTail = Infinity } = {}) {
  let n = 0, wins = 0, losses = 0, grossProfit = 0n, grossLoss = 0n, net = 0n, realized = 0n, fees = 0n, largestWin = 0n, largestLoss = 0n;
  // A drawdown from the zero baseline starts at the curve's first point.
  let equity = 0n, peak = 0n, maxDrawdown = 0n, drawdownStart = null, worstFrom = null, worstTo = null;
  let streak = 0, bestStreak = 0, worstStreak = 0, liquidated = 0, deleveraged = 0;
  let curve = [];
  const holds = [], winHolds = [], lossHolds = [];
  const byMarket = new Map();
  const sides = { [LONG]: { trips: 0, wins: 0, net: 0n }, [SHORT]: { trips: 0, wins: 0, net: 0n } };
  function add(t) {
    if (n === 0) drawdownStart = t.closeTs ?? null;
    n++; net += t.net; realized += t.realized; fees += t.fees;
    if (t.net > 0n) { wins++; grossProfit += t.net; if (t.net > largestWin) largestWin = t.net; }
    else if (t.net < 0n) { losses++; grossLoss -= t.net; if (t.net < largestLoss) largestLoss = t.net; }
    equity += t.net;
    if (equity > peak) { peak = equity; drawdownStart = t.closeTs; }
    const dd = peak - equity;
    if (dd > maxDrawdown) { maxDrawdown = dd; worstFrom = drawdownStart; worstTo = t.closeTs; }
    curve.push({ ts: t.closeTs, equity });
    if (curve.length > 2 * curveTail) curve = curve.slice(-curveTail);
    if (t.net > 0n) { streak = streak > 0 ? streak + 1 : 1; bestStreak = Math.max(bestStreak, streak); }
    else if (t.net < 0n) { streak = streak < 0 ? streak - 1 : -1; worstStreak = Math.min(worstStreak, streak); }
    if (t.complete) { const h = t.closeTs - t.openTs; holds.push(h); if (t.net > 0n) winHolds.push(h); else if (t.net < 0n) lossHolds.push(h); }
    const x = byMarket.get(t.market) ?? { market: t.market, trips: 0, wins: 0, net: 0n, realized: 0n, fees: 0n, volume: 0n, longs: 0, shorts: 0 };
    x.trips++; x.net += t.net; x.realized += t.realized; x.fees += t.fees; x.volume += t.entryNotional + t.exitNotional;
    if (t.net > 0n) x.wins++; if (t.side === LONG) x.longs++; else x.shorts++;
    byMarket.set(t.market, x);
    const s = sides[t.side];
    if (s && (t.side === LONG || t.side === SHORT)) { s.trips++; s.net += t.net; if (t.net > 0n) s.wins++; }
    if (t.liquidated) liquidated++;
    if (t.deleveraged) deleveraged++;
  }
  function result() {
    const sorted = list => Float64Array.from(list).sort();
    const markets = [...byMarket.values()].sort((a, b) => (b.net > a.net ? 1 : b.net < a.net ? -1 : 0));
    const side = s => ({ trips: s.trips, wins: s.wins, win_rate: s.trips ? s.wins / s.trips : null, net: s.net });
    return {
      closedTrips: n, wins, losses, breakeven: n - wins - losses,
      winRate: n ? wins / n : null,
      grossProfit, grossLoss, profitFactor: grossLoss > 0n ? Number(grossProfit * 10000n / grossLoss) / 10000 : null,
      net, realized, fees,
      averageWin: wins ? grossProfit / BigInt(wins) : null, averageLoss: losses ? grossLoss / BigInt(losses) : null,
      expectancy: n ? net / BigInt(n) : null,
      largestWin: wins ? largestWin : null, largestLoss: losses ? largestLoss : null,
      maxDrawdown, drawdownFrom: worstFrom, drawdownTo: worstTo, curve: curve.length > curveTail ? curve.slice(-curveTail) : curve,
      bestStreak, worstStreak: -worstStreak, currentStreak: streak,
      averageHold: holds.length ? Math.round(holds.reduce((a, b) => a + b, 0) / holds.length) : null, medianHold: median(sorted(holds)),
      medianWinHold: median(sorted(winHolds)), medianLossHold: median(sorted(lossHolds)),
      long: side(sides[LONG]), short: side(sides[SHORT]),
      liquidatedTrips: liquidated, deleveragedTrips: deleveraged,
      bestMarket: markets[0] ?? null, worstMarket: markets.length > 1 ? markets.at(-1) : null, markets
    };
  }
  return { add, result };
}

export function performance(trips) {
  const tally = performanceTally();
  for (const t of trips.filter(t => t.closeTs !== null).sort((a, b) => a.closeBlock - b.closeBlock)) tally.add(t);
  return tally.result();
}

// Per-event counts for the notes and the heatmap: user trades per UTC weekday
// and hour, and entry leverage counted by value (a long history stays small).
export function eventTally() {
  const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const leverage = new Map(); // leverage x100 -> entries
  let entries = 0;
  const tally = {
    grid,
    add(rows) {
      for (const r of rows) {
        if (USER.has(r.kind)) { const d = new Date(Number(r.ts) * 1000); grid[d.getUTCDay()][d.getUTCHours()]++; }
        if ((r.kind === 'open' || r.kind === 'increase') && Number(r.leverage) > 0) { const l = Number(r.leverage); leverage.set(l, (leverage.get(l) ?? 0) + 1); entries++; }
      }
      return tally;
    },
    entries: () => entries,
    // The median entry leverage (x), as from the sorted list of entries.
    medianLeverage() {
      if (!entries) return null;
      const keys = [...leverage.keys()].sort((a, b) => a - b);
      const at = k => { let seen = 0; for (const key of keys) { seen += leverage.get(key); if (seen > k) return key / 100; } return null; };
      return entries % 2 ? at((entries - 1) / 2) : (at(entries / 2 - 1) + at(entries / 2)) / 2;
    },
    hours: () => grid[0].map((_, h) => grid.reduce((a, day) => a + day[h], 0))
  };
  return tally;
}

// A wallet's history read a page at a time in chain order: the walk carries open
// trips across pages, each closed trip goes into the performance tally, and only
// the latest `keepTrips` are kept whole for the trip list.
export function walletAnalyzer({ keepTrips = 200, curveTail = 2000 } = {}) {
  const tally = performanceTally({ curveTail });
  const recent = [];
  const walk = tripWalker(t => { tally.add(t); recent.push(t); if (recent.length > 2 * keepTrips) recent.splice(0, recent.length - keepTrips); });
  const events = eventTally();
  let count = 0, firstTs = null;
  return {
    add(rows) { if (!rows.length) return; if (firstTs === null) firstTs = Number(rows[0].ts); walk.add(rows); events.add(rows); count += rows.length; },
    result: () => ({ perf: tally.result(), trips: recent.slice(-keepTrips), openTrips: walk.openTrips(), events, count, firstTs, totals: walk.totals })
  };
}

// Rule-based behaviour notes (no model): each states the evidence it rests on.
// `events` is an eventTally, or the event rows themselves.
export function insights(perf, events, { symbol = id => `#${id}` } = {}) {
  const out = [];
  if (!perf.closedTrips) return out;
  const ev = Array.isArray(events) ? eventTally().add(events) : events;
  const pct = x => `${Math.round(x * 100)}%`;
  // One unit per range, so two holds read alike ("1.7m vs 4m", not "103s vs 4m").
  const one = x => (x < 10 ? x.toFixed(1).replace(/.0$/, '') : String(Math.round(x)));
  const dur = s => (s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${one(s / 60)}m` : s < 172800 ? `${one(s / 3600)}h` : `${Math.round(s / 86400)}d`);
  if (perf.long.trips + perf.short.trips >= 5) {
    const share = perf.long.trips / (perf.long.trips + perf.short.trips);
    if (share >= 0.7) out.push({ tag: 'bias', text: `Long bias: ${pct(share)} of round trips are longs.` });
    else if (share <= 0.3) out.push({ tag: 'bias', text: `Short bias: ${pct(1 - share)} of round trips are shorts.` });
    if (perf.long.win_rate !== null && perf.short.win_rate !== null && perf.long.trips >= 5 && perf.short.trips >= 5 && Math.abs(perf.long.win_rate - perf.short.win_rate) >= 0.15)
      out.push({ tag: 'edge', text: `Wins more often ${perf.long.win_rate > perf.short.win_rate ? 'long' : 'short'} (${pct(Math.max(perf.long.win_rate, perf.short.win_rate))} vs ${pct(Math.min(perf.long.win_rate, perf.short.win_rate))}).` });
  }
  if (perf.medianHold !== null) out.push({ tag: 'style', text: perf.medianHold < 900 ? `Scalper: median hold ${dur(perf.medianHold)}.` : perf.medianHold < 6 * 3600 ? `Intraday: median hold ${dur(perf.medianHold)}.` : `Swing: median hold ${dur(perf.medianHold)}.` });
  if (perf.medianWinHold !== null && perf.medianLossHold !== null && perf.losses >= 3 && perf.wins >= 3 && perf.medianLossHold > perf.medianWinHold * 2)
    out.push({ tag: 'discipline', text: `Holds losers longer than winners (median ${dur(perf.medianLossHold)} vs ${dur(perf.medianWinHold)}).` });
  if (perf.averageWin !== null && perf.averageLoss !== null && perf.averageLoss > perf.averageWin * 2n && perf.winRate !== null && perf.winRate > 0.5)
    out.push({ tag: 'risk', text: 'High win rate but average loss is more than twice the average win.' });
  if (perf.profitFactor !== null) out.push({ tag: 'result', text: perf.profitFactor >= 1.5 ? `Profitable: profit factor ${perf.profitFactor.toFixed(2)}.` : perf.profitFactor < 1 ? `Net losing: profit factor ${perf.profitFactor.toFixed(2)}.` : `Around break-even: profit factor ${perf.profitFactor.toFixed(2)}.` });
  if (perf.bestMarket && perf.worstMarket && perf.bestMarket.net > 0n && perf.worstMarket.net < 0n) out.push({ tag: 'markets', text: `Best market ${symbol(perf.bestMarket.market)}, worst ${symbol(perf.worstMarket.market)}.` });
  if (perf.liquidatedTrips) out.push({ tag: 'risk', text: `${perf.liquidatedTrips} of ${perf.closedTrips} round trips ended in liquidation.` });
  if (perf.worstStreak >= 5) out.push({ tag: 'streak', text: `Longest losing streak: ${perf.worstStreak} trips in a row.` });
  if (ev.entries() >= 5) { const med = ev.medianLeverage(); out.push({ tag: 'leverage', text: `Median leverage on entries: ${med.toFixed(1)}x${med >= 20 ? ' (aggressive)' : ''}.` }); }
  const hours = ev.hours(), n = hours.reduce((a, b) => a + b, 0);
  if (n >= 30) { const top = hours.map((c, h) => [h, c]).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([h]) => h).sort((a, b) => a - b); out.push({ tag: 'timing', text: `Most active around ${top.map(h => `${String(h).padStart(2, '0')}:00`).join(', ')} UTC.` }); }
  return out;
}

// Trades per UTC weekday and hour (activity heatmap).
export function activityGrid(rows) {
  return eventTally().add(rows).grid;
}
