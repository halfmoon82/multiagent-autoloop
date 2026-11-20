import test from 'node:test';
import assert from 'node:assert/strict';
import { formatElapsed } from '../public/format.mjs';

test('formatElapsed：mm:ss / h:mm:ss，起点缺失、非法或在未来不编造', () => {
  const now = Date.parse('2026-11-20T10:00:00Z');
  assert.equal(formatElapsed('2026-11-20T09:59:55Z', now), '00:05');
  assert.equal(formatElapsed('2026-11-20T09:57:30Z', now), '02:30');
  assert.equal(formatElapsed('2026-11-20T08:58:09Z', now), '1:01:51');
  assert.equal(formatElapsed(null, now), '');
  assert.equal(formatElapsed('not-a-date', now), '');
  assert.equal(formatElapsed('2026-11-20T10:00:05Z', now), '', '起点在未来视为未知，不显示负数');
});
