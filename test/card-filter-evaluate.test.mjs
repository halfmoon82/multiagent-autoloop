import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { evaluate, DEFAULT_VALIDATION_SET } from '../scripts/card-filter-evaluate.mjs';
import { DEFAULT_RULES } from '../src/card-router.mjs';

test('默认验证集覆盖六类门禁，默认规则人工门禁误自动路由为 0', async () => {
  const gates = new Set(DEFAULT_VALIDATION_SET.filter(s => s.expected === 'human').map(s => s.gate));
  assert.equal(gates.size, 6);
  const r = await evaluate({ samples: DEFAULT_VALIDATION_SET, rules: DEFAULT_RULES });
  assert.equal(r.humanGateFalseAuto, 0);
  assert.equal(r.passed, true);
  assert.ok(r.autoRoutedCorrect > 0);
});

test('坏规则把人工门禁样本放行时评测失败（门禁不可被规则改写）', async () => {
  const bad = [{ id: 'bad', route: 'scheduler', tags: ['gate:finance', 'gate:credential', 'gate:product'], confidence: 0.99 }];
  const r = await evaluate({ samples: DEFAULT_VALIDATION_SET, rules: bad });
  assert.equal(r.humanGateFalseAuto, 0, '硬门禁先于规则');
  const forced = await evaluate({ samples: [{ title: '修复测试', expected: 'human' }], rules: DEFAULT_RULES });
  assert.equal(forced.humanGateFalseAuto, 1);
  assert.equal(forced.passed, false);
});

test('shadow 评测不修改输入样本', async () => {
  const samples = structuredClone(DEFAULT_VALIDATION_SET);
  await evaluate({ samples, rules: DEFAULT_RULES });
  assert.deepEqual(samples, DEFAULT_VALIDATION_SET);
});

test('CLI：默认通过退出 0，输出 JSON；坏样本退出 1', () => {
  const script = path.resolve('scripts/card-filter-evaluate.mjs');
  const out = execFileSync('node', [script, '--json'], { encoding: 'utf8' });
  assert.equal(JSON.parse(out).passed, true);
  const dir = mkdtempSync(path.join(tmpdir(), 'cfe-'));
  const file = path.join(dir, 's.json');
  writeFileSync(file, JSON.stringify([{ title: '修复测试', expected: 'human' }]));
  const res = spawnSync('node', [script, '--samples', file, '--json'], { encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.equal(JSON.parse(res.stdout).passed, false);
});

// ---- 发布入口（issue #93）CLI：--publish --home ----
test('CLI --publish --home：通过评测注册 v1 并落盘，重复发布不产生 v2', () => {
  const script = path.resolve('scripts/card-filter-evaluate.mjs');
  const home = mkdtempSync(path.join(tmpdir(), 'cfe-pub-'));
  const first = spawnSync('node', [script, '--publish', '--home', home, '--json'], { encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  const r1 = JSON.parse(first.stdout);
  assert.equal(r1.published, true);
  assert.equal(r1.version, 'v1');
  const file = path.join(home, 'card-router', 'store.json');
  assert.ok(existsSync(file));
  const disk = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(disk.versions.length, 1);
  assert.equal(disk.versions[0].validation.passed, true);
  const second = spawnSync('node', [script, '--publish', '--home', home, '--json'], { encoding: 'utf8' });
  assert.equal(second.status, 0, second.stderr);
  const r2 = JSON.parse(second.stdout);
  assert.equal(r2.created, false);
  assert.equal(r2.version, 'v1');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).versions.length, 1);
});

test('CLI --publish：评测未通过退出 1 且不注册版本', () => {
  const script = path.resolve('scripts/card-filter-evaluate.mjs');
  const home = mkdtempSync(path.join(tmpdir(), 'cfe-pub-'));
  const dir = mkdtempSync(path.join(tmpdir(), 'cfe-bad-'));
  const bad = path.join(dir, 'bad.json');
  writeFileSync(bad, JSON.stringify([{ title: '修复测试', expected: 'human' }]));
  const res = spawnSync('node', [script, '--publish', '--home', home, '--samples', bad, '--json'], { encoding: 'utf8' });
  assert.equal(res.status, 1);
  const r = JSON.parse(res.stdout);
  assert.equal(r.published, false);
  const file = path.join(home, 'card-router', 'store.json');
  assert.ok(!existsSync(file) || JSON.parse(readFileSync(file, 'utf8')).versions.length === 0);
});
