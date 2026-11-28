// whisper 默认路径解析：AUTOLOOP_WHISPER_PATH 环境变量优先，其次 PATH 逐个目录探测可执行 whisper，
// 都没有 → null（503 降级）。全部用临时目录放假可执行文件，不依赖开发机真实 whisper 安装。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { defaultWhisperPath, findWhisperOnPath } from '../src/whisper-transcribe.mjs';

function tmp(t, prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeWhisper(t, dir, { executable = true } = {}) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'whisper');
  writeFileSync(file, '#!/bin/sh\nexit 0\n');
  chmodSync(file, executable ? 0o755 : 0o644);
  return file;
}

test('env 覆盖生效：AUTOLOOP_WHISPER_PATH 优先于 PATH 探测', t => {
  const bin = tmp(t, 'whisper-path-');
  fakeWhisper(t, bin);
  const resolved = defaultWhisperPath({ AUTOLOOP_WHISPER_PATH: '/opt/custom/whisper', PATH: bin });
  assert.equal(resolved, '/opt/custom/whisper');
});

test('env 为空白字符串时忽略，回退 PATH 探测', t => {
  const bin = tmp(t, 'whisper-path-');
  const file = fakeWhisper(t, bin);
  assert.equal(defaultWhisperPath({ AUTOLOOP_WHISPER_PATH: '   ', PATH: bin }), file);
});

test('PATH 探测命中：返回命中目录下 whisper 的绝对路径', t => {
  const bin = tmp(t, 'whisper-path-');
  const file = fakeWhisper(t, bin);
  assert.equal(findWhisperOnPath(bin), file);
  assert.equal(defaultWhisperPath({ PATH: bin }), file);
});

test('PATH 多目录：跳过无命中目录，取第一个可执行命中', t => {
  const emptyDir = tmp(t, 'whisper-empty-');
  const bin = tmp(t, 'whisper-path-');
  const file = fakeWhisper(t, bin);
  const pathEnv = [emptyDir, bin].join(path.delimiter);
  assert.equal(findWhisperOnPath(pathEnv), file);
});

test('PATH 探测不命中：空 PATH / 无 whisper / 不可执行 / 目录同名 → null', t => {
  const emptyDir = tmp(t, 'whisper-empty-');
  assert.equal(findWhisperOnPath(''), null);
  assert.equal(findWhisperOnPath(null), null); // null/空串不触发默认 process.env.PATH
  assert.equal(findWhisperOnPath(emptyDir), null);
  const nonExec = tmp(t, 'whisper-noexec-');
  fakeWhisper(t, nonExec, { executable: false });
  assert.equal(findWhisperOnPath(nonExec), null);
  const dirNamed = tmp(t, 'whisper-dir-');
  mkdirSync(path.join(dirNamed, 'whisper'));
  assert.equal(findWhisperOnPath(dirNamed), null);
  assert.equal(defaultWhisperPath({ PATH: emptyDir }), null);
});
