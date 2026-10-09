// A long, varied trading history for one account, the same rows on every run:
// opens, adds, partial and full closes, flips, partial and full liquidations,
// deleveraging and unwinds across three markets, several events to a block.
// Market 3 starts with a position opened before the history begins.
export function tradeHistory(n, { seed = 7, start = 1790000000 } = {}) {
  let x = seed;
  const rnd = () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const pos = new Map([[3, { side: 1, lot: 5n }]]);
  const rows = [];
  let block = 1000;
  for (let i = 0; i < n; i++) {
    if (rnd() < 0.6) block++;
    const market = pick(1, 3);
    const p = pos.get(market) ?? { side: 0, lot: 0n };
    const at = { market, role: rnd() < 0.5 ? 'maker' : 'taker', block, log_index: i, ts: start + (block - 1000) * 37, fee: BigInt(pick(0, 4)), builder_fee: 0n, funding: BigInt(pick(-2, 2)), leverage: pick(0, 30) * 50 };
    const ending = (kind, lot, endLot, pnl) => ({ ...at, kind, side: p.side, lot, start_lot: p.lot, end_lot: endLot, notional: lot * BigInt(pick(90, 110)), pnl });
    let r;
    const u = rnd();
    if (p.lot === 0n) {
      const side = pick(0, 1), lot = BigInt(pick(1, 10));
      r = { ...at, kind: 'open', side, lot, start_lot: 0n, end_lot: lot, notional: lot * 100n, pnl: 0n };
      pos.set(market, { side, lot });
    } else if (u < 0.25) {
      const add = BigInt(pick(1, 5));
      r = { ...at, kind: 'increase', side: p.side, lot: add, start_lot: p.lot, end_lot: p.lot + add, notional: add * 100n, pnl: BigInt(pick(-3, 3)) };
      p.lot += add;
    } else if (u < 0.45 && p.lot > 1n) {
      const cut = BigInt(pick(1, Number(p.lot) - 1));
      r = ending('decrease', cut, p.lot - cut, BigInt(pick(-50, 50)));
      p.lot -= cut;
    } else if (u < 0.7) {
      r = ending('close', p.lot, 0n, BigInt(pick(-80, 80)));
      p.lot = 0n;
    } else if (u < 0.82) {
      const fresh = BigInt(pick(1, 8)), side = 1 - p.side, lot = p.lot + fresh;
      r = { ...at, kind: 'invert', side, lot, start_lot: p.lot, end_lot: fresh, notional: lot * 100n, pnl: BigInt(pick(-60, 60)) };
      p.side = side; p.lot = fresh;
    } else if (u < 0.92) {
      const cut = rnd() < 0.5 && p.lot > 1n ? BigInt(pick(1, Number(p.lot) - 1)) : p.lot;
      r = ending('liquidation', cut, p.lot - cut, -BigInt(pick(10, 100)));
      p.lot -= cut;
    } else {
      r = ending(u < 0.97 ? 'deleverage' : 'unwind', p.lot, 0n, BigInt(pick(-40, 40)));
      p.lot = 0n;
    }
    if (!pos.has(market)) pos.set(market, p);
    rows.push(r);
  }
  return rows;
}
