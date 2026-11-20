import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createConsoleServer } from '../src/server.mjs';
import { resolveDownload } from '../src/artifacts.mjs';
import { SchedulingSessionError } from '../src/scheduling-session.mjs';
import { listen, close } from './helpers.mjs';

// 会话管理器假件：用真实 resolveDownload 做路径校验，验证 server 的流式输出与响应头。
function stubManager(cwd) {
  return {
    async list() { return []; },
    async resolveSessionDownload(id, relPath) {
      if (id !== 'one') throw new SchedulingSessionError('调度会话不存在', { status: 404 });
      try { return resolveDownload(cwd, relPath); }
      catch (error) { throw new SchedulingSessionError(error.message, { status: /越界|不支持|过大/.test(error.message) ? 400 : 404 }); }
    },
  };
}

test('GET /download 以 attachment 流式返回二进制，字节一致、带 nosniff，中文文件名走 filename*', async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'dl-'));
  mkdirSync(path.join(cwd, 'work', 'apk'), { recursive: true });
  const bytes = Buffer.from(Array.from({ length: 70000 }, (_, i) => i % 256));
  writeFileSync(path.join(cwd, 'work', 'apk', '控制台.apk'), bytes);
  const server = createConsoleServer({ hubUrl: 'http://127.0.0.1:1', ownerKey: 'k' }, stubManager(cwd));
  const url = await listen(server);
  try {
    const response = await fetch(`${url}/api/scheduling-sessions/one/download?path=${encodeURIComponent('work/apk/控制台.apk')}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/octet-stream');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('content-length'), String(bytes.length));
    const disposition = response.headers.get('content-disposition');
    assert.match(disposition, /^attachment;/);
    assert.ok(disposition.includes(`filename*=UTF-8''${encodeURIComponent('控制台.apk')}`));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes, '下载内容必须与原文件逐字节一致');
  } finally { await close(server); }
});

test('GET /download 拒绝越界、未知类型、不存在的会话，且不泄露绝对路径', async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'dl-'));
  writeFileSync(path.join(cwd, 'notes.txt'), 'x');
  const server = createConsoleServer({ hubUrl: 'http://127.0.0.1:1', ownerKey: 'k' }, stubManager(cwd));
  const url = await listen(server);
  try {
    const traversal = await fetch(`${url}/api/scheduling-sessions/one/download?path=${encodeURIComponent('../../etc/hosts')}`);
    assert.equal(traversal.status, 400);
    const unknownType = await fetch(`${url}/api/scheduling-sessions/one/download?path=notes.txt`);
    assert.equal(unknownType.status, 400);
    const missing = await fetch(`${url}/api/scheduling-sessions/one/download?path=none.apk`);
    assert.equal(missing.status, 404);
    assert.ok(!(await missing.text()).includes(cwd), '错误信息不得带出绝对路径');
    const noSession = await fetch(`${url}/api/scheduling-sessions/ghost/download?path=a.apk`);
    assert.equal(noSession.status, 404);
  } finally { await close(server); }
});
