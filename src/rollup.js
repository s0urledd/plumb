// Hourly rollups. An hour is rolled up once every block in it is ingested
// (coverage.hourCovered), by INSERT ... SELECT from the raw events; the
// result replaces any earlier row for that hour, so reruns are harmless.
// Window queries read rolled-up hours from these tables and everything else
// (window edges, the current hour, hours still being backfilled) from raw
// events with the same expressions (aggregates.js).
import { MARKET, PROTOCOL, ACCOUNT, raw, columns, SQL_SETTINGS } from './aggregates.js';
import { ROLLUP_VERSION } from './schema.js';

const HOUR = 3600;
const hourOf = ts => Math.floor(ts / HOUR) * HOUR;

export function rollupStatements() {
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

export function createRollups({ ch, coverage, log = () => {}, maxHoursPerStatement = 24 * 7 }) {
  const done = new Set(); // hour starts rolled up at the current version
  const statements = rollupStatements();
  let running = null, loaded = false;
  const status = { hours: 0, lastRunAt: null, lastRunMs: null, pending: 0, lastError: null };

  async function load() {
    for (const r of await ch.query('SELECT toUnixTimestamp(hour) AS h FROM rollup_hours FINAL WHERE version = {v:UInt32}', { v: ROLLUP_VERSION })) done.add(Number(r.h));
    loaded = true;
    status.hours = done.size;
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
    const params = { from, to };
    await ch.exec(statements.market, params, SQL_SETTINGS);
    await ch.exec(statements.protocol, params, SQL_SETTINGS);
    await ch.exec(statements.account, params, SQL_SETTINGS);
    const hours = [];
    for (let h = from; h < to; h += HOUR) hours.push({ hour: h, version: ROLLUP_VERSION, computed_at: Date.now() });
    await ch.insert('rollup_hours', hours);
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

  return { load, run, pendingRuns, rolledRuns, isRolled: h => done.has(h), status, done };
}
