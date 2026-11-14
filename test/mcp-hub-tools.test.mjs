import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleToolCall, projectName, matchesProject, SERVER_NAME } from '../src/mcp/hub-tools.mjs';
import { fakeHub, json, close } from './helpers.mjs';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULE_DIR, '..');
const HUB_TOOLS_PATH = path.join(REPOSITORY_ROOT, 'src', 'mcp', 'hub-tools.mjs');

const OWNER_SECRET = 'test-owner-secret-key';

const SNAPSHOT = {
  seq: 42,
  lines: [
    { name: '开发', paused: null, totals: { running: 1 } },
    { name: '部署', paused: { reason: '额度耗尽', until: '2026-11-15T00:00:00+08:00' } },
  ],
  runs: [
    { id: 7, rule: '开发', agent: 'codex', state: 'claimed', attempts: 1, createdAt: '2026-11-14T01:00:00Z', summary: '正在改' },
    { id: 8, rule: '旧规则', agent: 'codex', state: 'queued', attempts: 3, error: '连接失败', project: '/elsewhere/beta' },
    { id: 9, rule: '部署', agent: 'codex', state: 'done', attempts: 0, summary: '完成', finishedAt: '2026-11-14T02:00:00Z', cwd: '/workspace/demo' },
    { id: 10, rule: '开发', agent: 'codex', state: 'unknown', attempts: 5, summary: '失联', project: '/elsewhere/beta' },
  ],
  cards: [
    { id: 21, state: 'open', title: '是否继续', text: '开放卡片一', options: ['继续'] },
    { id: 22, state: 'closed', title: '已结案', text: '不应出现', options: [] },
    { id: 23, state: 'open', title: '缺凭据', text: '开放卡片二' },
  ],
};

const RULES = {
  agents: { codex: { name: 'Codex' } },
  sources: {},
  rules: [
    { name: '开发', to: 'codex', cwd: '/workspace/demo', prompt: '开发任务', when: { cron: '*/10 * * * *' }, parallel: 1, resume: false },
    { name: '部署', to: 'codex', cwd: '/elsewhere/beta', prompt: '部署任务', when: { source: 'github', types: ['push'] }, parallel: 2, resume: true },
  ],
};

async function fixture() {
  const home = mkdtempSync(path.join(tmpdir(), 'autoloop-mcp-test-'));
  const hub = await fakeHub((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${OWNER_SECRET}`);
    json(res, SNAPSHOT);
  });
  writeFileSync(path.join(home, 'config.json'), JSON.stringify({ url: hub.url, owner: OWNER_SECRET }));
  writeFileSync(path.join(home, 'rules.json'), JSON.stringify(RULES));
  const config = { root: home, hubUrl: hub.url, ownerKey: OWNER_SECRET, rulesFile: path.join(home, 'rules.json') };
  return { home, hub, config };
}

test('list_rules returns schedule, cwd project ownership and paused state merged from hub lines', async () => {
  const { hub, config } = await fixture();
  try {
    const result = await handleToolCall('list_rules', {}, { config });
    assert.equal(result.rules.length, 2);
    const dev = result.rules.find(rule => rule.name === '开发');
    assert.equal(dev.schedule, '定时 · */10 * * * *');
    assert.equal(dev.cwd, '/workspace/demo');
    assert.equal(dev.project, 'demo');
    assert.equal(dev.agent, 'codex');
    assert.equal(dev.paused, null);
    const deploy = result.rules.find(rule => rule.name === '部署');
    assert.equal(deploy.paused.reason, '额度耗尽');
    assert.equal(deploy.paused.until, '2026-11-15T00:00:00+08:00');
  } finally { await close(hub.server); }
});

test('list_rules project filter matches by path or basename like the console projectName normalization', async () => {
  const { hub, config } = await fixture();
  try {
    const byPath = await handleToolCall('list_rules', { project: '/elsewhere/beta' }, { config });
    assert.deepEqual(byPath.rules.map(rule => rule.name), ['部署']);
    const byBase = await handleToolCall('list_rules', { project: 'demo' }, { config });
    assert.deepEqual(byBase.rules.map(rule => rule.name), ['开发']);
    const byOwnerStyle = await handleToolCall('list_rules', { project: 'owner/demo' }, { config });
    assert.deepEqual(byOwnerStyle.rules.map(rule => rule.name), ['开发']);
  } finally { await close(hub.server); }
});

test('list_runs resolves project from run data or rule workdir and summarizes error over summary', async () => {
  const { hub, config } = await fixture();
  try {
    const result = await handleToolCall('list_runs', {}, { config });
    assert.equal(result.runs.length, 4);
    const run = result.runs.find(item => item.id === 8);
    assert.equal(run.rule, '旧规则');
    assert.equal(run.project, 'beta');
    assert.equal(run.state, 'queued');
    assert.equal(run.attempts, 3);
    assert.equal(run.text, '连接失败');
    const ruleFallback = result.runs.find(item => item.id === 7);
    assert.equal(ruleFallback.project, 'demo', 'run without project/cwd falls back to the matching rule cwd');
    const done = result.runs.find(item => item.id === 9);
    assert.equal(done.finishedAt, '2026-11-14T02:00:00Z');
    const filtered = await handleToolCall('list_runs', { project: 'beta' }, { config });
    assert.deepEqual(filtered.runs.map(item => item.id), [8, 10]);
  } finally { await close(hub.server); }
});

test('list_cards returns only open cards with id, title and text', async () => {
  const { hub, config } = await fixture();
  try {
    const result = await handleToolCall('list_cards', {}, { config });
    assert.deepEqual(result.cards.map(card => card.id), [21, 23]);
    assert.equal(result.cards[0].title, '是否继续');
    assert.equal(result.cards[0].text, '开放卡片一');
  } finally { await close(hub.server); }
});

test('tool results never contain the owner key', async () => {
  const { hub, config } = await fixture();
  try {
    for (const name of ['list_rules', 'list_runs', 'list_cards']) {
      const result = await handleToolCall(name, {}, { config });
      assert.equal(JSON.stringify(result).includes(OWNER_SECRET), false, `${name} leaked the owner key`);
    }
  } finally { await close(hub.server); }
});

test('unknown tool names and hub failures surface as readable errors', async () => {
  const { hub, config } = await fixture();
  try {
    await assert.rejects(() => handleToolCall('delete_everything', {}, { config }), /未知工具/);
    const failing = await fakeHub((req, res) => json(res, { error: 'boom' }, 502));
    const failingConfig = { ...config, hubUrl: failing.url };
    try {
      await assert.rejects(() => handleToolCall('list_cards', {}, { config: failingConfig }), /中台|boom/);
    } finally { await close(failing.server); }
  } finally { await close(hub.server); }
});

test('projectName and matchesProject mirror the frontend basename normalization', () => {
  assert.equal(projectName('/workspace/demo/'), 'demo');
  assert.equal(projectName('owner/demo'), 'demo');
  assert.equal(projectName(''), '未识别');
  assert.equal(matchesProject('/alpha/demo', '/beta/demo'), true);
  assert.equal(matchesProject('/workspace/demo', '/workspace/demo2'), false);
  assert.equal(matchesProject('/workspace/demo', ''), true);
});

test('stdio server answers initialize, tools/list and tools/call over JSON-RPC', async () => {
  const { home, hub } = await fixture();
  try {
    const child = spawn(process.execPath, [HUB_TOOLS_PATH], {
      env: { AGENT_AUTOLOOP_HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    const responses = new Map();
    let buffer = '';
    const done = new Promise((resolve, reject) => {
      child.stdout.on('data', chunk => {
        buffer += chunk.toString();
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          const message = JSON.parse(line);
          if (message.id !== undefined && message.id !== null) responses.set(message.id, message);
          if (responses.has(2) && responses.has(3) && responses.has(4)) resolve();
        }
      });
      child.on('error', reject);
      setTimeout(() => reject(new Error('stdio MCP 服务器响应超时')), 8000);
    });
    const send = value => child.stdin.write(`${JSON.stringify(value)}\n`);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_cards', arguments: {} } });
    send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } });
    await done;
    child.kill('SIGTERM');
    const init = responses.get(1);
    assert.equal(init.result.serverInfo.name, SERVER_NAME);
    assert.deepEqual(init.result.capabilities, { tools: {} });
    const toolList = responses.get(2).result.tools.map(tool => tool.name);
    assert.deepEqual(toolList.sort(), ['list_cards', 'list_rules', 'list_runs', 'pause_rule', 'resume_rule', 'run_rule']);
    const cards = JSON.parse(responses.get(3).result.content[0].text);
    assert.deepEqual(cards.cards.map(card => card.id), [21, 23]);
    const bad = responses.get(4);
    assert.equal(bad.result.isError, true);
    assert.equal(stderr.includes(OWNER_SECRET), false, 'stderr must never carry the owner key');
  } finally { await close(hub.server); }
});

test('the MCP script path advertised by the console exists', () => {
  assert.ok(existsSync(HUB_TOOLS_PATH));
});

test('write tools post to the same hub actions as the console buttons with the right payloads', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'autoloop-mcp-write-'));
  const requests = [];
  const hub = await fakeHub((req, res, body) => {
    requests.push({ method: req.method, url: req.url, body: JSON.parse(body || '{}') });
    json(res, { changed: true });
  });
  writeFileSync(path.join(home, 'config.json'), JSON.stringify({ url: hub.url, owner: OWNER_SECRET }));
  writeFileSync(path.join(home, 'rules.json'), JSON.stringify({ rules: [], agents: {}, sources: {} }));
  const config = { root: home, hubUrl: hub.url, ownerKey: OWNER_SECRET, rulesFile: path.join(home, 'rules.json') };
  const auditLines = [];
  const originalError = console.error;
  console.error = (...args) => { auditLines.push(args.join(' ')); };
  try {
    const resumed = await handleToolCall('resume_rule', { name: '恢复测试', reason: '自愈完成' }, { config });
    assert.deepEqual(resumed, { changed: true });
    const paused = await handleToolCall('pause_rule', { name: '额度耗尽规则' }, { config });
    assert.deepEqual(paused, { changed: true });
    const ran = await handleToolCall('run_rule', { name: '开发', subject: 'demo-fix', reason: '重触发' }, { config });
    assert.deepEqual(ran, { changed: true });
    assert.deepEqual(requests.map(request => `${request.method} ${request.url}`), [
      'POST /v1/rules/%E6%81%A2%E5%A4%8D%E6%B5%8B%E8%AF%95/resume',
      'POST /v1/rules/%E9%A2%9D%E5%BA%A6%E8%80%97%E5%B0%BD%E8%A7%84%E5%88%99/pause',
      'POST /v1/rules/%E5%BC%80%E5%8F%91/run',
    ]);
    assert.deepEqual(requests[0].body, { reason: '自愈完成' });
    assert.deepEqual(requests[1].body, {});
    assert.deepEqual(requests[2].body, { subject: 'demo-fix', reason: '重触发' });
    for (const request of requests) assert.equal(request.body.reason === OWNER_SECRET, false);
  } finally {
    console.error = originalError;
    await close(hub.server);
  }
  assert.deepEqual(auditLines.map(line => line.replace(/name=.* ok$/, 'name=<rule> ok')), [
    '[autoloop-hub] 写工具审计: resume_rule name=<rule> ok',
    '[autoloop-hub] 写工具审计: pause_rule name=<rule> ok',
    '[autoloop-hub] 写工具审计: run_rule name=<rule> ok',
  ]);
  assert.equal(auditLines.join('\n').includes(OWNER_SECRET), false, '审计日志不得携带密钥');
});

test('write tools validate a non-empty rule name and never leak the owner key', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'autoloop-mcp-write-'));
  const hub = await fakeHub((req, res) => json(res, { changed: true }));
  writeFileSync(path.join(home, 'config.json'), JSON.stringify({ url: hub.url, owner: OWNER_SECRET }));
  writeFileSync(path.join(home, 'rules.json'), JSON.stringify({ rules: [], agents: {}, sources: {} }));
  const config = { root: home, hubUrl: hub.url, ownerKey: OWNER_SECRET, rulesFile: path.join(home, 'rules.json') };
  try {
    for (const tool of ['resume_rule', 'pause_rule', 'run_rule']) {
      await assert.rejects(() => handleToolCall(tool, { name: '' }, { config }), /name/);
      await assert.rejects(() => handleToolCall(tool, {}, { config }), /name/);
      await assert.rejects(() => handleToolCall(tool, { name: 42 }, { config }), /name/);
    }
    const failing = await fakeHub((req, res) => json(res, { error: 'resume boom' }, 502));
    const failingConfig = { ...config, hubUrl: failing.url };
    try {
      await assert.rejects(() => handleToolCall('resume_rule', { name: 'x' }, { config: failingConfig }), /resume boom/);
      const error = await handleToolCall('resume_rule', { name: 'x' }, { config: failingConfig }).catch(e => e);
      assert.equal(String(error.message).includes(OWNER_SECRET), false);
    } finally { await close(failing.server); }
  } finally { await close(hub.server); }
});

test('write tool results never contain the owner key', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'autoloop-mcp-write-'));
  const hub = await fakeHub((req, res) => json(res, { changed: true, echo: req.headers.authorization }));
  writeFileSync(path.join(home, 'config.json'), JSON.stringify({ url: hub.url, owner: OWNER_SECRET }));
  writeFileSync(path.join(home, 'rules.json'), JSON.stringify({ rules: [], agents: {}, sources: {} }));
  const config = { root: home, hubUrl: hub.url, ownerKey: OWNER_SECRET, rulesFile: path.join(home, 'rules.json') };
  try {
    for (const tool of ['resume_rule', 'pause_rule', 'run_rule']) {
      const result = await handleToolCall(tool, { name: '开发' }, { config, cooldowns: new Map() });
      assert.equal(JSON.stringify(result).includes(OWNER_SECRET), false, `${tool} leaked the owner key`);
    }
  } finally { await close(hub.server); }
});

test('run_rule enforces a 10-minute per-rule cooldown with remaining seconds in the error', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'autoloop-mcp-cooldown-'));
  const runPosts = [];
  const hub = await fakeHub((req, res, body) => {
    if (req.url.endsWith('/run')) runPosts.push(JSON.parse(body || '{}'));
    json(res, { changed: true });
  });
  writeFileSync(path.join(home, 'config.json'), JSON.stringify({ url: hub.url, owner: OWNER_SECRET }));
  writeFileSync(path.join(home, 'rules.json'), JSON.stringify({ rules: [], agents: {}, sources: {} }));
  const config = { root: home, hubUrl: hub.url, ownerKey: OWNER_SECRET, rulesFile: path.join(home, 'rules.json') };
  const auditLines = [];
  const originalError = console.error;
  console.error = (...args) => { auditLines.push(args.join(' ')); };
  const t0 = 1_700_000_000_000;
  const cooldowns = new Map();
  const deps = { config, now: () => currentNow, cooldowns };
  let currentNow = t0;
  try {
    await handleToolCall('run_rule', { name: '开发' }, deps);
    assert.equal(runPosts.length, 1);
    await assert.rejects(
      () => { currentNow = t0 + 60_000; return handleToolCall('run_rule', { name: '开发', reason: '重复触发' }, deps); },
      /开发.*冷却|冷却.*开发|剩余 [0-9]+ 秒/,
    );
    assert.equal(runPosts.length, 1, '冷却期内的重复 run 不得打到 Hub');
    currentNow = t0 + 10 * 60 * 1000 + 1;
    const okAgain = await handleToolCall('run_rule', { name: '开发' }, deps);
    assert.deepEqual(okAgain, { changed: true });
    assert.equal(runPosts.length, 2, '冷却过后再次 run 应放行');
    // 不同规则互不影响
    currentNow = t0 + 10 * 60 * 1000 + 2;
    await handleToolCall('run_rule', { name: '部署' }, deps);
    assert.equal(runPosts.length, 3);
  } finally {
    console.error = originalError;
    await close(hub.server);
  }
  const rejections = auditLines.filter(line => line.includes('run_rule') && line.includes('拒绝'));
  assert.equal(rejections.length, 1, '冷却拒绝必须在审计日志留一行');
  assert.match(rejections[0], /name=开发/);
  assert.equal(rejections[0].includes(OWNER_SECRET), false);
});

test('write tools audit-log the failure path without the response body', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'autoloop-mcp-audit-'));
  const hub = await fakeHub((req, res) => json(res, { error: '额度不足细节[已隐藏]', secretEcho: 'x' }, 502));
  writeFileSync(path.join(home, 'config.json'), JSON.stringify({ url: hub.url, owner: OWNER_SECRET }));
  writeFileSync(path.join(home, 'rules.json'), JSON.stringify({ rules: [], agents: {}, sources: {} }));
  const config = { root: home, hubUrl: hub.url, ownerKey: OWNER_SECRET, rulesFile: path.join(home, 'rules.json') };
  const auditLines = [];
  const originalError = console.error;
  console.error = (...args) => { auditLines.push(args.join(' ')); };
  try {
    await assert.rejects(() => handleToolCall('pause_rule', { name: '开发' }, { config }));
  } finally {
    console.error = originalError;
    await close(hub.server);
  }
  assert.equal(auditLines.length, 1);
  assert.match(auditLines[0], /pause_rule/);
  assert.match(auditLines[0], /failed|失败/);
  assert.equal(auditLines[0].includes('额度不足细节'), false, '审计日志不得包含响应体');
});

test('run_rule subject must be stable ASCII without spaces (scheduling contract §4.5)', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'autoloop-mcp-subject-'));
  const hub = await fakeHub((req, res) => json(res, { changed: true }));
  writeFileSync(path.join(home, 'config.json'), JSON.stringify({ url: hub.url, owner: OWNER_SECRET }));
  writeFileSync(path.join(home, 'rules.json'), JSON.stringify({ rules: [], agents: {}, sources: {} }));
  const config = { root: home, hubUrl: hub.url, ownerKey: OWNER_SECRET, rulesFile: path.join(home, 'rules.json') };
  try {
    const bad = [
      ['has space', { name: '开发', subject: 'demo fix' }],
      ['non-ascii', { name: '开发', subject: '演示-修复' }],
      ['control char', { name: '开发', subject: 'demo\nfix' }],
      ['empty', { name: '开发', subject: '' }],
    ];
    for (const [label, args] of bad) {
      const error = await handleToolCall('run_rule', args, { config }).catch(e => e);
      assert.ok(error && error.code === -32602, `${label}: expected -32602, got ${error && error.code}`);
    }
    const ok = await handleToolCall('run_rule', { name: '开发', subject: 'demo-fix.v2_r1' }, { config, cooldowns: new Map() });
    assert.deepEqual(ok, { changed: true });
  } finally { await close(hub.server); }
});
