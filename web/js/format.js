// Formatting helpers. API amounts are exact decimal strings; they become
// floats only here, for display.
export const num = v => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };

const units = [['', 1], ['K', 1e3], ['M', 1e6], ['B', 1e9], ['T', 1e12]];
export function compact(v, { digits = 2, sign = false } = {}) {
  const n = num(v);
  if (n === null) return '—';
  const a = Math.abs(n), s = n < 0 ? '-' : sign && n > 0 ? '+' : '';
  if (a < 1) return `${s}${a.toFixed(a === 0 ? 0 : 4)}`;
  // Unit and decimals follow the rounded figure: 999.7 reads 1.00K and 99,999
  // reads 100.0K, never 1000 or 100.00K.
  for (let i = units.findLastIndex(([, k]) => a >= k); ; i++) {
    const [u, k] = units[i], x = a / k, t = x.toFixed(Number(x.toFixed(digits)) >= 100 ? (u ? 1 : 0) : digits);
    if (Number(t) < 1000 || i === units.length - 1) return `${s}${t}${u}`;
  }
}
export const usd = (v, opts = {}) => {
  const n = num(v);
  // Cents below a dollar, and a floor instead of long fractions; under a cent
  // the sign is dropped, as the amount shows as zero.
  if (n !== null && n !== 0 && Math.abs(n) < 1) { const s = n < 0 ? '-' : opts.sign ? '+' : ''; return Math.abs(n) < 0.005 ? '<$0.01' : `${s}$${Math.abs(n).toFixed(2)}`; }
  const t = compact(v, opts);
  return t === '—' ? t : t.startsWith('-') ? `-$${t.slice(1)}` : t.startsWith('+') ? `+$${t.slice(1)}` : `$${t}`;
};
export function usdFull(v, digits = 2) {
  const n = num(v);
  if (n === null) return '—';
  return `${n < 0 && Number(Math.abs(n).toFixed(digits)) > 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}
export function int(v) { const n = num(v); return n === null ? '—' : Math.round(n).toLocaleString('en-US'); }
// Decimals follow the price's size and are always written out, so a column of
// prices (a book, a tape) lines up: 0.02900 over 0.02858, never 0.029.
export function price(v) {
  const n = num(v);
  if (n === null) return '—';
  const a = Math.abs(n);
  const d = a >= 1000 ? 1 : a >= 100 ? 2 : a >= 1 ? 3 : a >= 0.01 ? 5 : 7;
  return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
export function pct(v, { digits = 2, sign = false } = {}) {
  const n = num(v);
  if (n === null) return '—';
  // Decimals follow the rounded figure (99.996 reads 100%, never 100.00%), and a
  // value that rounds to zero reads 0, with no minus or plus (never "-0.00%").
  const t = n.toFixed(Math.abs(Number(n.toFixed(digits))) >= 100 ? 0 : digits);
  return Number(t) === 0 ? `${t.replace('-', '')}%` : `${sign && n > 0 ? '+' : ''}${t}%`;
}
// A share of a total: none reads 0%, and one too small for a decimal <0.1%, never 0.0%.
export const share = v => { const n = num(v); return n === 0 ? '0%' : n !== null && n > 0 && n < 0.05 ? '<0.1%' : pct(v, { digits: 1 }); };
// Basis points, as pct: a value that rounds to zero reads 0.0 bps, with no minus or plus.
// An epoch's span, e.g. "Sep 16 → Sep 23, 16:00 UTC", or "since Sep 23, 16:00 UTC" while it runs.
export function epochSpan(from, to, running = false) {
  const day = ts => new Date(ts * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return running ? `since ${day(from)}, 16:00 UTC` : `${day(from)} → ${day(to)}, 16:00 UTC`;
}

export function bps(v, { digits = 1, sign = false } = {}) {
  const n = num(v);
  if (n === null) return '—';
  const t = n.toFixed(digits), shown = Number(t).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return Number(t) === 0 ? `${t.replace('-', '')} bps` : `${sign && n > 0 ? '+' : ''}${shown} bps`;
}
export function size(v) { const n = num(v); if (n === null) return '—'; const a = Math.abs(n); return n.toLocaleString('en-US', { maximumFractionDigits: a >= 100 ? 2 : a >= 1 ? 4 : 6 }); }
// Colour for a signed value as shown at `digits` decimals: one that rounds to zero is neutral.
export const signClass = (v, digits = 2) => { const n = num(v), r = n === null ? 0 : Number(n.toFixed(digits)); return r > 0 ? 'pos' : r < 0 ? 'neg' : ''; };
// invert: a rise is bad (liquidations, losses), so it takes the negative colour.
export function deltaHtml(change, invert = false, title = null) {
  const n = num(change);
  if (n === null) return '<span class="delta flat">—</span>';
  // Direction follows the change as shown: one that rounds to 0.0 % is flat.
  // Decimals follow the rounded figure too: 99.96 reads 100%, like 100.
  const dp = Math.abs(Number(n.toFixed(1))) >= 100 ? 0 : 1, r = Number(n.toFixed(dp));
  const good = invert ? r < 0 : r > 0, bad = invert ? r > 0 : r < 0;
  const cls = good ? 'up' : bad ? 'down' : 'flat';
  // Past +1000 % (from a near-empty previous window) a multiple reads better: "×113".
  const text = r >= 1000 ? `×${Math.round(1 + n / 100)}` : `${Math.abs(r).toFixed(dp)}%`;
  return `<span class="delta ${cls}" title="${esc(title ?? `${pct(n, { digits: 1 })} vs the previous period`)}">${r > 0 ? '▲' : r < 0 ? '▼' : ''} ${text}</span>`;
}
export function ago(ts) {
  if (!ts) return '—';
  const s = Math.max(0, Math.round(Date.now() / 1000 - Number(ts)));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
export function duration(sec) {
  const s = num(sec);
  if (s === null) return '—';
  // Unit and decimals follow the rounded figure: 59.6 s reads 1.0m and 23.8 h
  // 1.0d, never 60s or 24h. Under ten of a unit one decimal shows (2.4m, 1.5h).
  const fig = x => x.toFixed(Number(x.toFixed(1)) < 10 ? 1 : 0);
  if (Math.round(s) < 60) return `${Math.round(s)}s`;
  if (Math.round(s / 60) < 60) return `${fig(s / 60)}m`;
  if (Number(fig(s / 3600)) < 24) return `${fig(s / 3600)}h`;
  return `${fig(s / 86400)}d`;
}
const pad = n => String(n).padStart(2, '0');
export function dateTime(ts) { if (!ts) return '—'; const d = new Date(Number(ts) * 1000); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; }
export function date(ts) { if (!ts) return '—'; const d = new Date(Number(ts) * 1000); return `${d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} ${d.getUTCDate()}, ${d.getUTCFullYear()}`; }
export function timeOnly(ts) { const d = new Date(Number(ts) * 1000); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`; }
// Cover ratios round down, so a cover below 100 % never reads as full.
export function multiple(pctValue) {
  const n = num(pctValue);
  if (n === null) return '—';
  if (n >= 10000) return `${Math.floor(n / 100)}×`;
  if (n >= 1000) return `${(Math.floor(n / 10) / 10).toFixed(1)}×`;
  return n >= 100 ? `${Math.floor(n)}%` : `${(Math.floor(n * 10) / 10).toFixed(1)}%`;
}
// A key short enough to read (an account ID, a typed fragment) is shown whole.
export const short = a => { if (!a) return '—'; const t = String(a); return t.length > 12 ? `${t.slice(0, 6)}…${t.slice(-4)}` : t; };
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ESC[c]);
