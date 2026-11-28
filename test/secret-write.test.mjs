import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeSecret, ALLOWED_KEYS, SecretWriteError } from '../src/secret-write.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'secret-write.mjs');
const SECRET = 'sk-test-SECRET-VALUE-12345';

function home(config = { url: 'http://127.0.0.1:1', owner: 'old-owner' }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'secret-write-'));
  writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  return dir;
}
const run = (dir, args, input) => spawnSync(process.execPath, [script, ...args], {
  input, encoding: 'utf8', env: { ...process.env, AGENT_AUTOLOOP_HOME: dir },
});
const mode = file => statSync(file).mode & 0o777;

test('cloudflare-token 写入 secrets/ 目录：文件 0600、目录 0700、无临时文件、值不出现在输出与参数', () => {
  const dir = home();
  const r = run(dir, ['cloudflare-token'], `${SECRET}\n${SECRET}\n`);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes(SECRET) && !r.stderr.includes(SECRET));
  const file = path.join(dir, 'secrets', 'cloudflare-token');
  assert.equal(readFileSync(file, 'utf8'), SECRET);
  assert.equal(mode(file), 0o600);
  assert.equal(mode(path.join(dir, 'secrets')), 0o700);
  assert.deepEqual(readdirSync(path.join(dir, 'secrets')), ['cloudflare-token']);
  rmSync(dir, { recursive: true });
});

test('owner 写入 config.json 的 owner 字段，其余字段保留，文件 0600', () => {
  const dir = home({ url: 'http://127.0.0.1:1', owner: 'old', maxSessions: 4 });
  const r = run(dir, ['owner'], `${SECRET}\n`);
  assert.equal(r.status, 0, r.stderr);
  const config = JSON.parse(readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.deepEqual(config, { url: 'http://127.0.0.1:1', owner: SECRET, maxSessions: 4 });
  assert.equal(mode(path.join(dir, 'config.json')), 0o600);
  assert.ok(!r.stdout.includes(SECRET) && !r.stderr.includes(SECRET));
  assert.deepEqual(readdirSync(dir).sort(), ['config.json']);
  rmSync(dir, { recursive: true });
});

test('非法 key 拒绝并列出允许项，不写任何文件', () => {
  const dir = home();
  const r = run(dir, ['../evil'], `${SECRET}\n`);
  assert.notEqual(r.status, 0);
  for (const key of Object.keys(ALLOWED_KEYS)) assert.ok(r.stderr.includes(key));
  assert.ok(!r.stderr.includes(SECRET));
  assert.deepEqual(readdirSync(dir), ['config.json']);
  assert.equal(run(dir, [], `${SECRET}\n`).status, 1);
  rmSync(dir, { recursive: true });
});

test('值不能作为命令行参数：多余参数被拒绝且不回显', () => {
  const dir = home();
  const r = run(dir, ['cloudflare-token', SECRET], `${SECRET}\n`);
  assert.notEqual(r.status, 0);
  assert.ok(!r.stderr.includes(SECRET) && !r.stdout.includes(SECRET));
  assert.deepEqual(readdirSync(dir), ['config.json']);
  rmSync(dir, { recursive: true });
});

test('空值与二次确认不一致都不写入，报错不复述值', () => {
  const dir = home();
  const empty = run(dir, ['cloudflare-token'], '\n');
  assert.notEqual(empty.status, 0);
  const diff = run(dir, ['cloudflare-token'], `${SECRET}\n${SECRET}x\n`);
  assert.notEqual(diff.status, 0);
  assert.ok(!diff.stderr.includes(SECRET) && !diff.stdout.includes(SECRET));
  assert.deepEqual(readdirSync(dir), ['config.json']);
  rmSync(dir, { recursive: true });
});

test('原子替换：覆盖旧值，不留临时文件；写入失败保留旧值且不留半成品', () => {
  const dir = home();
  assert.equal(run(dir, ['cloudflare-token'], 'first\n').status, 0);
  assert.equal(run(dir, ['cloudflare-token'], `${SECRET}\n`).status, 0);
  const file = path.join(dir, 'secrets', 'cloudflare-token');
  assert.equal(readFileSync(file, 'utf8'), SECRET);
  // 目标被目录占位 → rename 失败：无半成品，报错不含值。
  rmSync(file);
  mkdirSync(file);
  assert.throws(() => writeSecret({ root: dir, key: 'cloudflare-token', value: 'new-value-xyz' }),
    error => error instanceof SecretWriteError && !error.message.includes('new-value-xyz'));
  assert.deepEqual(readdirSync(path.join(dir, 'secrets')), ['cloudflare-token']);
  rmSync(dir, { recursive: true });
});

test('config.json 损坏时 owner 写入失败且不覆盖原文件', () => {
  const dir = home();
  writeFileSync(path.join(dir, 'config.json'), '{broken');
  assert.throws(() => writeSecret({ root: dir, key: 'owner', value: SECRET }),
    error => error instanceof SecretWriteError && !error.message.includes(SECRET));
  assert.equal(readFileSync(path.join(dir, 'config.json'), 'utf8'), '{broken');
  assert.deepEqual(readdirSync(dir), ['config.json']);
  rmSync(dir, { recursive: true });
});
