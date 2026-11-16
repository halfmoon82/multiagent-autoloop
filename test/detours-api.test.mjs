import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createConsoleServer } from '../src/server.mjs';
import { listen, close } from './helpers.mjs';

const base = { hubUrl: 'http://127.0.0.1:1', ownerKey: 'server-secret', host: '127.0.0.1' };

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'console-detours-api-'));
  writeFileSync(path.join(root, 'config.json'), JSON.stringify({ url: 'http://127.0.0.1:50494', owner: 'test' }));
  writeFileSync(path.join(root, 'rules.json'), JSON.stringify({ sources: {}, agents: {}, rules: [] }));
  return root;
}

const sample = {
  id: 'wb-hy4-x', status: 'detoured', blockedAt: '2026-11-15T00:24:04.000Z',
  blockedAgent: 'workbuddy', blockedModel: 'hy4free', evidence: '429',
  fallbackAgent: 'claude', rules: [{ name: '开发', originalTo: 'workbuddy' }],
  probe: { command: ['/secret/probe.sh'], cooldownMinutes: 30 },
  lastProbeAt: null, lastProbeOk: null, history: [],
};

test('GET /api/detours lists serialized detours without probe commands', async () => {
  const root = fixture();
  writeFileSync(path.join(root, 'detours.json'), JSON.stringify({ detours: [sample] }));
  const server = createConsoleServer({ ...base, root, rulesFile: path.join(root, 'rules.json') });
  const url = await listen(server);
  try {
    const response = await fetch(`${url}/api/detours`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.detours.length, 1);
    assert.equal(body.detours[0].blockedModel, 'hy4free');
    assert.equal(body.detours[0].probe, undefined);
    assert.match(JSON.stringify(body), /"status":"detoured"/);
  } finally { await close(server); }
});

test('GET /api/detours returns an empty list when nothing was recorded', async () => {
  const root = fixture();
  const server = createConsoleServer({ ...base, root, rulesFile: path.join(root, 'rules.json') });
  const url = await listen(server);
  try {
    const response = await fetch(`${url}/api/detours`);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).detours, []);
  } finally { await close(server); }
});

test('GET /api/detours survives one malformed record and maps a corrupt file to 502', async () => {
  const root = fixture();
  writeFileSync(path.join(root, 'detours.json'), JSON.stringify({ detours: [sample, { id: 'broken' }] }));
  const server = createConsoleServer({ ...base, root, rulesFile: path.join(root, 'rules.json') });
  const url = await listen(server);
  try {
    const ok = await fetch(`${url}/api/detours`);
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).detours.length, 1); // 坏记录被跳过，好记录仍在
  } finally { await close(server); }

  writeFileSync(path.join(root, 'detours.json'), '{corrupt');
  const server2 = createConsoleServer({ ...base, root, rulesFile: path.join(root, 'rules.json') });
  const url2 = await listen(server2);
  try {
    const bad = await fetch(`${url2}/api/detours`);
    assert.equal(bad.status, 502); // 前端 catch 降级为空列表，页面不挂
  } finally { await close(server2); }
});
