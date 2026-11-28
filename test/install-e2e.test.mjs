// 安装链路离线 e2e：临时目录模拟干净机器，串起 doctor 两阶段、secret-write 往返、release 组装。
// 全程离线：控制台用本机假服务，公网探测用注入的假 fetch，不依赖网络与真实 Cloudflare。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runDoctor, formatReport, UPSTREAM_URL } from '../src/doctor.mjs';
import { buildRelease } from '../scripts/release.mjs';
import { listen, close } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, 'fixtures', 'install');
const REPO = path.resolve(here, '..');
const SECRET = 'sentinel-secret-7f3a9c1d5e2b'; // 假凭据，只用于断言不泄漏
const TOKEN = 'sentinel-device-token-4b8e6a0c';
const HOST = 'console.example.com';

const cleanups = [];
test.after(() => { for (const dir of cleanups) rmSync(dir, { recursive: true, force: true }); });

function freshMachine() {
  const root = mkdtempSync(path.join(tmpdir(), 'install-e2e-'));
  cleanups.push(root);
  const home = path.join(root, 'home');
  const source = path.join(root, 'source');
  cpSync(path.join(FIXTURES, 'home'), home, { recursive: true });
  cpSync(path.join(FIXTURES, 'source'), source, { recursive: true });
  return { root, home, source };
}
async function fakeConsole() {
  const server = http.createServer((req, res) => { res.writeHead(200, { connection: 'close' }); res.end('ok'); });
  return { server, url: await listen(server) };
}
function setPublicHost(home) {
  const file = path.join(home, 'config.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), publicHost: HOST }));
}
// 假公网：匿名请求 302 到 Access 登录；带设备令牌的移动端接口 200。
const fakePublicFetch = async (url, init = {}) => {
  const { pathname } = new URL(url);
  if (pathname.startsWith('/api/mobile/') && init.headers?.['x-device-token'] === TOKEN) return new Response('{}', { status: 200 });
  return new Response(null, { status: 302, headers: { location: 'https://team.cloudflareaccess.com/login' } });
};
const run = (file, args, env) => new Promise(resolve => {
  execFile(process.execPath, [path.join(REPO, 'scripts', file), ...args], { env: { ...process.env, ...env } },
    (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
});
const writeSecretCli = (home, key, input) => spawnSync(process.execPath, [path.join(REPO, 'scripts', 'secret-write.mjs'), key],
  { input, env: { ...process.env, AGENT_AUTOLOOP_HOME: home }, encoding: 'utf8' });
function listTree(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const abs = path.join(dir, entry.name);
    return entry.isDirectory() ? listTree(abs, base) : [`${path.relative(base, abs)}\n${readFileSync(abs, 'utf8')}`];
  }).sort();
}

test('doctor local：干净机器连跑两次结果一致，CLI 退出码 0', async () => {
  const { home } = freshMachine(); const c = await fakeConsole();
  try {
    const env = { AGENT_AUTOLOOP_HOME: home, AUTOLOOP_CONSOLE_URL: c.url };
    const a = await run('doctor.mjs', ['--phase', 'local', '--json'], env);
    const b = await run('doctor.mjs', ['--phase', 'local', '--json'], env);
    assert.equal(a.code, 0); assert.equal(b.code, 0);
    assert.equal(a.stdout, b.stdout);
    assert.ok(JSON.parse(a.stdout).checks.every(x => x.status === 'pass'));
  } finally { await close(c.server); }
});

test('doctor local：缺内核时输出 GitHub 指引，退出码 1，且可重入', async () => {
  const { home } = freshMachine(); const c = await fakeConsole();
  rmSync(path.join(home, 'app'), { recursive: true });
  try {
    const env = { AGENT_AUTOLOOP_HOME: home, AUTOLOOP_CONSOLE_URL: c.url };
    const a = await run('doctor.mjs', ['--phase', 'local'], env);
    const b = await run('doctor.mjs', ['--phase', 'local'], env);
    for (const r of [a, b]) {
      assert.equal(r.code, 1);
      assert.ok(r.stdout.includes(UPSTREAM_URL));
      assert.match(r.stdout, /git clone/);
    }
    assert.equal(a.stdout, b.stdout);
    assert.ok(!existsSync(path.join(home, 'app')), 'doctor 只读，不得自行补内核');
  } finally { await close(c.server); }
});

test('doctor public：缺 publicHost 失败；配置后假隧道与假公网通过且可重入；匿名放行时失败', async () => {
  const { home } = freshMachine(); const c = await fakeConsole();
  try {
    const base = { phase: 'public', home, consoleUrl: c.url, fetch: fakePublicFetch, tunnelConfigPaths: [path.join(home, 'cloudflared.yml')], deviceToken: TOKEN };
    const noHost = await runDoctor(base);
    assert.equal(noHost.exitCode, 1);
    assert.equal(noHost.checks.find(x => x.id === 'public-host').status, 'fail');
    assert.equal(noHost.checks.find(x => x.id === 'mobile-api').status, 'skip');

    setPublicHost(home); // 模拟 playbook 阶段二写入 publicHost
    const a = await runDoctor(base); const b = await runDoctor(base);
    assert.equal(a.exitCode, 0, formatReport(a));
    assert.deepEqual(a, b);
    assert.ok(a.checks.every(x => x.status === 'pass'));

    const open = await runDoctor({ ...base, fetch: async () => new Response('secret page', { status: 200 }) });
    assert.equal(open.exitCode, 1);
    assert.equal(open.checks.find(x => x.id === 'access-blocks-anonymous').status, 'fail');
  } finally { await close(c.server); }
});

test('secret-write 往返：写入落盘、权限收紧、重复写入结果一致、值不出现在输出', () => {
  const { home } = freshMachine();
  const first = writeSecretCli(home, 'cloudflare-token', `${SECRET}\n${SECRET}\n`);
  assert.equal(first.status, 0);
  const file = path.join(home, 'secrets', 'cloudflare-token');
  assert.equal(readFileSync(file, 'utf8'), SECRET);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);

  const second = writeSecretCli(home, 'cloudflare-token', `${SECRET}\n`);
  assert.equal(second.status, 0);
  assert.equal(second.stdout, first.stdout);
  assert.equal(readFileSync(file, 'utf8'), SECRET);

  const owner = writeSecretCli(home, 'owner', `${SECRET}\n`);
  assert.equal(owner.status, 0);
  assert.equal(JSON.parse(readFileSync(path.join(home, 'config.json'), 'utf8')).owner, SECRET);
  assert.equal(statSync(path.join(home, 'config.json')).mode & 0o777, 0o600);

  for (const r of [first, second, owner]) {
    assert.ok(!r.stdout.includes(SECRET)); assert.ok(!r.stderr.includes(SECRET));
  }
  assert.deepEqual(readdirSync(path.join(home, 'secrets')), ['cloudflare-token'], '不留临时文件');
});

test('secret-write 失败路径：不允许的 key、两次不一致、空值都不写入且不泄漏', () => {
  const { home } = freshMachine();
  const bad = writeSecretCli(home, 'not-allowed', `${SECRET}\n`);
  const mismatch = writeSecretCli(home, 'cloudflare-token', `${SECRET}\n${SECRET}-other\n`);
  const empty = writeSecretCli(home, 'cloudflare-token', '\n');
  for (const r of [bad, mismatch, empty]) {
    assert.equal(r.status, 1);
    assert.ok(!r.stdout.includes(SECRET)); assert.ok(!r.stderr.includes(SECRET));
  }
  assert.ok(!existsSync(path.join(home, 'secrets', 'cloudflare-token')));
});

test('凭据不泄漏：写入密钥后 doctor 两阶段输出不含密钥值，也不含设备令牌', async () => {
  const { home } = freshMachine(); const c = await fakeConsole();
  try {
    assert.equal(writeSecretCli(home, 'owner', `${SECRET}\n`).status, 0);
    setPublicHost(home);
    const outputs = [];
    for (const phase of ['local', 'public']) {
      const report = await runDoctor({ phase, home, consoleUrl: c.url, fetch: fakePublicFetch, tunnelConfigPaths: [path.join(home, 'cloudflared.yml')], deviceToken: TOKEN });
      outputs.push(JSON.stringify(report), formatReport(report));
    }
    const cli = await run('doctor.mjs', ['--phase', 'local'], { AGENT_AUTOLOOP_HOME: home, AUTOLOOP_CONSOLE_URL: c.url, AUTOLOOP_DEVICE_TOKEN: TOKEN });
    outputs.push(cli.stdout, cli.stderr);
    for (const text of outputs) { assert.ok(!text.includes(SECRET)); assert.ok(!text.includes(TOKEN)); }
  } finally { await close(c.server); }
});

test('release 组装：两次结果一致、不含内核与运行状态；守门命中时失败且不留半成品', () => {
  const { root, source } = freshMachine();
  const out1 = path.join(root, 'out1'); const out2 = path.join(root, 'out2');
  const a = buildRelease({ sourceRoot: source, outDir: out1, tarball: true });
  const b = buildRelease({ sourceRoot: source, outDir: out2, tarball: true });
  assert.equal(a.manifestSha256, b.manifestSha256);
  assert.deepEqual(listTree(out1), listTree(out2));
  assert.deepEqual(readFileSync(a.tarball), readFileSync(b.tarball));
  assert.equal(buildRelease({ sourceRoot: source, outDir: out1, tarball: true }).manifestSha256, a.manifestSha256, '同目录重跑可重入');
  const paths = a.manifest.files.map(f => f.path);
  assert.ok(paths.includes('README.md') && paths.includes('docs/install/playbook.md'));
  assert.ok(!paths.some(p => /(^|\/)app\/|(^|\/)(config|rules)\.json$|node_modules/.test(p)));

  // 源里混入密钥文件与密钥内容：构建失败并列出文件，不带值，不留半成品
  writeFileSync(path.join(source, 'src', 'leak.mjs'), `const t = "${'gh' + 'p_'}${'a'.repeat(30)}";\n`);
  writeFileSync(path.join(source, 'src', 'master.key'), SECRET);
  const out3 = path.join(root, 'out3');
  assert.throws(() => buildRelease({ sourceRoot: source, outDir: out3 }), error => {
    assert.match(error.message, /leak\.mjs/); assert.match(error.message, /master\.key/);
    assert.ok(!error.message.includes(SECRET));
    return true;
  });
  assert.ok(!existsSync(out3));
  assert.deepEqual(readdirSync(root).filter(name => name.startsWith('.release-stage')), []);
});

test('release CLI：输出与 manifest 不含凭据；缺必需内容时退出码 1', async () => {
  const { root, source, home } = freshMachine();
  assert.equal(writeSecretCli(home, 'cloudflare-token', `${SECRET}\n`).status, 0);
  const out = path.join(root, 'cli-out');
  const ok = await run('release.mjs', ['--source', source, '--out', out, '--json'], {});
  assert.equal(ok.code, 0);
  for (const text of [ok.stdout, ok.stderr, readFileSync(path.join(out, 'manifest.json'), 'utf8')]) assert.ok(!text.includes(SECRET));
  rmSync(path.join(source, 'docs'), { recursive: true });
  const bad = await run('release.mjs', ['--source', source, '--out', path.join(root, 'bad-out')], {});
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /发布构建失败/);
});
