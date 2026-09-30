// Measures how far behind the chain a running instance is: block production,
// finalization, server-sent block and trade events, and contract-state
// snapshots. Needs MONAD_RPC_URL (never printed) and the app at APP_URL.
//   node --env-file=.env scripts/measure-latency.js [seconds]
const RPC = process.env.MONAD_RPC_URL;
const APP = process.env.APP_URL || 'http://127.0.0.1:8787';
if (!RPC) { console.error('MONAD_RPC_URL is required'); process.exit(1); }
const DURATION = Number(process.argv[2] || 90) * 1000;
const t0 = Date.now();
const latestSeen = new Map(), finalSeen = new Map(), sseSeen = [], snapSeen = [], tradesSeen = [], proposedSeen = new Map(), rpcMs = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let id = 1;
async function rpc(method, params) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error('RPC_ERROR');
  return j.result;
}
// The chain: the proposed head and the finalized head, every 100 ms.
async function pollChain() {
  while (Date.now() - t0 < DURATION) {
    const started = performance.now();
    try {
      const [latest, fin] = await Promise.all([rpc('eth_blockNumber', []), rpc('eth_getBlockByNumber', ['finalized', false])]);
      const now = Date.now(); rpcMs.push(performance.now() - started);
      const ln = Number(BigInt(latest)); if (!latestSeen.has(ln)) latestSeen.set(ln, now);
      const fn = Number(BigInt(fin.number)); if (!finalSeen.has(fn)) finalSeen.set(fn, now);
    } catch { /* a missed sample */ }
    await sleep(100);
  }
}
// The contract-state snapshot block, every 250 ms.
async function pollSnapshot() {
  while (Date.now() - t0 < DURATION) {
    try { const j = await (await fetch(`${APP}/api/v1/overview`)).json(); const b = Number(j.snapshot?.block); if (b && (!snapSeen.length || snapSeen.at(-1).b !== b)) snapSeen.push({ b, at: Date.now() }); } catch { /* retry */ }
    await sleep(250);
  }
}
// Server-sent events: committed blocks and trades.
async function stream() {
  const ctl = new AbortController(); setTimeout(() => ctl.abort(), DURATION);
  try {
    const r = await fetch(`${APP}/api/v1/stream`, { signal: ctl.signal });
    const dec = new TextDecoder(); let buf = '';
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const msg = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /^event: (.*)$/m.exec(msg)?.[1], data = /^data: (.*)$/m.exec(msg)?.[1];
        if (ev === 'block') sseSeen.push({ b: Number(JSON.parse(data).block), at: Date.now() });
        if (ev === 'trades') for (const t of JSON.parse(data)) tradesSeen.push({ b: Number(t.block), at: Date.now() });
        // Trades of a proposed block, pushed from the execution-event stream before finality.
        if (ev === 'proposed') { const b = Number(JSON.parse(data).block); if (!proposedSeen.has(b)) proposedSeen.set(b, Date.now()); }
      }
    }
  } catch { /* aborted at the end */ }
}
await Promise.all([pollChain(), pollSnapshot(), stream()]);

const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]) : null; };
const stats = a => ({ n: a.length, p50: q(a, 0.5), p90: q(a, 0.9), max: q(a, 1) });
const firstAtLeast = (list, n) => list.find(x => x.b >= n)?.at ?? null;
const blocks = [...latestSeen.keys()].sort((a, b) => a - b);
const lag = { fin: [], sse: [], sseFin: [], snap: [], snapFin: [] };
for (const n of blocks) {
  if (!finalSeen.has(n)) continue;
  const proposed = latestSeen.get(n), finalized = finalSeen.get(n);
  lag.fin.push(finalized - proposed);
  const s = firstAtLeast(sseSeen, n); if (s) { lag.sse.push(s - proposed); lag.sseFin.push(s - finalized); }
  const c = firstAtLeast(snapSeen, n); if (c) { lag.snap.push(c - proposed); lag.snapFin.push(c - finalized); }
}
const gaps = list => list.slice(1).map((x, i) => x.at - list[i].at);
console.log(JSON.stringify({
  seconds: DURATION / 1000,
  blocks_seen: blocks.length,
  block_time_ms: blocks.length > 1 ? Math.round((latestSeen.get(blocks.at(-1)) - latestSeen.get(blocks[0])) / (blocks.at(-1) - blocks[0])) : null,
  rpc_roundtrip_ms: stats(rpcMs),
  finalization_lag_ms: stats(lag.fin),
  sse_block_after_proposed_ms: stats(lag.sse),
  sse_block_after_finalized_ms: stats(lag.sseFin),
  sse_block_interval_ms: stats(gaps(sseSeen)),
  trade_on_tape_after_proposed_ms: stats(tradesSeen.filter(t => latestSeen.has(t.b)).map(t => t.at - latestSeen.get(t.b))),
  // Proposed-block trades (execution events): against the RPC head (negative = before the RPC reports the block) and the finalized head.
  proposed_blocks_pushed: proposedSeen.size,
  proposed_trades_after_rpc_head_ms: stats([...proposedSeen].filter(([b]) => latestSeen.has(b)).map(([b, at]) => at - latestSeen.get(b))),
  proposed_trades_before_finalized_ms: stats([...proposedSeen].filter(([b]) => finalSeen.has(b)).map(([b, at]) => finalSeen.get(b) - at)),
  finalized_trades_after_proposed_trades_ms: stats(tradesSeen.filter(t => proposedSeen.has(t.b)).map(t => t.at - proposedSeen.get(t.b))),
  contract_snapshot_after_proposed_ms: stats(lag.snap),
  contract_snapshot_after_finalized_ms: stats(lag.snapFin),
  contract_snapshot_interval_ms: stats(gaps(snapSeen))
}, null, 1));
