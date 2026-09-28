import test from 'node:test';
import assert from 'node:assert/strict';
import { compact, usd, usdFull, pct, bps, signClass, deltaHtml, duration } from '../web/js/format.js';

test('compact amounts switch unit on the rounded figure', () => {
  assert.equal(usd(999.4), '$999');
  assert.equal(usd(999.7), '$1.00K');
  assert.equal(usd(5030), '$5.03K');
  assert.equal(usd(99999), '$100.0K');
  assert.equal(usd(999949), '$999.9K');
  assert.equal(usd(999960), '$1.00M');
  assert.equal(usd(-999.7), '-$1.00K');
  assert.equal(usd(1234.5, { sign: true }), '+$1.23K');
  assert.equal(compact(99.999), '100');
  assert.equal(compact(12.345), '12.35');
  assert.equal(compact(0), '0');
  assert.equal(compact(null), '—');
});

test('amounts under a cent show a floor without a sign', () => {
  assert.equal(usd(0.004), '<$0.01');
  assert.equal(usd(-0.004, { sign: true }), '<$0.01');
  assert.equal(usd(-0.5), '-$0.50');
  assert.equal(usd(0.5, { sign: true }), '+$0.50');
  assert.equal(usd(0), '$0');
  assert.equal(usdFull(-0.001), '$0.00');
  assert.equal(usdFull(-1234.5), '-$1,234.50');
});

test('a percentage that rounds to zero is 0 and neutral', () => {
  assert.equal(pct(-0.004), '0.00%');
  assert.equal(pct(0.004, { sign: true }), '0.00%');
  assert.equal(pct(-0.03), '-0.03%');
  assert.equal(pct(1.5, { sign: true }), '+1.50%');
  assert.equal(pct(-0.00004, { digits: 4 }), '0.0000%');
  assert.equal(signClass(-0.004), '');
  assert.equal(signClass(-0.03), 'neg');
  assert.equal(signClass(0.00004, 4), '');
  assert.equal(signClass(0.0004, 4), 'pos');
  assert.equal(signClass(null), '');
  assert.equal(bps(-0.04, { sign: true }), '0.0 bps');
  assert.equal(bps(2.66, { sign: true }), '+2.7 bps');
  assert.equal(bps(-2.66), '-2.7 bps');
  assert.equal(bps(null), '—');
});

test('a change that rounds to 0.0 % is flat', () => {
  assert.match(deltaHtml(-0.02), /class="delta flat"[^>]*> 0\.0%/);
  assert.match(deltaHtml(-5.21), /class="delta down"[^>]*>▼ 5\.2%/);
  assert.match(deltaHtml(12.34, true), /class="delta down"[^>]*>▲ 12\.3%/);
  assert.match(deltaHtml(1500), /▲ ×16/);
});

test('percentages and changes pick decimals on the rounded figure', () => {
  assert.equal(pct(99.996), '100%');
  assert.equal(pct(-99.996), '-100%');
  assert.equal(pct(99.994), '99.99%');
  assert.equal(pct(99.96, { digits: 1 }), '100%');
  assert.match(deltaHtml(99.96), /class="delta up"[^>]*>▲ 100%/);
  assert.match(deltaHtml(-99.96), /class="delta down"[^>]*>▼ 100%/);
  assert.match(deltaHtml(99.94), /▲ 99\.9%/);
  assert.match(deltaHtml(999.6), /▲ ×11/);
});

test('durations switch unit on the rounded figure', () => {
  assert.equal(duration(59.4), '59s');
  assert.equal(duration(59.6), '1m');
  assert.equal(duration(3590), '1.0h');
  assert.equal(duration(5400), '1.5h');
  assert.equal(duration(35990), '10h');
  assert.equal(duration(86000), '1.0d');
  assert.equal(duration(863990), '10d');
  assert.equal(duration(null), '—');
});
