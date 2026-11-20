import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createConsoleServer } from '../src/server.mjs';
import { fakeHub, json, listen, close } from './helpers.mjs';

async function setup() {
  const hub = await fakeHub((req, res) => json(res, { ok: true }));
  // 传 false 显式关闭会话装配：本文件只验证 API→Hub 的转发，answer 的额外 /v1/state 查询会破坏请求序号断言。
  const server = createConsoleServer({ hubUrl: hub.url, ownerKey: 'private', host: '127.0.0.1' }, false);
  const url = await listen(server);
  return { hub, server, url };
}
async function action(url, path, body = {}, headers = {}) {
  const target = new URL(url);
  return fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-console-request': '1', origin: target.origin, ...headers }, body: JSON.stringify(body) });
}
const cases = [
  ['/api/rules/%E5%B7%A1%E6%A3%80/run', '/v1/rules/%E5%B7%A1%E6%A3%80/run', { subject: '#1' }],
  ['/api/rules/%E5%B7%A1%E6%A3%80/pause', '/v1/rules/%E5%B7%A1%E6%A3%80/pause', { reason: '维护' }],
  ['/api/rules/%E5%B7%A1%E6%A3%80/resume', '/v1/rules/%E5%B7%A1%E6%A3%80/resume', {}],
  ['/api/runs/12/cancel', '/v1/runs/12/cancel', {}],
  ['/api/cards/8/answer', '/v1/cards/8/answer', { choice: 1 }],
  ['/api/cards/8/resolve', '/v1/cards/8/resolve', { reason: '已处理' }],
];
for (const [path, upstream, payload] of cases) test(`${path} maps only to its allowed hub action`, async () => {
  const { hub, server, url } = await setup();
  try {
    const response = await action(url, path, payload); assert.equal(response.status, 200);
    assert.equal(hub.requests[0].method, 'POST'); assert.equal(hub.requests[0].url, upstream); assert.deepEqual(JSON.parse(hub.requests[0].body), payload);
  } finally { await close(server); await close(hub.server); }
});

test('rejects invalid identifiers and unknown actions without reaching the hub', async () => {
  const { hub, server, url } = await setup();
  try {
    for (const path of ['/api/runs/not-a-number/cancel', '/api/cards/-1/answer', '/api/rules/x/delete', '/api/runs/1/kill']) {
      const response = await action(url, path); assert.ok([400, 404].includes(response.status));
    }
    assert.equal(hub.requests.length, 0);
  } finally { await close(server); await close(hub.server); }
});

test('rejects cross-site, missing marker and non-JSON writes', async () => {
  const { hub, server, url } = await setup();
  try {
    let response = await action(url, '/api/rules/x/pause', {}, { origin: 'https://evil.example' }); assert.equal(response.status, 403);
    response = await fetch(`${url}/api/rules/x/pause`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); assert.equal(response.status, 403);
    response = await fetch(`${url}/api/rules/x/pause`, { method: 'POST', headers: { 'x-console-request': '1', 'content-type': 'text/plain' }, body: '{}' }); assert.equal(response.status, 415);
    assert.equal(hub.requests.length, 0);
  } finally { await close(server); await close(hub.server); }
});

test('rejects DNS rebinding even when Host and Origin share an attacker domain', async () => {
  const { hub, server, url } = await setup();
  try {
    const target = new URL(url);
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: target.hostname, port: target.port, path: '/api/rules/x/pause', method: 'POST', headers: { host: 'evil.example', origin: 'http://evil.example', 'content-type': 'application/json', 'x-console-request': '1' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject); req.end('{}');
    });
    assert.equal(status, 403); assert.equal(hub.requests.length, 0);
  } finally { await close(server); await close(hub.server); }
});

test('retired dispatch_task routes are gone', async () => {
  const { hub, server, url } = await setup();
  try {
    assert.equal((await fetch(`${url}/api/dispatch-tasks`)).status, 404);
    assert.equal((await action(url, '/api/dispatch-tasks', { subject: 'task-one', project: '/tmp' })).status, 404);
    assert.equal((await action(url, '/api/dispatch-tasks/x/cost', { tokens: 1 })).status, 404);
    assert.equal(hub.requests.length, 0);
  } finally { await close(server); await close(hub.server); }
});

// 卡片退回事务的 Hub 授权规则（#177 后对齐 dag-runtime/#85）：
//   POST /v1/events → source；/v1/cards/:id/resolve、GET /v1/state → owner（默认）。
test('POST /api/cards/:id/delegate authenticates the delegate event with the source key', async () => {
  const hub = await fakeHub((req, res) => {
    if (req.url === '/v1/state') return json(res, { cards: [{ id: 8, state: 'open', title: '凭据问题', text: 'x' }] });
    if (req.url === '/v1/events') return json(res, { event: 1 });
    if (req.url === '/v1/cards/8/resolve') return json(res, { ok: true });
    json(res, { error: 'unexpected' }, 404);
  });
  const server = createConsoleServer({ hubUrl: hub.url, ownerKey: 'owner-key', sourceKey: 'source-key', host: '127.0.0.1' });
  const url = await listen(server);
  try {
    const response = await action(url, '/api/cards/8/delegate', {});
    assert.equal(response.status, 200);
    const authOf = p => hub.requests.find(r => r.url === p)?.headers.authorization;
    assert.equal(authOf('/v1/events'), 'Bearer source-key', '退回事件必须带 source 密钥，否则中台回「要来源自己的密钥」401');
    assert.equal(authOf('/v1/cards/8/resolve'), 'Bearer owner-key');
  } finally { await close(server); await close(hub.server); }
});
