// Hourly rollups. An hour is rolled up once every block in it is ingested
// (coverage.hourCovered), by INSERT ... SELECT from the raw events; the
// result replaces any earlier row for that hour, so reruns are harmless.
// Window queries read rolled-up hours from these tables and everything else
// (window edges, the current hour, hours still being backfilled) from raw
// events with the same expressions (aggregates.js).
import { marketDefs, PROTOCOL, ACCOUNT, raw, columns, SQL_SETTINGS } from './aggregates.js';
import { ROLLUP_VERSION } from './schema.js';

const HOUR = 3600, DAY = 86400;
const hourOf = ts => Math.floor(ts / HOUR) * HOUR;

// Version 3 only added the reducing-fee split and the liquidation shares
// (columns that read 0 on rows rolled before). A UTC day rolled at version 2
// with no charged decrease or close and no liquidation has the same figures
// at version 3, so its hours are carried over as they are; every other day
// is rolled again from the stored events. Whole days, not hours: scattered
// single hours left to roll would each become a raw range in every window
// query (one OR term each) until rolled. Only a bump from 2 to 3 carries;
// rerunning it carries nothing twice.
export const CARRY = { from: 2, to: 3, touched: "SELECT DISTINCT toUnixTimestamp(toStartOfDay(ts)) AS d FROM ev WHERE kind = 'liquidation' OR (kind IN ('decrease','close') AND fee != 0)" };

// Marks every hour rolled at the current version from `fromTs` on to be
// rolled again, in the database, whether or not a rollups object has loaded
// it. Ingest runs it before it stores a rate change, so a crash between the
// two cannot leave hours rolled with the old rates marked done.
export const markStale = (ch, fromTs) => ch.exec(`INSERT INTO rollup_hours (hour, version, computed_at)
  SELECT hour, 0, fromUnixTimestamp64Milli({at:Int64}, 'UTC') FROM rollup_hours FINAL WHERE version = {v:UInt32} AND toUnixTimestamp(hour) + 3600 > {from:UInt32}`, { at: Date.now(), v: ROLLUP_VERSION, from: fromTs });

// `rates`: the revenue split rates in force, as SQL (revenue.js sql()).
export function rollupStatements(rates) {
  const MARKET = marketDefs(rates);
  return {
    market: `INSERT INTO agg_market_hour (hour, market, ${columns(MARKET)}, traders, computed_at)
      SELECT toStartOfHour(ts) AS hour, market, ${raw(MARKET)}, uniqExactIf(account, kind IN ('open','increase','decrease','close','invert')) AS traders, now64(3)
      FROM ev WHERE ts >= toDateTime({from:UInt32}, 'UTC') AND ts < toDateTime({to:UInt32}, 'UTC') AND market != 0
      GROUP BY hour, market`,
    protocol: `INSERT INTO agg_hour (hour, ${columns(PROTOCOL)}, traders, depositors, computed_at)
      SELECT toStartOfHour(ts) AS hour, ${raw(PROTOCOL)},
        uniqExactIf(account, kind IN ('open','increase','decrease','close','invert')) AS traders,
        uniqExactIf(account, kind IN ('deposit','withdrawal')) AS depositors, now64(3)
      FROM ev WHERE ts >= toDateTime({from:UInt32}, 'UTC') AND ts < toDateTime({to:UInt32}, 'UTC')
      GROUP BY hour`,
    account: `INSERT INTO agg_account_hour (hour, account, market, ${columns(ACCOUNT)}, computed_at)
      SELECT toStartOfHour(ts) AS hour, account, market, ${raw(ACCOUNT)}, now64(3)
      FROM ev WHERE ts >= toDateTime({from:UInt32}, 'UTC') AND ts < toDateTime({to:UInt32}, 'UTC') AND account != 0 AND kind NOT IN ('maker_fill', 'taker_fill')
      GROUP BY hour, account, market`
  };
}

// `rates`: the revenue parameter history (revenue.js createRevenueParams);
// without it the split uses the default rates.
export function createRollups({ ch, coverage, rates = null, log = () => {}, maxHoursPerStatement = 24 * 7 }) {
  const done = new Set(); // hour starts rolled up at the current version
  let running = null, loaded = false, generation = 0;
  const status = { hours: 0, lastRunAt: null, lastRunMs: null, pending: 0, lastError: null, carried: null };

  async function carryOver() {
    if (ROLLUP_VERSION !== CARRY.to) return 0; // a later version rolls everything again unless it says otherwise
    const old = (await ch.query('SELECT toUnixTimestamp(hour) AS h FROM rollup_hours FINAL WHERE version = {v:UInt32}', { v: CARRY.from })).map(r => Number(r.h));
    if (!old.length) return 0;
    const touched = new Set((await ch.query(CARRY.touched)).map(r => Number(r.d)));
    const keep = old.filter(h => !touched.has(h - h % DAY));
    await ch.insert('rollup_hours', keep.map(h => ({ hour: h, version: ROLLUP_VERSION, computed_at: Date.now() })));
    log('info', `rollup version ${ROLLUP_VERSION}: ${keep.length} hours carried over, ${old.length - keep.length} to roll again`);
    return keep.length;
  }

  async function load() {
    // A failed carry-over only means more hours are rolled again.
    status.carried = await carryOver().catch(error => { log('warn', `rollup carry-over skipped: ${error.message}`); return null; });
    for (const r of await ch.query('SELECT toUnixTimestamp(hour) AS h FROM rollup_hours FINAL WHERE version = {v:UInt32}', { v: ROLLUP_VERSION })) done.add(Number(r.h));
    loaded = true;
    status.hours = done.size;
  }

  // Hours from `fromTs` on are rolled again: a fee or liquidation parameter
  // change indexed after them (the backfill runs newest first) changes their
  // split. In memory only: ingest has marked them in the database first
  // (markStale). A run in flight when this happens does not mark its hours.
  function invalidate(fromTs) {
    generation++;
    const hours = [...done].filter(h => h + HOUR > fromTs);
    for (const h of hours) done.delete(h);
    status.hours = done.size;
    if (hours.length) log('info', `${hours.length} rolled-up hours to roll again after a parameter change`);
    return hours.length;
  }

  // Fully covered, closed, not yet rolled-up hours, as contiguous runs.
  function pendingRuns(nowTs = Math.floor(Date.now() / 1000)) {
    const runs = [];
    const current = hourOf(nowTs);
    for (const x of coverage.intervals) {
      for (let h = hourOf(x.fromTs); h < current && h + HOUR <= x.toTs + 1; h += HOUR) {
        if (done.has(h) || !coverage.hourCovered(h)) continue;
        const last = runs.at(-1);
        if (last && last.to === h && (last.to - last.from) / HOUR < maxHoursPerStatement) last.to = h + HOUR;
        else runs.push({ from: h, to: h + HOUR });
      }
    }
    status.pending = runs.reduce((a, r) => a + (r.to - r.from) / HOUR, 0);
    return runs;
  }

  async function rollRun({ from, to }) {
    const params = { from, to }, gen = generation;
    const statements = rollupStatements(rates?.sql());
    await ch.exec(statements.market, params, SQL_SETTINGS);
    await ch.exec(statements.protocol, params, SQL_SETTINGS);
    await ch.exec(statements.account, params, SQL_SETTINGS);
    if (gen !== generation) return; // rates changed meanwhile: the next run redoes these hours
    const hours = [];
    for (let h = from; h < to; h += HOUR) hours.push({ hour: h, version: ROLLUP_VERSION, computed_at: Date.now() });
    await ch.insert('rollup_hours', hours);
    // Rates changed while they were being marked: marked stale again (a later
    // stamp wins), as markStale may have run before this insert landed.
    if (gen !== generation) return ch.insert('rollup_hours', hours.map(h => ({ ...h, version: 0, computed_at: Date.now() })));
    for (const h of hours) done.add(h.hour);
    status.hours = done.size;
  }

  // A run that times out (a busy week) is retried as two halves, down to one
  // hour. Rows written by an attempt the client gave up on collapse on merge.
  async function rollRange(r) {
    try { await rollRun(r); }
    catch (error) {
      if (!/timeout/i.test(error.message) || r.to - r.from <= HOUR) throw error;
      const mid = r.from + Math.floor((r.to - r.from) / HOUR / 2) * HOUR;
      await rollRange({ from: r.from, to: mid });
      await rollRange({ from: mid, to: r.to });
    }
  }

  // One run at a time. The guard is cleared once the run has settled, never
  // inside it: a run with nothing to do finishes before `running` is assigned,
  // and clearing it there left a settled promise in place that blocked every later run.
  async function run(nowTs) {
    if (running) return running;
    const job = (async () => {
      const started = Date.now();
      try {
        if (!loaded) await load();
        const runs = pendingRuns(nowTs);
        for (const r of runs) await rollRange(r);
        status.lastRunAt = Date.now(); status.lastRunMs = Date.now() - started; status.lastError = null;
        if (runs.length) log('info', `rolled up ${runs.reduce((a, r) => a + (r.to - r.from) / HOUR, 0)} hours in ${Date.now() - started} ms`);
        return runs.length;
      } catch (error) {
        status.lastError = { message: error.message, at: Date.now() };
        log('warn', `rollup failed: ${error.message}`);
        return 0;
      }
    })();
    running = job.finally(() => { running = null; });
    return running;
  }

  // Rolled-up hours inside [from, to) as sorted runs of [start, end).
  function rolledRuns(from, to) {
    const out = [];
    for (let h = Math.ceil(from / HOUR) * HOUR; h + HOUR <= to; h += HOUR) {
      if (!done.has(h)) continue;
      const last = out.at(-1);
      if (last && last[1] === h) last[1] = h + HOUR; else out.push([h, h + HOUR]);
    }
    return out;
  }

  return { load, run, invalidate, pendingRuns, rolledRuns, isRolled: h => done.has(h), status, done };
}
