import test from 'node:test';
import assert from 'node:assert/strict';
import { createAlerts, parseUsd, usd, fmtPrice } from '../src/alerts.js';

const ADDR = '0x1111111111111111111111111111111111111111';
const NOW = 1_800_000_000;
const text = r => (typeof r === 'string' ? r : r.text);
const buttons = r => (r.keyboard ?? []).flat().map(b => b.callback_data ?? b.url);

// A fake Telegram: records sent and edited messages and serves queued updates.
function harness({ positions = [], maxChats } = {}) {
  const sent = [], edited = [], answered = [], updates = [];
  let saved = null, gate = null, release = null, clock = NOW * 1000, stateCalls = 0;
  const fetch = async (url, init) => {
    const method = url.split('/').pop(), body = JSON.parse(init.body);
    const ok = result => ({ json: async () => ({ ok: true, result }) });
    if (method === 'sendMessage') { if (gate) await gate; sent.push(body); return ok({}); }
    if (method === 'editMessageText') { edited.push(body); return ok({}); }
    if (method === 'answerCallbackQuery') { answered.push(body); return ok(true); }
    if (method === 'getUpdates') return ok(updates.splice(0));
    return ok({ username: 'plumb_test_bot' });
  };
  const alerts = createAlerts({
    token: 'T', fetch, sendGapMs: 0, now: () => clock, maxChats,
    store: { load: async () => saved, save: async v => { saved = structuredClone(v); } },
    resolveAccount: async key => (key === ADDR || key === '7' ? { id: 7, address: ADDR } : null),
    tradeViews: async rows => rows.map(r => ({ ...r, symbol: r.market === 1 ? 'BTC' : 'SOL', address: r.account === 7 ? ADDR : null })),
    accountState: async () => { stateCalls++; await new Promise(r => setTimeout(r, 5)); return { portfolio: { account_value: '361.2', unrealized_pnl: '-1.17' }, positions }; },
    symbolOf: id => ({ 1: 'BTC', 2: 'SOL', 30: 'SOL_v2' }[id] ?? `#${id}`), marketIds: () => [1, 2, 30]
  });
  let n = 100;
  const msg = (t, chat = 42) => updates.push({ update_id: n++, message: { text: t, chat: { id: chat, type: 'private' } } });
  const tap = (data, chat = 42) => updates.push({ update_id: n++, callback_query: { id: `q${n}`, data, message: { message_id: 5, chat: { id: chat, type: 'private' } } } });
  const flush = () => new Promise(r => setTimeout(r, 100));
  // Replies go out through a queue that is not awaited: wait until the condition
  // holds (or a generous limit passes) rather than for a fixed time.
  const until = async (ok, ms = 5000) => { for (const end = Date.now() + ms; !ok() && Date.now() < end;) await new Promise(r => setTimeout(r, 5)); };
  return {
    alerts, sent, edited, answered, msg, tap, flush, until, saved: () => saved, setPositions: p => { positions.splice(0, positions.length, ...p); },
    // Holds every sendMessage until released, so alerts pile up in the queue.
    hold: () => { gate = new Promise(r => { release = r; }); }, release: () => { gate = null; release(); },
    advance: s => { clock += s * 1000; }, stateCalls: () => stateCalls
  };
}
const trade = over => ({ kind: 'open', role: 'taker', account: 3, market: 1, side: 'long', buy: true, size: '0.5', price: '84000', notional: '42000', pnl: '0', tx: '0xabc', ...over });
const pos = d => ({ market: 1, symbol: 'BTC', side: 'long', notional: '478', leverage: 15, pnl: '-1.17', mark: '84419.3', liquidation_price: '82252.46', liquidation_distance_pct: d });

test('amount parsing and formatting', () => {
  assert.equal(parseUsd('50k'), 50000);
  assert.equal(parseUsd('$1.5m'), 1500000);
  assert.equal(parseUsd('25,000'), 25000);
  assert.equal(parseUsd('abc'), null);
  assert.deepEqual([1000, 1500, 25000, 27319.55, 1.25e6].map(v => usd(v)), ['$1K', '$1.5K', '$25K', '$27.3K', '$1.25M']);
  assert.equal(usd(-12.5, { sign: true }), '-$12.50');
  assert.equal(fmtPrice('84566.2123'), '84,566.2');
  assert.equal(fmtPrice('0.0244671'), '0.024467');
});

test('the menu shows each alert state and the buttons to change it', async () => {
  const h = harness();
  const m = await h.alerts.handle('1', '/start');
  assert.match(text(m), /Plumb · Perpl alerts/);
  assert.match(text(m), /▫️ <b>Liquidations<\/b> {2}off/);
  assert.deepEqual(buttons(m).slice(0, 6), ['watch', 'pos', 'list', 'levels', 'liqs', 'trades']);
  await h.alerts.handle('1', '/liqs 25k BTC');
  assert.match(text(await h.alerts.handle('1', '/menu')), /✅ <b>Liquidations<\/b> {2}\$25K and up on BTC/);
});

test('commands and a bare address subscribe; state persists', async () => {
  const h = harness();
  h.msg(ADDR); h.msg('/trades 500'); h.msg('/funding'); h.msg('/watch 0xdead'); h.msg('/list');
  await h.alerts.pollOnce(); await h.until(() => h.sent.length >= 5);
  const texts = h.sent.map(m => m.text);
  assert.match(texts[0], /Watching/);
  assert.match(texts[1], /minimum/);
  assert.match(texts[2], /✅ <b>Funding flips<\/b> {2}on/);
  assert.match(texts[3], /No Perpl account/);
  assert.match(texts[4], /Watched wallets[\s\S]*0x1111…1111/);
  assert.deepEqual(Object.keys(h.saved().subs['42'].wallets), ['7']);
  assert.equal(h.saved().offset, 105);
});

test('buttons edit the menu in place: pickers, the watch prompt, unwatch, levels', async () => {
  const h = harness();
  h.tap('liqs'); h.tap('liqs:50000'); h.tap('watch'); h.msg('7'); h.tap('unwatch:7'); h.tap('levels:early'); h.tap('trades:off');
  await h.alerts.pollOnce(); await h.flush();
  assert.match(h.edited[0].text, /Get every liquidation/);
  assert.deepEqual(h.edited[0].reply_markup.inline_keyboard[0].map(b => b.callback_data), ['liqs:1000', 'liqs:10000', 'liqs:50000', 'liqs:100000']);
  assert.match(h.edited[1].text, /\$50K and up/);
  assert.match(h.edited[2].text, /Send a 0x address/);
  assert.match(h.sent[0].text, /Watching/); // the text after the prompt
  assert.doesNotMatch(h.edited[3].text, /0x1111/);
  assert.match(h.edited[4].text, /Liquidations<\/b> {2}\$50K/);
  assert.equal(h.saved().subs['42'].levels, 'early');
  assert.ok(h.answered.some(a => a.text === 'Early · 20% 10% 5%'));
});

test('deep link /start watch_<address> subscribes; a market name picks the newest listing', async () => {
  const h = harness();
  assert.match(text(await h.alerts.handle('9', `/start watch_${ADDR}`)), /Watching/);
  assert.match(text(await h.alerts.handle('9', '/liqs 10k sol')), /on SOL_v2/);
  assert.match(text(await h.alerts.handle('9', '/liqs 10k DOGE')), /Unknown market/);
});

test('positions screen: live state, closest to liquidation first', async () => {
  const h = harness({ positions: [{ ...pos(40), symbol: 'SOL', market: 2 }, pos(2.5)] });
  assert.match(text(await h.alerts.handle('1', '/positions')), /Watch a wallet first/);
  await h.alerts.handle('1', '/watch 7');
  const s = text(await h.alerts.handle('1', '/positions'));
  assert.match(s, /value <b>\$361<\/b> · uPnL <b>-\$1.17<\/b>/);
  assert.match(s, /🔴 <b>BTC LONG<\/b> \$478 · 15.0x · PnL -\$1.17\n {5}liq 82,252.5 · <b>2.5% away<\/b>\n🟢 <b>SOL LONG/);
});

test('events reach the right chats, grouped per commit', async () => {
  const h = harness();
  await h.alerts.handle('1', '/watch 7');
  await h.alerts.handle('2', '/liqs 20k');
  await h.alerts.handle('3', '/trades 40k BTC');
  await h.alerts.onCommit({ ts: NOW, ev: [
    trade({ account: 7, kind: 'close', role: 'maker', notional: '900', pnl: '12.5' }),
    trade({ kind: 'liquidation', notional: '27000' }),
    trade({ kind: 'liquidation', notional: '5000' }),
    trade({ notional: '42000' }),
    trade({ market: 2, notional: '99000' })
  ], funding: [] });
  await h.flush();
  const to = chat => h.sent.filter(m => m.chat_id === chat).map(m => m.text);
  assert.equal(to('1').length, 1);
  assert.match(to('1')[0], /^⚪ <b>BTC long closed<\/b> {2}#BTC\n<b>Size:<\/b> \$900 · 0\.5 BTC\n<b>Price:<\/b> 84,000\n<b>PnL:<\/b> \+\$12\.50\n<b>Wallet:<\/b> .*0x1111…1111.*\n<a href="[^"]+\/tx\/0xabc">View on explorer ↗<\/a>$/);
  assert.equal(to('2').length, 1);
  assert.match(to('2')[0], /^💥 <b>BTC long liquidated<\/b> {2}#BTC\n<b>Size:<\/b> \$27K · 0\.5 BTC\n<b>Price:<\/b> 84,000\n<b>PnL:<\/b> under \$0\.01\n<b>Wallet:<\/b> /);
  assert.equal(to('3').length, 1);
  assert.match(to('3')[0], /^🐋 <b>Large BTC buy<\/b> {2}#BTC\n<b>Size:<\/b> \$42K · 0\.5 BTC\n<b>Price:<\/b> 84,000\n<b>Trader:<\/b> .* opened long\n.*View on explorer ↗/);
});

test('a profit or loss under a cent is written out', async () => {
  const h = harness();
  await h.alerts.handle('1', '/watch 7');
  await h.alerts.onCommit({ ts: NOW, ev: [trade({ account: 7, kind: 'close', role: 'maker', notional: '100', pnl: '-0.003' }), trade({ account: 7, kind: 'decrease', role: 'maker', notional: '50', pnl: '-1.5' })], funding: [] });
  await h.flush();
  const text = h.sent.map(m => m.text).join('\n\n');
  assert.match(text, /BTC long closed[\s\S]*<b>PnL:<\/b> under \$0\.01/);
  assert.match(text, /BTC long reduced[\s\S]*<b>PnL:<\/b> -\$1\.50/);
  assert.doesNotMatch(text, /\$0\.00/);
});

test('old events after downtime are not sent', async () => {
  const h = harness();
  await h.alerts.handle('1', '/trades 1k');
  await h.alerts.onCommit({ ts: NOW - 3600, ev: [trade({})], funding: [] });
  await h.flush();
  assert.equal(h.sent.length, 0);
});

test('funding flips are reported once per change of direction', async () => {
  const h = harness();
  await h.alerts.handle('1', '/funding on');
  const f = rate => ({ ts: NOW, ev: [], funding: [{ market: 2, actual_rate: rate }] });
  for (const r of [45, 0, 30, -20, -10, 5]) await h.alerts.onCommit(f(r));
  await h.flush();
  const texts = h.sent.map(m => m.text);
  assert.equal(texts.length, 2);
  assert.match(texts[0], /Funding flipped · SOL<\/b>\nShorts now pay longs · -0\.0200%/);
  assert.match(texts[1], /Longs now pay shorts/);
});

test('near-liquidation warnings follow the chat\'s levels, once per level, and re-arm', async () => {
  const h = harness();
  await h.alerts.handle('1', '/watch 7');
  for (const d of [12, 9, 8, 4.5, 4, 16, 9]) { h.setPositions([pos(d)]); await h.alerts.checkRisk(); }
  await h.flush();
  const texts = h.sent.map(m => m.text);
  assert.equal(texts.length, 3);
  assert.match(texts[0], /^⚠️ <b>BTC long near liquidation<\/b> {2}#BTC\n<b>Distance:<\/b> 9\.0%\n<b>Mark → liq:<\/b> 84,419\.3 → 82,252\.5\n<b>Position:<\/b> \$478\n<b>Wallet:<\/b> /);
  assert.match(texts[1], /^🚨[\s\S]*Distance:<\/b> 4\.5%/);
  assert.match(texts[2], /Distance:<\/b> 9\.0%/);

  const early = harness();
  await early.alerts.handle('1', '/watch 7');
  await early.alerts.press('1', 'levels:early');
  for (const d of [30, 19, 9]) { early.setPositions([pos(d)]); await early.alerts.checkRisk(); }
  await early.flush();
  assert.deepEqual(early.sent.map(m => /Distance:<\/b> (\d+\.\d)%/.exec(m.text)[1]), ['19.0', '9.0']);
});

test('a busy chat keeps its newest alerts, and alerts gone stale in the queue are dropped', async () => {
  const h = harness();
  await h.alerts.handle('1', '/trades 1k');
  h.hold();
  const commits = [h.alerts.onCommit({ ts: NOW, ev: [trade({ notional: '1000' })], funding: [] })];
  await new Promise(r => setTimeout(r, 20)); // the first is on its way, held
  for (let i = 2; i <= 30; i++) commits.push(h.alerts.onCommit({ ts: NOW, ev: [trade({ notional: String(1000 * i) })], funding: [] }));
  await new Promise(r => setTimeout(r, 20));
  h.release();
  await Promise.all(commits); await h.flush();
  // Of the 29 waiting, the 20 newest go out.
  assert.deepEqual(h.sent.map(m => /<b>\$(\d+K)<\/b>/.exec(m.text)[1]), ['1K', ...Array.from({ length: 20 }, (_, i) => `${i + 11}K`)]);
  assert.equal(h.alerts.stats.dropped, 9);

  const s = harness();
  await s.alerts.handle('1', '/trades 1k');
  s.hold();
  const first = s.alerts.onCommit({ ts: NOW, ev: [trade({ notional: '1000' })], funding: [] });
  await new Promise(r => setTimeout(r, 20));
  const second = s.alerts.onCommit({ ts: NOW, ev: [trade({ notional: '2000' })], funding: [] });
  s.msg('/list', 1); await s.alerts.pollOnce(); // a command reply queued behind it
  s.advance(400); s.release();
  await Promise.all([first, second]); await s.flush();
  // The alert that waited past five minutes is dropped; the reply is not.
  assert.equal(s.sent.length, 2);
  assert.match(s.sent[0].text, /<b>\$1K<\/b>/);
  assert.match(s.sent[1].text, /Watched wallets/);
  assert.equal(s.alerts.stats.dropped, 1);
});

test('a funding change nobody heard about, or seen late, is not reported later', async () => {
  const h = harness();
  const f = (rate, ts = NOW) => ({ ts, ev: [], funding: [{ market: 2, actual_rate: rate }] });
  await h.alerts.handle('1', '/funding on');
  await h.alerts.onCommit(f(45));
  await h.alerts.handle('1', '/stop');
  await h.alerts.onCommit(f(-20)); // flips with nobody subscribed
  await h.alerts.handle('2', '/funding on');
  await h.alerts.onCommit(f(-10));
  await h.alerts.onCommit(f(30, NOW - 3600)); // a flip in a stale commit
  await h.alerts.onCommit(f(5));
  await h.alerts.onCommit(f(-5));
  await h.flush();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].text, /Shorts now pay longs · -0\.0050%/);
});

test('a full service refuses new chats on every path; existing chats keep working', async () => {
  const h = harness({ maxChats: 1 });
  assert.match(text(await h.alerts.handle('1', '/funding on')), /Funding flips<\/b> {2}on/);
  for (const t of ['/liqs 25k', '/trades 100k', '/funding on', '/watch 7']) assert.equal(text(await h.alerts.handle('2', t)), 'The alert service is full right now.', t);
  for (const d of ['liqs:10000', 'trades:50000', 'funding', 'levels:early']) assert.equal(text((await h.alerts.press('2', d))[0]), 'The alert service is full right now.', d);
  assert.deepEqual(Object.keys(h.alerts.subs()), ['1']);
  assert.match(text(await h.alerts.handle('1', '/liqs 25k')), /Liquidations<\/b> {2}\$25K/);
});

test('re-watching a wallet warns again; risk checks never overlap', async () => {
  const h = harness();
  await h.alerts.handle('1', '/watch 7');
  h.setPositions([pos(9)]);
  await h.alerts.checkRisk();
  await h.alerts.handle('1', '/unwatch 7');
  await h.alerts.handle('1', '/watch 7');
  await h.alerts.checkRisk();
  await h.flush();
  assert.equal(h.sent.length, 2);

  const g = harness();
  await g.alerts.handle('1', '/watch 7');
  await Promise.all([g.alerts.checkRisk(), g.alerts.checkRisk()]);
  assert.equal(g.stateCalls(), 1);
});

test('a blocked chat is dropped', async () => {
  let saved = null;
  const alerts = createAlerts({
    token: 'T', sendGapMs: 0, now: () => NOW * 1000,
    fetch: async () => ({ json: async () => ({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }) }),
    store: { load: async () => null, save: async v => { saved = v; } },
    resolveAccount: async () => ({ id: 7, address: ADDR }), tradeViews: async rows => rows.map(r => ({ ...r, symbol: 'BTC', address: ADDR })), accountState: async () => ({ positions: [] })
  });
  await alerts.handle('5', '/watch 7');
  await alerts.onCommit({ ts: NOW, ev: [trade({ account: 7 })], funding: [] });
  await new Promise(r => setTimeout(r, 10));
  await alerts.save();
  assert.deepEqual(saved.subs, {});
});
