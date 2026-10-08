// Alerts: the Telegram bot (what it sends, one tap to open it) above the
// watchlist of wallets starred in this browser, each with a link that starts
// watching it in Telegram. The watchlist itself stays in this browser only.
import { get } from '../api.js';
import { usd, int, esc, short, ago } from '../format.js';
import { table, pnl, empty, skeleton, watch, ICON, alertsLink, alertsBotReady, alertsBotName } from '../ui.js';

const FEATURES = [
  ['👛', 'Your wallets', 'Every position change: open, add, reduce, close, liquidation.'],
  ['🚨', 'Before liquidation', 'A warning as a position nears its liquidation price, at the levels you pick.'],
  ['📍', 'Positions on demand', 'Each watched wallet\'s positions now, closest to liquidation first.'],
  ['💥', 'Market moves', 'Large liquidations, large trades and funding flips, above sizes you pick.']
];

export function mount(el, { navigate }) {
  let alive = true, bot = alertsBotName();
  el.innerHTML = `<div class="page-head"><div><h1>Alerts</h1><div class="sub">Watch wallets here, and get their moves in Telegram as they land onchain.</div></div></div>
    <section class="panel alerts-hero" id="bot">${skeleton(3)}</section>
    <section class="panel"><div class="panel-head"><div><h2>Watchlist</h2><div class="desc">Wallets you star are kept in this browser only; the bell starts watching one in Telegram</div></div><button class="btn ghost" data-action="compare">${ICON.plus} Compare all</button></div>
      <div class="panel-body flush" id="list">${skeleton(6)}</div></section>`;
  const $ = s => el.querySelector(`#${s}`);

  // A sample of what the bot sends, drawn as a chat bubble.
  const sample = `<div class="tg-bubble" aria-hidden="true">
      <div class="tg-line">🚨 <b>BTC long near liquidation</b>  <span class="tg-link">#BTC</span></div>
      <div class="tg-line"><b>Distance:</b> 2.6%</div>
      <div class="tg-line"><b>Mark → liq:</b> 84,419.3 → 82,252.5</div>
      <div class="tg-line"><b>Position:</b> $478</div>
      <div class="tg-line"><b>Wallet:</b> <span class="tg-link">0xcfe9…b477</span></div>
      <div class="tg-time">15:55</div>
    </div>`;
  function renderBot() {
    const link = bot ? `https://t.me/${bot}` : null;
    $('bot').innerHTML = `<div class="alerts-grid">
      <div class="alerts-copy">
        <div class="alerts-kicker">${ICON.bell} Telegram bot${bot ? ` · @${esc(bot)}` : ''}</div>
        <h2>Alerts for the wallets you watch</h2>
        <div class="alerts-features">${FEATURES.map(([i, t, d]) => `<div class="alerts-f"><span class="alerts-fi">${i}</span><div><b>${t}</b><span>${d}</span></div></div>`).join('')}</div>
        ${link ? `<div class="alerts-cta"><a class="btn primary" href="${esc(link)}" target="_blank" rel="noopener noreferrer">Open @${esc(bot)} ${ICON.ext}</a><span class="faint">Free · send it a wallet address to start</span></div>` : '<div class="faint" style="margin-top:14px">Telegram alerts are not enabled on this server.</div>'}
      </div>
      <div class="alerts-demo">${sample}</div>
    </div>`;
  }

  async function load() {
    const list = watch.list();
    el.querySelector('[data-action="compare"]').disabled = !list.length;
    if (!list.length) { $('list').innerHTML = empty('No wallets yet. Star a wallet from the leaderboard, a feed or a wallet page.'); return; }
    const rows = await Promise.all(list.map(w => get(`wallets/${encodeURIComponent(w.key)}`, { maxAge: 10000 }).then(d => ({ key: w.key, added: w.added, d })).catch(() => ({ key: w.key, added: w.added, d: null }))));
    if (!alive) return;
    $('list').innerHTML = table({ id: 'watch', columns: [
      { key: 'a', label: 'Wallet', render: r => `<span class="addr"><a class="mono" href="/wallet/${esc(r.d?.account.address ?? r.key)}">${esc(short(r.d?.account.address ?? r.key))}</a><button class="icon-btn on" data-watch="${esc(r.key)}" title="Remove from watchlist">${ICON.star}</button></span>` },
      { key: 'v', label: 'Account value', n: true, render: r => usd(r.d?.portfolio?.account_value) },
      { key: 'o', label: 'Open positions', phone: false, n: true, render: r => int(r.d ? r.d.positions?.length ?? 0 : null) }, // a wallet that failed to load: unknown, not none
      { key: 'c', label: 'Closest liq.', n: true, render: r => { const d = r.d?.portfolio?.closest_liquidation?.distance_pct ?? null; return d === null ? '<span class="faint">—</span>' : `<span class="${d < 5 ? 'neg' : d < 15 ? 'warn-text' : 'muted'}">${d.toFixed(1)}% away</span>`; } },
      { key: 'u', label: 'Unrealized PnL', phone: false, n: true, render: r => pnl(r.d?.portfolio?.unrealized_pnl) },
      { key: 'p', label: 'Net PnL', phone: false, n: true, render: r => pnl(r.d?.summary.net_pnl) },
      { key: 'l', label: 'Last trade', phone: false, n: true, render: r => `<span class="muted">${r.d?.summary.last_trade ? ago(r.d.summary.last_trade) : '—'}</span>` },
      { key: 't', label: '', n: true, render: r => { const link = alertsLink(r.d?.account.address); return link ? `<a class="btn ghost sm" href="${esc(link)}" target="_blank" rel="noopener noreferrer" title="Watch this wallet in Telegram">${ICON.bell} Alert me</a>` : ''; } }
    ], rows, rowAttrs: r => `class="link" data-href="/wallet/${esc(r.d?.account.address ?? r.key)}"` });
  }
  const onChange = () => load().catch(() => {});
  window.addEventListener('watchlist', onChange);
  renderBot();
  // The bot's name comes with /health; the page redraws once it is known.
  alertsBotReady.then(() => { if (!alive) return; bot = alertsBotName(); renderBot(); load().catch(() => {}); });
  load().catch(() => {});
  return {
    onAction(a) { if (a === 'compare') navigate('/compare', { w: watch.list().slice(0, 5).map(w => w.key).join(',') }); },
    destroy() { alive = false; window.removeEventListener('watchlist', onChange); }
  };
}
