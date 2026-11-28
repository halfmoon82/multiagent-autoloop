import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { buildRelease, ReleaseError } from '../scripts/release.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function put(root, rel, content = 'x\n') {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function fakeSource() {
  const root = mkdtempSync(join(tmpdir(), 'release-src-'));
  put(root, 'package.json', JSON.stringify({ name: 'demo-console', version: '1.2.3' }));
  put(root, 'README.md', '# demo\n');
  put(root, 'LICENSE', 'MIT\n');
  put(root, 'src/server.mjs', 'export const ok = true;\n');
  put(root, 'public/index.html', '<html></html>\n');
  put(root, 'scripts/start.mjs', '#!/usr/bin/env node\n');
  put(root, 'examples/config.example.json', '{}\n');
  put(root, 'docs/install/playbook.md', '# playbook\n');
  return root;
}

function workdir() {
  return mkdtempSync(join(tmpdir(), 'release-out-'));
}

function assertFails(root, pattern) {
  const out = join(workdir(), 'rel');
  assert.throws(() => buildRelease({ sourceRoot: root, outDir: out }), (error) => {
    assert.ok(error instanceof ReleaseError, String(error));
    assert.match(error.message, pattern);
    return true;
  });
  assert.equal(existsSync(out), false, '失败不留产物目录');
  assert.deepEqual(readdirSync(dirname(out)), [], '失败不留临时半成品');
}

test('正常源：产物含应有内容、排除运行状态与上游内核，附带逐文件 sha256 manifest', () => {
  const root = fakeSource();
  put(root, 'app/kernel.mjs', 'upstream kernel\n');
  put(root, 'node_modules/dep/index.js', 'dep\n');
  put(root, 'config.json', '{"secret":1}\n');
  put(root, 'rules.json', '[]\n');
  put(root, 'examples/runtime.db', 'db');
  put(root, 'src/debug.log', 'log');
  put(root, 'docs/2026-11-26-agent-guided-release-prd.md', 'not shipped\n');
  const out = join(workdir(), 'rel');
  const result = buildRelease({ sourceRoot: root, outDir: out });
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
  const paths = manifest.files.map((f) => f.path);
  assert.deepEqual(paths, [...paths].sort());
  for (const want of ['README.md', 'LICENSE', 'package.json', 'src/server.mjs', 'public/index.html',
    'scripts/start.mjs', 'examples/config.example.json', 'docs/install/playbook.md']) {
    assert.ok(paths.includes(want), `缺 ${want}`);
    assert.ok(existsSync(join(out, want)));
  }
  for (const banned of ['app/kernel.mjs', 'node_modules/dep/index.js', 'config.json', 'rules.json',
    'examples/runtime.db', 'src/debug.log', 'docs/2026-11-26-agent-guided-release-prd.md']) {
    assert.ok(!paths.includes(banned), `不应含 ${banned}`);
    assert.equal(existsSync(join(out, banned)), false);
  }
  assert.equal(result.fileCount, paths.length);
  assert.match(manifest.files[0].sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(manifest.attachments, [{ kind: 'apk', name: 'NoMoTo.apk', status: 'pending', sha256: null, size: null }]);
  assert.ok(statSync(join(out, 'scripts/start.mjs')).isFile());
});

test('APK 只进附件清单（记录 sha256），不拷进发布目录', () => {
  const root = fakeSource();
  const apkDir = workdir();
  writeFileSync(join(apkDir, 'NoMoTo-1.0.apk'), 'apkbytes');
  const out = join(workdir(), 'rel');
  buildRelease({ sourceRoot: root, outDir: out, apk: join(apkDir, 'NoMoTo-1.0.apk') });
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
  assert.equal(manifest.attachments[0].status, 'present');
  assert.equal(manifest.attachments[0].size, 8);
  assert.match(manifest.attachments[0].sha256, /^[0-9a-f]{64}$/);
  assert.equal(existsSync(join(out, 'NoMoTo-1.0.apk')), false);
});

test('确定性：两次构建 manifest 与 tarball 字节一致，且可重入覆盖旧产物', () => {
  const root = fakeSource();
  const base = workdir();
  const a = buildRelease({ sourceRoot: root, outDir: join(base, 'a'), tarball: true });
  const b = buildRelease({ sourceRoot: root, outDir: join(base, 'b'), tarball: true });
  assert.equal(readFileSync(join(base, 'a/manifest.json'), 'utf8'), readFileSync(join(base, 'b/manifest.json'), 'utf8'));
  assert.equal(a.manifestSha256, b.manifestSha256);
  assert.deepEqual(readFileSync(a.tarball), readFileSync(b.tarball));
  const again = buildRelease({ sourceRoot: root, outDir: join(base, 'a'), tarball: true });
  assert.equal(again.manifestSha256, a.manifestSha256);
  assert.deepEqual(readdirSync(base).sort(), ['a', 'a.tar.gz', 'b', 'b.tar.gz']);
  const tar = gunzipSync(readFileSync(a.tarball));
  assert.match(tar.toString('latin1'), /demo-console-1\.2\.3\/src\/server\.mjs/);
});

test('源文件变化 → manifest 变化', () => {
  const root = fakeSource();
  const base = workdir();
  const a = buildRelease({ sourceRoot: root, outDir: join(base, 'a') });
  put(root, 'src/server.mjs', 'export const ok = false;\n');
  const b = buildRelease({ sourceRoot: root, outDir: join(base, 'b') });
  assert.notEqual(a.manifestSha256, b.manifestSha256);
});

test('守门：混入上游内核文件即失败并列出命中文件', () => {
  const root = fakeSource();
  put(root, 'src/app/kernel.mjs', 'upstream\n');
  assertFails(root, /src\/app\/kernel\.mjs.*内核/);
});

test('守门：私钥与 token 内容即失败', () => {
  for (const [rel, content, label] of [
    ['src/a.mjs', `-----BEGIN ${'RSA '}PRIVATE KEY-----\nabc\n`, /私钥/],
    ['src/b.mjs', `const t = '${'ghp_'}${'a'.repeat(30)}';\n`, /GitHub token/],
    ['src/c.mjs', `const k = '${'sk-'}${'b'.repeat(30)}';\n`, /API key/]
  ]) {
    const root = fakeSource();
    put(root, rel, content);
    assertFails(root, new RegExp(`${rel.replace('.', '\\.')}.*${label.source}`));
  }
});

test('守门：本机绝对路径即失败', () => {
  const root = fakeSource();
  put(root, 'src/w.mjs', `const p = '/${'Users'}/someone/.local/bin/tool';\n`);
  assertFails(root, /src\/w\.mjs.*本机路径/);
});

test('守门：密钥文件即失败，.env.example 放行', () => {
  const root = fakeSource();
  put(root, 'examples/.env.example', 'KEY=\n');
  put(root, 'examples/server.pem', 'pem');
  assertFails(root, /examples\/server\.pem.*密钥文件/);
  rmSync(join(root, 'examples/server.pem'));
  buildRelease({ sourceRoot: root, outDir: join(workdir(), 'rel') });
});

test('守门：符号链接即失败', () => {
  const root = fakeSource();
  symlinkSync('/etc/hosts', join(root, 'src/link.txt'));
  assertFails(root, /src\/link\.txt.*符号链接/);
});

test('守门：多处命中一次性全部列出', () => {
  const root = fakeSource();
  put(root, 'src/app/k.mjs', 'k\n');
  put(root, 'src/w.mjs', `'/${'Users'}/x/y'\n`);
  assertFails(root, /src\/app\/k\.mjs[\s\S]*src\/w\.mjs/);
});

test('缺少必需内容（LICENSE、docs/install）即失败并说明', () => {
  const root = fakeSource();
  rmSync(join(root, 'LICENSE'));
  rmSync(join(root, 'docs/install'), { recursive: true });
  assertFails(root, /缺少必需内容：LICENSE、docs\/install/);
});

test('失败不破坏已有产物（原子就位）', () => {
  const root = fakeSource();
  const out = join(workdir(), 'rel');
  buildRelease({ sourceRoot: root, outDir: out });
  const before = readFileSync(join(out, 'manifest.json'), 'utf8');
  put(root, 'src/app/k.mjs', 'k\n');
  assert.throws(() => buildRelease({ sourceRoot: root, outDir: out }), ReleaseError);
  assert.equal(readFileSync(join(out, 'manifest.json'), 'utf8'), before);
  assert.deepEqual(readdirSync(dirname(out)), ['rel']);
});

test('CLI：守门失败退出码 1 且 stderr 列出命中文件；成功退出码 0', () => {
  const root = fakeSource();
  const out = join(workdir(), 'rel');
  const ok = spawnSync('node', [join(REPO, 'scripts/release.mjs'), '--source', root, '--out', out], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /发布包已生成/);
  put(root, 'src/app/k.mjs', 'k\n');
  const bad = spawnSync('node', [join(REPO, 'scripts/release.mjs'), '--source', root, '--out', join(workdir(), 'x')], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /src\/app\/k\.mjs/);
});

test('发布脚本自身可通过守门（不含触发自身规则的字面量），package.json 有 release 入口', () => {
  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.release, 'node scripts/release.mjs');
  const root = fakeSource();
  put(root, 'scripts/release.mjs', readFileSync(join(REPO, 'scripts/release.mjs'), 'utf8'));
  buildRelease({ sourceRoot: root, outDir: join(workdir(), 'rel') });
});
