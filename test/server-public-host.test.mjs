import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createConsoleServer } from '../src/server.mjs';
import { loadConsoleConfig, resolvePublicHost } from '../src/config.mjs';
import { listen, close } from './helpers.mjs';

const stub = { async list() { return []; } };
// fetch 不允许改 Host，改用 http.request 手工指定头。
function call(base, { method = 'GET', pathname = '/api/nope', headers = {} } = {}) {
  const { port } = new URL(base);
  const clean = Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== undefined));
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: clean }, res => {
      let text = ''; res.on('data', c => { text += c; }); res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject); req.end(method === 'GET' ? undefined : '{}');
  });
}
const write = (host, origin) => ({ method: 'POST', headers: { host, ...(origin ? { origin } : {}), 'x-console-request': '1', 'content-type': 'application/json' } });
async function withServer(extra, fn) {
  const server = createConsoleServer({ hubUrl: 'http://127.0.0.1:1', ownerKey: 'k', ...extra }, stub);
  const url = await listen(server);
  try { await fn(url); } finally { await close(server); }
}

test('未配置 publicHost：公网 Host 403，本机照常', async () => {
  await withServer({}, async url => {
    assert.equal((await call(url, { headers: { host: 'console.example.com' } })).status, 403);
    assert.notEqual((await call(url, { headers: { host: '127.0.0.1' } })).status, 403);
  });
});

test('配置 publicHost：该域名读写放行，其他域名仍 403', async () => {
  await withServer({ publicHost: 'console.example.com' }, async url => {
    assert.notEqual((await call(url, { headers: { host: 'console.example.com' } })).status, 403);
    assert.equal((await call(url, { headers: { host: 'other.example.com' } })).status, 403);
    assert.equal((await call(url, { headers: { host: 'console.example.com:8080' } })).status, 403);
    const ok = await call(url, write('console.example.com', 'https://console.example.com'));
    assert.equal(ok.status, 404, '通过 Host/Origin/头/类型校验后落到路由 404');
  });
});

test('写操作 Origin 白名单含且仅含本机与 publicHost', async () => {
  await withServer({ publicHost: 'console.example.com' }, async url => {
    const post = (host, origin) => call(url, write(host, origin)).then(r => r.status);
    assert.equal(await post('console.example.com', 'https://console.example.com'), 404);
    assert.equal(await post('127.0.0.1', 'https://console.example.com'), 404);
    assert.equal(await post('127.0.0.1', 'http://127.0.0.1'), 404);
    assert.equal(await post('console.example.com', 'https://evil.example.com'), 403);
    assert.equal(await post('127.0.0.1', 'https://evil.example.com'), 403);
  });
});

test('未配置 publicHost：写操作带公网 Origin 仍被拒', async () => {
  await withServer({}, async url => {
    assert.equal((await call(url, write('127.0.0.1', 'https://console.example.com'))).status, 403);
  });
});

test('publicHost 不放宽自定义头与 JSON 校验', async () => {
  await withServer({ publicHost: 'console.example.com' }, async url => {
    const base = write('console.example.com', 'https://console.example.com');
    assert.equal((await call(url, { ...base, headers: { ...base.headers, 'x-console-request': undefined } })).status, 403);
    assert.equal((await call(url, { ...base, headers: { ...base.headers, 'content-type': 'text/plain' } })).status, 415);
  });
});

test('resolvePublicHost：合法值通过，缺省为 null，非法值告警回退 null', () => {
  const warnings = []; const original = console.warn; console.warn = m => warnings.push(m);
  try {
    assert.equal(resolvePublicHost('console.example.com'), 'console.example.com');
    assert.equal(resolvePublicHost(undefined), null);
    assert.equal(warnings.length, 0);
    const bad = ['Console.Example.com', 'a.com:8080', 'a.com/x', '*.a.com', 'https://a.com', '', 'nodot', 42, ' a.com'];
    for (const value of bad) assert.equal(resolvePublicHost(value), null, String(value));
    assert.equal(warnings.length, bad.length);
  } finally { console.warn = original; }
});

test('loadConsoleConfig 透出 publicHost，非法值不阻断启动', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'public-host-'));
  const load = extra => { writeFileSync(path.join(root, 'config.json'), JSON.stringify({ url: 'http://127.0.0.1:3350', owner: 'o', ...extra })); return loadConsoleConfig(root); };
  assert.equal(load({ publicHost: 'console.example.com' }).publicHost, 'console.example.com');
  assert.equal(load({}).publicHost, null);
  const original = console.warn; console.warn = () => {};
  try { assert.equal(load({ publicHost: 'Bad Host/' }).publicHost, null); } finally { console.warn = original; }
});
