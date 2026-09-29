// Telegram alerts. People subscribe by chatting with the bot, with buttons or
// commands: wallets to watch (every position change, and a warning when a
// position nears its liquidation price), large liquidations, large trades and
// funding flips. Alerts come from the same committed events as the dashboard;
// nothing here trades or holds keys other than the bot token.
//
// The bot long-polls getUpdates, so it needs no public endpoint. Subscriptions
// are one JSON document in the kv table.

const KINDS = ['open', 'increase', 'decrease', 'close', 'invert', 'liquidation', 'deleverage'];
const EVENT = {
  open: ['🟢', 'Opened'], increase: ['➕', 'Added to'], decrease: ['➖', 'Reduced'], close: ['⚪', 'Closed'],
  invert: ['🔄', 'Flipped to'], liquidation: ['💥', 'Liquidated'], deleverage: ['⚠️', 'Deleveraged']
};
const MAX_WALLETS = 20, MAX_CHATS = 2000, MIN_USD = 1000;
// A position warns once below each level of its chat's preset (distance to
// the liquidation price) and re-arms 5 points above the highest level.
export const LEVELS = { early: [20, 10, 5], standard: [10, 5], late: [5, 2] };
const LEVEL_NAMES = { early: 'Early · 20% 10% 5%', standard: 'Standard · 10% 5%', late: 'Late · 5% 2%' };
const STALE_S = 300;
// Alerts waiting in one chat's queue; beyond this the oldest are dropped.
const MAX_QUEUED = 20;
const LIQ_STEPS = [1e3, 1e4, 5e4, 1e5], TRADE_STEPS = [1e4, 5e4, 1e5, 2.5e5];

export const COMMANDS = [
  ['menu', 'Alert menu'],
  ['positions', 'Live positions of your watched wallets'],
  ['watch', 'Watch a wallet: /watch <address or id>'],
  ['unwatch', 'Stop watching a wallet'],
  ['liqs', 'Large liquidations: /liqs 25k [market]'],
  ['trades', 'Large trades: /trades 100k [market]'],
  ['funding', 'Funding flips: /funding on|off'],
  ['list', 'Your alerts'],
  ['stop', 'Remove all alerts']
];

const escHtml = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const short = a => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—');
const trim = s => s.replace(/\.0+(?=[KM]?$)|(\.\d*?)0+(?=[KM]?$)/, '$1');
export function usd(v, { sign = false } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  const a = Math.abs(n), s = n < 0 ? '-' : sign && n > 0 ? '+' : '';
  const body = a >= 1e6 ? trim(`${(a / 1e6).toFixed(2)}M`) : a >= 1e3 ? trim(`${(a / 1e3).toFixed(1)}K`) : a >= 100 ? a.toFixed(0) : a.toFixed(2);
  return `${s}$${body}`;
}
// "50k", "1.5m", "$25,000" -> number
export function parseUsd(text) {
  const m = /^\$?([\d,]*\.?\d+)\s*([km])?$/i.exec(String(text ?? '').trim());
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, '')) * ({ k: 1e3, m: 1e6 }[m[2]?.toLowerCase()] ?? 1);
  return Number.isFinite(n) ? n : null;
}
// 84,566.2 / 113.05 / 0.024467: five significant digits, grouped above 1,000.
export const fmtPrice = v => { const n = Number(v); if (v === null || v === undefined || !Number.isFinite(n)) return '—'; return n >= 1000 ? n.toLocaleString('en-US', { maximumFractionDigits: 1 }) : String(+n.toPrecision(5)); };
const assetOf = s => String(s ?? '').replace(/(\s+perp|[_-]v\d+)$/i, '').trim().toUpperCase();
const isKey = t => /^(0x[0-9a-fA-F]{40}|\d{1,9})$/.test(t);

export function createAlerts({ token, fetch: doFetch = globalThis.fetch, store, resolveAccount, tradeViews, accountState, fundingSeed = async () => [], symbolOf = id => `#${id}`, marketIds = () => [], site = 'https://plumb.huginn.tech', explorer = 'https://monadvision.com', log = () => {}, now = () => Date.now(), sendGapMs = 1100, maxChats = MAX_CHATS }) {
  const api = `https://api.telegram.org/bot${token}`;
  // chat id (string) -> { wallets: { [accountId]: address }, liqs: { min, market } | null, trades: { min, market } | null, funding: bool, levels?: 'early' | 'standard' | 'late' }
  let subs = {};
  let offset = 0, running = false, dirty = false, riskTimer = null, pollAbort = null, riskBusy = false;
  const lastFundingSign = new Map(); // market -> -1 | 1
  const warned = new Map(); // `${chat}:${account}:${market}:${side}` -> lowest level warned
  const awaiting = new Map(); // chat -> 'watch' after the "Watch a wallet" button
  const stats = { chats: 0, sent: 0, failed: 0, dropped: 0, commands: 0 };

  // --- persistence -------------------------------------------------------------
  async function load() {
    try { const saved = await store.load(); if (saved) ({ subs = {}, offset = 0 } = saved); } catch (error) { log('warn', `alerts: load failed: ${error.message}`); }
    stats.chats = Object.keys(subs).length;
  }
  async function save() {
    if (!dirty) return;
    dirty = false;
    // Chats that turned everything off are not kept.
    for (const [id, c] of Object.entries(subs)) if (!Object.keys(c.wallets).length && !c.liqs && !c.trades && !c.funding) delete subs[id];
    stats.chats = Object.keys(subs).length;
    try { await store.save({ subs, offset }); } catch (error) { dirty = true; log('warn', `alerts: save failed: ${error.message}`); }
  }
  const touch = () => { dirty = true; stats.chats = Object.keys(subs).length; };
  const chatOf = id => (subs[id] ??= { wallets: {}, liqs: null, trades: null, funding: false });
  // A new chat is refused once the service holds maxChats; existing chats keep working.
  const full = id => !subs[id] && Object.keys(subs).length >= maxChats;
  const FULL = 'The alert service is full right now.';
  // Warnings sent for a chat's wallet (or all of its wallets) are forgotten when it stops watching.
  const forget = (chat, id = null) => { const prefix = id === null ? `${chat}:` : `${chat}:${id}:`; for (const key of [...warned.keys()]) if (key.startsWith(prefix)) warned.delete(key); };
  const drop = id => { if (subs[id]) { delete subs[id]; touch(); } forget(id); };
  const EMPTY = { wallets: {}, liqs: null, trades: null, funding: false };
  const levelsOf = chat => LEVELS[subs[chat]?.levels] ?? LEVELS.standard;

  // --- Telegram calls: one message at a time per chat, spaced for its limits ----
  const queues = new Map();
  async function call(method, body) {
    const res = await doFetch(`${api}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: pollAbort && method === 'getUpdates' ? pollAbort.signal : undefined });
    const json = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
    if (!json.ok) throw Object.assign(new Error(json.description || 'telegram error'), { code: json.error_code, retryAfter: json.parameters?.retry_after });
    return json.result;
  }
  const payload = reply => (typeof reply === 'string' ? { text: reply } : reply);
  const markup = keyboard => (keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {});
  // An alert carries the time of its event (`ts`, unix seconds): it is dropped
  // if it has gone stale by the time its turn comes, and the oldest waiting
  // alerts give way when a busy chat's queue grows past MAX_QUEUED. Replies to
  // commands and buttons (no `ts`) are always sent.
  const waiting = new Map(); // chat -> alert jobs not yet started
  function send(chat, reply, ts = null) {
    const { text, keyboard } = payload(reply);
    const job = { dropped: false };
    if (ts !== null) {
      const list = waiting.get(chat) ?? [];
      list.push(job); waiting.set(chat, list);
      if (list.length > MAX_QUEUED) { list.shift().dropped = true; stats.dropped++; }
    }
    const prev = queues.get(chat) ?? Promise.resolve();
    const next = prev.then(async () => {
      if (ts !== null) {
        const list = waiting.get(chat) ?? [], i = list.indexOf(job);
        if (i >= 0) list.splice(i, 1);
        if (!list.length) waiting.delete(chat);
        if (job.dropped) return;
        if (now() / 1000 - Number(ts) > STALE_S) { stats.dropped++; return; }
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        try { await call('sendMessage', { chat_id: chat, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...markup(keyboard) }); stats.sent++; break; }
        catch (error) {
          if (error.code === 403 || error.code === 400 && /chat not found/i.test(error.message)) { drop(chat); break; } // blocked or gone
          if (error.code === 429 && attempt < 2) { await new Promise(r => setTimeout(r, (error.retryAfter ?? 1) * 1000)); continue; }
          // A network failure (no answer from Telegram) is retried too, after a pause.
          if (error.code === undefined && attempt < 2) { await new Promise(r => setTimeout(r, 2000 * (attempt + 1))); continue; }
          stats.failed++; log('warn', `alerts: send failed: ${error.message}`); break;
        }
      }
      await new Promise(r => setTimeout(r, sendGapMs));
    });
    queues.set(chat, next);
    next.finally(() => { if (queues.get(chat) === next) queues.delete(chat); });
    return next;
  }
  // Buttons edit the message they sit on, so the menu stays one message.
  async function edit(chat, messageId, reply) {
    const { text, keyboard } = payload(reply);
    try { await call('editMessageText', { chat_id: chat, message_id: messageId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...markup(keyboard) }); }
    catch (error) { if (!/not modified/i.test(error.message)) await send(chat, reply); }
  }

  // --- screens ---------------------------------------------------------------------
  const walletLink = (address, id) => `<a href="${site}/wallet/${escHtml(address || id)}">${escHtml(address ? short(address) : `#${id}`)}</a>`;
  const onMarket = market => (market !== null && market !== undefined ? ` on ${escHtml(symbolOf(market))}` : '');
  const btn = (text, data) => ({ text, callback_data: data });
  const back = [btn('‹ Menu', 'menu')];
  function menu(chat) {
    const s = subs[chat] ?? EMPTY, n = Object.keys(s.wallets).length;
    const state = on => (on ? '✅' : '▫️');
    return {
      text: [
        '<b>Plumb · Perpl alerts</b>',
        'Live from Monad, the moment a block lands.',
        '',
        `${state(n)} <b>Wallets</b>  ${n ? `${n} watched · warnings at ${levelsOf(chat).join('%, ')}% from liquidation` : 'your positions: every change, and a warning before liquidation'}`,
        `${state(s.liqs)} <b>Liquidations</b>  ${s.liqs ? `${usd(s.liqs.min)} and up${onMarket(s.liqs.market)}` : 'off'}`,
        `${state(s.trades)} <b>Large trades</b>  ${s.trades ? `${usd(s.trades.min)} and up${onMarket(s.trades.market)}` : 'off'}`,
        `${state(s.funding)} <b>Funding flips</b>  ${s.funding ? 'on' : 'off'}`
      ].join('\n'),
      keyboard: [
        [btn('👛 Watch a wallet', 'watch'), btn('📍 My positions', 'pos')],
        [btn('📋 Wallets', 'list'), btn('🎚 Warning levels', 'levels')],
        [btn('💥 Liquidations', 'liqs'), btn('🐋 Large trades', 'trades')],
        [btn(s.funding ? '🔁 Funding flips: on' : '🔁 Funding flips: off', 'funding')],
        [{ text: '📊 Open Plumb', url: site }]
      ]
    };
  }
  function picker(chat, kind) {
    const s = subs[chat] ?? EMPTY, cur = s[kind]?.min, steps = kind === 'liqs' ? LIQ_STEPS : TRADE_STEPS;
    return {
      text: kind === 'liqs'
        ? '💥 <b>Liquidations</b>\nGet every liquidation and deleverage at least this large.\n<i>For one market: /liqs 25k BTC</i>'
        : '🐋 <b>Large trades</b>\nGet every taker trade at least this large.\n<i>For one market: /trades 100k ETH</i>',
      keyboard: [steps.map(v => btn(`${cur === v ? '• ' : ''}${usd(v)}+`, `${kind}:${v}`)), [btn(s[kind] ? 'Turn off' : '· off ·', `${kind}:off`), ...back]]
    };
  }
  function wallets(chat) {
    const s = subs[chat] ?? EMPTY, list = Object.entries(s.wallets);
    return {
      text: list.length ? `📋 <b>Watched wallets</b>\n${list.map(([id, a]) => `• ${walletLink(a, id)}`).join('\n')}\n\nTap one to stop watching it.` : '📋 <b>Watched wallets</b>\nNone yet. Tap <b>Watch a wallet</b> or send an address.',
      keyboard: [...list.map(([id, a]) => [btn(`✖ ${a ? short(a) : `#${id}`}`, `unwatch:${id}`)]), back]
    };
  }
  function levelsScreen(chat) {
    const cur = subs[chat]?.levels ?? 'standard';
    return {
      text: '🎚 <b>Liquidation warnings</b>\nHow far from its liquidation price a watched position is when you hear about it. One message per level; it re-arms once the position recovers.',
      keyboard: [...Object.keys(LEVELS).map(k => [btn(`${k === cur ? '• ' : ''}${LEVEL_NAMES[k]}`, `levels:${k}`)]), back]
    };
  }
  // Live state of each watched wallet from contract state, closest to liquidation first.
  async function positions(chat) {
    const list = Object.entries(subs[chat]?.wallets ?? {});
    if (!list.length) return { text: '📍 <b>My positions</b>\nWatch a wallet first: tap <b>Watch a wallet</b> or send an address.', keyboard: [[btn('👛 Watch a wallet', 'watch')], back] };
    const blocks = [];
    for (const [id, address] of list) {
      let st;
      try { st = await accountState(Number(id)); } catch { blocks.push(`${walletLink(address, id)}\n<i>unavailable right now</i>`); continue; }
      const pf = st?.portfolio ?? {}, ps = [...(st?.positions ?? [])].sort((a, b) => (a.liquidation_distance_pct ?? 1e9) - (b.liquidation_distance_pct ?? 1e9));
      const head = `👛 ${walletLink(address, id)}${pf.account_value !== undefined ? ` · value <b>${usd(pf.account_value)}</b>` : ''}${pf.unrealized_pnl !== undefined ? ` · uPnL <b>${usd(pf.unrealized_pnl, { sign: true })}</b>` : ''}`;
      const lines = ps.map(q => {
        const d = q.liquidation_distance_pct, dot = d === null || d === undefined ? '⚪' : d <= 5 ? '🔴' : d <= 10 ? '🟠' : d <= 20 ? '🟡' : '🟢';
        return `${dot} <b>${escHtml(assetOf(q.symbol))} ${escHtml(String(q.side).toUpperCase())}</b> ${usd(q.notional)} · ${q.leverage ? `${Number(q.leverage).toFixed(1)}x` : '—'} · PnL ${usd(q.pnl, { sign: true })}\n     liq ${fmtPrice(q.liquidation_price)} · <b>${d === null || d === undefined ? '—' : `${Number(d).toFixed(1)}% away`}</b>`;
      });
      blocks.push(`${head}\n${lines.length ? lines.join('\n') : '<i>no open positions</i>'}`);
    }
    const time = new Date(now()).toISOString().slice(11, 19);
    // Within Telegram's 4096 characters: later wallets are left out with a note.
    let body = '', shown = 0;
    for (const b of blocks) { if (body.length + b.length > 3500) break; body += (body ? '\n\n' : '') + b; shown++; }
    if (shown < blocks.length) body += `\n\n<i>+${blocks.length - shown} more wallets: /list</i>`;
    return { text: `📍 <b>My positions</b>\n\n${body}\n\n<i>Contract state · ${time} UTC</i>`, keyboard: [[btn('🔄 Refresh', 'pos'), ...back]] };
  }
  const watchPrompt = { text: '👛 <b>Watch a wallet</b>\nSend a 0x address or a Perpl account id.\nYou will get its position changes, and a warning before any of its positions is liquidated.', keyboard: [back] };

  // --- actions ---------------------------------------------------------------------
  const marketByName = name => {
    if (!name) return null;
    const want = assetOf(name);
    const ids = marketIds().filter(id => assetOf(symbolOf(id)) === want);
    return ids.length ? ids.at(-1) : undefined; // the newest listing of that asset
  };
  async function watchWallet(chat, key, remove = false) {
    let acct;
    try { acct = await resolveAccount(key); } catch { acct = null; }
    if (!acct) return '🤷 No Perpl account found for that address or id.';
    const id = String(acct.id);
    if (remove) { unwatch(chat, id); return { text: `Stopped watching ${walletLink(acct.address, id)}.`, keyboard: [back] }; }
    if (full(chat)) return FULL;
    const s = chatOf(chat);
    if (!s.wallets[id] && Object.keys(s.wallets).length >= MAX_WALLETS) return `You can watch up to ${MAX_WALLETS} wallets.`;
    s.wallets[id] = acct.address ?? null; touch();
    return { text: `👛 <b>Watching</b> ${walletLink(acct.address, id)}\nPosition changes, and a warning at ${levelsOf(chat).join('%, ')}% from liquidation.`, keyboard: [[btn('📍 Positions now', 'pos'), { text: '📊 On Plumb', url: `${site}/wallet/${acct.address || id}` }], back] };
  }
  function unwatch(chat, id) {
    if (subs[chat]) { delete subs[chat].wallets[id]; touch(); }
    forget(chat, id);
  }
  // False when a new chat cannot be added.
  function setThreshold(chat, kind, min, market = null) {
    if (min === null) { if (subs[chat]) { subs[chat][kind] = null; touch(); } return true; }
    if (full(chat)) return false;
    chatOf(chat)[kind] = { min, market }; touch();
    return true;
  }
  function setFunding(chat, on) {
    if (!on) { if (subs[chat]) { subs[chat].funding = false; touch(); } return true; }
    if (full(chat)) return false;
    chatOf(chat).funding = true; touch();
    return true;
  }

  async function handle(chat, text) {
    stats.commands++;
    const trimmed = String(text).trim();
    // A bare address or id watches it, as does any text after "Watch a wallet".
    if (!trimmed.startsWith('/')) {
      if (awaiting.get(chat) === 'watch' || isKey(trimmed)) { awaiting.delete(chat); return watchWallet(chat, trimmed); }
      return menu(chat);
    }
    awaiting.delete(chat);
    const [raw, ...args] = trimmed.split(/\s+/);
    let cmd = raw.toLowerCase().replace(/@\w+$/, '');
    // Deep links from the dashboard: t.me/<bot>?start=watch_<address>
    if (cmd === '/start' && /^watch_/.test(args[0] ?? '')) { cmd = '/watch'; args[0] = args[0].slice(6); }
    switch (cmd) {
      case '/start': case '/help': case '/menu': return menu(chat);
      case '/list': return wallets(chat);
      case '/positions': case '/pos': return positions(chat);
      case '/stop': drop(chat); return { text: 'All your alerts are removed.', keyboard: [back] };
      case '/watch': case '/unwatch':
        if (!args[0]) { if (cmd === '/unwatch') return wallets(chat); awaiting.set(chat, 'watch'); return watchPrompt; }
        return watchWallet(chat, args[0], cmd === '/unwatch');
      case '/liqs': case '/trades': {
        const kind = cmd.slice(1);
        if (!args[0]) return picker(chat, kind);
        if (/^off$/i.test(args[0])) { setThreshold(chat, kind, null); return menu(chat); }
        const min = parseUsd(args[0]);
        if (min === null) return `Usage: /${kind} <i>min USD</i> [<i>market</i>], e.g. /${kind} 25k BTC`;
        if (min < MIN_USD) return `The minimum is ${usd(MIN_USD)}.`;
        const market = marketByName(args[1]);
        if (market === undefined) return `Unknown market ${escHtml(args[1])}.`;
        return setThreshold(chat, kind, min, market) ? menu(chat) : FULL;
      }
      case '/funding': return setFunding(chat, !/^off$/i.test(args[0] ?? 'on')) ? menu(chat) : FULL;
      default: return menu(chat);
    }
  }
  // Button taps: returns [the screen to show, a short toast].
  async function press(chat, data) {
    stats.commands++;
    const [what, arg] = String(data).split(':');
    switch (what) {
      case 'menu': awaiting.delete(chat); return [menu(chat)];
      case 'watch': awaiting.set(chat, 'watch'); return [watchPrompt];
      case 'list': return [wallets(chat)];
      case 'pos': return [await positions(chat), 'Updated'];
      case 'levels': {
        if (!arg) return [levelsScreen(chat)];
        if (!LEVELS[arg]) return [levelsScreen(chat)];
        if (full(chat)) return [{ text: FULL, keyboard: [back] }];
        chatOf(chat).levels = arg; touch();
        return [menu(chat), LEVEL_NAMES[arg]];
      }
      case 'unwatch': unwatch(chat, arg); return [wallets(chat), 'Stopped watching'];
      case 'liqs': case 'trades': {
        if (!arg) return [picker(chat, what)];
        const min = arg === 'off' ? null : Number(arg);
        if (min !== null && !(Number.isFinite(min) && min >= MIN_USD)) return [picker(chat, what)];
        if (!setThreshold(chat, what, min, min === null ? null : subs[chat]?.[what]?.market ?? null)) return [{ text: FULL, keyboard: [back] }];
        return [menu(chat), min === null ? 'Turned off' : `${usd(min)} and up`];
      }
      case 'funding': { const on = !subs[chat]?.funding; if (!setFunding(chat, on)) return [{ text: FULL, keyboard: [back] }]; return [menu(chat), on ? 'Funding flips on' : 'Funding flips off']; }
      default: return [menu(chat)];
    }
  }

  // --- alert messages --------------------------------------------------------------
  const txLink = tx => (tx ? `<a href="${explorer}/tx/${escHtml(tx)}">tx ↗</a>` : '');
  const sideOf = v => (v.side ? v.side.toUpperCase() : '');
  const fill = v => `${escHtml(v.size)} ${escHtml(assetOf(v.symbol))} @ ${fmtPrice(v.price ?? v.mark)}`;
  const pnlPart = v => (['decrease', 'close', 'invert', 'liquidation', 'deleverage'].includes(v.kind) && Number(v.pnl) ? ` · PnL <b>${usd(v.pnl, { sign: true })}</b>` : '');
  function walletAlert(v) {
    const [icon, verb] = EVENT[v.kind];
    return `${icon} <b>${verb} ${escHtml(assetOf(v.symbol))} ${sideOf(v)}</b> · ${walletLink(v.address, v.account)}\n<b>${usd(v.notional)}</b> · ${fill(v)}${pnlPart(v)}\n${txLink(v.tx)}`;
  }
  function liqAlert(v) {
    return `${v.kind === 'liquidation' ? '💥 <b>Liquidation' : '⚠️ <b>Deleverage'} · ${escHtml(assetOf(v.symbol))} ${sideOf(v)}</b>\n<b>${usd(v.notional)}</b> · ${fill(v)}${pnlPart(v)}\n${walletLink(v.address, v.account)} · ${txLink(v.tx)}`;
  }
  function tradeAlert(v) {
    const [, verb] = EVENT[v.kind];
    return `🐋 <b>Large ${v.buy ? 'buy' : 'sell'} · ${escHtml(assetOf(v.symbol))}</b>\n<b>${usd(v.notional)}</b> · ${fill(v)}\n${walletLink(v.address, v.account)} ${verb.toLowerCase()} ${sideOf(v).toLowerCase()} · ${txLink(v.tx)}`;
  }
  // Called with each committed range of blocks (ingest 'commit' events).
  async function onCommit(event) {
    // Funding direction: positive rates mean longs pay. Zero keeps the last
    // direction. It is tracked on every commit, so a later subscriber is never
    // told about a change that happened before.
    const flips = [];
    for (const f of event.funding ?? []) {
      const rate = Number(f.actual_rate) / 1000, sign = Math.sign(rate);
      if (!sign) continue;
      const before = lastFundingSign.get(f.market);
      lastFundingSign.set(f.market, sign);
      if (before !== undefined && before !== sign) flips.push(`🔁 <b>Funding flipped · ${escHtml(assetOf(symbolOf(f.market)))}</b>\n${sign > 0 ? 'Longs now pay shorts' : 'Shorts now pay longs'} · ${rate > 0 ? '+' : ''}${rate.toFixed(4)}% this interval`);
    }
    const chats = Object.entries(subs);
    if (!chats.length) return;
    // Catching up after downtime: old events are not news.
    if (now() / 1000 - Number(event.ts) > STALE_S) return;
    const watched = new Set(chats.flatMap(([, s]) => Object.keys(s.wallets)));
    const needTrades = chats.some(([, s]) => s.trades), needLiqs = chats.some(([, s]) => s.liqs);
    const rows = event.ev.filter(r => KINDS.includes(r.kind) && (watched.has(String(r.account)) || needLiqs && (r.kind === 'liquidation' || r.kind === 'deleverage') || needTrades && r.role === 'taker'));
    const views = rows.length ? await tradeViews(rows) : [];
    const out = new Map(); // chat -> alerts
    const add = (chat, text) => { if (!out.has(chat)) out.set(chat, []); out.get(chat).push(text); };
    for (const [chat, s] of chats) {
      for (const v of views) {
        const n = Number(v.notional);
        if (s.wallets[String(v.account)] !== undefined) add(chat, walletAlert(v));
        else if (s.liqs && (v.kind === 'liquidation' || v.kind === 'deleverage') && n >= s.liqs.min && (s.liqs.market === null || v.market === s.liqs.market)) add(chat, liqAlert(v));
        else if (s.trades && v.role === 'taker' && v.kind !== 'liquidation' && n >= s.trades.min && (s.trades.market === null || v.market === s.trades.market)) add(chat, tradeAlert(v));
      }
    }
    if (flips.length) for (const [chat, s] of chats) if (s.funding) flips.forEach(text => add(chat, text));
    await Promise.all([...out].map(([chat, texts]) => sendAll(chat, texts, Number(event.ts))));
  }
  // Alerts of one block range go out together; Telegram caps a message at 4096 characters.
  function sendAll(chat, texts, ts) {
    const parts = [];
    let cur = '';
    for (const t of texts) { if (cur && cur.length + t.length + 2 > 3800) { parts.push(cur); cur = ''; } cur += (cur ? '\n\n' : '') + t; }
    if (cur) parts.push(cur);
    return Promise.all(parts.map(p => send(chat, p, ts)));
  }

  // Positions of watched wallets against their liquidation price, from contract
  // state. A run is skipped while the previous one is still going.
  async function checkRisk() {
    if (riskBusy) return;
    riskBusy = true;
    try { await checkRiskOnce(); } finally { riskBusy = false; }
  }
  async function checkRiskOnce() {
    const byAccount = new Map();
    for (const [chat, s] of Object.entries(subs)) for (const id of Object.keys(s.wallets)) { if (!byAccount.has(id)) byAccount.set(id, []); byAccount.get(id).push(chat); }
    // Warnings of wallets no longer watched are forgotten.
    for (const key of [...warned.keys()]) { const [chat, id] = key.split(':'); if (subs[chat]?.wallets[id] === undefined) warned.delete(key); }
    for (const [id, chats] of byAccount) {
      let state;
      try { state = await accountState(Number(id)); } catch { continue; }
      const live = new Set();
      for (const p of state?.positions ?? []) {
        const d = p.liquidation_distance_pct;
        for (const chat of chats) {
          const key = `${chat}:${id}:${p.market}:${p.side}`;
          live.add(key);
          if (d === null || d === undefined) continue;
          const levels = levelsOf(chat);
          if (d > levels[0] + 5) { warned.delete(key); continue; }
          const level = levels.filter(x => d <= x).at(-1);
          if (level === undefined || (warned.get(key) ?? Infinity) <= level) continue;
          warned.set(key, level);
          // Not awaited: each chat's queue keeps the order, and one slow chat does not hold up the rest.
          // Sent without a time, so a busy queue never drops a warning.
          send(chat, `${level === levels.at(-1) ? '🚨' : '⚠️'} <b>Near liquidation · ${escHtml(assetOf(p.symbol))} ${escHtml(String(p.side).toUpperCase())}</b>\n${walletLink(subs[chat]?.wallets[id], id)} · <b>${usd(p.notional)}</b> position\nMark ${fmtPrice(p.mark)} → liquidation ${fmtPrice(p.liquidation_price)}\n<b>${d.toFixed(1)}% away</b>`);
        }
      }
      // A closed position clears its warning.
      for (const key of [...warned.keys()]) if (key.split(':')[1] === id && !live.has(key)) warned.delete(key);
    }
  }

  // --- polling loop --------------------------------------------------------------------
  async function pollOnce() {
    const updates = await call('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] });
    for (const u of updates) {
      offset = Math.max(offset, u.update_id + 1); dirty = true;
      try {
        if (u.callback_query) {
          const q = u.callback_query, chat = String(q.message?.chat?.id ?? '');
          if (!chat || q.message.chat.type !== 'private') continue;
          const [screen, toast] = await press(chat, q.data);
          call('answerCallbackQuery', { callback_query_id: q.id, ...(toast ? { text: toast } : {}) }).catch(() => {});
          await edit(chat, q.message.message_id, screen);
          continue;
        }
        const msg = u.message;
        if (!msg?.text || msg.chat?.type !== 'private') continue; // private chats only
        const chat = String(msg.chat.id);
        send(chat, await handle(chat, msg.text));
      } catch (error) { log('warn', `alerts: update failed: ${error.message}`); }
    }
    await save();
  }
  async function loop() {
    while (running) {
      try { await pollOnce(); }
      catch (error) { if (!running) break; log('warn', `alerts: poll failed: ${error.message}`); await new Promise(r => setTimeout(r, 5000)); }
    }
  }
  // The command list and the bot's profile texts, set on every start.
  async function profile() {
    await call('setMyCommands', { commands: COMMANDS.map(([command, description]) => ({ command, description })) });
    await call('setMyShortDescription', { short_description: 'Live Perpl alerts from Monad: wallets, liquidations, large trades, funding flips.' });
    await call('setMyDescription', { description: 'Plumb alerts for Perpl, the onchain perps exchange on Monad.\n\nWatch any wallet for position changes and liquidation warnings, and get large liquidations, large trades and funding flips as they land onchain.\n\nTap Start to open the menu.' });
  }
  async function start({ riskMs = 60000 } = {}) {
    await load();
    // The last direction per market, so the first flip after a restart is not missed.
    try { for (const f of await fundingSeed()) { const sign = Math.sign(Number(f.rate)); if (sign) lastFundingSign.set(Number(f.market), sign); } } catch (error) { log('warn', `alerts: funding seed failed: ${error.message}`); }
    running = true;
    pollAbort = new AbortController();
    loop();
    riskTimer = setInterval(() => { checkRisk().catch(error => log('warn', `alerts: risk check failed: ${error.message}`)); save(); }, riskMs);
    try { const me = await call('getMe', {}); stats.bot = me.username; log('info', `alerts: Telegram bot @${me.username}, ${stats.chats} chats`); } catch (error) { log('warn', `alerts: getMe failed: ${error.message}`); }
    profile().catch(error => log('warn', `alerts: profile update failed: ${error.message}`));
  }
  function stop() { running = false; pollAbort?.abort(); clearInterval(riskTimer); return save(); }

  return { start, stop, handle, press, onCommit, checkRisk, pollOnce, load, save, stats, subs: () => subs };
}

// Subscriptions live as one JSON value in the kv table.
export function kvStore(ch, key = 'alerts.telegram') {
  return {
    async load() { const r = await ch.first('SELECT value FROM kv FINAL WHERE key = {k:String}', { k: key }); return r ? JSON.parse(r.value) : null; },
    async save(value) { await ch.insert('kv', [{ key, value: JSON.stringify(value) }]); }
  };
}
