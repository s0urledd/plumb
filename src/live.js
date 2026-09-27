// Real-time layer.
//
// 1. Server-Sent Events to browsers: every committed (finalized) block range
//    is pushed as new trades, liquidations and the refreshed 24 h headline,
//    so the dashboard updates in place without polling.
// 2. Wake-ups for the ingest: the Monad execution-events sidecar (Monode's
//    backend, which reads the node's shared-memory event ring) reports each
//    BlockFinalized as it happens; without it a WebSocket newHeads
//    subscription on the node does the same, and without either the ingest
//    simply polls.
// 3. Speculative tape: with the sidecar, exchange logs are visible when their
//    block is proposed, about a second before finalization. They are pushed
//    marked "proposed" and never written to storage. Blocks that carried
//    exchange logs then report their consensus stages as they happen: voted
//    (a quorum certificate, BlockQC) and finalized, each with the time since
//    the block started executing here.
import { rowsFromLogs } from './decode.js';

export function createSse({ log = () => {}, heartbeatMs = 15000, maxClients = 500 } = {}) {
  const clients = new Set();
  let seq = 0;
  const timer = setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, heartbeatMs);
  timer.unref?.();
  function open(req, res, headers = {}) {
    if (clients.size >= maxClients) { res.writeHead(503, { 'retry-after': '10' }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no', ...headers });
    res.write('retry: 3000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
  }
  function send(event, data) {
    if (!clients.size) return;
    const text = `id: ${++seq}\nevent: ${event}\ndata: ${JSON.stringify(data, (_, v) => typeof v === 'bigint' ? v.toString() : v)}\n\n`;
    for (const res of clients) { try { res.write(text); } catch (error) { clients.delete(res); log('warn', `sse write failed: ${error.message}`); } }
  }
  return { open, send, get clients() { return clients.size; }, close: () => { clearInterval(timer); for (const res of clients) res.end(); clients.clear(); } };
}

// A WebSocket that keeps itself connected. One attempt at a time; a handshake
// that has not opened within openTimeoutMs, or an open socket with no message
// for idleMs, is closed and retried (a stalled handshake fires no event of its
// own, so without these a feed can stay down for good). Events from a retired
// socket are ignored, so a late close never schedules a second attempt.
export function keepConnected({ url, WebSocketImpl = globalThis.WebSocket, openTimeoutMs = 15000, idleMs = 60000, onOpen = () => {}, onMessage = () => {}, onDown = () => {}, now = () => Date.now(), timers = { setTimeout, clearTimeout, setInterval, clearInterval } }) {
  let stopped = false, retry = 1000, attempt = 0, ws = null, watch = null;
  const stats = { reconnects: 0, lastError: null };
  function connect() {
    if (stopped || !WebSocketImpl) return;
    const id = ++attempt, startedAt = now();
    let open = false, lastMessageAt = startedAt, ended = false;
    const end = reason => {
      if (ended || id !== attempt) return;
      ended = true; timers.clearInterval(watch);
      try { ws?.close(); } catch { /* already closing */ }
      if (reason) stats.lastError = reason;
      onDown({ wasOpen: open, reason });
      schedule();
    };
    try { ws = new WebSocketImpl(url); } catch (error) { stats.lastError = error.message; schedule(); return; }
    watch = timers.setInterval(() => {
      if (!open && now() - startedAt > openTimeoutMs) end('connect timeout');
      else if (open && now() - lastMessageAt > idleMs) end('no messages');
    }, Math.min(5000, openTimeoutMs, idleMs));
    watch.unref?.();
    ws.onopen = () => { if (id !== attempt) return; open = true; retry = 1000; lastMessageAt = now(); onOpen(ws); };
    ws.onmessage = msg => { if (id !== attempt) return; lastMessageAt = now(); onMessage(msg); };
    ws.onerror = event => { if (id === attempt) stats.lastError = event?.message ?? 'error'; };
    ws.onclose = () => end(null);
  }
  function schedule() { if (stopped) return; stats.reconnects++; const t = timers.setTimeout(connect, retry); t.unref?.(); retry = Math.min(retry * 2, 30000); }
  return { start: connect, stop: () => { stopped = true; timers.clearInterval(watch); try { ws?.close(); } catch { /* closing */ } }, stats };
}

// Monode backend WebSocket client. Its messages are serde's externally tagged
// ServerMessage: {"Events":[{event_name, block_number, txn_idx, txn_hash,
// payload:{type,...}, seqno, timestamp_ns}, ...]}, {"TPS":n} or
// {"TopAccesses":{...}}. Hex values are 0x-prefixed lowercase strings and a
// log's topics arrive as one concatenated hex string. A block number can be
// proposed more than once; losing proposals are dropped without an event,
// which is why nothing seen here is ever stored.
export function createExecEvents({ url, exchange, onFinalized = () => {}, onProposed = () => {}, onStage = () => {}, onStatus = () => {}, log = () => {}, WebSocketImpl = globalThis.WebSocket, now = () => Date.now() }) {
  const target = exchange.toLowerCase();
  const pending = new Map(); // block_number -> { blockId, ts, startedAt, logs: [] }
  // Blocks whose proposed trades were pushed: block_id -> { block, startedAt, voted }.
  const shown = new Map();
  const status = { connected: false, lastEventAt: null, finalized: null, proposed: null, tps: null, reconnects: 0, lastError: null };
  let socket = null;

  function handleEvent(e) {
    const p = e.payload ?? {};
    status.lastEventAt = Date.now();
    switch (e.event_name) {
      case 'BlockStart': pending.set(Number(p.block_number), { blockId: p.block_id, ts: Number(p.timestamp), startedAt: now(), logs: [] }); status.proposed = Number(p.block_number); break;
      case 'TxnLog': {
        if (String(p.address).toLowerCase() !== target || e.block_number === undefined) break;
        const b = pending.get(Number(e.block_number));
        if (!b) break;
        const topics = [];
        const hex = String(p.topics ?? '0x').slice(2);
        for (let i = 0; i + 64 <= hex.length; i += 64) topics.push('0x' + hex.slice(i, i + 64));
        // log_index counts within the transaction; events of different
        // transactions can interleave, so order is restored at BlockEnd.
        b.logs.push({ blockNumber: Number(e.block_number), transactionIndex: Number(p.txn_index), txLogIndex: Number(p.log_index), blockTimestamp: b.ts, transactionHash: e.txn_hash ?? null, topics, data: p.data ?? '0x' });
        break;
      }
      case 'BlockEnd': {
        const b = pending.get(Number(e.block_number));
        if (b && b.logs.length) {
          b.logs.sort((x, y) => x.transactionIndex - y.transactionIndex || x.txLogIndex - y.txLogIndex);
          b.logs.forEach((l, i) => { l.logIndex = i; });
          onProposed({ block: Number(e.block_number), blockId: b.blockId, ts: b.ts, logs: b.logs });
          shown.set(String(b.blockId).toLowerCase(), { block: Number(e.block_number), startedAt: b.startedAt, voted: false });
          if (shown.size > 500) shown.delete(shown.keys().next().value);
        }
        break;
      }
      case 'BlockQC': {
        const s = shown.get(String(p.block_id).toLowerCase());
        if (s && !s.voted) { s.voted = true; onStage({ block: s.block, blockId: p.block_id, stage: 'voted', ms: now() - s.startedAt }); }
        break;
      }
      case 'BlockFinalized': {
        const n = Number(p.block_number);
        status.finalized = n;
        for (const k of pending.keys()) if (k <= n) pending.delete(k);
        const s = shown.get(String(p.block_id).toLowerCase());
        if (s) { shown.delete(String(p.block_id).toLowerCase()); onStage({ block: s.block, blockId: p.block_id, stage: 'finalized', ms: now() - s.startedAt }); }
        onFinalized(n);
        break;
      }
      case 'BlockReject': pending.delete(Number(e.block_number)); break;
      default:
    }
  }

  // Monode sends its TPS line every second, so a minute of silence means the link is gone.
  function start() {
    socket = keepConnected({
      url, WebSocketImpl, now, idleMs: 60000,
      onOpen: () => { status.connected = true; onStatus(status); log('info', 'execution-events sidecar connected'); },
      onMessage: msg => {
        let data;
        try { data = JSON.parse(typeof msg.data === 'string' ? msg.data : Buffer.from(msg.data).toString()); } catch { return; }
        if (Array.isArray(data.Events)) for (const e of data.Events) handleEvent(e);
        else if (data.TPS !== undefined) status.tps = Number(data.TPS);
      },
      onDown: ({ wasOpen, reason }) => {
        status.connected = false; status.reconnects = socket.stats.reconnects + 1; status.lastError = reason ?? socket.stats.lastError;
        if (wasOpen) log('warn', `execution-events sidecar disconnected${reason ? ` (${reason})` : ''}`);
        onStatus(status);
      }
    });
    socket.start();
    return status;
  }
  return { start, stop: () => socket?.stop(), status, handleEvent };
}

// Node WebSocket newHeads subscription as a wake-up source.
export function createHeadSubscription({ url, onHead = () => {}, log = () => {}, WebSocketImpl = globalThis.WebSocket }) {
  const status = { connected: false, lastHeadAt: null, head: null, reconnects: 0 };
  // A block is proposed every few hundred milliseconds: a minute without a head means a dead subscription.
  const socket = keepConnected({
    url, WebSocketImpl, idleMs: 60000,
    onOpen: ws => { status.connected = true; ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newHeads'] })); },
    onMessage: msg => {
      let data; try { data = JSON.parse(typeof msg.data === 'string' ? msg.data : Buffer.from(msg.data).toString()); } catch { return; }
      const head = data?.params?.result;
      if (head?.number) { status.head = Number(BigInt(head.number)); status.lastHeadAt = Date.now(); onHead(status.head); }
    },
    onDown: ({ wasOpen, reason }) => { if (wasOpen) log('warn', `head subscription closed${reason ? ` (${reason})` : ''}`); status.connected = false; status.reconnects = socket.stats.reconnects + 1; }
  });
  return { start: () => { socket.start(); return status; }, stop: () => socket.stop(), status };
}

// Proposed-block trades for the live tape (never stored).
export function speculativeTrades(logs, ingest) {
  try {
    const out = rowsFromLogs(logs, { unitsOf: id => ingest.unitsOf(id), collateralDecimals: ingest.collateralDecimals });
    return out.ev.filter(r => r.role === 'taker' && ['open', 'increase', 'decrease', 'close', 'invert', 'liquidation'].includes(r.kind));
  } catch { return []; }
}
