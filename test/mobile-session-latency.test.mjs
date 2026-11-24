// session-latency 节点：详情页轮询只读「活跃会话」一个接口，并带每次请求的计时，便于定位延迟来源。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionsReader } from '../mobile/src/features/sessions/browser.mjs';

function fakeFetch(log, delayMs = 0, clock = { t: 0 }) {
  return async (url) => {
    log.push(new URL(url).pathname);
    clock.t += delayMs;
    const body = url.endsWith('/sessions') ? [{ id: 's1', kind: 'normal', status: 'running', updatedAt: '2026-11-24T00:00:00Z' }] : { sessions: [] };
    return { ok: true, status: 200, json: async () => body };
  };
}

test('load 记录每个接口的耗时，供根因定位', async () => {
  const log = [];
  const slow = fakeFetch(log);
  const reader = createSessionsReader({ origin: 'https://x.test', fetchImpl: async url => { await new Promise(r => setTimeout(r, 50)); return slow(url); } });
  const started = Date.now();
  await reader.load();
  const timings = reader.timings();
  assert.deepEqual(timings.map(item => item.path).sort(), ['/api/mobile/api/session-archives', '/api/mobile/api/sessions']);
  assert.ok(timings.every(item => item.ms >= 45), '每路耗时应如实记录');
  assert.ok(Date.now() - started < 95, '两路并行：总耗时约等于单路而不是两路之和');
});

test('refreshActive 只打活跃会话接口，沿用上次存档，串行往返减半', async () => {
  const clock = { t: 0 };
  const log = [];
  const reader = createSessionsReader({ origin: 'https://x.test', fetchImpl: fakeFetch(log, 40, clock), now: () => clock.t });
  const first = await reader.load();
  log.length = 0;
  const before = clock.t;
  const next = await reader.refreshActive(first);
  assert.deepEqual(log, ['/api/mobile/api/sessions']);
  assert.equal(clock.t - before, 40);
  assert.equal(next.snapshot.currentId, 's1');
  assert.deepEqual(next.snapshot.archives, first.snapshot.archives);
});

test('refreshActive 失败时保留错误且不编造会话', async () => {
  const reader = createSessionsReader({ origin: 'https://x.test', fetchImpl: async () => ({ ok: false, status: 502, json: async () => ({}) }) });
  const result = await reader.refreshActive({ snapshot: { archives: [] }, rawArchives: [] });
  assert.equal(result.snapshot.sessions, null);
  assert.match(result.snapshot.sessionsError, /502/);
});
