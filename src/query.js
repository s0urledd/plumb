// Window queries over ClickHouse. Every window is split into hours already
// rolled up (read from agg_* tables) and everything else (read from raw
// events with the same expressions), so results are exact at any window
// edge and never wait for a rollup.
import { MARKET, PROTOCOL, ACCOUNT, USER, ACCOUNT_TRADES, merged, columns, raw, SQL_SETTINGS } from './aggregates.js';

const HOUR = 3600;
const int = v => { const n = Number(v); if (!Number.isSafeInteger(n)) throw new Error('INVALID_INTEGER'); return n; };

// Splits [from, to) (unix seconds) into rolled-up hour runs and raw ranges.
export function segments(from, to, rolledRuns) {
  from = int(from); to = int(to);
  const rolled = to > from ? rolledRuns(from, to) : [];
  const rawRanges = [];
  let cursor = from;
  for (const [a, b] of rolled) { if (a > cursor) rawRanges.push([cursor, a]); cursor = b; }
  if (cursor < to) rawRanges.push([cursor, to]);
  return { rolled, raw: rawRanges };
}
const cond = (col, ranges) => ranges.length ? ranges.map(([a, b]) => `(${col} >= toDateTime(${int(a)}, 'UTC') AND ${col} < toDateTime(${int(b)}, 'UTC'))`).join(' OR ') : '0';

export const BUCKETS = { '1h': 3600, '4h': 14400, '1d': 86400, '1w': 604800 };
export const WINDOWS = { '24h': 86400, '7d': 7 * 86400, '30d': 30 * 86400, '90d': 90 * 86400, all: null };
export const DEFAULT_BUCKET = { '24h': '1h', '7d': '4h', '30d': '1d', '90d': '1d', all: '1w' }; // all-time: weekly, so single spikes do not flatten the rest

// Intersection of two sorted lists of [a, b) ranges.
export function intersect(ranges, allowed) {
  const out = [];
  for (const [a, b] of ranges) for (const [c, d] of allowed) { const lo = Math.max(a, c), hi = Math.min(b, d); if (lo < hi) out.push([lo, hi]); }
  return out;
}

export function createQueries({ ch, rollups, coverage = null }) {
  const q = (sql, params = {}) => ch.query(sql, params, SQL_SETTINGS);
  // Raw ranges only where blocks were ingested: elsewhere there are no rows.
  const split = (from, to) => {
    const s = segments(from, to, rollups.rolledRuns);
    if (coverage) s.raw = intersect(s.raw, coverage.intervals.map(x => [x.fromTs, x.toTs + 1]));
    return s;
  };

  async function marketTotals(from, to, { groupBy = 'market', bucket = null } = {}) {
    const s = split(from, to);
    const key = bucket ? `toStartOfInterval(%T, INTERVAL ${int(bucket)} SECOND) AS t, market` : 'market';
    const parts = [];
    if (s.rolled.length) parts.push(`SELECT ${key.replace('%T', 'hour')}, ${columns(MARKET)} FROM agg_market_hour FINAL WHERE ${cond('hour', s.rolled)}`);
    if (s.raw.length) parts.push(`SELECT ${key.replace('%T', 'ts')}, ${raw(MARKET)} FROM ev WHERE market != 0 AND (${cond('ts', s.raw)}) GROUP BY ${bucket ? 't, market' : 'market'}`);
    if (!parts.length) return [];
    const by = bucket ? 't, market' : groupBy;
    return q(`SELECT ${bucket ? 'toUnixTimestamp(t) AS t, market' : 'market'}, ${merged(MARKET)} FROM (${parts.join(' UNION ALL ')}) GROUP BY ${by} ORDER BY ${by}`);
  }

  async function protocolTotals(from, to, { bucket = null } = {}) {
    const s = split(from, to);
    const key = bucket ? `toStartOfInterval(%T, INTERVAL ${int(bucket)} SECOND) AS t` : null;
    const parts = [];
    if (s.rolled.length) parts.push(`SELECT ${key ? key.replace('%T', 'hour') + ', ' : ''}${columns(PROTOCOL)} FROM agg_hour FINAL WHERE ${cond('hour', s.rolled)}`);
    if (s.raw.length) parts.push(`SELECT ${key ? key.replace('%T', 'ts') + ', ' : ''}${raw(PROTOCOL)} FROM ev WHERE ${cond('ts', s.raw)}${key ? ' GROUP BY t' : ''}`);
    if (!parts.length) return [];
    return q(`SELECT ${key ? 'toUnixTimestamp(t) AS t, ' : ''}${merged(PROTOCOL)} FROM (${parts.join(' UNION ALL ')})${key ? ' GROUP BY t ORDER BY t' : ''}`);
  }

  // Distinct accounts with at least one trade, overall / per market / per bucket.
  async function traders(from, to, { by = null, bucket = null } = {}) {
    const s = split(from, to);
    const key = bucket ? `toStartOfInterval(%T, INTERVAL ${int(bucket)} SECOND) AS t, ` : '';
    const parts = [];
    if (s.rolled.length) parts.push(`SELECT ${key.replace('%T', 'hour')}account, market FROM agg_account_hour FINAL WHERE trades > 0 AND (${cond('hour', s.rolled)})`);
    if (s.raw.length) parts.push(`SELECT ${key.replace('%T', 'ts')}account, market FROM ev_account WHERE ${ACCOUNT_TRADES} AND (${cond('ts', s.raw)})`);
    if (!parts.length) return [];
    const group = [bucket ? 't' : null, by === 'market' ? 'market' : null].filter(Boolean);
    return q(`SELECT ${bucket ? 'toUnixTimestamp(t) AS t, ' : ''}${by === 'market' ? 'market, ' : ''}uniqExact(account) AS traders FROM (${parts.join(' UNION ALL ')})${group.length ? ` GROUP BY ${group.join(', ')} ORDER BY ${group.join(', ')}` : ''}`);
  }

  const SORTS = { pnl: 'realized - fees', realized: 'realized', loss: '-(realized - fees)', volume: 'volume', fees: 'fees', trades: 'trades', liquidated: 'liquidated', deposits: 'deposits', withdrawals: 'withdrawals', net_flow: 'deposits - withdrawals' };
  // Trade sorts rank the accounts that traded in the window, flow sorts the
  // accounts with that flow, whether or not they traded. A rank is 1 + the number of accounts
  // strictly ahead (ties share it), as on wallet pages.
  const TRADED = 'trades > 0', FLOW_FILTER = { deposits: 'deposits > 0', withdrawals: 'withdrawals > 0', net_flow: 'deposits > 0 OR withdrawals > 0' };
  async function accounts(from, to, { sort = 'pnl', limit = 50, offset = 0, market = null, account = null } = {}) {
    if (!Object.hasOwn(SORTS, sort)) throw Object.assign(new Error('INVALID_SORT'), { status: 400 });
    const s = split(from, to);
    const filters = [market !== null ? `market = ${int(market)}` : null, account !== null ? `account = ${int(account)}` : null].filter(Boolean);
    const where = filters.length ? ` AND ${filters.join(' AND ')}` : '';
    const parts = [];
    if (s.rolled.length) parts.push(`SELECT account, market, ${columns(ACCOUNT)} FROM agg_account_hour FINAL WHERE (${cond('hour', s.rolled)})${where}`);
    if (s.raw.length) parts.push(`SELECT account, market, ${raw(ACCOUNT)} FROM ev_account WHERE (${cond('ts', s.raw)})${where} GROUP BY account, market`);
    if (!parts.length) return { total: 0, rows: [] };
    const inner = `SELECT account, ${merged(ACCOUNT)}, groupUniqArrayIf(market, trades > 0 AND market != 0) AS markets FROM (${parts.join(' UNION ALL ')}) GROUP BY account`;
    const rows = await q(`SELECT *, count() OVER () AS total, rank() OVER (ORDER BY ${SORTS[sort]} DESC) AS rank FROM (${inner}) WHERE ${FLOW_FILTER[sort] ?? TRADED} ORDER BY ${SORTS[sort]} DESC, account LIMIT ${int(limit)} OFFSET ${int(offset)}`);
    return { total: rows.length ? Number(rows[0].total) : 0, rows };
  }

  // Net PnL and volume of every account that traded in a window (rank tables:
  // the leaderboard's population and definitions).
  async function accountScores(from, to) {
    const s = split(from, to);
    const parts = [];
    if (s.rolled.length) parts.push(`SELECT account, ${columns(ACCOUNT)} FROM agg_account_hour FINAL WHERE (${cond('hour', s.rolled)})`);
    if (s.raw.length) parts.push(`SELECT account, ${raw(ACCOUNT)} FROM ev_account WHERE (${cond('ts', s.raw)}) GROUP BY account`);
    if (!parts.length) return [];
    return q(`SELECT account, toFloat64(${SORTS.pnl}) AS pnl, toFloat64(${SORTS.volume}) AS volume FROM (SELECT account, ${merged(ACCOUNT)} FROM (${parts.join(' UNION ALL ')}) GROUP BY account) WHERE ${TRADED}`);
  }

  // One account's totals per market over a window (wallet page).
  async function accountMarkets(accountId, from, to) {
    const s = split(from, to);
    const parts = [];
    if (s.rolled.length) parts.push(`SELECT market, ${columns(ACCOUNT)} FROM agg_account_hour FINAL WHERE account = ${int(accountId)} AND (${cond('hour', s.rolled)})`);
    if (s.raw.length) parts.push(`SELECT market, ${raw(ACCOUNT)} FROM ev_account WHERE account = ${int(accountId)} AND (${cond('ts', s.raw)}) GROUP BY market`);
    if (!parts.length) return [];
    return q(`SELECT market, ${merged(ACCOUNT)} FROM (${parts.join(' UNION ALL ')}) GROUP BY market ORDER BY market`);
  }

  // One account's realized PnL, fees, volume and flows per bucket.
  async function accountSeries(accountId, from, to, bucket) {
    const s = split(from, to);
    const parts = [];
    const key = `toStartOfInterval(%T, INTERVAL ${int(bucket)} SECOND) AS t`;
    if (s.rolled.length) parts.push(`SELECT ${key.replace('%T', 'hour')}, ${columns(ACCOUNT)} FROM agg_account_hour FINAL WHERE account = ${int(accountId)} AND (${cond('hour', s.rolled)})`);
    if (s.raw.length) parts.push(`SELECT ${key.replace('%T', 'ts')}, ${raw(ACCOUNT)} FROM ev_account WHERE account = ${int(accountId)} AND (${cond('ts', s.raw)}) GROUP BY t`);
    if (!parts.length) return [];
    return q(`SELECT toUnixTimestamp(t) AS t, ${merged(ACCOUNT)} FROM (${parts.join(' UNION ALL ')}) GROUP BY t ORDER BY t`);
  }

  // Cumulative open-interest lots per market and net collateral flow before ts.
  async function cumulativeBefore(ts) {
    const s = split(0, ts);
    const parts = [], flows = [];
    if (s.rolled.length) {
      parts.push(`SELECT market, oi_long, oi_short FROM agg_market_hour FINAL WHERE ${cond('hour', s.rolled)}`);
      flows.push(`SELECT deposits - withdrawals + protocol_in - protocol_out AS net FROM agg_hour FINAL WHERE ${cond('hour', s.rolled)}`);
    }
    if (s.raw.length) {
      parts.push(`SELECT market, sum(oi_long) AS oi_long, sum(oi_short) AS oi_short FROM ev WHERE market != 0 AND (${cond('ts', s.raw)}) GROUP BY market`);
      flows.push(`SELECT sumIf(amount, kind IN ('deposit','protocol_deposit')) - sumIf(amount, kind IN ('withdrawal','protocol_withdrawal')) AS net FROM ev WHERE kind IN ('deposit','withdrawal','protocol_deposit','protocol_withdrawal') AND (${cond('ts', s.raw)})`);
    }
    if (!parts.length) return { oi: new Map(), net: 0n };
    const [oi, net] = await Promise.all([
      q(`SELECT market, sum(oi_long) AS l, sum(oi_short) AS s FROM (${parts.join(' UNION ALL ')}) GROUP BY market`),
      q(`SELECT sum(net) AS net FROM (${flows.join(' UNION ALL ')})`)
    ]);
    return { oi: new Map(oi.map(r => [Number(r.market), { long: BigInt(r.l), short: BigInt(r.s) }])), net: BigInt(net[0]?.net ?? 0) };
  }

  // Running sums up to and including one block (data-integrity check).
  async function cumulativeAtBlock(block, blockTs) {
    const cut = Math.floor(int(blockTs) / HOUR) * HOUR;
    const s = split(0, cut);
    const b = BigInt(block).toString();
    const oi = [], flows = [];
    if (s.rolled.length) {
      oi.push(`SELECT market, oi_long, oi_short FROM agg_market_hour FINAL WHERE ${cond('hour', s.rolled)}`);
      flows.push(`SELECT deposits - withdrawals + protocol_in - protocol_out AS net FROM agg_hour FINAL WHERE ${cond('hour', s.rolled)}`);
    }
    const rawCond = `(${cond('ts', s.raw)} OR ts >= toDateTime(${cut}, 'UTC')) AND block <= ${b}`;
    oi.push(`SELECT market, sum(oi_long) AS oi_long, sum(oi_short) AS oi_short FROM ev WHERE market != 0 AND ${rawCond} GROUP BY market`);
    flows.push(`SELECT sumIf(amount, kind IN ('deposit','protocol_deposit')) - sumIf(amount, kind IN ('withdrawal','protocol_withdrawal')) AS net FROM ev WHERE kind IN ('deposit','withdrawal','protocol_deposit','protocol_withdrawal') AND ${rawCond}`);
    const [o, n] = await Promise.all([
      q(`SELECT market, sum(oi_long) AS l, sum(oi_short) AS s FROM (${oi.join(' UNION ALL ')}) GROUP BY market`),
      q(`SELECT sum(net) AS net FROM (${flows.join(' UNION ALL ')})`)
    ]);
    return { oi: new Map(o.map(r => [Number(r.market), { long: BigInt(r.l), short: BigInt(r.s) }])), net: BigInt(n[0]?.net ?? 0) };
  }

  // Last trade price per market strictly before ts: closed hours from the
  // rollups, the rest from raw fills.
  async function lastPricesBefore(ts) {
    const s = split(0, ts);
    const parts = [`SELECT market, argMax(close_price, close_key) AS price, max(close_key) AS k FROM agg_market_hour FINAL WHERE fills > 0 AND hour < toDateTime(${int(ts)}, 'UTC') GROUP BY market`];
    if (s.raw.length) parts.push(`SELECT market, argMax(price, (block, log_index)) AS price, max(block * 4294967296 + log_index) AS k FROM ev WHERE kind = 'maker_fill' AND (${cond('ts', s.raw)}) GROUP BY market`);
    const rows = await q(`SELECT market, argMax(price, k) AS price FROM (${parts.join(' UNION ALL ')}) GROUP BY market`);
    return new Map(rows.map(r => [Number(r.market), BigInt(r.price)]));
  }

  const EV_COLUMNS = 'block, log_index, tx_index, toUnixTimestamp(ts) AS ts, tx, kind, market, account, side, role, buy, price, lot, start_lot, end_lot, notional, fee, builder_fee, ins_fee, prot_fee, pnl, funding, deposit, amount, balance, leverage, mark, flags';

  // An account's trading events in chain order (newest `limit` when capped),
  // with only the columns round-trip analytics need, as compact rows.
  const LEAN = ['block', 'log_index', 'ts', 'kind', 'market', 'side', 'role', 'lot', 'start_lot', 'end_lot', 'notional', 'fee', 'builder_fee', 'pnl', 'funding', 'leverage'];
  async function accountEvents(accountId, { limit = 150000 } = {}) {
    const rows = await ch.queryCompact(`SELECT block, log_index, toUnixTimestamp(ts), kind, market, side, role, lot, start_lot, end_lot, notional, fee, builder_fee, pnl, funding, leverage FROM ev_account WHERE account = {a:UInt32} AND kind IN ('open','increase','decrease','close','invert','liquidation','deleverage','unwind') ORDER BY block DESC, log_index DESC LIMIT ${int(limit)}`, { a: accountId }, SQL_SETTINGS);
    const out = new Array(rows.length);
    for (let i = rows.length - 1, j = 0; i >= 0; i--, j++) { const r = rows[i], o = {}; for (let k = 0; k < LEAN.length; k++) o[LEAN[k]] = r[k]; out[j] = o; }
    return out;
  }
  async function accountEventCount(accountId) { return Number((await ch.first("SELECT count() AS n FROM ev_account WHERE account = {a:UInt32} AND kind IN ('open','increase','decrease','close','invert','liquidation','deleverage','unwind')", { a: accountId })).n); }
  // Time of an account's first trade (null before any).
  async function accountFirstTrade(accountId) {
    const r = await ch.first(`SELECT toUnixTimestamp(ts) AS ts FROM ev_account WHERE account = {a:UInt32} AND ${ACCOUNT_TRADES} ORDER BY block, log_index LIMIT 1`, { a: accountId }, SQL_SETTINGS);
    return r ? Number(r.ts) : null;
  }

  // Newest-first page of an account's trades (cursor = "block:log_index").
  async function accountTrades(accountId, { before = null, limit = 100, market = null } = {}) {
    const [b, l] = before ? before.split(':').map(int) : [null, null];
    const cursor = before ? ` AND (block, log_index) < (${b}, ${l})` : '';
    const m = market !== null ? ` AND market = ${int(market)}` : '';
    return q(`SELECT ${EV_COLUMNS} FROM ev_account WHERE account = {a:UInt32} AND (kind IN ${USER} OR kind IN ('liquidation','deleverage','unwind'))${m}${cursor} ORDER BY block DESC, log_index DESC LIMIT ${int(limit)}`, { a: accountId });
  }
  async function accountFlows(accountId, { limit = 200 } = {}) {
    return q(`SELECT ${EV_COLUMNS} FROM ev_account WHERE account = {a:UInt32} AND kind IN ('deposit','withdrawal') ORDER BY block DESC, log_index DESC LIMIT ${int(limit)}`, { a: accountId });
  }

  // Latest rows of given kinds across the exchange (feeds).
  // order 'size': largest notional first (the biggest liquidation in a window).
  const recentWhere = (kinds, market, sinceTs) => {
    const k = kinds.map(x => `'${x.replace(/[^a-z_]/g, '')}'`).join(',');
    const m = market !== null ? ` AND market = ${int(market)}` : '';
    const since = sinceTs !== null ? ` AND ts >= toDateTime(${int(sinceTs)}, 'UTC')` : '';
    return `kind IN (${k})${m}${since}`;
  };
  async function recent(kinds, { limit = 100, offset = 0, market = null, sinceTs = null, order = 'recent' } = {}) {
    return q(`SELECT ${EV_COLUMNS} FROM ev WHERE ${recentWhere(kinds, market, sinceTs)} ORDER BY ${order === 'size' ? 'notional DESC, block DESC' : 'block DESC, log_index DESC'} LIMIT ${int(limit)}${offset ? ` OFFSET ${int(offset)}` : ''}`);
  }
  // Latest position changes of a set of accounts (the account-ordered copy of
  // the events reads only their rows).
  async function movesOf(accounts, { sinceTs, limit = 50 } = {}) {
    if (!accounts.length) return [];
    return q(`SELECT ${EV_COLUMNS} FROM ev_account WHERE account IN (${accounts.map(int).join(',')}) AND kind IN ('open', 'increase', 'decrease', 'close', 'invert', 'liquidation', 'deleverage') AND ts >= toDateTime(${int(sinceTs)}, 'UTC') ORDER BY block DESC, log_index DESC LIMIT ${int(limit)}`);
  }
  // Open interest opened and closed, per side and bucket, in collateral units.
  // Each position event carries its signed effect on long and short open
  // interest (lots); the fill's notional per lot prices it.
  async function positionFlow(market, from, to, bucket) {
    const px = 'notional / lot';
    return q(`SELECT toUnixTimestamp(toStartOfInterval(ts, INTERVAL ${int(bucket)} SECOND)) AS t,
      sumIf(oi_long * ${px}, oi_long > 0) AS long_open, sumIf(-oi_long * ${px}, oi_long < 0) AS long_close,
      sumIf(oi_short * ${px}, oi_short > 0) AS short_open, sumIf(-oi_short * ${px}, oi_short < 0) AS short_close,
      countIf(oi_long > 0 OR oi_short > 0) AS opens, countIf(oi_long < 0 OR oi_short < 0) AS closes
      FROM ev WHERE market = ${int(market)} AND ts >= toDateTime(${int(from)}, 'UTC') AND ts < toDateTime(${int(to)}, 'UTC') AND lot > 0 AND (oi_long != 0 OR oi_short != 0)
      GROUP BY t ORDER BY t`);
  }
  async function recentCount(kinds, { market = null, sinceTs = null } = {}) {
    return Number((await q(`SELECT count() AS n FROM ev WHERE ${recentWhere(kinds, market, sinceTs)}`))[0]?.n ?? 0);
  }

  async function fundingHistory(market, { limit = 500 } = {}) {
    return q(`SELECT market, funding_block, block, toUnixTimestamp(ts) AS ts, tx, specified_rate, actual_rate, price, payment, sum FROM funding FINAL WHERE market = {m:UInt16} ORDER BY funding_block DESC LIMIT ${int(limit)}`, { m: market });
  }
  // Mean rate per bucket and market, and the mean spacing in seconds between
  // each of those events and the market's previous one (looked up to a day
  // before `from`; null when there is none).
  async function fundingSeries(from, to, bucket) {
    const prev = 'lagInFrame(toInt64(toUnixTimestamp(ts)), 1, 0) OVER w AS prev_ts, lagInFrame(funding_block, 1, 0) OVER w AS prev_block';
    const events = `SELECT market, ts, funding_block, actual_rate, ${prev} FROM funding FINAL WHERE ts >= toDateTime(${Math.max(0, int(from) - 86400)}, 'UTC') AND ts < toDateTime(${int(to)}, 'UTC') WINDOW w AS (PARTITION BY market ORDER BY funding_block, block, log_index ROWS BETWEEN 1 PRECEDING AND CURRENT ROW)`;
    return q(`SELECT toUnixTimestamp(toStartOfInterval(ts, INTERVAL ${int(bucket)} SECOND)) AS t, market, avg(actual_rate) AS rate, count() AS events, avgIf(toInt64(toUnixTimestamp(ts)) - prev_ts, prev_block > 0 AND funding_block > prev_block) AS spacing FROM (${events}) WHERE ts >= toDateTime(${int(from)}, 'UTC') GROUP BY t, market ORDER BY t, market`);
  }

  async function findAccounts(text, { limit = 10 } = {}) {
    const t = String(text).trim().toLowerCase();
    if (/^0x[0-9a-f]{40}$/.test(t)) return q('SELECT account, address, toUnixTimestamp(ts) AS ts FROM accounts FINAL WHERE address = {a:String} LIMIT 5', { a: t });
    if (/^0x[0-9a-f]{3,39}$/.test(t)) return q(`SELECT account, address, toUnixTimestamp(ts) AS ts FROM accounts FINAL WHERE startsWith(address, {a:String}) ORDER BY account LIMIT ${int(limit)}`, { a: t });
    if (/^\d{1,9}$/.test(t)) return q('SELECT account, address, toUnixTimestamp(ts) AS ts FROM accounts FINAL WHERE account = {a:UInt32}', { a: Number(t) });
    return [];
  }
  async function addresses(ids) {
    if (!ids.length) return new Map();
    const rows = await q(`SELECT account, address, toUnixTimestamp(ts) AS ts FROM accounts FINAL WHERE account IN (${ids.map(int).join(',')})`);
    return new Map(rows.map(r => [Number(r.account), { address: r.address, created: Number(r.ts) }]));
  }

  return { marketTotals, protocolTotals, traders, accounts, accountScores, accountMarkets, accountSeries, cumulativeBefore, cumulativeAtBlock, lastPricesBefore, accountEvents, accountEventCount, accountFirstTrade, accountTrades, accountFlows, recent, recentCount, movesOf, positionFlow, fundingHistory, fundingSeries, findAccounts, addresses, split };
}
