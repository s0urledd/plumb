// Event ingestion into ClickHouse.
//
// One writer path: eth_getLogs over FINALIZED blocks only, so nothing written
// is ever rolled back. The live loop follows the node's finalized head (woken
// early by the execution-events sidecar or a WebSocket head subscription when
// available) and a backfill fills every uncovered range from the exchange's
// deployment block, newest first, from the local node while it still has the
// history and from archive endpoints before that.
//
// Exactly-once: a range is recorded in `chunks` only after its rows are
// inserted and ranges handed to workers never overlap. When a commit fails
// part-way, the rows of exactly those ranges are deleted before they are
// retried; on start any row outside recorded coverage (a crash between the
// two inserts) is deleted the same way. Rows are keyed by (block, log_index)
// in a ReplacingMergeTree, so even an insert that completed after its
// client gave up collapses on merge.
//
// Topics added after history was indexed (decode.js TOPIC_SET) have their
// own coverage (`topic_chunks`): every range the ingest reads counts for them
// too, and a topic backfill reads them alone over the ranges indexed before
// (see below).
import { createReader } from './exchange.js';
import { rowsFromLogs, ingestTopics, TOPIC_SET, topicSetTopics, TRANSFER_KINDS } from './decode.js';
import { createCoverage } from './coverage.js';
import { normalizeMarket } from './state.js';
import { createRevenueParams, REVENUE_PARAM_EVENTS } from './revenue.js';
import { markStale } from './rollup.js';
import * as m from './math.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const integer = (value, fallback) => { const n = Number(value ?? fallback); if (!Number.isFinite(n) || n < 0) throw new Error('INVALID_INGEST_OPTION'); return n; };
const min = (a, b) => (a < b ? a : b), max = (a, b) => (a > b ? a : b);

export function ingestOptions(env = {}) {
  return {
    liveRange: BigInt(integer(env.LIVE_LOG_RANGE, 1000)),
    livePollMs: integer(env.LIVE_POLL_MS, 400),
    liveMinCommitMs: integer(env.LIVE_COMMIT_MS, 1000),
    liveHorizon: BigInt(integer(env.LIVE_HISTORY_BLOCKS, 600000)), // how far back the local node serves logs
    liveMaxStep: BigInt(integer(env.LIVE_MAX_STEP_BLOCKS, 20000)),
    liveConcurrency: Math.max(1, integer(env.LIVE_BACKFILL_CONCURRENCY, 4)),
    archiveRange: BigInt(integer(env.ARCHIVE_LOG_RANGE, 1000)),
    archiveConcurrency: Math.max(1, integer(env.ARCHIVE_CONCURRENCY, 4)),
    batchRows: integer(env.INGEST_BATCH_ROWS, 150000),
    batchMs: integer(env.INGEST_BATCH_MS, 3000),
    backfill: env.BACKFILL !== '0',
    backfillFrom: env.BACKFILL_FROM_BLOCK ? BigInt(integer(env.BACKFILL_FROM_BLOCK, 0)) : null, // partial history (development)
    retries: integer(env.INGEST_RETRIES, 6),
    topicBackfill: env.TOPIC_BACKFILL !== '0',
    topicArchiveRps: integer(env.TOPIC_BACKFILL_RPS, 4) // eth_getLogs per second to each archive (0: unpaced)
  };
}

const digits = v => { const s = BigInt(v).toString(); if (!/^\d+$/.test(s)) throw new Error('INVALID_BLOCK'); return s; };

export function createIngest({ ch, config, liveRpc, archiveRpcs = [], options = ingestOptions(), log = () => {} }) {
  const floor = config.deployBlock;
  const coverage = createCoverage({ floor });
  const live = { name: 'node', reader: createReader({ rpc: liveRpc, exchange: config.exchange }), range: options.liveRange, concurrency: options.liveConcurrency };
  const archives = archiveRpcs.map((rpc, i) => ({ name: `archive${i + 1}`, reader: createReader({ rpc, exchange: config.exchange }), range: options.archiveRange, concurrency: options.archiveConcurrency }));
  const topicCoverage = createCoverage({ floor }); // ranges read with the added topics (block numbers only)
  // The topic backfill paces its own requests to each archive (public endpoints are rate-limited).
  const topicSources = { live: { ...live, gap: 0, nextAt: 0, pausedUntil: 0 }, archives: archives.map(a => ({ ...a, gap: options.topicArchiveRps > 0 ? 1000 / options.topicArchiveRps : 0, nextAt: 0, pausedUntil: 0 })) };
  const markets = new Map(); // id -> { symbol, name, priceDecimals, lotDecimals }
  const revenueParams = createRevenueParams(); // fee and liquidation rates over time (revenue split)
  let staleSince = null; // a rate change whose rolled hours are not yet marked stale in the database
  const listeners = new Set();
  let collateralDecimals = 6;
  let running = false, stopRequested = false, wake = null;
  const status = {
    live: { from: null, to: null, toTs: null, finalized: null, finalizedTs: null, commits: 0, rows: 0, lastCommitAt: null, lastError: null, errors: 0, trigger: 'poll' },
    backfill: { running: false, targetFrom: floor, targetTo: null, totalBlocks: 0n, doneBlocks: 0n, startedAt: null, finishedAt: null, chunks: 0, rows: 0, failed: [], rate: null, lastError: null },
    topics: { running: false, startedAt: null, finishedAt: null, chunks: 0, rows: 0, skipped: 0, requests: 0, failed: [], rate: null, lastError: null },
    repaired: 0,
    // Decoder consistency counters over everything ingested since start.
    checks: { logs: 0, userEvents: 0, linked: 0, unlinked: 0, lotMismatch: 0, feeChecked: 0, feeMismatch: 0, forcedLinked: 0, forcedLotMismatch: 0, takerFillsUnlinked: 0 }
  };

  const emit = event => { for (const fn of listeners) { try { fn(event); } catch (error) { log('warn', `ingest listener failed: ${error.message}`); } } };
  const unitsOf = id => { const x = markets.get(id); return x ? m.units(x.priceDecimals, x.lotDecimals, collateralDecimals) : null; };

  // --- start-up ------------------------------------------------------------
  async function loadMarkets() {
    for (const r of await ch.query('SELECT market, symbol, name, price_decimals, lot_decimals FROM markets FINAL')) markets.set(Number(r.market), { symbol: r.symbol, name: r.name, priceDecimals: Number(r.price_decimals), lotDecimals: Number(r.lot_decimals) });
  }
  async function refreshMarketsFromContract(reader, block) {
    const ids = await reader.readMarketIds(block);
    const reads = (await reader.readMarkets(ids, block)).map(normalizeMarket);
    const head = await reader.getBlock(block);
    const rows = reads.filter(x => x.priceDecimals || x.lotDecimals || x.symbol).map(x => ({ market: x.id, name: x.name, symbol: x.symbol, price_decimals: x.priceDecimals, lot_decimals: x.lotDecimals, base_price: x.basePricePNS, max_oi: x.oiMaxLNS, init_margin_hdths: Number(x.initHdths), maint_margin_hdths: Number(x.maintHdths), block: Number(head.number), ts: head.timestamp, source: 'contract' }));
    await ch.insert('markets', rows);
    for (const r of rows) markets.set(r.market, { symbol: r.symbol, name: r.name, priceDecimals: r.price_decimals, lotDecimals: r.lot_decimals });
    return rows.length;
  }
  async function loadRevenueParams() {
    revenueParams.add(await ch.query(`SELECT block, log_index, toUnixTimestamp(ts) AS ts, name, market, args FROM params FINAL WHERE name IN (${REVENUE_PARAM_EVENTS.map(x => `'${x}'`).join(', ')})`));
  }
  async function loadCoverage() {
    for (const r of await ch.query('SELECT from_block, to_block, toUnixTimestamp(from_ts) AS from_ts, toUnixTimestamp(to_ts) AS to_ts FROM chunks FINAL ORDER BY from_block')) coverage.add(BigInt(r.from_block), BigInt(r.to_block), Number(r.from_ts), Number(r.to_ts));
    for (const r of await ch.query('SELECT from_block, to_block FROM topic_chunks FINAL WHERE topics = {t:String} ORDER BY from_block', { t: TOPIC_SET.name })) topicCoverage.add(BigInt(r.from_block), BigInt(r.to_block), 0, 0);
  }
  // Rows outside recorded coverage can only come from an interrupted commit.
  async function repair() {
    const inside = coverage.intervals.map(x => `(block BETWEEN ${digits(x.from)} AND ${digits(x.to)})`).join(' OR ') || '0';
    const outside = Number((await ch.first(`SELECT count() AS n FROM ev WHERE NOT (${inside})`)).n);
    if (!outside) return 0;
    log('warn', `removing ${outside} rows outside recorded coverage (interrupted commit)`);
    await ch.exec(`DELETE FROM ev WHERE NOT (${inside})`);
    await ch.exec(`DELETE FROM ev_account WHERE NOT (${inside})`);
    status.repaired = outside;
    return outside;
  }

  // Deletes rows of ranges whose commit failed part-way (never covered ranges).
  const dirty = [];
  async function clearRanges(ranges) {
    for (const r of ranges) if (coverage.gaps(r.from, r.to).length === 0) throw new Error('CLEAR_COVERED_RANGE');
    const cond = ranges.map(r => `(block BETWEEN ${digits(r.from)} AND ${digits(r.to)})`).join(' OR ');
    if (!cond) return;
    await ch.exec(`DELETE FROM ev WHERE ${cond}`);
    await ch.exec(`DELETE FROM ev_account WHERE ${cond}`);
  }
  async function clearDirty() {
    while (dirty.length) { await clearRanges(dirty.slice(0, 50)); dirty.splice(0, 50); }
  }
  // True when every coverage row of a commit is stored (a request can fail
  // on the client after the server applied it).
  async function chunksStored(chunkRows) {
    const froms = chunkRows.map(r => digits(r.from_block));
    const stored = new Map((await ch.query(`SELECT from_block, max(to_block) AS to_block FROM chunks WHERE from_block IN (${froms.join(',')}) GROUP BY from_block`)).map(r => [r.from_block, BigInt(r.to_block)]));
    return chunkRows.every(r => (stored.get(digits(r.from_block)) ?? -1n) >= BigInt(r.to_block));
  }
  async function guardedCommit(results, opts) {
    await clearDirty();
    try { return await commit(results, opts); }
    catch (error) {
      if (await chunksStored(opts.chunkRows).catch(() => false)) {
        log('warn', `commit reported ${error.message} but its coverage is stored; keeping it`);
        return gather(results);
      }
      dirty.push(...results.map(r => ({ from: r.from, to: r.to })));
      await clearDirty().catch(e => log('warn', `range cleanup deferred: ${e.message}`));
      throw error;
    }
  }

  async function init() {
    await loadMarkets();
    await loadRevenueParams();
    await loadCoverage();
    await repair();
    const fin = await live.reader.getBlock('finalized');
    try { collateralDecimals = Number((await live.reader.readExchange(fin.number)).collateralDecimals ?? 6); } catch (error) { log('warn', `collateral decimals unavailable, using 6: ${error.message}`); }
    await refreshMarketsFromContract(live.reader, fin.number);
    status.live.finalized = fin.number; status.live.finalizedTs = fin.timestamp;
    log('info', `ingest ready: ${coverage.size} coverage intervals, top ${coverage.top() ?? 'none'}, finalized ${fin.number}, ${markets.size} markets`);
    return fin;
  }

  // --- one range -----------------------------------------------------------
  async function fetchLogs(source, from, to, topics = ingestTopics) {
    if (source.gap !== undefined) await pace(source);
    try { return await source.reader.getLogs({ fromBlock: from, toBlock: to, topics }); }
    catch (error) {
      if (error.kind === 'limit' && to > from) {
        const mid = from + (to - from) / 2n;
        return [...await fetchLogs(source, from, mid, topics), ...await fetchLogs(source, mid + 1n, to, topics)];
      }
      throw error;
    }
  }
  // Providers without blockTimestamp on logs: take it from the headers.
  async function stampTimes(source, logs) {
    const missing = [...new Set(logs.filter(l => l.blockTimestamp === undefined).map(l => l.blockNumber))];
    if (!missing.length) return;
    const stamps = new Map();
    for (const number of missing) stamps.set(number, (await source.reader.getBlock(BigInt(number))).timestamp);
    for (const l of logs) if (l.blockTimestamp === undefined) l.blockTimestamp = stamps.get(l.blockNumber);
  }

  // Logs, end-block timestamps and decoded rows for [from, to].
  async function readRange(source, from, to, { toBlock = null } = {}) {
    const [logs, first, last] = await Promise.all([fetchLogs(source, from, to), source.reader.getBlock(from), toBlock ?? source.reader.getBlock(to)]);
    await stampTimes(source, logs);
    let out = rowsFromLogs(logs, { unitsOf, collateralDecimals });
    if (out.missingMarkets.size) {
      await refreshMarketsFromContract(live.reader, 'finalized').catch(() => 0);
      if ([...out.missingMarkets].some(id => !markets.has(id))) await refreshMarketsFromContract(source.reader, to).catch(() => 0);
      out = rowsFromLogs(logs, { unitsOf, collateralDecimals });
      if (out.missingMarkets.size) throw Object.assign(new Error(`MISSING_MARKET_METADATA:${[...out.missingMarkets].join(',')}`), { kind: 'other' });
    }
    for (const k of Object.keys(status.checks)) status.checks[k] += out.stats[k] ?? 0;
    return { from, to, fromTs: first.timestamp, toTs: last.timestamp, logs: logs.length, out, source: source.name };
  }

  const gather = results => { const all = { ev: [], markets: [], accounts: [], funding: [], params: [] }; for (const r of results) for (const k of Object.keys(all)) all[k].push(...r.out[k]); return all; };
  // Inserts several ranges' rows; coverage rows go last. Every topic was
  // read, the added ones too, so the ranges count for them as well.
  async function commit(results, { chunkRows, topicRows = chunkRows }) {
    const all = gather(results);
    await store(all);
    await ch.insert('chunks', chunkRows);
    await ch.insert('topic_chunks', topicRows.map(r => ({ topics: TOPIC_SET.name, from_block: r.from_block, to_block: r.to_block, rows: 0, source: r.source })));
    return all;
  }
  async function store(all) {
    if (all.markets.length) { await ch.insert('markets', all.markets); for (const x of all.markets) markets.set(x.market, { symbol: x.symbol, name: x.name, priceDecimals: x.price_decimals, lotDecimals: x.lot_decimals }); }
    await ch.insert('accounts', all.accounts);
    await ch.insert('funding', all.funding);
    // A fee or liquidation rate change applies from its block on; hours
    // already rolled after it (the backfill runs newest first) are redone.
    // They are marked in the database before the change is stored: a replay
    // after a crash finds the change already known and would not mark them.
    const since = revenueParams.add(all.params);
    if (since !== null) { staleSince = staleSince === null ? since : Math.min(staleSince, since); emit({ type: 'revenue-params', ts: since }); }
    if (staleSince !== null) { const t = staleSince; await markStale(ch, t); if (staleSince === t) staleSince = null; }
    await ch.insert('params', all.params);
    await ch.insert('ev', all.ev);
  }

  // --- live ---------------------------------------------------------------
  const session = { from: null, fromTs: null, logs: 0, rows: 0 };
  async function liveStep() {
    const fin = await live.reader.getBlock('finalized');
    status.live.finalized = fin.number; status.live.finalizedTs = fin.timestamp;
    if (session.from === null) {
      const top = coverage.top();
      const start = top !== null && fin.number - top <= options.liveHorizon ? top + 1n : fin.number;
      session.from = start; status.live.from = start;
      if (top !== null && start === top + 1n) {
        // Extend the interval that already ends at top.
        const last = coverage.intervals.at(-1);
        session.from = last.from; session.fromTs = last.fromTs;
        status.live.from = last.from;
      }
      status.live.to = start - 1n;
      log('info', `live ingest starting at block ${start}`);
    }
    const to = status.live.to;
    if (fin.number <= to) return false;
    const target = min(fin.number, to + options.liveMaxStep);
    const results = [];
    for (let from = to + 1n; from <= target; from += options.liveRange) {
      const hi = min(from + options.liveRange - 1n, target);
      results.push(await readRange(live, from, hi, { toBlock: hi === fin.number ? fin : null }));
    }
    if (session.fromTs === null) session.fromTs = results[0].fromTs;
    const last = results.at(-1);
    for (const r of results) { session.logs += r.logs; session.rows += r.out.ev.length; }
    const row = { from_block: session.from, to_block: last.to, from_ts: session.fromTs, to_ts: last.toTs, logs: session.logs, rows: session.rows, source: 'live' };
    // The added topics' coverage row of this session starts where this
    // process first read them (or extends the range that ends just before).
    if (session.topicFrom === undefined) { const t = topicCoverage.intervals.at(-1); session.topicFrom = t && t.to + 1n === results[0].from ? t.from : results[0].from; }
    const all = await guardedCommit(results, { chunkRows: [row], topicRows: [{ ...row, from_block: session.topicFrom }] });
    coverage.add(results[0].from, last.to, results[0].fromTs, last.toTs);
    topicCoverage.add(results[0].from, last.to, 0, 0);
    status.live.to = last.to; status.live.toTs = last.toTs; status.live.commits++; status.live.rows += all.ev.length; status.live.lastCommitAt = Date.now();
    emit({ type: 'commit', source: 'live', from: results[0].from, to: last.to, ts: last.toTs, finalized: fin.number, ev: all.ev, funding: all.funding, accounts: all.accounts, markets: all.markets });
    return last.to < fin.number ? 'more' : true;
  }

  async function liveLoop() {
    let failures = 0;
    while (running) {
      const started = Date.now();
      let more = false;
      try { more = (await liveStep()) === 'more'; failures = 0; }
      catch (error) {
        failures++; status.live.errors++; status.live.lastError = { message: error.message, kind: error.kind ?? null, at: Date.now() };
        log('warn', `live ingest step failed: ${error.message}`);
      }
      const wait = failures ? Math.min(options.livePollMs * 2 ** failures, 30000) : more ? 0 : Math.max(options.livePollMs, options.liveMinCommitMs - (Date.now() - started));
      let woken = null;
      await new Promise(resolve => { const t = setTimeout(resolve, wait); wake = via => { clearTimeout(t); woken = via; resolve(); }; });
      wake = null;
      status.live.trigger = woken ?? 'poll'; // what started the next step
    }
  }
  // Called by the execution-events or WebSocket head feed on each new
  // finalized block, so the next step runs as soon as pacing allows.
  function notifyFinalized(number, via = 'feed') {
    if (number !== undefined && status.live.to !== null && BigInt(number) <= status.live.to) return;
    if (wake && status.live.lastCommitAt !== null && Date.now() - status.live.lastCommitAt >= options.liveMinCommitMs) wake(via);
  }

  // --- backfill ------------------------------------------------------------
  const backfillFloor = () => (options.backfillFrom !== null && options.backfillFrom > floor ? options.backfillFrom : floor);
  const planBackfill = to => chunkTasks(coverage.gaps(backfillFloor(), to));
  // Ascending gaps to chunks, newest first.
  function chunkTasks(gaps) {
    const horizon = status.live.finalized !== null ? status.live.finalized - options.liveHorizon + 1000n : null;
    const tasks = [];
    for (const gap of [...gaps].reverse()) {
      // Grid-aligned chunks keep boundaries (and dedup tokens) stable across restarts.
      for (let hi = gap.to; hi >= gap.from;) {
        const nodeServes = horizon !== null && hi >= horizon;
        const size = nodeServes ? options.liveRange : options.archiveRange;
        let lo = hi - (hi % size); // grid start
        if (lo < gap.from) lo = gap.from;
        if (nodeServes && lo < horizon) lo = max(horizon, gap.from);
        tasks.push({ from: lo, to: hi, index: tasks.length, nodeServes, attempt: 0 });
        hi = lo - 1n;
      }
    }
    return tasks;
  }

  // The node first while it has the range, then archives round-robin.
  function pickSource(task, sources = { live, archives }) {
    if (!sources.archives.length) return sources.live;
    if (task.nodeServes && task.attempt === 0) return sources.live;
    return sources.archives[(task.index + task.attempt) % sources.archives.length];
  }

  async function backfill() {
    if (status.backfill.running) return null;
    const until = status.live.from !== null ? status.live.from - 1n : null;
    const lo = backfillFloor();
    if (until === null || until < lo) return null;
    const tasks = planBackfill(until);
    const b = status.backfill;
    Object.assign(b, { running: true, targetFrom: lo, targetTo: until, totalBlocks: until - lo + 1n, doneBlocks: coverage.blocks(lo, until), startedAt: Date.now(), finishedAt: null, chunks: 0, rows: 0, failed: [], lastError: null });
    if (!tasks.length) { Object.assign(b, { running: false, finishedAt: Date.now() }); return b; }
    log('info', `backfill: ${tasks.length} chunks, ${(b.totalBlocks - b.doneBlocks).toString()} blocks missing`);
    const queue = tasks; let next = 0;
    let batch = [], batchRows = 0, batchStarted = Date.now(), flushing = Promise.resolve();
    const rateWindow = [];

    async function flush() {
      if (!batch.length) return;
      const results = batch; batch = []; batchRows = 0; batchStarted = Date.now();
      results.sort((x, y) => (x.from < y.from ? -1 : 1));
      const chunkRows = results.map(r => ({ from_block: r.from, to_block: r.to, from_ts: r.fromTs, to_ts: r.toTs, logs: r.logs, rows: r.out.ev.length, source: r.source }));
      await guardedCommit(results, { chunkRows });
      for (const r of results) { coverage.add(r.from, r.to, r.fromTs, r.toTs); topicCoverage.add(r.from, r.to, 0, 0); b.doneBlocks += r.to - r.from + 1n; b.chunks++; b.rows += r.out.ev.length; }
      b.rate = rateOf(rateWindow, results) ?? b.rate;
      emit({ type: 'backfill', progress: progress() });
    }
    // A failed flush leaves its ranges uncovered (and cleared); the next
    // backfill round picks them up again.
    const scheduleFlush = () => { flushing = flushing.then(flush).catch(error => { b.lastError = { message: error.message, at: Date.now() }; log('warn', `backfill flush failed: ${error.message}`); }); return flushing; };

    async function worker() {
      while (!stopRequested) {
        const task = queue[next++];
        if (!task) return;
        for (;;) {
          const source = pickSource(task);
          try {
            const result = await readRange(source, task.from, task.to);
            batch.push(result); batchRows += result.out.ev.length;
            if (batchRows >= options.batchRows || Date.now() - batchStarted >= options.batchMs) await scheduleFlush();
            break;
          } catch (error) {
            task.attempt++;
            if (task.attempt > options.retries) { b.failed.push({ from: task.from.toString(), to: task.to.toString(), message: error.message, kind: error.kind ?? null }); log('warn', `backfill chunk ${task.from}-${task.to} failed: ${error.message}`); break; }
            await sleep(Math.min(500 * 2 ** task.attempt, 20000));
          }
        }
      }
    }
    const concurrency = Math.max(options.liveConcurrency, archives.length ? options.archiveConcurrency : 0);
    try {
      await Promise.all(Array.from({ length: concurrency }, worker));
      await scheduleFlush();
    } catch (error) {
      b.lastError = { message: error.message, at: Date.now() };
    } finally {
      b.running = false; b.finishedAt = Date.now();
      log('info', `backfill ${b.failed.length ? `stopped with ${b.failed.length} failed chunks` : 'complete'}: ${b.chunks} chunks, ${b.rows} rows`);
      emit({ type: 'backfill', progress: progress() });
    }
    return b;
  }

  // Coverage of the whole history [deployment, ingested head], so the
  // percentage never resets when a restart re-plans the remaining gaps.
  function progress() {
    const b = status.backfill;
    const lo = backfillFloor(), hi = status.live.to ?? status.live.finalized ?? lo;
    const total = hi >= lo ? hi - lo + 1n : 0n, done = total > 0n ? coverage.blocks(lo, hi) : 0n;
    const missing = total - done;
    return { running: b.running, complete: missing === 0n, from_block: lo.toString(), to_block: hi.toString(), total_blocks: total.toString(), done_blocks: done.toString(), missing_blocks: missing.toString(), pct: total > 0n ? Number(done * 10000n / total) / 100 : null, rate_blocks_per_s: b.rate, eta_s: b.rate && missing > 0n ? Math.round(Number(missing) / b.rate) : null, chunks: b.chunks, rows: b.rows, failed: b.failed.slice(0, 20), last_error: b.lastError };
  }
  // Blocks per second over the last 20 flushes (null until two).
  function rateOf(window, results) {
    window.push({ at: Date.now(), blocks: results.reduce((a, r) => a + Number(r.to - r.from + 1n), 0) });
    while (window.length > 20) window.shift();
    const seconds = (window.at(-1).at - window[0].at) / 1000;
    return window.length > 1 && seconds > 0 ? Math.round(window.slice(1).reduce((a, x) => a + x.blocks, 0) / seconds) : null;
  }

  // --- topic backfill ------------------------------------------------------
  // The added topics (decode.js TOPIC_SET) alone, over every range the ingest
  // covered before it read them: newest first, the node while it has the
  // range, then the archives, each paced. Exactly-once like the ingest: tasks
  // never overlap, a range is recorded in topic_chunks after its rows, and a
  // row already stored (a range the ingest read but did not record here, or
  // a commit retried after its rows landed) is not inserted again. Only
  // ranges the ingest has covered are read, so its own repair and range
  // cleanup never meet these rows.
  const topicTarget = () => {
    const lo = backfillFloor(), hi = status.live.to;
    return hi === null ? [] : coverage.intervals.map(x => ({ from: max(x.from, lo), to: min(x.to, hi) })).filter(x => x.to >= x.from);
  };
  const planTopics = () => chunkTasks(topicTarget().flatMap(x => topicCoverage.gaps(x.from, x.to)));

  // One eth_getLogs slot per `gap` ms for each archive; a rate-limit or
  // timeout answer pauses that source for everyone (pausedUntil).
  async function pace(source) {
    status.topics.requests++;
    const now = Date.now(), at = Math.max(now, source.nextAt, source.pausedUntil);
    source.nextAt = at + source.gap;
    if (at > now) await sleep(at - now);
  }

  async function readTopicRange(source, from, to) {
    const logs = await fetchLogs(source, from, to, topicSetTopics);
    await stampTimes(source, logs);
    return { from, to, logs: logs.length, out: rowsFromLogs(logs, { unitsOf, collateralDecimals }), source: source.name };
  }

  // Rows, then coverage (contiguous ranges as one row each).
  async function commitTopics(results) {
    results.sort((x, y) => (x.from < y.from ? -1 : 1));
    const all = gather(results);
    const blocks = [...new Set(all.ev.map(r => r.block))];
    if (blocks.length) {
      const stored = new Set((await ch.query(`SELECT block, log_index FROM ev WHERE block IN (${blocks.map(digits).join(',')}) AND kind IN (${TRANSFER_KINDS.map(k => `'${k}'`).join(',')})`)).map(r => `${r.block}:${r.log_index}`));
      const fresh = all.ev.filter(r => !stored.has(`${r.block}:${r.log_index}`));
      status.topics.skipped += all.ev.length - fresh.length;
      all.ev = fresh;
    }
    await store(all);
    const runs = [];
    for (const r of results) { const last = runs.at(-1); if (last && last.to_block + 1n === r.from) { last.to_block = r.to; last.rows += r.out.ev.length; } else runs.push({ topics: TOPIC_SET.name, from_block: r.from, to_block: r.to, rows: r.out.ev.length, source: r.source }); }
    await ch.insert('topic_chunks', runs);
    return all;
  }

  async function topicBackfill() {
    const t = status.topics;
    if (t.running) return null;
    const tasks = planTopics();
    Object.assign(t, { running: true, startedAt: Date.now(), finishedAt: null, chunks: 0, rows: 0, skipped: 0, failed: [], lastError: null });
    if (!tasks.length) { Object.assign(t, { running: false, finishedAt: Date.now() }); return t; }
    log('info', `topic backfill (${TOPIC_SET.name}): ${tasks.length} chunks, ${topicProgress().missing_blocks} blocks`);
    let next = 0, batch = [], batchStarted = Date.now(), flushing = Promise.resolve();
    const rateWindow = [];
    async function flush() {
      if (!batch.length) return;
      const results = batch; batch = []; batchStarted = Date.now();
      const all = await commitTopics(results);
      for (const r of results) { topicCoverage.add(r.from, r.to, 0, 0); t.chunks++; }
      t.rows += all.ev.length;
      t.rate = rateOf(rateWindow, results) ?? t.rate;
    }
    // A failed flush leaves its ranges unrecorded; the next round reads them again.
    const scheduleFlush = () => { flushing = flushing.then(flush).catch(error => { t.lastError = { message: error.message, at: Date.now() }; log('warn', `topic backfill flush failed: ${error.message}`); }); return flushing; };
    async function worker() {
      while (!stopRequested) {
        const task = tasks[next++];
        if (!task) return;
        for (;;) {
          const source = pickSource(task, topicSources);
          try {
            batch.push(await readTopicRange(source, task.from, task.to));
            if (Date.now() - batchStarted >= options.batchMs) await scheduleFlush();
            break;
          } catch (error) {
            task.attempt++;
            if (error.kind === 'rate' || error.kind === 'timeout') source.pausedUntil = Math.max(source.pausedUntil, Date.now() + Math.min(2000 * 2 ** task.attempt, 60000));
            if (task.attempt > options.retries) { t.failed.push({ from: task.from.toString(), to: task.to.toString(), message: error.message, kind: error.kind ?? null }); log('warn', `topic backfill chunk ${task.from}-${task.to} failed: ${error.message}`); break; }
            await sleep(Math.min(500 * 2 ** task.attempt, 20000));
          }
        }
      }
    }
    const concurrency = Math.max(options.liveConcurrency, archives.length ? options.archiveConcurrency : 0);
    try {
      await Promise.all(Array.from({ length: concurrency }, worker));
      await scheduleFlush();
    } catch (error) {
      t.lastError = { message: error.message, at: Date.now() };
    } finally {
      t.running = false; t.finishedAt = Date.now();
      log('info', `topic backfill ${t.failed.length ? `stopped with ${t.failed.length} failed chunks` : 'round done'}: ${t.chunks} chunks, ${t.rows} rows`);
    }
    return t;
  }

  // Share of the ranges the ingest covered that were read with the added topics.
  // The contract's protocol balance at a past block: the node while it keeps
  // that state, then the archives.
  async function protocolBalanceAt(block) {
    let last = null;
    for (const source of [live, ...archives]) {
      try { return (await source.reader.call('getExchangeInfo', [], BigInt(block)))[1]; } catch (error) { last = error; }
    }
    throw last ?? new Error('NO_SOURCE');
  }
  function topicProgress() {
    const t = status.topics;
    let total = 0n, done = 0n;
    for (const x of topicTarget()) { total += x.to - x.from + 1n; done += topicCoverage.blocks(x.from, x.to); }
    const missing = total - done;
    return { topics: TOPIC_SET.name, events: TOPIC_SET.events, running: t.running, complete: missing === 0n, total_blocks: total.toString(), done_blocks: done.toString(), missing_blocks: missing.toString(), pct: total > 0n ? Number(done * 10000n / total) / 100 : null, covered_from: topicCoveredFrom()?.toString() ?? null, rate_blocks_per_s: t.rate, eta_s: t.rate && missing > 0n ? Math.round(Number(missing) / t.rate) : null, chunks: t.chunks, rows: t.rows, skipped: t.skipped, requests: t.requests, failed: t.failed.slice(0, 20), last_error: t.lastError };
  }
  // Lowest block from which the added topics are read without a gap up to
  // the ingested head (null before the first live commit).
  function topicCoveredFrom() {
    const last = topicCoverage.intervals.at(-1);
    return last && status.live.to !== null && last.to >= status.live.to ? last.from : null;
  }

  async function start() {
    running = true; stopRequested = false;
    const loop = liveLoop();
    // Backfill once the live start is known; retried periodically while gaps remain.
    (async () => {
      while (running && status.live.from === null) await sleep(200);
      while (running && options.backfill) {
        const result = await backfill().catch(error => { log('warn', `backfill failed: ${error.message}`); return null; });
        const missing = status.live.from !== null && coverage.gaps(backfillFloor(), status.live.from - 1n).length > 0;
        if (!missing) break;
        await sleep(result?.failed?.length ? 60000 : 5000);
      }
    })();
    // The topic backfill takes turns with it (they share the archives) and
    // stops once every covered range was read with the added topics; later
    // ranges are read with every topic by the ingest itself.
    (async () => {
      while (running && status.live.to === null) await sleep(200);
      while (running && options.topicBackfill) {
        if (status.backfill.running) { await sleep(5000); continue; }
        const result = await topicBackfill().catch(error => { log('warn', `topic backfill failed: ${error.message}`); return null; });
        if (topicProgress().complete) break;
        await sleep(result?.failed?.length ? 60000 : 5000);
      }
    })();
    return loop;
  }
  function stop() { running = false; stopRequested = true; if (wake) wake(); }

  return { init, start, stop, liveStep, backfill, topicBackfill, protocolBalanceAt, readRange, commit, repair, notifyFinalized, on: fn => { listeners.add(fn); return () => listeners.delete(fn); }, coverage, topicCoverage, markets, revenueParams, unitsOf, progress, topicProgress, topicCoveredFrom, status, get collateralDecimals() { return collateralDecimals; }, sources: { live, archives } };
}
