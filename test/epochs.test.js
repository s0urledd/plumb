import test from 'node:test';
import assert from 'node:assert/strict';
import { epochRange, epochStart, EPOCH_SECONDS } from '../src/query.js';

const at = iso => Date.parse(iso) / 1000;

test('epochs run from Wednesday 16:00 UTC to the next', () => {
  // Wednesday 30 September 2026, before and after the snapshot.
  assert.deepEqual(epochRange('last_epoch', at('2026-09-30T13:37:00Z')), { from: at('2026-09-16T16:00:00Z'), to: at('2026-09-23T16:00:00Z') });
  assert.deepEqual(epochRange('this_epoch', at('2026-09-30T13:37:00Z')), { from: at('2026-09-23T16:00:00Z'), to: at('2026-09-30T13:37:00Z') + 1 });
  assert.deepEqual(epochRange('last_epoch', at('2026-09-30T16:00:00Z')), { from: at('2026-09-23T16:00:00Z'), to: at('2026-09-30T16:00:00Z') });
  // A snapshot second belongs to the new epoch; any day of the week maps back to its Wednesday.
  assert.equal(epochStart(at('2026-09-30T15:59:59Z')), at('2026-09-23T16:00:00Z'));
  assert.equal(epochStart(at('2026-10-06T23:00:00Z')), at('2026-09-30T16:00:00Z'));
  assert.equal(epochStart(at('2026-07-08T16:00:00Z')), at('2026-07-08T16:00:00Z')); // before the anchor too
  for (const iso of ['2026-02-11T00:00:00Z', '2026-12-31T23:59:59Z']) {
    const s = epochStart(at(iso));
    assert.equal(new Date(s * 1000).getUTCDay(), 3);
    assert.equal(new Date(s * 1000).getUTCHours(), 16);
    assert.ok(s <= at(iso) && at(iso) < s + EPOCH_SECONDS);
  }
});
