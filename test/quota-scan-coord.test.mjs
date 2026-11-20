import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { scanForQuotaDetours } from '../src/quota-scan.mjs';
import { readDetours } from '../src/detour.mjs';

const mkRules = () => ({
  sources: { local: { name: 'local' } },
  agents: {
    'codex-full': { name: 'Codex 可写调度', use: 'codex', access: 'full' },
    'codex-full-tier-light': { name: 'Codex 可写调度·light', use: 'codex', access: 'full', model: 'deepseek-v4.1-flash' },
    'codex-full-tier-standard': { name: 'Codex 可写调度·standard', use: 'codex', access: 'full', model: 'kimi-for-coding' },
    'codex-full-tier-heavy': { name: 'Codex 可写调度·heavy', use: 'codex', access: 'full', model: 'k3.1-pro' },
    claude: { name: 'Claude Code', use: 'claude', access: 'full', model: 'claude-sonnet-5-5' },
    'claude-tier-light': { name: 'Claude Code·light', use: 'claude', access: 'full', model: 'haiku' },
    'claude-tier-standard': { name: 'Claude Code·standard', use: 'claude', access: 'full', model: 'claude-sonnet-5-5' },
    'claude-tier-heavy': { name: 'Claude Code·heavy', use: 'claude', access: 'full', model: 'opus' },
    workbuddy: { name: 'WorkBuddy AI', use: 'acp', command: ['/bin/wb.sh', '--acp'], access: 'full' },
    'workbuddy-tier-light': { name: 'WorkBuddy AI·light', use: 'acp', command: ['/bin/wb.sh', '--acp', '--model', 'hy4flash-free'], access: 'full' },
    'workbuddy-tier-standard': { name: 'WorkBuddy AI·standard', use: 'acp', command: ['/bin/wb.sh', '--acp', '--model', 'hy4std'], access: 'full' },
    'workbuddy-tier-heavy': { name: 'WorkBuddy AI·heavy', use: 'acp', command: ['/bin/wb.sh', '--acp', '--model', 'deepseek-v4-pro'], access: 'full' },
  },
  rules: [
    { name: '调度会话执行', when: { source: 'local', types: ['scheduling.message'] }, to: 'codex-full-tier-light', cwd: '/p', prompt: 's', resume: true },
    { name: '调度自愈处理', when: { cron: '*/15 * * * *' }, to: 'codex-full', cwd: '/p', prompt: 's', resume: false },
  ],
  timezone: 'Asia/Shanghai', askFirst: [],
});

const setup = () => {
  const root = mkdtempSync(path.join(tmpdir(), 'quota-coord-'));
  const config = { root, rulesFile: path.join(root, 'rules.json') };
  writeFileSync(config.rulesFile, JSON.stringify(mkRules(), null, 2));
  return config;
};

// 用真实 sqlite 建 hub 的 projections + runs 视图，模拟生产结构
const mkHubDb = (root, rows) => {
  const db = path.join(root, 'hub.db');
  const statements = [
    "create table projections(collection text, data text)",
    "insert into projections(collection,data) values " +
      rows.map((r, i) => `('runs','${JSON.stringify({ id: r.id ?? i + 1, rule: r.rule, agent: r.agent, state: r.state || 'queued', attempts: r.attempts ?? 0, error: r.error ?? null, summary: r.summary ?? null, created_at: r.at ?? '2026-11-19T10:00:00.000Z' }).replace(/'/g, "''")}')`).join(','),
    "create view runs as select json_extract(data,'$.id') id, json_extract(data,'$.rule') rule, json_extract(data,'$.agent') agent, json_extract(data,'$.state') state, json_extract(data,'$.attempts') attempts, json_extract(data,'$.error') error, json_extract(data,'$.summary') summary, json_extract(data,'$.created_at') created_at from projections where collection='runs'",
  ];
  execFileSync('/usr/bin/sqlite3', [db, ...statements]);
};

const policy = { defaults: { dev: { primary: 'workbuddy', fallback: 'claude' }, review: { primary: 'claude', fallback: 'codex-full' }, coord: { primary: 'codex-full', fallback: 'claude' } }, projects: {} };

const hubErr = 'exceeded retry limit, last status: 429 Too Many Requests';
const rowsOf = () => [
  { id: 1, rule: '调度会话执行', agent: 'codex-full-tier-light', error: hubErr },
  { id: 2, rule: '调度自愈处理', agent: 'codex-full', error: hubErr },
  { id: 3, rule: '调度会话执行', agent: 'codex-full-tier-light', error: hubErr },
  { id: 4, rule: '调度会话执行', agent: 'codex-full-tier-light', error: hubErr },
];

test('Hub 侧 codex 连续额度失败 → 自动登记绕行到 claude（coord），且不再靠 worker 日志', () => {
  const config = setup();
  mkHubDb(config.root, rowsOf());
  const result = scanForQuotaDetours(config, { policy, threshold: 3, now: new Date('2026-11-19T11:00:00Z'), dryRun: false });
  assert.equal(result.detours.length, 1);
  const detour = result.detours[0];
  assert.equal(detour.blockedAgent, 'codex-full-tier-light');
  assert.equal(detour.fallbackAgent, 'claude-tier-light', '备用平台的同一档执行者');
  assert.deepEqual(detour.rules.map(r => r.name), ['调度会话执行']);
  // rules.json 里的调度会话执行已被原子改派到 claude-tier-light
  const raw = JSON.parse(readFileSync(config.rulesFile, 'utf8'));
  assert.equal(raw.rules.find(r => r.name === '调度会话执行').to, 'claude-tier-light');
  assert.equal(raw.rules.find(r => r.name === '调度自愈处理').to, 'codex-full');
  // 登记留痕
  const detours = readDetours(config);
  assert.equal(detours.at(-1).blockedAgent, 'codex-full-tier-light');
  assert.equal(detours.at(-1).origin, 'auto-scan');
});

test('Hub 侧多 agent 混合：只把同 agent+model 的连续命中计数，跨 agent 不清空', () => {
  const config = setup();
  mkHubDb(config.root, [
    { id: 1, rule: '调度会话执行', agent: 'codex-full-tier-light', error: hubErr },
    { id: 2, rule: '调度会话执行', agent: 'codex-full-tier-light', error: hubErr },
    { id: 3, rule: 'DAG自动开发·light', agent: 'workbuddy-tier-light', error: hubErr },
    { id: 4, rule: '调度会话执行', agent: 'codex-full-tier-light', error: hubErr },
  ]);
  const result = scanForQuotaDetours(config, { policy, threshold: 3, now: new Date('2026-11-19T11:00:00Z'), dryRun: false });
  assert.equal(result.detours.length, 1, '只有 codex-full-tier-light 够连续 3 次');
  assert.equal(result.detours[0].blockedAgent, 'codex-full-tier-light');
});

test('Hub 侧成功轮次打断连续命中，不登记', () => {
  const config = setup();
  mkHubDb(config.root, [
    { id: 1, rule: '调度会话执行', agent: 'codex-full-tier-light', error: hubErr },
    { id: 2, rule: '调度会话执行', agent: 'codex-full-tier-light', error: hubErr },
    { id: 3, rule: '调度会话执行', agent: 'codex-full-tier-light', state: 'done', attempts: 0, error: null },
    { id: 4, rule: '调度会话执行', agent: 'codex-full-tier-light', error: hubErr },
  ]);
  const result = scanForQuotaDetours(config, { policy, threshold: 3, now: new Date('2026-11-19T11:00:00Z'), dryRun: false });
  assert.equal(result.detours.length, 0, 'done 打断，只有 3 次命中但中间有成功不连续');
});

test('Hub db 缺失或读不到时不影响 worker 侧扫描', () => {
  const config = setup();
  // hub.db 根本没有建 —— hub 侧读不到就当空，不抛错
  const result = scanForQuotaDetours(config, { policy, threshold: 3, now: new Date('2026-11-19T11:00:00Z'), dryRun: false });
  assert.equal(result.detours.length, 0);
  assert.deepEqual(result.skipped, []);
});

test('「调度自愈处理」这类 coord 规则名能被判出工作类型，撞限绕行到 claude', () => {
  const config = setup();
  mkHubDb(config.root, [
    { id: 1, rule: '调度自愈处理', agent: 'codex-full', error: hubErr },
    { id: 2, rule: '调度自愈处理', agent: 'codex-full', error: hubErr },
    { id: 3, rule: '调度自愈处理', agent: 'codex-full', error: hubErr },
  ]);
  const result = scanForQuotaDetours(config, { policy, threshold: 3, now: new Date('2026-11-19T11:00:00Z'), dryRun: false });
  assert.equal(result.detours.length, 1, '调度自愈处理判为 coord 才绕行');
  assert.equal(result.detours[0].blockedAgent, 'codex-full');
  assert.equal(result.detours[0].fallbackAgent, 'claude');
  assert.deepEqual(result.detours[0].rules.map(r => r.name), ['调度自愈处理']);
});

test('连续命中超过阈值（4+ 次）也照样登记绕行', () => {
  const config = setup();
  mkHubDb(config.root, [
    { id: 1, rule: '调度会话执行', agent: 'codex-full-tier-light', error: hubErr },
    { id: 2, rule: '调度会话执行', agent: 'codex-full-tier-light', error: hubErr },
    { id: 3, rule: '调度会话执行', agent: 'codex-full-tier-light', error: hubErr },
    { id: 4, rule: '调度会话执行', agent: 'codex-full-tier-light', error: hubErr },
  ]);
  const result = scanForQuotaDetours(config, { policy, threshold: 3, now: new Date('2026-11-19T11:00:00Z'), dryRun: false });
  assert.equal(result.detours.length, 1, 'count>=threshold 才放行，不是 ==threshold');
  assert.equal(result.detours[0].blockedAgent, 'codex-full-tier-light');
});

test('窗口内出现过连续命中但最新已恢复成功，不误登记绕行', () => {
  const config = setup();
  mkHubDb(config.root, [
    { id: 1, rule: '调度会话执行', agent: 'codex-full-tier-light', error: hubErr },
    { id: 2, rule: '调度会话执行', agent: 'codex-full-tier-light', error: hubErr },
    { id: 3, rule: '调度会话执行', agent: 'codex-full-tier-light', error: hubErr },
    { id: 4, rule: '调度会话执行', agent: 'codex-full-tier-light', state: 'done', attempts: 0, error: null },
  ]);
  const result = scanForQuotaDetours(config, { policy, threshold: 3, now: new Date('2026-11-19T11:00:00Z'), dryRun: false });
  assert.equal(result.detours.length, 0, '末尾已恢复成功的历史 streak 不再登记');
});

test('同一个任务反复撞限（attempts 累计）也算连续命中——#8104 型：1 条记录重试 5 次', () => {
  const config = setup();
  mkHubDb(config.root, [
    { id: 1, rule: '调度会话执行', agent: 'codex-full-tier-light', attempts: 5, error: hubErr },
  ]);
  const result = scanForQuotaDetours(config, { policy, threshold: 3, now: new Date('2026-11-19T11:00:00Z'), dryRun: false });
  assert.equal(result.detours.length, 1, '单条 attempts=5 达到阈值 3');
  assert.equal(result.detours[0].blockedAgent, 'codex-full-tier-light');
  assert.match(result.detours[0].evidence, /5 次/);
});

test('单条 attempts 不足阈值时不登记（attempts=2 < 3）', () => {
  const config = setup();
  mkHubDb(config.root, [
    { id: 1, rule: '调度会话执行', agent: 'codex-full-tier-light', attempts: 2, error: hubErr },
  ]);
  const result = scanForQuotaDetours(config, { policy, threshold: 3, now: new Date('2026-11-19T11:00:00Z'), dryRun: false });
  assert.equal(result.detours.length, 0);
});

test('重试后成功（done 且 attempts>0）不算失败，不登记', () => {
  const config = setup();
  mkHubDb(config.root, [
    { id: 1, rule: '调度会话执行', agent: 'codex-full-tier-light', attempts: 5, state: 'done', error: null },
  ]);
  const result = scanForQuotaDetours(config, { policy, threshold: 3, now: new Date('2026-11-19T11:00:00Z'), dryRun: false });
  assert.equal(result.detours.length, 0);
});

test('同一任务在 worker 日志和 Hub 都有记录时只算一次（Hub 为准），不重复计数', () => {
  const config = setup();
  // Hub：一条 run 7 重试 2 次（attempts=2，不到阈值 3）
  mkHubDb(config.root, [
    { id: 7, rule: '调度会话执行', agent: 'codex-full-tier-light', attempts: 2, error: hubErr },
  ]);
  // worker 侧：同一 run 7 的两次尝试日志（同 agent，模型未识别）
  for (const attempt of [1, 2]) {
    const dir = path.join(config.root, 'worker', 'runs', `7-${attempt}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'entry.json'), JSON.stringify({ run: 7, attempt, job: { rule: { name: '调度会话执行' }, agent: { id: 'codex-full-tier-light', model: '' } } }));
    writeFileSync(path.join(dir, 'stdout-1.log'), `{"finished":true,"error":${JSON.stringify(hubErr)}}\n`);
    writeFileSync(path.join(dir, 'exit-1'), '1');
  }
  const result = scanForQuotaDetours(config, { policy, threshold: 3, now: new Date('2026-11-19T11:00:00Z'), dryRun: false });
  assert.equal(result.detours.length, 0, '真实只撞限 2 次，不能因两个通道重复计成 4 次而绕行');
});
