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
    assert.deepEqual(toolList.sort(), ['list_cards', 'list_rules', 'list_runs']);
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
