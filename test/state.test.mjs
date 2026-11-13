import test from 'node:test';
import assert from 'node:assert/strict';
import { createConsoleServer } from '../src/server.mjs';
import { fakeHub, json, listen, close } from './helpers.mjs';

const configFor = url => ({ hubUrl: url, ownerKey: 'server-secret', host: '127.0.0.1' });

test('GET /api/state returns the hub snapshot without sending the key back', async () => {
  const hub = await fakeHub((req, res) => json(res, { seq: 7, secret: req.headers.authorization }));
  const server = createConsoleServer(configFor(hub.url));
  const url = await listen(server);
  try {
    const response = await fetch(`${url}/api/state`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.seq, 7);
    assert.equal(body.secret, 'Bearer [已隐藏]');
    assert.equal(JSON.stringify(body).includes('server-secret'), false);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(hub.requests[0].url, '/v1/state');
  } finally { await close(server); await close(hub.server); }
});

test('hub network failures and malformed responses become readable 502 errors', async () => {
  const hub = await fakeHub((req, res) => { res.end('not-json'); });
  const server = createConsoleServer(configFor(hub.url));
  const url = await listen(server);
  try {
    const response = await fetch(`${url}/api/state`);
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /中台/);
  } finally { await close(server); await close(hub.server); }
  const offline = createConsoleServer(configFor('http://127.0.0.1:1'));
  const offlineUrl = await listen(offline);
  try {
    const response = await fetch(`${offlineUrl}/api/state`);
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /中台/);
  } finally { await close(offline); }
});
