// 中台状态共享缓存：控制台各处读 /v1/state 合并为短时共享的一份，减轻中台单线程同步读库的压力。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { hubRequest, resetHubStateCache } from '../src/hub.mjs';

async function fakeHub({ delayMs = 0 } = {}) {
  const hits = { state: 0, statePaged: 0, writes: 0 };
  let version = 1;
  let failNext = false;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/v1/state') {
      if (url.search) hits.statePaged++; else hits.state++;
      if (failNext) { failNext = false; res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"boom"}'); return; }
      setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ version, runs: [{ id: 1 }] })); }, delayMs);
      return;
    }
    hits.writes++; version++;
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { hubUrl: `http://127.0.0.1:${server.address().port}`, ownerKey: 'owner-k', sourceKey: 'source-k' };
  return { config, hits, close: () => new Promise(resolve => server.close(resolve)), bump: () => { version++; }, failOnce: () => { failNext = true; } };
}

test('并发读 /v1/state 合并成一次中台请求，短时间内重复读命中缓存', async t => {
  resetHubStateCache();
  const hub = await fakeHub({ delayMs: 50 }); t.after(hub.close);
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => hubRequest(hub.config, '/v1/state')));
  assert.equal(hub.hits.state, 1);
  assert.ok(results.every(item => item.version === 1));
  await hubRequest(hub.config, '/v1/state');
  assert.equal(hub.hits.state, 1, '缓存有效期内不再打中台');
});

test('每个调用方拿到独立副本，改动不会污染其他调用方', async t => {
  resetHubStateCache();
  const hub = await fakeHub(); t.after(hub.close);
  const first = await hubRequest(hub.config, '/v1/state');
  first.runs.push({ id: 999 }); first.version = 'tampered';
  const second = await hubRequest(hub.config, '/v1/state');
  assert.equal(second.version, 1);
  assert.deepEqual(second.runs, [{ id: 1 }]);
});

test('过期后重新读中台；HUB_STATE_CACHE_MS=0 关闭缓存', async t => {
  resetHubStateCache();
  const hub = await fakeHub(); t.after(hub.close);
  await hubRequest(hub.config, '/v1/state', { cacheMs: 30 });
  hub.bump();
  await new Promise(resolve => setTimeout(resolve, 60));
  const fresh = await hubRequest(hub.config, '/v1/state', { cacheMs: 30 });
  assert.equal(fresh.version, 2);
  assert.equal(hub.hits.state, 2);
  await hubRequest(hub.config, '/v1/state', { cacheMs: 0 });
  await hubRequest(hub.config, '/v1/state', { cacheMs: 0 });
  assert.equal(hub.hits.state, 4, 'cacheMs=0 每次都直读');
});

test('控制台写中台后缓存立即失效，写之前发起的在途读不会在写之后被复用', async t => {
  resetHubStateCache();
  const hub = await fakeHub({ delayMs: 80 }); t.after(hub.close);
  const before = hubRequest(hub.config, '/v1/state');                       // 在途读（写之前发起）
  await hubRequest(hub.config, '/v1/cards/7/answer', { method: 'POST', body: { answer: 'x' } });
  const after = await hubRequest(hub.config, '/v1/state');
  assert.equal(after.version, 2, '写之后读到新状态');
  assert.equal((await before).version >= 1, true);
  assert.equal(hub.hits.state, 2);
});

test('失败不缓存：下一次调用重新请求中台', async t => {
  resetHubStateCache();
  const hub = await fakeHub(); t.after(hub.close);
  hub.failOnce();
  await assert.rejects(hubRequest(hub.config, '/v1/state'), /boom/);
  const ok = await hubRequest(hub.config, '/v1/state');
  assert.equal(ok.version, 1);
  assert.equal(hub.hits.state, 2);
});

test('翻页读取（?before=）与其他路径、source 身份不走缓存', async t => {
  resetHubStateCache();
  const hub = await fakeHub(); t.after(hub.close);
  await hubRequest(hub.config, '/v1/state?before=10');
  await hubRequest(hub.config, '/v1/state?before=10');
  assert.equal(hub.hits.statePaged, 2);
  await hubRequest(hub.config, '/v1/state', { auth: 'source' });
  await hubRequest(hub.config, '/v1/state', { auth: 'source' });
  assert.equal(hub.hits.state, 2, 'source 身份不与 owner 共享缓存');
});

test('不同中台地址互不共享缓存', async t => {
  resetHubStateCache();
  const a = await fakeHub(); const b = await fakeHub(); t.after(a.close); t.after(b.close);
  b.bump();
  assert.equal((await hubRequest(a.config, '/v1/state')).version, 1);
  assert.equal((await hubRequest(b.config, '/v1/state')).version, 2);
});
