import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync, execFile } from 'node:child_process';
import { runDoctor, formatReport, UPSTREAM_URL } from '../src/doctor.mjs';
import { listen, close } from './helpers.mjs';

const RULES = { agents: { a: { name: 'A' } }, rules: [{ name: 'r', when: { cron: '* * * * *' }, to: 'a', cwd: '/tmp', prompt: 'x' }] };

function makeHome({ kernel = true, config = { url: 'http://127.0.0.1:1', owner: 'k' }, rules = RULES } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'doctor-'));
  if (config) writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));
  if (rules) writeFileSync(path.join(home, 'rules.json'), typeof rules === 'string' ? rules : JSON.stringify(rules));
  if (kernel) { mkdirSync(path.join(home, 'app', 'bin'), { recursive: true }); writeFileSync(path.join(home, 'app', 'bin', 'agent-autoloop.ts'), '// fake'); }
  return home;
}
async function consoleServer(handler) {
  const server = http.createServer((req, res) => { res.setHeader('connection', 'close'); handler(req, res); });
  return { server, url: await listen(server) };
}
const okConsole = (req, res) => { res.writeHead(200); res.end('ok'); };
const byId = report => Object.fromEntries(report.checks.map(c => [c.id, c]));

test('local：全部通过，退出码 0', async () => {
  const home = makeHome(); const c = await consoleServer(okConsole);
  try {
    const report = await runDoctor({ phase: 'local', home, consoleUrl: c.url });
    assert.equal(report.ok, true); assert.equal(report.exitCode, 0);
    assert.deepEqual(report.checks.map(x => x.id), ['node-version', 'home-layout', 'console-reachable', 'rules-draft']);
    assert.ok(report.checks.every(x => x.status === 'pass'));
  } finally { await close(c.server); rmSync(home, { recursive: true, force: true }); }
});

test('local：缺内核输出上游 GitHub 地址与获取指引，退出码 1', async () => {
  const home = makeHome({ kernel: false }); const c = await consoleServer(okConsole);
  try {
    const report = await runDoctor({ phase: 'local', home, consoleUrl: c.url });
    const layout = byId(report)['home-layout'];
    assert.equal(report.exitCode, 1); assert.equal(layout.status, 'fail');
    assert.match(layout.detail, /app\/bin\/agent-autoloop\.ts/);
    assert.ok(layout.detail.includes(UPSTREAM_URL));
    assert.match(layout.fix, /git clone|获取/);
    assert.match(formatReport(report), new RegExp(UPSTREAM_URL.replace(/[.]/g, '\\.')));
  } finally { await close(c.server); rmSync(home, { recursive: true, force: true }); }
});

test('local：Node 版本过低、未设运行目录、缺配置文件各自失败', async () => {
  const old = await runDoctor({ phase: 'local', home: makeHome(), nodeVersion: '22.1.0', consoleUrl: 'http://127.0.0.1:1', fetch: async () => { throw new Error('x'); } });
  assert.equal(byId(old)['node-version'].status, 'fail');
  const none = await runDoctor({ phase: 'local', home: undefined, nodeVersion: '24.0.0', fetch: async () => { throw new Error('x'); } });
  assert.equal(byId(none)['home-layout'].status, 'fail'); assert.match(byId(none)['home-layout'].detail, /AGENT_AUTOLOOP_HOME/);
  const home = makeHome({ config: null, rules: null });
  const report = await runDoctor({ phase: 'local', home, nodeVersion: '24.0.0', fetch: async () => { throw new Error('x'); } });
  assert.match(byId(report)['home-layout'].detail, /config\.json/); assert.match(byId(report)['home-layout'].detail, /rules\.json/);
  assert.equal(byId(report)['rules-draft'].status, 'fail');
  rmSync(home, { recursive: true, force: true });
});

test('local：控制台不可达按失败项报告而不崩溃', async () => {
  const home = makeHome();
  const report = await runDoctor({ phase: 'local', home, consoleUrl: 'http://127.0.0.1:1' });
  assert.equal(byId(report)['console-reachable'].status, 'fail');
  assert.equal(report.exitCode, 1);
  rmSync(home, { recursive: true, force: true });
});

test('local：rules 草稿非法（坏 JSON / Agent 不存在）失败', async () => {
  const c = await consoleServer(okConsole);
  try {
    for (const rules of ['{bad', { agents: {}, rules: [{ name: 'r', when: { cron: '* * * * *' }, to: 'zz', cwd: '/x' }] }, { agents: { a: {} }, rules: [{ name: 'r', to: 'a', cwd: '/x' }] }]) {
      const home = makeHome({ rules });
      const report = await runDoctor({ phase: 'local', home, consoleUrl: c.url });
      assert.equal(byId(report)['rules-draft'].status, 'fail', JSON.stringify(rules));
      rmSync(home, { recursive: true, force: true });
    }
  } finally { await close(c.server); }
});

// ---- public ----
function publicFixture({ publicHost = 'console.example.com', tunnel = true, ingressHost = publicHost } = {}) {
  const home = makeHome({ config: { url: 'http://127.0.0.1:1', owner: 'k', ...(publicHost === null ? {} : { publicHost }) } });
  const cf = path.join(home, 'cloudflared.yml');
  if (tunnel) writeFileSync(cf, `tunnel: abc\ningress:\n  - hostname: ${ingressHost}\n    service: http://127.0.0.1:50761\n  - service: http_status:404\n`);
  return { home, cf };
}
function fakeFetch({ publicRoot = 302, publicApi = 302, mobile = 200 } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers || {} });
    const u = new URL(url);
    if (u.hostname === 'console.example.com') {
      if (u.pathname === '/api/mobile/session' && init.headers?.['x-device-token']) return new Response('{}', { status: init.headers['x-device-token'] === 'good' ? mobile : 401 });
      const status = u.pathname === '/' ? publicRoot : publicApi;
      return new Response(status === 200 ? '{"secret":"leak"}' : 'login', { status, headers: status >= 300 && status < 400 ? { location: 'https://team.cloudflareaccess.com/login' } : {} });
    }
    if (u.pathname === '/api/mobile/session') return new Response('{}', { status: init.headers?.['x-device-token'] === 'good' ? mobile : 401 });
    return new Response('ok', { status: 200 });
  };
  fn.calls = calls; return fn;
}

test('public：全部通过', async () => {
  const { home, cf } = publicFixture();
  try {
    const report = await runDoctor({ phase: 'public', home, nodeVersion: '24.0.0', consoleUrl: 'http://127.0.0.1:50761', fetch: fakeFetch(), tunnelConfigPaths: [cf], deviceToken: 'good' });
    assert.equal(report.exitCode, 0, formatReport(report));
    assert.deepEqual(report.checks.slice(4).map(x => x.id), ['public-host', 'tunnel-config', 'public-reachable', 'access-blocks-anonymous', 'mobile-api']);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('public：publicHost 缺失或非法', async () => {
  for (const publicHost of [null, 'Bad.COM', 'a.com:8443', 'https://a.com', '*.a.com', 'a.com/x', 'localhost']) {
    const { home, cf } = publicFixture({ publicHost, tunnel: false });
    const report = await runDoctor({ phase: 'public', home, nodeVersion: '24.0.0', consoleUrl: 'http://127.0.0.1:1', fetch: fakeFetch(), tunnelConfigPaths: [cf] });
    assert.equal(byId(report)['public-host'].status, 'fail', String(publicHost));
    assert.equal(report.exitCode, 1);
    rmSync(home, { recursive: true, force: true });
  }
});

test('public：隧道配置缺失或不含该域名', async () => {
  for (const opts of [{ tunnel: false }, { ingressHost: 'other.example.com' }]) {
    const { home, cf } = publicFixture(opts);
    const report = await runDoctor({ phase: 'public', home, nodeVersion: '24.0.0', consoleUrl: 'http://127.0.0.1:1', fetch: fakeFetch(), tunnelConfigPaths: [cf] });
    assert.equal(byId(report)['tunnel-config'].status, 'fail');
    rmSync(home, { recursive: true, force: true });
  }
});

test('public：匿名请求未被拦截（200 返回数据）失败，且不回显响应内容', async () => {
  const { home, cf } = publicFixture();
  try {
    const report = await runDoctor({ phase: 'public', home, nodeVersion: '24.0.0', consoleUrl: 'http://127.0.0.1:1', fetch: fakeFetch({ publicApi: 200 }), tunnelConfigPaths: [cf], deviceToken: 'good' });
    const item = byId(report)['access-blocks-anonymous'];
    assert.equal(item.status, 'fail'); assert.equal(report.exitCode, 1);
    assert.ok(!JSON.stringify(report).includes('leak'));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('public：公网不可达按失败报告；匿名探测不带凭证头', async () => {
  const { home, cf } = publicFixture();
  try {
    const fetch = fakeFetch();
    const down = async (url, init) => { if (new URL(url).hostname === 'console.example.com') throw new Error('ENOTFOUND'); return fetch(url, init); };
    const report = await runDoctor({ phase: 'public', home, nodeVersion: '24.0.0', consoleUrl: 'http://127.0.0.1:1', fetch: down, tunnelConfigPaths: [cf], deviceToken: 'good' });
    assert.equal(byId(report)['public-reachable'].status, 'fail');
    assert.equal(byId(report)['access-blocks-anonymous'].status, 'fail');
    const ok = fakeFetch();
    await runDoctor({ phase: 'public', home, nodeVersion: '24.0.0', consoleUrl: 'http://127.0.0.1:1', fetch: ok, tunnelConfigPaths: [cf], deviceToken: 'good' });
    const anon = ok.calls.filter(c => c.url.startsWith('https://console.example.com') && !c.url.includes('/api/mobile/'));
    assert.ok(anon.length >= 2); assert.ok(anon.every(c => !c.headers['x-device-token'] && !c.headers.authorization));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('public：移动端 API 令牌无效失败，未提供令牌为 skip 且不判失败', async () => {
  const { home, cf } = publicFixture();
  try {
    const bad = await runDoctor({ phase: 'public', home, nodeVersion: '24.0.0', consoleUrl: 'http://127.0.0.1:1', fetch: fakeFetch(), tunnelConfigPaths: [cf], deviceToken: 'bad' });
    assert.equal(byId(bad)['mobile-api'].status, 'fail');
    const none = await runDoctor({ phase: 'public', home, nodeVersion: '24.0.0', consoleUrl: 'http://127.0.0.1:1', fetch: fakeFetch(), tunnelConfigPaths: [cf] });
    assert.equal(byId(none)['mobile-api'].status, 'skip');
    assert.equal(none.exitCode, 0, formatReport(none));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('只读且可重复：连跑两次结果一致，运行目录不被修改', async () => {
  const { home, cf } = publicFixture();
  const snap = () => spawnSync('find', [home, '-type', 'f', '-exec', 'stat', '-f', '%N %m %z', '{}', '+'], { encoding: 'utf8' }).stdout;
  try {
    const opts = { phase: 'public', home, nodeVersion: '24.0.0', consoleUrl: 'http://127.0.0.1:1', tunnelConfigPaths: [cf], deviceToken: 'good' };
    const s0 = snap();
    const a = await runDoctor({ ...opts, fetch: fakeFetch() }); const b = await runDoctor({ ...opts, fetch: fakeFetch() });
    assert.deepEqual(a, b); assert.equal(snap(), s0)
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('CLI：--json 结构稳定，缺内核退出码 1；参数非法退出码 2', async () => {
  const home = makeHome({ kernel: false }); const c = await consoleServer(okConsole);
  try {
    const env = { ...process.env, AGENT_AUTOLOOP_HOME: home, AUTOLOOP_CONSOLE_URL: c.url };
    const r = await new Promise(resolve => execFile(process.execPath, ['scripts/doctor.mjs', '--phase', 'local', '--json'], { env }, (err, stdout) => resolve({ status: err?.code ?? 0, stdout })));
    assert.equal(r.status, 1);
    const parsed = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(parsed), ['phase', 'ok', 'exitCode', 'checks']);
    for (const item of parsed.checks) assert.ok(['id', 'status', 'detail'].every(k => k in item));
    assert.ok(r.stdout.includes(UPSTREAM_URL));
    const bad = await new Promise(resolve => execFile(process.execPath, ['scripts/doctor.mjs', '--phase', 'nope'], { env }, (err, stdout, stderr) => resolve({ status: err?.code, stderr })));
    assert.equal(bad.status, 2); assert.match(bad.stderr, /--phase/);
  } finally { await close(c.server); rmSync(home, { recursive: true, force: true }); }
});
