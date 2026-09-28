// ECharts (self-hosted) with the Plumb theme. Every chart has one value
// axis, thin marks, a recessive grid and a hover tooltip; colours come from
// the validated categorical palette or the long/short pair.
import { usd, compact, dateTime, date, num, esc } from './format.js';

const T = {
  text: 'rgba(224,225,255,0.70)', faint: 'rgba(255,255,255,0.42)', grid: 'rgba(255,255,255,0.05)', axis: 'rgba(255,255,255,0.10)',
  accent: '#a2a4ff', long: '#81c784', short: '#f65a6e', tooltip: '#24222a', border: 'rgba(255,255,255,0.12)', font: 'Geist, ui-sans-serif, system-ui, sans-serif'
};
export const COLORS = T;
const registry = new Set();
const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(entries => { for (const e of entries) e.target.__chart?.resize(); }) : null;

function init(el) {
  if (!el || !window.echarts) return null;
  let chart = el.__chart;
  // A view that re-renders clears the node (innerHTML = ''), which detaches
  // the chart's own DOM: drop that instance and draw a fresh one.
  if (chart && (chart.isDisposed() || !el.contains(chart.__root))) {
    try { observer?.unobserve(el); chart.dispose(); } catch { /* already gone */ }
    registry.delete(chart); chart = null; el.__chart = null;
  }
  if (!chart) {
    chart = window.echarts.init(el, null, { renderer: 'canvas' });
    chart.__root = el.lastElementChild; // echarts appends its own root
    el.__chart = chart; registry.add(chart); observer?.observe(el);
  }
  return chart;
}
// Exports: the plotted data (time-aligned series, as shown) and the image.
// Text that a spreadsheet would run as a formula is prefixed with a quote.
const csvCell = v => { let t = String(v ?? ''); if (typeof v === 'string' && /^[=+\-@\t\r]/.test(t) && !Number.isFinite(Number(t))) t = `'${t}`; return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
export function chartCsv(el) {
  const chart = el?.__chart; if (!chart) return null;
  const o = chart.getOption();
  const times = o.xAxis?.[0]?.data ?? [];
  const cols = [];
  for (const s of o.series ?? []) {
    const value = d => (d && typeof d === 'object' && !Array.isArray(d) ? d.value : d);
    if (s.type === 'candlestick') ['open', 'close', 'low', 'high'].forEach((k, j) => cols.push({ name: `${s.name ?? 'price'} ${k}`, at: i => value(s.data?.[i])?.[j] }));
    else if (s.type === 'heatmap') (o.yAxis?.[0]?.data ?? []).forEach((name, y) => { const byX = new Map((s.data ?? []).filter(d => d[1] === y).map(d => [d[0], d[2]])); cols.push({ name, at: i => byX.get(i) }); });
    else cols.push({ name: s.name ?? `series ${cols.length + 1}`, at: i => { const v = value(s.data?.[i]); return Array.isArray(v) ? v[1] : v; } });
  }
  const iso = t => (/^\d+$/.test(String(t)) ? new Date(Number(t) * 1000).toISOString().replace('.000Z', 'Z') : t);
  const lines = [['time_utc', ...cols.map(c => c.name)], ...times.map((t, i) => [iso(t), ...cols.map(c => { const v = c.at(i); return v === '-' || v === null || v === undefined ? '' : v; })])];
  return lines.map(r => r.map(csvCell).join(',')).join('\n');
}
export const chartPng = el => el?.__chart?.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: '#0e0d10' }) ?? null;

// Shows or hides one series (legend chips outside the canvas drive this).
export function toggleSeries(el, name) { el?.__chart?.dispatchAction({ type: 'legendToggleSelect', name }); }
export function disposeAll() { for (const c of registry) { try { observer?.unobserve(c.getDom()); c.dispose(); } catch { /* already gone */ } } registry.clear(); }

const base = () => ({
  animation: true, animationDuration: 300, animationDurationUpdate: 250,
  textStyle: { fontFamily: T.font, color: T.text, fontSize: 11 },
  grid: { left: 8, right: 12, top: 14, bottom: 6, containLabel: true },
  tooltip: {
    trigger: 'axis', backgroundColor: T.tooltip, borderColor: T.border, borderWidth: 1, padding: [8, 10], textStyle: { color: '#fff', fontSize: 12, fontFamily: T.font },
    axisPointer: { type: 'line', lineStyle: { color: 'rgba(162,164,255,0.35)', width: 1 }, shadowStyle: { color: 'rgba(162,164,255,0.06)' } },
    extraCssText: 'box-shadow:0 10px 30px rgba(0,0,0,.5);border-radius:6px;'
  }
});
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Sub-day buckets show clock time and switch to the date at midnight UTC.
export function timeLabel(v, bucketSeconds) {
  const d = new Date(Number(v) * 1000);
  const day = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  if (bucketSeconds >= 86400 || (d.getUTCHours() === 0 && d.getUTCMinutes() === 0)) return day;
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
const timeAxis = (times, bucketSeconds) => ({
  type: 'category', data: times, boundaryGap: true,
  axisLine: { lineStyle: { color: T.axis } }, axisTick: { show: false },
  axisLabel: { color: T.faint, hideOverlap: true, formatter: v => timeLabel(v, bucketSeconds), margin: 10 }
});
// 1, 2, 2.5 or 5 times a power of ten, at or above v.
const niceCeil = v => { const p = 10 ** Math.floor(Math.log10(v)); return [1, 2, 2.5, 5, 10].map(k => k * p).find(x => x >= v); };
// Axis money: $1.5M, $900K, $0.
export const usdAxis = v => { const n = Number(v); if (!n) return '$0'; const a = Math.abs(n); const [k, u] = a >= 1e9 ? [1e9, 'B'] : a >= 1e6 ? [1e6, 'M'] : a >= 1e3 ? [1e3, 'K'] : [1, '']; const x = a / k; return `${n < 0 ? '-' : ''}$${x >= 100 || Number.isInteger(x) ? Math.round(x) : x.toFixed(1).replace(/\.0$/, '')}${u}`; };
const valueAxis = fmt => ({ type: 'value', splitNumber: 4, axisLabel: { color: T.faint, formatter: fmt, margin: 10 }, splitLine: { lineStyle: { color: T.grid } }, axisLine: { show: false }, axisTick: { show: false } });
const row = (color, name, value) => `<div style="display:flex;justify-content:space-between;gap:18px;line-height:1.7"><span><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${color};margin-right:7px"></span>${esc(name)}</span><b style="font-weight:500;font-variant-numeric:tabular-nums">${value}</b></div>`;
// The last bucket while its period is still running: its bar is drawn faded
// and its tooltip says so, so a half-filled hour does not read as a drop.
function partialAt(times, bucketSeconds) {
  const last = Number(times?.at?.(-1));
  return Number.isFinite(last) && bucketSeconds > 0 && last + bucketSeconds > Date.now() / 1000 ? times.length - 1 : -1;
}
const PARTIAL_OPACITY = 0.4;
const fade = (data, at) => (at < 0 ? data : data.map((d, i) => (i !== at ? d : d && typeof d === 'object' && !Array.isArray(d) ? { ...d, itemStyle: { ...d.itemStyle, opacity: PARTIAL_OPACITY } } : { value: d, itemStyle: { opacity: PARTIAL_OPACITY } })));
function tooltip(fmt, bucketSeconds, { total = false, exclude = null, partial = -1 } = {}) {
  return params => {
    const all = Array.isArray(params) ? params : [params];
    // A running-total line is shown on its own row, outside the per-period sum.
    const extra = exclude ? all.find(p => p.seriesName === exclude) : null;
    const list = exclude ? all.filter(p => p.seriesName !== exclude) : all;
    if (!list.length) return '';
    const t = list[0].axisValue;
    const running = partial >= 0 && list[0].dataIndex === partial ? ' · in progress' : '';
    const head = `<div style="color:${T.faint};margin-bottom:4px">${bucketSeconds >= 86400 ? date(t) : dateTime(t) + ' UTC'}${running}</div>`;
    const rows = list.filter(p => p.value !== null && p.value !== undefined && p.value !== 0 && p.value !== '-').sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).slice(0, 10);
    const sum = list.reduce((a, p) => a + (num(p.value) ?? 0), 0);
    const foot = [total && list.length > 1 ? row('transparent', 'Total', fmt(sum)) : '', extra && extra.value !== null && extra.value !== undefined ? row('#ffffff', extra.seriesName, fmt(extra.value)) : ''].join('');
    return head + rows.map(p => row(p.color, p.seriesName, fmt(p.value))).join('') + (foot ? `<div style="border-top:1px solid ${T.border};margin-top:4px;padding-top:4px">${foot}</div>` : '');
  };
}

export function sparkline(el, values, { color = T.accent, area = true } = {}) {
  const chart = init(el);
  if (!chart) return;
  chart.setOption({
    animation: false, grid: { left: 0, right: 0, top: 2, bottom: 2 },
    xAxis: { type: 'category', show: false, data: values.map((_, i) => i) }, yAxis: { type: 'value', show: false, scale: true },
    series: [{ type: 'line', data: values, symbol: 'none', smooth: 0.25, lineStyle: { color, width: 1.5 }, areaStyle: area ? { color: new window.echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: color + '4d' }, { offset: 1, color: color + '05' }]) } : undefined }]
  }, true);
}

// A range slider under a time chart (drag or scroll to zoom), plus wheel zoom.
export const CUMULATIVE = 'Cumulative';
function zoomOptions(xAxisIndex = 0) {
  return [
    { type: 'inside', xAxisIndex, zoomOnMouseWheel: 'shift', moveOnMouseMove: false },
    { type: 'slider', xAxisIndex, height: 16, bottom: 4, borderColor: T.axis, backgroundColor: 'rgba(255,255,255,0.02)', fillerColor: 'rgba(162,164,255,0.12)', dataBackground: { lineStyle: { color: 'rgba(162,164,255,0.35)' }, areaStyle: { color: 'rgba(162,164,255,0.08)' } }, selectedDataBackground: { lineStyle: { color: T.accent }, areaStyle: { color: 'rgba(162,164,255,0.18)' } }, handleStyle: { color: '#24222a', borderColor: T.accent }, moveHandleSize: 0, textStyle: { color: T.faint, fontSize: 10 }, labelFormatter: () => '', brushSelect: false }
  ];
}

// Stacked bars over time (one series per market, colour follows the market).
// cumulative: a running total of all series as a line on a right-hand axis.
// zoom: a range slider under the chart.
export function stackedBars(el, { times, series, bucketSeconds, fmt = v => usd(v), yFmt = usdAxis, cumulative = false, zoom = false }) {
  const chart = init(el);
  if (!chart) return;
  let run = 0;
  const total = cumulative ? times.map((_, i) => (run += series.reduce((a, s) => a + (num(s.data[i]) || 0), 0))) : null;
  const partial = partialAt(times, bucketSeconds);
  chart.setOption({
    ...base(),
    grid: { ...base().grid, right: cumulative ? 8 : 12, bottom: zoom ? 30 : 6 },
    xAxis: timeAxis(times, bucketSeconds),
    yAxis: cumulative ? [valueAxis(yFmt), { ...valueAxis(yFmt), splitLine: { show: false } }] : valueAxis(yFmt),
    legend: { show: false, data: [...series.map(s => s.name), ...(cumulative ? [CUMULATIVE] : [])] },
    tooltip: { ...base().tooltip, formatter: tooltip(fmt, bucketSeconds, { total: true, exclude: CUMULATIVE, partial }) },
    dataZoom: zoom ? zoomOptions() : undefined,
    series: [
      ...series.map((s, i) => ({ name: s.name, type: 'bar', stack: 'a', data: fade(s.data, partial), itemStyle: { color: s.color, borderRadius: i === series.length - 1 ? [2, 2, 0, 0] : 0, borderColor: '#0e0d10', borderWidth: series.length > 1 ? 0.5 : 0 }, barMaxWidth: 22, emphasis: { focus: 'series' } })),
      ...(cumulative ? [{ name: CUMULATIVE, type: 'line', yAxisIndex: 1, data: total, symbol: 'none', smooth: 0.2, lineStyle: { color: 'rgba(255,255,255,0.75)', width: 1.5 }, itemStyle: { color: '#ffffff' }, z: 5 }] : [])
    ]
  }, true);
}

// Axis money with enough decimals to tell ticks apart on a narrow range.
function usdAxisFor(lo, hi) {
  const top = Math.max(Math.abs(lo), Math.abs(hi));
  const [k, u] = top >= 1e9 ? [1e9, 'B'] : top >= 1e6 ? [1e6, 'M'] : top >= 1e3 ? [1e3, 'K'] : [1, ''];
  const step = (hi - lo) / 5 / k;
  const d = step > 0 ? Math.min(4, Math.max(0, Math.ceil(-Math.log10(step)))) : 1;
  return v => `${v < 0 ? '-' : ''}$${(Math.abs(v) / k).toFixed(d)}${u}`;
}

export function lineChart(el, { times, series, bucketSeconds, fmt = v => usd(v), yFmt = null, area = true, scale = false }) {
  const chart = init(el);
  if (!chart) return;
  if (!yFmt) {
    const vals = series.flatMap(s => s.data).map(num).filter(v => v !== null);
    yFmt = scale && vals.length ? usdAxisFor(Math.min(...vals), Math.max(...vals)) : usdAxis;
  }
  chart.setOption({
    ...base(), grid: { ...base().grid, right: 22 }, xAxis: { ...timeAxis(times, bucketSeconds), boundaryGap: false }, yAxis: { ...valueAxis(yFmt), scale },
    tooltip: { ...base().tooltip, formatter: tooltip(fmt, bucketSeconds) },
    series: series.map(s => ({ name: s.name, type: 'line', data: s.data, symbol: 'none', smooth: 0.2, connectNulls: true, lineStyle: { color: s.color, width: 2 }, itemStyle: { color: s.color }, areaStyle: area && series.length === 1 ? { color: new window.echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: s.color + '4d' }, { offset: 1, color: s.color + '05' }]) } : undefined }))
  }, true);
}

// Positive values green, negative red (net flows, daily PnL).
// dayTicks: irregular event times (funding) get one date label per UTC day.
export function signedBars(el, { times, values, bucketSeconds, name = 'Value', fmt = v => usd(v, { sign: true }), yFmt = usdAxis, dayTicks = false }) {
  const chart = init(el);
  if (!chart) return;
  const xAxis = timeAxis(times, bucketSeconds);
  if (dayTicks) {
    const day = t => Math.floor(Number(t) / 86400);
    // The first point is labelled only when the next day starts far enough away not to collide with it.
    const firstBreak = times.findIndex((t, i) => i > 0 && day(times[i - 1]) !== day(t));
    const labelFirst = firstBreak === -1 || firstBreak >= times.length / 14;
    xAxis.axisLabel = { ...xAxis.axisLabel, interval: 0, hideOverlap: true, formatter: (v, i) => ((i === 0 && labelFirst) || (i > 0 && day(times[i - 1]) !== day(v)) ? timeLabel(day(v) * 86400, 86400) : '') };
  }
  const partial = dayTicks ? -1 : partialAt(times, bucketSeconds); // funding events are points in time, not periods
  chart.setOption({
    ...base(), xAxis, yAxis: valueAxis(yFmt),
    tooltip: { ...base().tooltip, formatter: tooltip(fmt, bucketSeconds, { partial }) },
    series: [{ name, type: 'bar', data: fade(values.map(v => ({ value: v, itemStyle: { color: (num(v) ?? 0) >= 0 ? T.long : T.short, borderRadius: (num(v) ?? 0) >= 0 ? [2, 2, 0, 0] : [0, 0, 2, 2] } })), partial), barMaxWidth: 18 }]
  }, true);
}

// Two-sided bars: inflow above zero, outflow below (drawn negative), with the
// net per period as a line (deposits vs withdrawals, taker buys vs sells).
export function twoSided(el, { times, up, down, net = 'Net', bucketSeconds, fmt = v => usd(v, { sign: true }), yFmt = usdAxis }) {
  const chart = init(el);
  if (!chart) return;
  const upData = up.data.map(v => num(v) ?? 0), downData = down.data.map(v => -(num(v) ?? 0));
  const partial = partialAt(times, bucketSeconds);
  chart.setOption({
    ...base(), xAxis: timeAxis(times, bucketSeconds), yAxis: valueAxis(yFmt),
    legend: { show: false, data: [up.name, down.name, net] },
    tooltip: { ...base().tooltip, formatter: tooltip(fmt, bucketSeconds, { partial }) },
    series: [
      { name: up.name, type: 'bar', stack: 's', data: fade(upData, partial), itemStyle: { color: up.color ?? T.long, borderRadius: [2, 2, 0, 0] }, barMaxWidth: 18 },
      { name: down.name, type: 'bar', stack: 's', data: fade(downData, partial), itemStyle: { color: down.color ?? T.short, borderRadius: [0, 0, 2, 2] }, barMaxWidth: 18 },
      { name: net, type: 'line', data: upData.map((v, i) => v + downData[i]), symbol: 'none', lineStyle: { color: '#ffffff', width: 1.25, opacity: 0.75 }, itemStyle: { color: '#ffffff' }, z: 5 }
    ]
  }, true);
}

// Rows (markets) × time buckets on a diverging scale centred on zero: two
// hues and a grey midpoint; values beyond ±clamp take the end colours. The
// hues are the site's positive/negative ones, so a cell reads like a rate.
export const DIVERGING = { neg: '#f65a6e', mid: '#2c2b33', pos: '#81c784' };
export function divergingHeatmap(el, { times, rows, bucketSeconds, clamp, fmt = v => String(v), labels = ['', ''] }) {
  const chart = init(el);
  if (!chart) return;
  const data = [];
  rows.forEach((r, y) => r.values.forEach((v, x) => { if (v !== null && v !== undefined) data.push([x, y, v]); }));
  chart.setOption({
    ...base(), grid: { left: 8, right: 12, top: 6, bottom: 34, containLabel: true },
    tooltip: { ...base().tooltip, trigger: 'item', axisPointer: undefined, formatter: p => `<div style="color:${T.faint};margin-bottom:4px">${bucketSeconds >= 86400 ? date(times[p.value[0]]) : dateTime(times[p.value[0]]) + ' UTC'}</div>${row(p.color, rows[p.value[1]].name, fmt(p.value[2]))}` },
    xAxis: { ...timeAxis(times, bucketSeconds), splitArea: { show: false } },
    yAxis: { type: 'category', data: rows.map(r => r.name), inverse: true, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: T.text, margin: 10 } },
    visualMap: { type: 'continuous', min: -clamp, max: clamp, calculable: false, orient: 'horizontal', left: 'center', bottom: 0, itemWidth: 10, itemHeight: 180, text: labels, textGap: 8, textStyle: { color: T.faint, fontSize: 11 }, inRange: { color: [DIVERGING.neg, DIVERGING.mid, DIVERGING.pos] } },
    series: [{ type: 'heatmap', data, itemStyle: { borderColor: '#0e0d10', borderWidth: 2, borderRadius: 2 }, emphasis: { itemStyle: { borderColor: 'rgba(255,255,255,0.6)', borderWidth: 1 } } }]
  }, true);
}

// Candles with volume below (two stacked grids, each with its own single axis).
// levels: liquidation bands [{ lo, hi, long, short, count, top: { address, account_id } }]
// drawn across the price chart, longs green and shorts red, stronger where more
// notional would be liquidated; the price axis widens to show bands within
// `levelSpan` of the mark. onLevel(level) fires when a band is clicked.
export function candles(el, { times, ohlc, volume, bucketSeconds, priceFmt, volColor = 'rgba(162,164,255,0.35)', zoom = false, levels = null, mark = null, levelSpan = 0.08, onLevel = null }) {
  const chart = init(el);
  if (!chart) return;
  const x = i => ({ ...timeAxis(times, bucketSeconds), gridIndex: i, axisLabel: i === 0 ? { show: false } : timeAxis(times, bucketSeconds).axisLabel });
  const bands = levels && mark ? levels.filter(l => Math.abs((l.lo + l.hi) / 2 / mark - 1) <= levelSpan).map(l => ({ ...l, n: (num(l.long) ?? 0) + (num(l.short) ?? 0), side: (num(l.long) ?? 0) >= (num(l.short) ?? 0) ? 'long' : 'short' })) : [];
  const peak = Math.max(1, ...bands.map(b => b.n));
  const labelled = new Set([...bands].sort((a, b) => b.n - a.n).slice(0, 4));
  const markArea = bands.length ? {
    silent: false,
    data: bands.map((b, i) => [{
      yAxis: b.lo, name: `band-${i}`,
      itemStyle: { color: b.side === 'long' ? T.long : T.short, opacity: 0.07 + 0.43 * Math.sqrt(b.n / peak) },
      label: { show: labelled.has(b), position: 'insideRight', color: b.side === 'long' ? T.long : T.short, fontSize: 10.5, formatter: () => `liq ${usd(b.n)}` }
    }, { yAxis: b.hi }])
  } : undefined;
  const lows = ohlc.filter(Array.isArray).map(c => c[2]), highs = ohlc.filter(Array.isArray).map(c => c[3]);
  const yMin = bands.length ? Math.min(...lows, ...bands.map(b => b.lo)) : null, yMax = bands.length ? Math.max(...highs, ...bands.map(b => b.hi)) : null;
  const pad = yMin !== null ? (yMax - yMin) * 0.03 : 0;
  chart.off('click');
  if (onLevel) chart.on('click', p => { const i = /^band-(\d+)$/.exec(p.name ?? '')?.[1]; if (p.componentType === 'markArea' && i !== undefined) onLevel(bands[Number(i)]); });
  chart.setOption({
    ...base(),
    dataZoom: zoom ? zoomOptions([0, 1]) : undefined,
    grid: [{ left: 8, right: 12, top: 12, height: zoom ? '58%' : '64%', containLabel: true }, { left: 8, right: 12, top: zoom ? '72%' : '78%', bottom: zoom ? 30 : 6, containLabel: true }],
    xAxis: [x(0), x(1)],
    yAxis: [{ ...valueAxis(priceFmt), scale: true, gridIndex: 0, ...(yMin !== null ? { min: yMin - pad, max: yMax + pad } : {}) }, { ...valueAxis(usdAxis), gridIndex: 1, splitNumber: 2 }],
    tooltip: { ...base().tooltip, formatter: params => { const c = params.find(p => p.seriesType === 'candlestick'); const v = params.find(p => p.seriesType === 'bar'); const t = params[0]?.axisValue; if (!c) return ''; const [o, cl, lo, hi] = c.value.slice(1); return `<div style="color:${T.faint};margin-bottom:4px">${bucketSeconds >= 86400 ? date(t) : dateTime(t) + ' UTC'}</div>${row('transparent', 'Open', priceFmt(o))}${row('transparent', 'High', priceFmt(hi))}${row('transparent', 'Low', priceFmt(lo))}${row('transparent', 'Close', priceFmt(cl))}${v ? row('transparent', 'Volume', usd(v.value)) : ''}`; } },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    series: [
      { type: 'candlestick', data: ohlc, xAxisIndex: 0, yAxisIndex: 0, itemStyle: { color: T.long, color0: T.short, borderColor: T.long, borderColor0: T.short }, barMaxWidth: 10, markArea, z: 3 },
      { type: 'bar', name: 'Volume', data: volume, xAxisIndex: 1, yAxisIndex: 1, itemStyle: { color: volColor }, barMaxWidth: 10 }
    ]
  }, true);
}

// Horizontal bars (categories on y), e.g. per-market breakdowns.
export function hbars(el, { labels, values, colors, fmt = v => usd(v) }) {
  const chart = init(el);
  if (!chart) return;
  chart.setOption({
    ...base(), grid: { left: 8, right: 60, top: 6, bottom: 6, containLabel: true },
    xAxis: { type: 'value', show: false }, yAxis: { type: 'category', data: labels, inverse: true, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: T.text } },
    tooltip: { ...base().tooltip, trigger: 'item', formatter: p => row(p.color, p.name, fmt(p.value)) },
    series: [{ type: 'bar', data: values.map((v, i) => ({ value: v, itemStyle: { color: colors[i], borderRadius: [0, 2, 2, 0] } })), barMaxWidth: 14, label: { show: true, position: 'right', color: T.text, formatter: p => fmt(p.value), fontSize: 11 } }]
  }, true);
}

// Mirrored bars: long exposure left of zero, short right (liquidation ladder).
export function mirrored(el, { labels, long, short, fmt = v => usd(v) }) {
  const chart = init(el);
  if (!chart) return;
  const peak = Math.max(0, ...long.map(v => num(v) ?? 0), ...short.map(v => num(v) ?? 0));
  const edge = peak > 0 ? niceCeil(peak * 1.05) : 1;
  chart.setOption({
    ...base(), grid: { left: 8, right: 28, top: 26, bottom: 6, containLabel: true },
    legend: { top: 0, right: 0, itemWidth: 8, itemHeight: 8, textStyle: { color: T.text }, data: ['Longs exposed (price down)', 'Shorts exposed (price up)'] },
    // Symmetric around zero so both sides read on the same scale.
    xAxis: { type: 'value', min: -edge, max: edge, axisLabel: { color: T.faint, hideOverlap: true, showMinLabel: false, showMaxLabel: false, formatter: v => usdAxis(Math.abs(v)) }, splitLine: { lineStyle: { color: T.grid } } },
    yAxis: { type: 'category', data: labels, inverse: true, axisTick: { show: false }, axisLine: { lineStyle: { color: T.axis } }, axisLabel: { color: T.text } },
    tooltip: { ...base().tooltip, trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: ps => `<div style="color:${T.faint};margin-bottom:4px">Price moves ${ps[0].axisValue}</div>` + ps.map(p => row(p.color, p.seriesName, fmt(Math.abs(p.value)))).join('') },
    series: [
      { name: 'Longs exposed (price down)', type: 'bar', stack: 'x', data: long.map(v => -v), itemStyle: { color: T.long, borderRadius: [2, 0, 0, 2] }, barMaxWidth: 14 },
      { name: 'Shorts exposed (price up)', type: 'bar', stack: 'x', data: short, itemStyle: { color: T.short, borderRadius: [0, 2, 2, 0] }, barMaxWidth: 14 }
    ]
  }, true);
}

// Open interest opened (above zero) and closed (below) per bucket, long and
// short stacked, with the net change as a line. Closes are the paler shade.
export function flowBars(el, { times, longOpen, longClose, shortOpen, shortClose, bucketSeconds, fmt = v => usd(v), yFmt = usdAxis }) {
  const chart = init(el);
  if (!chart) return;
  const partial = partialAt(times, bucketSeconds);
  const n = a => a.map(v => num(v) ?? 0);
  const lo = n(longOpen), lc = n(longClose), so = n(shortOpen), sc = n(shortClose);
  const net = lo.map((v, i) => v - lc[i]); // long and short open interest move together
  const bar = (name, data, color, stack, radius) => ({ name, type: 'bar', stack, data: fade(data, partial), itemStyle: { color, borderRadius: radius }, barMaxWidth: 18, emphasis: { focus: 'series' } });
  chart.setOption({
    ...base(), xAxis: timeAxis(times, bucketSeconds), yAxis: valueAxis(v => yFmt(Math.abs(v)) === '$0' ? '$0' : `${v < 0 ? '-' : ''}${yFmt(Math.abs(v))}`),
    legend: { show: false },
    tooltip: { ...base().tooltip, formatter: params => {
      const all = Array.isArray(params) ? params : [params];
      const i = all[0]?.dataIndex ?? 0, t = all[0]?.axisValue;
      const head = `<div style="color:${T.faint};margin-bottom:4px">${bucketSeconds >= 86400 ? date(t) : dateTime(t) + ' UTC'}${i === partial ? ' · in progress' : ''}</div>`;
      return head + row(T.long, 'Longs opened', fmt(lo[i])) + row(T.long + '80', 'Longs closed', fmt(lc[i])) + row(T.short, 'Shorts opened', fmt(so[i])) + row(T.short + '80', 'Shorts closed', fmt(sc[i]))
        + `<div style="border-top:1px solid ${T.border};margin-top:4px;padding-top:4px">${row('#ffffff', 'Open interest change', `${net[i] > 0 ? '+' : ''}${fmt(net[i])}`)}</div>`;
    } },
    series: [
      bar('Longs opened', lo, T.long, 'open', 0), bar('Shorts opened', so, T.short, 'open', [2, 2, 0, 0]),
      bar('Longs closed', lc.map(v => -v), T.long + '80', 'close', 0), bar('Shorts closed', sc.map(v => -v), T.short + '80', 'close', [0, 0, 2, 2]),
      { name: 'Open interest change', type: 'line', data: net, symbol: 'none', lineStyle: { color: '#ffffff', width: 1.25, opacity: 0.8 }, itemStyle: { color: '#ffffff' }, z: 5 }
    ]
  }, true);
}

// Open positions by entry price: longs to the right, shorts to the left, the
// current mark as a marker line.
export function entryProfile(el, { bins, mark, priceFmt = v => String(v), fmt = v => usd(v) }) {
  const chart = init(el);
  if (!chart) return;
  // Open-ended edge bins say so: "< 81,091" holds every entry below the range.
  const labels = bins.map(b => (b.edge === 'below' ? `< ${priceFmt(b.hi)}` : b.edge === 'above' ? `> ${priceFmt(b.lo)}` : priceFmt((b.lo + b.hi) / 2)));
  const markIndex = bins.findIndex(b => mark >= b.lo && mark < b.hi);
  const peak = Math.max(1, ...bins.map(b => Math.max(num(b.long) ?? 0, num(b.short) ?? 0)));
  const edge = niceCeil(peak * 1.05);
  chart.setOption({
    ...base(), grid: { left: 8, right: 20, top: 8, bottom: 6, containLabel: true },
    xAxis: { type: 'value', min: -edge, max: edge, axisLabel: { color: T.faint, hideOverlap: true, formatter: v => usdAxis(Math.abs(v)) }, splitLine: { lineStyle: { color: T.grid } } },
    yAxis: { type: 'category', data: labels, axisTick: { show: false }, axisLine: { lineStyle: { color: T.axis } }, axisLabel: { color: T.faint, hideOverlap: true, interval: i => i % 4 === 0 || Boolean(bins[i]?.edge) } }, // the mark has its own line label
    tooltip: { ...base().tooltip, trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: ps => { const b = bins[ps[0].dataIndex]; const range = b.edge === 'below' ? `below ${priceFmt(b.hi)}` : b.edge === 'above' ? `above ${priceFmt(b.lo)}` : `${priceFmt(b.lo)} – ${priceFmt(b.hi)}`; return `<div style="color:${T.faint};margin-bottom:4px">Entry ${range}</div>${row(T.long, `Longs · ${b.long_count}`, fmt(b.long))}${row(T.short, `Shorts · ${b.short_count}`, fmt(b.short))}`; } },
    series: [
      { name: 'Longs', type: 'bar', stack: 'x', data: bins.map(b => num(b.long) ?? 0), itemStyle: { color: T.long, borderRadius: [0, 2, 2, 0] }, barCategoryGap: '20%',
        markLine: markIndex < 0 ? undefined : { symbol: 'none', silent: true, label: { formatter: `Mark ${priceFmt(mark)}`, color: T.text, position: 'insideStartTop', fontSize: 11 }, lineStyle: { color: 'rgba(255,255,255,0.55)', type: 'dashed', width: 1 }, data: [{ yAxis: markIndex }] } },
      { name: 'Shorts', type: 'bar', stack: 'x', data: bins.map(b => -(num(b.short) ?? 0)), itemStyle: { color: T.short, borderRadius: [2, 0, 0, 2] } }
    ]
  }, true);
}
