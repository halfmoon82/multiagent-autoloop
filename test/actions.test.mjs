import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createConsoleServer } from '../src/server.mjs';
import { fakeHub, json, listen, close } from './helpers.mjs';

async function setup() {
  const hub = await fakeHub((req, res) => json(res, { ok: true }));
  const server = createConsoleServer({ hubUrl: hub.url, ownerKey: 'private', host: '127.0.0.1' });
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
