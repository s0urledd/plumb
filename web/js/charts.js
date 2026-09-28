// ECharts (self-hosted) with the Plumb theme. Every chart has one value
// axis, thin marks, a recessive grid and a hover tooltip; colours come from
// the validated categorical palette or the long/short pair.
import { usd, compact, dateTime, date, num, esc } from './format.js';

const T = {
  text: 'rgba(224,225,255,0.70)', faint: 'rgba(255,255,255,0.42)', grid: 'rgba(255,255,255,0.045)', axis: 'rgba(255,255,255,0.10)',
  accent: '#a2a4ff', long: '#81c784', short: '#f65a6e', tooltip: '#1c1b20', border: 'rgba(255,255,255,0.10)', surface: '#121113', font: 'Geist, ui-sans-serif, system-ui, sans-serif'
};
export const COLORS = T;
const registry = new Set();
const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(entries => { for (const e of entries) { const c = e.target.__chart; c?.resize(); c?.__refit?.(); } }) : null;

function init(el) {
  if (!el || !window.echarts) return null;
  let chart = el.__chart;
  // A view that re-renders clears the node (innerHTML = ''), which detaches
  // the chart's own DOM: drop that instance and draw a fresh one. A chart
  // still attached is redrawn in place, its marks moving from where they were.
  if (chart && (chart.isDisposed() || !el.contains(chart.__root))) {
    try { observer?.unobserve(el); chart.dispose(); } catch { /* already gone */ }
    registry.delete(chart); chart = null; el.__chart = null;
  }
  if (!chart) {
    el.replaceChildren(); // a skeleton or message in the node gives way to the chart
    chart = window.echarts.init(el, null, { renderer: 'canvas' });
    chart.__root = el.lastElementChild; // echarts appends its own root
    el.__chart = chart; registry.add(chart); observer?.observe(el);
  }
  for (const t of ['click', 'datazoom', 'legendselectchanged']) chart.off(t); // handlers belong to the builder drawing now
  chart.__png = chart.__refit = null; // so do what the image export adds and the refit on a resize
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
// A chart whose key sits in the card head draws it into the image (__png: the
// options to add), since the file has no card around it; the page is left as it was.
export function chartPng(el) {
  const chart = el?.__chart; if (!chart) return null;
  const extra = chart.__png?.(), was = extra && chart.getOption();
  if (extra) chart.setOption({ ...extra, animation: false });
  const url = chart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: T.surface });
  if (extra) { chart.setOption(Object.fromEntries(Object.keys(extra).map(k => [k, was[k]]))); chart.setOption({ animation: was.animation }); }
  return url;
}

// Shows or hides one series (legend chips outside the canvas drive this).
export function toggleSeries(el, name) { el?.__chart?.dispatchAction({ type: 'legendToggleSelect', name }); }
export function disposeAll() { for (const c of registry) { try { observer?.unobserve(c.getDom()); c.dispose(); } catch { /* already gone */ } } registry.clear(); }

const base = () => ({
  animation: true, animationDuration: 300, animationDurationUpdate: 250,
  textStyle: { fontFamily: T.font, color: T.text, fontSize: 11 },
  grid: { left: 4, right: 8, top: 12, bottom: 4, containLabel: true },
  tooltip: {
    trigger: 'axis', backgroundColor: T.tooltip, borderColor: T.border, borderWidth: 1, padding: [8, 10], textStyle: { color: '#fff', fontSize: 12, fontFamily: T.font },
    axisPointer: { type: 'line', lineStyle: { color: 'rgba(162,164,255,0.35)', width: 1 }, shadowStyle: { color: 'rgba(162,164,255,0.06)' } },
    extraCssText: 'box-shadow:0 12px 32px rgba(0,0,0,.55);border-radius:8px;'
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
// Width of a label in the chart font (a legend's entries, a date under the axis).
let ruler;
const textWidth = (s, px = 11) => { ruler ??= document.createElement('canvas').getContext('2d'); ruler.font = `${px}px ${T.font}`; return ruler.measureText(s).width; };
// Days are named in white, hours stay faint. Over more than two days of
// sub-day buckets only the midnights are labelled, so each day is named once;
// over a day or two, every n hours counted from midnight, n the shortest step
// whose labels fit the chart's width (read again after a resize), so the date
// is always among them. Daily buckets leave the spacing to ECharts.
const midnight = v => Number(v) % 86400 === 0;
const multiDay = (times, bucketSeconds) => bucketSeconds < 86400 && times.length > 1 && Number(times.at(-1)) - Number(times[0]) > 2 * 86400;
const HOUR_STEPS = [1, 2, 3, 4, 6, 12, 24].map(h => h * 3600);
function labelAt(el, times, bucketSeconds) {
  if (bucketSeconds >= 86400) return null;
  if (multiDay(times, bucketSeconds)) return midnight;
  let width = null, step = 86400;
  return v => {
    if (el.clientWidth !== width) {
      width = el.clientWidth;
      const slot = (width - 60) / Math.max(1, times.length), need = textWidth('Sep 30', 10.5) + 16; // 60: about the value axis; 16: the gap between labels
      step = HOUR_STEPS.find(s => s % bucketSeconds === 0 && s / bucketSeconds * slot >= need) ?? 86400;
    }
    return Number(v) % step === 0;
  };
}
const timeAxis = (times, bucketSeconds, el) => {
  const at = labelAt(el, times, bucketSeconds);
  return {
    type: 'category', data: times, boundaryGap: true,
    axisLine: { show: false }, axisTick: { show: false },
    axisLabel: {
      color: T.faint, hideOverlap: true, margin: 12, fontSize: 10.5,
      ...(at ? { interval: (i, v) => at(v) } : {}),
      formatter: v => { const t = timeLabel(v, bucketSeconds); return bucketSeconds < 86400 && midnight(v) ? `{d|${t}}` : t; },
      rich: { d: { color: 'rgba(255,255,255,0.78)', fontWeight: 500, fontSize: 10.5 } }
    }
  };
};
// A date label is centred on its bar, so the last one can reach past the plot
// and be cut at the canvas edge (many bars on a phone). The right margin takes
// that overhang at the chart's width, and again when it is resized, so a wide
// chart keeps `right`. at: the last labelled index (by default the last bar
// labelled at the chart's width); line: the points sit on the plot's ends, not mid-bar.
function fitRight(chart, el, times, bucketSeconds, { right = 8, at: fixed, line = false } = {}) {
  const labelled = labelAt(el, times, bucketSeconds);
  const fit = () => {
    const at = fixed ?? (labelled ? times.findLastIndex(labelled) : times.length - 1);
    if (at < 0) return right;
    const slot = (el.clientWidth - 44 - right) / Math.max(1, times.length - (line ? 1 : 0)); // 44: about the value axis and its labels
    const overhang = textWidth(timeLabel(times[at], bucketSeconds), 10.5) / 2 + 1 - (times.length - 1 - at + (line ? 0 : 0.5)) * slot;
    return Math.max(right, Math.ceil(overhang));
  };
  chart.__refit = () => { const r = fit(); if (r !== chart.__right) { chart.__right = r; chart.setOption({ grid: chart.getOption().grid.map(() => ({ right: r })) }); } };
  return (chart.__right = fit());
}
// The first step times a power of ten at or above v (by default 1, 2, 2.5 or 5).
const niceCeil = (v, steps = [1, 2, 2.5, 5, 10]) => { const p = 10 ** Math.floor(Math.log10(v)); return steps.map(k => k * p).find(x => x >= v); };
// Axis money: $1.5M, $900K, $0.
export const usdAxis = v => { const n = Number(v); if (!n) return '$0'; const a = Math.abs(n); const [k, u] = a >= 1e9 ? [1e9, 'B'] : a >= 1e6 ? [1e6, 'M'] : a >= 1e3 ? [1e3, 'K'] : [1, '']; const x = a / k; return `${n < 0 ? '-' : ''}$${x >= 100 || Number.isInteger(x) ? Math.round(x) : x.toFixed(1).replace(/\.0$/, '')}${u}`; };
const SPLIT = { lineStyle: { color: T.grid, type: [3, 4] } };
const valueAxis = fmt => ({ type: 'value', splitNumber: 3, axisLabel: { color: T.faint, formatter: fmt, margin: 10, fontSize: 10.5 }, splitLine: SPLIT, axisLine: { show: false }, axisTick: { show: false } });
// Tooltip rows carry the same dot as the legends.
const row = (color, name, value) => `<div style="display:flex;justify-content:space-between;gap:18px;line-height:1.7"><span><span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${color};margin-right:7px;vertical-align:1px"></span>${esc(name)}</span><b style="font-weight:500;font-variant-numeric:tabular-nums">${value}</b></div>`;
// Rounds the outer end of each stack: per bucket, the last shown series with a value there.
const capped = (datas, radius, shown = datas.map(() => true)) => { const top = (datas[0] ?? []).map((_, i) => datas.findLastIndex((d, s) => shown[s] && num(d[i]))); return datas.map((d, s) => d.map((v, i) => (s === top[i] ? { value: v, itemStyle: { borderRadius: radius } } : v))); };
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
    const ev = Array.isArray(extra?.value) ? extra.value[1] : extra?.value; // a drawn running total is [index, total, previous]
    const foot = [total && rows.length > 1 ? row('transparent', 'Total', fmt(sum)) : '', ev !== null && ev !== undefined ? row('#ffffff', extra.seriesName, fmt(ev)) : ''].join('');
    return head + rows.map(p => row(p.color, p.seriesName, fmt(p.value))).join('') + (foot ? `<div style="border-top:1px solid ${T.border};margin-top:4px;padding-top:4px">${foot}</div>` : '');
  };
}

export function sparkline(el, values, { color = T.accent, area = true } = {}) {
  const chart = init(el);
  if (!chart) return;
  chart.setOption({
    animation: false, grid: { left: 0, right: 0, top: 2, bottom: 0 },
    xAxis: { type: 'category', show: false, data: values.map((_, i) => i) }, yAxis: { type: 'value', show: false, scale: true },
    series: [{ type: 'line', data: values, symbol: 'none', smooth: 0.35, lineStyle: { color, width: 1.5 }, areaStyle: area ? { color: new window.echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: color + '59' }, { offset: 1, color: color + '00' }]) } : undefined }]
  }, true);
}

// A range slider under a time chart (drag or scroll to zoom), plus wheel zoom.
// A chart redrawn in place (a refresh) keeps the stretch the reader zoomed to.
export const CUMULATIVE = 'Cumulative';
const zoomOf = chart => { const z = chart.getOption()?.dataZoom?.[0]; return z && (z.start > 0 || z.end < 100) ? { start: z.start, end: z.end } : null; };
function zoomOptions(xAxisIndex = 0, kept = null) {
  return [
    { type: 'inside', xAxisIndex, zoomOnMouseWheel: 'shift', moveOnMouseMove: false, ...kept },
    { type: 'slider', xAxisIndex, ...kept, height: 16, bottom: 4, borderColor: T.axis, backgroundColor: 'rgba(255,255,255,0.02)', fillerColor: 'rgba(162,164,255,0.12)', dataBackground: { lineStyle: { color: 'rgba(162,164,255,0.35)' }, areaStyle: { color: 'rgba(162,164,255,0.08)' } }, selectedDataBackground: { lineStyle: { color: T.accent }, areaStyle: { color: 'rgba(162,164,255,0.18)' } }, handleStyle: { color: '#24222a', borderColor: T.accent }, moveHandleSize: 0, textStyle: { color: T.faint, fontSize: 10 }, labelFormatter: () => '', brushSelect: false }
  ];
}

// A running total drawn on the bars' own axis, one segment per period: flat
// through the gaps and climbing across that period's bar, so the line never
// moves before the bar it adds and zooming keeps the two aligned.
const runningTotal = (total, bars) => ({
  name: CUMULATIVE, type: 'custom', yAxisIndex: 1, z: 5, data: total.map((v, i) => [i, v, i ? total[i - 1] : 0]), encode: { x: 0, y: 1 }, itemStyle: { color: '#ffffff' },
  renderItem: (_, api) => {
    const slot = api.size([1, 0])[0], half = Math.min(bars.barMaxWidth, slot * (1 - parseFloat(bars.barCategoryGap) / 100)) / 2; // the width the bars get
    const [x, from] = api.coord([api.value(0), api.value(2)]), to = api.coord([api.value(0), api.value(1)])[1];
    return { type: 'polyline', shape: { points: [[x - slot / 2, from], [x - half, from], [x + half, to], [x + slot / 2, to]] }, style: { stroke: 'rgba(255,255,255,0.8)', lineWidth: 1.5, fill: null, lineJoin: 'round' } };
  }
});

// Stacked bars over time (one series per market, colour follows the market).
// cumulative: a running total of all series as a line on a right-hand axis.
// zoom: a range slider under the chart.
export function stackedBars(el, { times, series, bucketSeconds, fmt = v => usd(v), yFmt = usdAxis, cumulative = false, zoom = false }) {
  const chart = init(el);
  if (!chart) return;
  const kept = zoom ? zoomOf(chart) : null;
  let run = 0;
  const total = cumulative ? times.map((_, i) => (run += series.reduce((a, s) => a + (num(s.data[i]) || 0), 0))) : null;
  const partial = partialAt(times, bucketSeconds);
  const layout = { barMaxWidth: 20, barCategoryGap: '30%' };
  const data = shown => capped(series.map(s => s.data), [3, 3, 0, 0], shown).map(d => fade(d, partial));
  // A series hidden from the legend hands the rounded top to the one now outermost.
  chart.on('legendselectchanged', e => chart.setOption({ series: data(series.map(s => e.selected[s.name] !== false)).map(d => ({ data: d })) }));
  chart.setOption({
    ...base(),
    // A running total has its axis on the right, which gives the last date room.
    grid: { ...base().grid, right: cumulative ? 8 : fitRight(chart, el, times, bucketSeconds), bottom: zoom ? 30 : 6 },
    xAxis: timeAxis(times, bucketSeconds, el),
    // The running total's ticks fall on the bars' gridlines.
    yAxis: cumulative ? [valueAxis(yFmt), { ...valueAxis(yFmt), splitLine: { show: false }, alignTicks: true }] : valueAxis(yFmt),
    legend: { show: false, data: [...series.map(s => s.name), ...(cumulative ? [CUMULATIVE] : [])] },
    tooltip: { ...base().tooltip, formatter: tooltip(fmt, bucketSeconds, { total: true, exclude: CUMULATIVE, partial }) },
    dataZoom: zoom ? zoomOptions(0, kept) : undefined,
    series: [
      ...data().map((d, i) => ({ name: series[i].name, type: 'bar', stack: 'a', data: d, itemStyle: { color: series[i].color, borderColor: T.surface, borderWidth: series.length > 1 ? 0.5 : 0 }, ...layout, emphasis: { focus: 'series' } })),
      ...(cumulative ? [runningTotal(total, layout)] : [])
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
    ...base(), grid: { ...base().grid, right: fitRight(chart, el, times, bucketSeconds, { line: true }) }, xAxis: { ...timeAxis(times, bucketSeconds, el), boundaryGap: false }, yAxis: { ...valueAxis(yFmt), scale },
    tooltip: { ...base().tooltip, formatter: tooltip(fmt, bucketSeconds) },
    series: series.map(s => ({ name: s.name, type: 'line', data: s.data, symbol: 'none', smooth: 0.3, connectNulls: true, lineStyle: { color: s.color, width: 1.75 }, itemStyle: { color: s.color }, areaStyle: area && series.length === 1 ? { color: new window.echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: s.color + '47' }, { offset: 1, color: s.color + '00' }]) } : undefined }))
  }, true);
}

// Positive values green, negative red (net flows, daily PnL).
// dayTicks: irregular event times (funding) get one date label per UTC day.
export function signedBars(el, { times, values, bucketSeconds, name = 'Value', fmt = v => usd(v, { sign: true }), yFmt = usdAxis, dayTicks = false }) {
  const chart = init(el);
  if (!chart) return;
  const xAxis = timeAxis(times, bucketSeconds, el);
  let at; // the last labelled bar, when not the one fitRight assumes
  if (dayTicks) {
    const day = t => Math.floor(Number(t) / 86400);
    // The first point is labelled only when the next day starts far enough away not to collide with it.
    const firstBreak = times.findIndex((t, i) => i > 0 && day(times[i - 1]) !== day(t));
    const labelFirst = firstBreak === -1 || firstBreak >= times.length / 14;
    xAxis.axisLabel = { ...xAxis.axisLabel, interval: 0, hideOverlap: true, formatter: (v, i) => ((i === 0 && labelFirst) || (i > 0 && day(times[i - 1]) !== day(v)) ? timeLabel(day(v) * 86400, 86400) : '') };
    at = Math.max(times.findLastIndex((t, i) => i > 0 && day(times[i - 1]) !== day(t)), labelFirst ? 0 : -1);
  }
  const partial = dayTicks ? -1 : partialAt(times, bucketSeconds); // funding events are points in time, not periods
  chart.setOption({
    ...base(), grid: { ...base().grid, right: fitRight(chart, el, times, dayTicks ? 86400 : bucketSeconds, { at }) }, xAxis, yAxis: valueAxis(yFmt),
    tooltip: { ...base().tooltip, formatter: tooltip(fmt, bucketSeconds, { partial }) },
    series: [{ name, type: 'bar', data: fade(values.map(v => ({ value: v, itemStyle: { color: (num(v) ?? 0) >= 0 ? T.long : T.short, borderRadius: (num(v) ?? 0) >= 0 ? [3, 3, 0, 0] : [0, 0, 3, 3] } })), partial), barMaxWidth: 18 }]
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
    ...base(), grid: { ...base().grid, right: fitRight(chart, el, times, bucketSeconds) }, xAxis: timeAxis(times, bucketSeconds, el), yAxis: valueAxis(yFmt),
    legend: { show: false, data: [up.name, down.name, net] },
    tooltip: { ...base().tooltip, formatter: tooltip(fmt, bucketSeconds, { partial }) },
    series: [
      { name: up.name, type: 'bar', stack: 's', data: fade(upData, partial), itemStyle: { color: up.color ?? T.long, borderRadius: [3, 3, 0, 0] }, barMaxWidth: 18 },
      { name: down.name, type: 'bar', stack: 's', data: fade(downData, partial), itemStyle: { color: down.color ?? T.short, borderRadius: [0, 0, 3, 3] }, barMaxWidth: 18 },
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
    xAxis: { ...timeAxis(times, bucketSeconds, el), splitArea: { show: false } },
    yAxis: { type: 'category', data: rows.map(r => r.name), inverse: true, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: T.text, margin: 10 } },
    visualMap: { type: 'continuous', min: -clamp, max: clamp, calculable: false, orient: 'horizontal', left: 'center', bottom: 0, itemWidth: 10, itemHeight: 180, text: labels, textGap: 8, textStyle: { color: T.faint, fontSize: 11 }, inRange: { color: [DIVERGING.neg, DIVERGING.mid, DIVERGING.pos] } },
    series: [{ type: 'heatmap', data, itemStyle: { borderColor: T.surface, borderWidth: 2, borderRadius: 2 }, emphasis: { itemStyle: { borderColor: 'rgba(255,255,255,0.6)', borderWidth: 1 } } }]
  }, true);
}

// Candles with volume below (two stacked grids, each with its own single axis).
// levels: liquidation bands [{ lo, hi, long, short, count, top: { address, account_id } }]
// drawn across the price chart, longs green and shorts red, stronger where more
// notional would be liquidated; the price axis widens to show bands within
// `levelSpan` of the mark. onLevel(level) fires when a band is clicked.
export function candles(el, { times, ohlc, volume, bucketSeconds, priceFmt, volColor = 'rgba(162,164,255,0.35)', zoom = false, levels = null, mark = null, levelSpan = 0.04, onLevel = null }) {
  const chart = init(el);
  if (!chart) return;
  const kept = zoom ? zoomOf(chart) : null;
  const x = i => ({ ...timeAxis(times, bucketSeconds, el), gridIndex: i, axisLabel: i === 0 ? { show: false } : timeAxis(times, bucketSeconds, el).axisLabel });
  const near = levels && mark ? levels.filter(l => Math.abs((l.lo + l.hi) / 2 / mark - 1) <= levelSpan).map(l => ({ ...l, n: (num(l.long) ?? 0) + (num(l.short) ?? 0), side: (num(l.long) ?? 0) >= (num(l.short) ?? 0) ? 'long' : 'short' })) : [];
  const peak = Math.max(1, ...near.map(b => b.n));
  // Bands under 5 % of the largest are left out: the chart shows where liquidations cluster, not every position.
  const bands = near.filter(b => b.n >= peak * 0.05);
  const lows = ohlc.filter(Array.isArray).map(c => c[2]), highs = ohlc.filter(Array.isArray).map(c => c[3]);
  const yMin = bands.length ? Math.min(...lows, ...bands.map(b => b.lo)) : null, yMax = bands.length ? Math.max(...highs, ...bands.map(b => b.hi)) : null;
  const pad = yMin !== null ? (yMax - yMin) * 0.03 : 0, ends = yMin !== null ? [yMin - pad, yMax + pad] : null;
  const priceH = zoom ? 58 : 64; // the price grid's share of the height, in %
  // Amounts on at most three bands, 1 % of price and a label's height (20px) apart:
  // per side the largest band that fits goes first, so neither side goes unlabelled.
  const gap = ends ? Math.max(mark * 0.01, 20 * (ends[1] - ends[0]) / ((chart.getHeight() || 400) * priceH / 100)) : 0;
  const bySize = [...bands].sort((a, c) => c.n - a.n), labelled = [];
  const fits = b => !labelled.includes(b) && labelled.every(o => Math.abs(o.lo + o.hi - b.lo - b.hi) / 2 >= gap);
  for (const side of new Set(bySize.map(b => b.side))) { const b = bySize.find(o => o.side === side && fits(o)); if (b) labelled.push(b); }
  for (const b of bySize) if (labelled.length < 3 && fits(b)) labelled.push(b);
  const markArea = bands.length ? {
    silent: false,
    data: bands.map((b, i) => [{
      yAxis: b.lo, name: `band-${i}`,
      itemStyle: { color: b.side === 'long' ? T.long : T.short, opacity: 0.08 + 0.5 * (b.n / peak) ** 0.8 },
      label: { show: false }
    }, { yAxis: b.hi }])
  } : undefined;
  // The amounts ride on invisible mark lines, which draw above the candles, on a
  // backing that keeps them legible; at the left end, so the newest candles stay clear.
  // precision: the default two decimals would move a line on a price under $1
  // off the axis (0.02605 to 0.03), and it would not be drawn.
  const markLine = labelled.length ? {
    symbol: 'none', silent: true, precision: 10, lineStyle: { color: 'transparent' },
    data: labelled.map(b => ({ yAxis: (b.lo + b.hi) / 2, label: { position: 'insideStart', distance: 4, color: b.side === 'long' ? T.long : T.short, fontSize: 10.5, backgroundColor: 'rgba(18,17,19,0.8)', padding: [2, 5], borderRadius: 4, formatter: () => `liq ${usd(b.n)}` } }))
  } : undefined;
  // Volume ticks at zero, half and a round top that the busiest bar in view nearly reaches.
  const volAxis = (from = 0, to = volume.length - 1) => { const top = niceCeil(Math.max(1, ...volume.slice(from, to + 1).map(v => num(v) ?? 0)), [1, 1.5, 2, 3, 4, 5, 6, 8, 10]); return { min: 0, max: top, interval: top / 2 }; };
  // Each grid sizes its gutter to its own axis labels, which would put a candle and
  // its volume bar at different x: the narrower gutter is widened to match.
  let lefts = [8, 8];
  const align = (s = 0) => {
    const plotLeft = i => { const [a, b] = [s, s + 1].map(v => chart.convertToPixel({ xAxisIndex: i }, v)); return a - (b - a) / 2; };
    const gutters = lefts.map((l, i) => plotLeft(i) - l), next = gutters.map(g => 8 + Math.max(...gutters) - g);
    if (next.every(Number.isFinite) && next.some((l, i) => Math.abs(l - lefts[i]) > 0.5)) { lefts = next; chart.setOption({ grid: lefts.map(left => ({ left })) }); }
  };
  const right = fitRight(chart, el, times, bucketSeconds); // both panes, so a candle and its volume share an x
  if (onLevel) chart.on('click', p => { const i = /^band-(\d+)$/.exec(p.name ?? '')?.[1]; if (p.componentType === 'markArea' && i !== undefined) onLevel(bands[Number(i)]); });
  // Zoomed in, the volume scale follows the stretch in view, and its labels may change width.
  const fitZoom = () => { const z = chart.getOption().dataZoom[0]; chart.setOption({ yAxis: [{}, volAxis(z.startValue, z.endValue)] }); align(z.startValue); };
  if (zoom) chart.on('datazoom', fitZoom);
  chart.setOption({
    ...base(),
    dataZoom: zoom ? zoomOptions([0, 1], kept) : undefined,
    grid: [{ left: 8, right, top: 12, height: `${priceH}%`, containLabel: true }, { left: 8, right, top: zoom ? '72%' : '78%', bottom: zoom ? 30 : 6, containLabel: true }],
    xAxis: [x(0), x(1)],
    yAxis: [
      // Widened to the bands, the ends fall between round ticks: they go unlabelled and take no room.
      { ...valueAxis(priceFmt), scale: true, gridIndex: 0, ...(ends ? { min: ends[0], max: ends[1], axisLabel: { ...valueAxis(priceFmt).axisLabel, formatter: v => (ends.includes(v) ? '' : priceFmt(v)) } } : {}) },
      { ...valueAxis(usdAxis), gridIndex: 1, ...volAxis() }
    ],
    tooltip: { ...base().tooltip, formatter: params => { const c = params.find(p => p.seriesType === 'candlestick'); const v = params.find(p => p.seriesType === 'bar'); const t = params[0]?.axisValue; if (!c) return ''; const [o, cl, lo, hi] = c.value.slice(1); return `<div style="color:${T.faint};margin-bottom:4px">${bucketSeconds >= 86400 ? date(t) : dateTime(t) + ' UTC'}</div>${row('transparent', 'Open', priceFmt(o))}${row('transparent', 'High', priceFmt(hi))}${row('transparent', 'Low', priceFmt(lo))}${row('transparent', 'Close', priceFmt(cl))}${v ? row('transparent', 'Volume', usd(v.value)) : ''}`; } },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    series: [
      { type: 'candlestick', data: ohlc, xAxisIndex: 0, yAxisIndex: 0, itemStyle: { color: T.long, color0: T.short, borderColor: T.long, borderColor0: T.short }, barMaxWidth: 10, markArea, markLine, z: 3 },
      { type: 'bar', name: 'Volume', data: volume, xAxisIndex: 1, yAxisIndex: 1, itemStyle: { color: volColor, borderRadius: [3, 3, 0, 0] }, barMaxWidth: 10 }
    ]
  }, true);
  if (kept) fitZoom(); else align();
}

// Horizontal bars (categories on y), e.g. per-market breakdowns.
export function hbars(el, { labels, values, colors, fmt = v => usd(v) }) {
  const chart = init(el);
  if (!chart) return;
  chart.setOption({
    ...base(), grid: { left: 8, right: 60, top: 6, bottom: 6, containLabel: true },
    xAxis: { type: 'value', show: false }, yAxis: { type: 'category', data: labels, inverse: true, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: T.text } },
    tooltip: { ...base().tooltip, trigger: 'item', formatter: p => row(p.color, p.name, fmt(p.value)) },
    series: [{ type: 'bar', data: values.map((v, i) => ({ value: v, itemStyle: { color: colors[i], borderRadius: [0, 3, 3, 0] } })), barMaxWidth: 14, label: { show: true, position: 'right', color: T.text, formatter: p => fmt(p.value), fontSize: 11 } }]
  }, true);
}


// Mirrored bars: long exposure left of zero, short right (liquidation ladder).
// legend: false leaves the key to a dot legend in the card head; the chart
// then draws its own only into a PNG export.
export function mirrored(el, { labels, long, short, fmt = v => usd(v), legend = true }) {
  const chart = init(el);
  if (!chart) return;
  const peak = Math.max(0, ...long.map(v => num(v) ?? 0), ...short.map(v => num(v) ?? 0));
  const edge = peak > 0 ? niceCeil(peak * 1.05) : 1;
  const longName = 'Longs exposed (price down)', shortName = 'Shorts exposed (price up)';
  // On a narrow chart the legend wraps to a second line: the bars start below it.
  const below = () => ([longName, shortName].reduce((w, n) => w + 7 + 5 + textWidth(n) + 14, 0) > el.clientWidth ? 46 : 26);
  if (!legend) chart.__png = () => ({ legend: { show: true }, grid: { top: below() } });
  chart.setOption({
    ...base(), grid: { left: 8, right: 28, top: legend ? below() : 8, bottom: 6, containLabel: true },
    legend: { show: legend, top: 0, right: 0, icon: 'circle', itemWidth: 7, itemHeight: 7, itemGap: 14, textStyle: { color: T.text, fontSize: 11 }, data: [longName, shortName] },
    // Symmetric around zero so both sides read on the same scale.
    xAxis: { type: 'value', min: -edge, max: edge, axisLabel: { color: T.faint, fontSize: 10.5, hideOverlap: true, showMinLabel: false, showMaxLabel: false, formatter: v => usdAxis(Math.abs(v)) }, splitLine: SPLIT },
    yAxis: { type: 'category', data: labels, inverse: true, axisTick: { show: false }, axisLine: { lineStyle: { color: T.axis } }, axisLabel: { color: T.text } },
    tooltip: { ...base().tooltip, trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: ps => `<div style="color:${T.faint};margin-bottom:4px">Price moves ${ps[0].axisValue}</div>` + ps.map(p => row(p.color, p.seriesName, fmt(Math.abs(p.value)))).join('') },
    series: [
      { name: longName, type: 'bar', stack: 'x', data: long.map(v => -v), itemStyle: { color: T.long, borderRadius: [3, 0, 0, 3] }, barMaxWidth: 14 },
      { name: shortName, type: 'bar', stack: 'x', data: short, itemStyle: { color: T.short, borderRadius: [0, 3, 3, 0] }, barMaxWidth: 14 }
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
  const opens = capped([lo, so], [3, 3, 0, 0]), closes = capped([lc.map(v => -v), sc.map(v => -v)], [0, 0, 3, 3]);
  const bar = (name, data, color, stack) => ({ name, type: 'bar', stack, data: fade(data, partial), itemStyle: { color }, barMaxWidth: 18, emphasis: { focus: 'series' } });
  chart.setOption({
    ...base(), grid: { ...base().grid, right: fitRight(chart, el, times, bucketSeconds) }, xAxis: timeAxis(times, bucketSeconds, el), yAxis: valueAxis(v => yFmt(Math.abs(v)) === '$0' ? '$0' : `${v < 0 ? '-' : ''}${yFmt(Math.abs(v))}`),
    legend: { show: false },
    tooltip: { ...base().tooltip, formatter: params => {
      const all = Array.isArray(params) ? params : [params];
      const i = all[0]?.dataIndex ?? 0, t = all[0]?.axisValue;
      const head = `<div style="color:${T.faint};margin-bottom:4px">${bucketSeconds >= 86400 ? date(t) : dateTime(t) + ' UTC'}${i === partial ? ' · in progress' : ''}</div>`;
      return head + row(T.long, 'Longs opened', fmt(lo[i])) + row(T.long + '80', 'Longs closed', fmt(lc[i])) + row(T.short, 'Shorts opened', fmt(so[i])) + row(T.short + '80', 'Shorts closed', fmt(sc[i]))
        + `<div style="border-top:1px solid ${T.border};margin-top:4px;padding-top:4px">${row('#ffffff', 'Open interest change', `${net[i] > 0 ? '+' : ''}${fmt(net[i])}`)}</div>`;
    } },
    series: [
      bar('Longs opened', opens[0], T.long, 'open'), bar('Shorts opened', opens[1], T.short, 'open'),
      bar('Longs closed', closes[0], T.long + '80', 'close'), bar('Shorts closed', closes[1], T.short + '80', 'close'),
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
    xAxis: { type: 'value', min: -edge, max: edge, axisLabel: { color: T.faint, fontSize: 10.5, hideOverlap: true, showMinLabel: false, showMaxLabel: false, formatter: v => usdAxis(Math.abs(v)) }, splitLine: SPLIT },
    yAxis: { type: 'category', data: labels, axisTick: { show: false }, axisLine: { lineStyle: { color: T.axis } }, axisLabel: { color: T.faint, fontSize: 10.5, hideOverlap: true, interval: i => i % 4 === 0 || Boolean(bins[i]?.edge) } }, // the mark has its own line label
    tooltip: { ...base().tooltip, trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: ps => { const b = bins[ps[0].dataIndex]; const range = b.edge === 'below' ? `below ${priceFmt(b.hi)}` : b.edge === 'above' ? `above ${priceFmt(b.lo)}` : `${priceFmt(b.lo)} – ${priceFmt(b.hi)}`; return `<div style="color:${T.faint};margin-bottom:4px">Entry ${range}</div>${row(T.long, `Longs · ${b.long_count}`, fmt(b.long))}${row(T.short, `Shorts · ${b.short_count}`, fmt(b.short))}`; } },
    series: [
      { name: 'Longs', type: 'bar', stack: 'x', data: bins.map(b => num(b.long) ?? 0), itemStyle: { color: T.long, borderRadius: [0, 3, 3, 0] }, barCategoryGap: '20%',
        markLine: markIndex < 0 ? undefined : { symbol: 'none', silent: true, label: { formatter: `Mark ${priceFmt(mark)}`, color: T.text, position: 'insideStartTop', fontSize: 11 }, lineStyle: { color: 'rgba(255,255,255,0.55)', type: 'dashed', width: 1 }, data: [{ yAxis: markIndex }] } },
      { name: 'Shorts', type: 'bar', stack: 'x', data: bins.map(b => -(num(b.short) ?? 0)), itemStyle: { color: T.short, borderRadius: [3, 0, 0, 3] } }
    ]
  }, true);
}
