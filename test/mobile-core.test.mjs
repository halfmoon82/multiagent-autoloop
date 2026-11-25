// mobile-core 节点（Spec §8 / DAG plan wave-3 / issue 4）边界测试：
// 总览、调度规则、执行轮次、待我处理、执行授权五个核心页面的只读视图模型。
// 覆盖：与后端状态一致、数据缺失显示明确空态不编造、上游文本纯字符串、服务端只读摘要。
// 不调用真实模型、不操作真实规则；移动端 core 为纯逻辑，可在 Node 里直接做边界测试。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MOBILE_API_KEYS } from '../mobile/app/www/shell.mjs';
import {
  MOBILE_PAGE_IDS, MOBILE_PAGE_TITLES, CORE_API_KEYS, MOBILE_NAVIGATION,
  statusLabel, cardStateLabel, billingText, projectName, scheduleLabel, ruleStatus,
  emptyState, collection, assembleSnapshot, createMobileCore, createCoreWrite,
  buildOverview, buildRules, buildRuns, buildTodos, buildAuthorization, buildPages,
} from '../mobile/src/core/index.mjs';
import { mobileProjectSummaries, mobileProjectOptions, discoverGitProjects } from '../src/projects.mjs';
import { mobileRuleSummaries, readRuleOptions } from '../src/rules.mjs';
import { mobileDagSummaries, createDagService } from '../src/dag-service.mjs';
import { createConsoleServer } from '../src/server.mjs';
import { createDeviceStore } from '../src/device-auth.mjs';
import { listen, close, fakeHub, json } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE_DIR = path.join(ROOT, 'mobile', 'src', 'core');
const NOW = new Date('2026-11-19T12:00:00+08:00');

// ---------------------------------------------------------------------------
// 真实形态的后端响应（与 Hub /v1/state、/api/rules、/api/projects、/api/dag-runs 一致）
// ---------------------------------------------------------------------------
const ALLOWED = ['worktree', 'run-tests', 'push-branch', 'create-pr', 'independent-review', 'rework-p0-p2', 'squash-merge', 'close-superseded-pr'];
const DENIED = ['deploy', 'release', 'production-write', 'credentials', 'external-communication'];

function statePayload() {
  return {
    runs: [
      { id: 128, rule: '移动控制台 · 设计推进', project: '/work/移动控制台', state: 'claimed', attempts: 0, agent: 'codex', usage: { input: 100, output: 50 }, events: [{ subject: 'dag-mobile-core', summary: '开发移动端核心页面' }], createdAt: '2026-11-19T09:00:00+08:00' },
      { id: 127, rule: '服务端 · 异常扫描', project: '/work/控制台服务端', state: 'queued', attempts: 2, agent: 'scanner', usage: {}, events: [], createdAt: '2026-11-19T08:00:00+08:00' },
      { id: 126, rule: '移动控制台 · 设计推进', project: '/work/移动控制台', state: 'done', attempts: 0, agent: 'codex', usage: { cost: 1.2, input: 1000, output: 200 }, finishedAt: '2026-11-19T10:00:00+08:00', events: [{ summary: '设计稿完成' }] },
      { id: 125, rule: '熟小麦 · 客服', project: '/work/熟小麦', state: 'nothing', attempts: 0, agent: 'wb', usage: { input: 10, output: 10 }, finishedAt: '2026-11-19T11:00:00+08:00' },
      { id: 124, rule: '未知规则', project: '/work/未知', state: 'unknown', attempts: 0, agent: 'x', usage: {}, createdAt: '2026-11-19T07:00:00+08:00' },
    ],
    cards: [
      { id: 'c1', title: '移动网络的访问边界', text: '任意网络还是仅可信私网？', rule: '移动控制台 · 设计推进', project: '/work/移动控制台', state: 'open', options: ['任意网络', '仅私网'], createdAt: '2026-11-19T09:38:00+08:00' },
      { id: 'c2', title: '推送服务凭据', text: '只有您掌握的凭据', rule: '服务端 · 异常扫描', state: 'decided', choice: '提供', createdAt: '2026-11-19T09:00:00+08:00' },
      { id: 'c3', title: '已结案事项', state: 'closed' },
    ],
    lines: [
      { name: '移动控制台 · 设计推进', paused: null, totals: { running: 1, queued: 0, retrying: 0, unknown: 0, doneToday: 1 } },
      { name: '服务端 · 异常扫描', paused: { reason: '冷却 30 分钟', until: null }, totals: { running: 0, queued: 0, retrying: 2, unknown: 0, doneToday: 0 } },
    ],
    spending: { today: { tokens: 1370, cost: 1.2, input: 1110, output: 260 } },
  };
}
function rulesPayload() {
  return {
    rules: [
      { name: '移动控制台 · 设计推进', when: { cron: '*/10 * * * *' }, to: 'codex', cwd: '/work/移动控制台', prompt: '推进设计', parallel: 1, resume: false },
      { name: '服务端 · 异常扫描', when: { source: 'local', types: ['tick'] }, to: 'scanner', cwd: '/work/控制台服务端', prompt: '扫描异常', parallel: undefined, resume: false },
    ],
    agents: [{ id: 'codex', name: 'Codex', access: 'edit', adapter: 'acp' }, { id: 'scanner', name: '巡检脚本', access: 'read', adapter: 'command' }],
    sources: [{ id: 'local', name: '本机' }],
    models: { codex: 'k3' },
    mobileRules: mobileRuleSummaries({
      rules: [
        { name: '移动控制台 · 设计推进', when: { cron: '*/10 * * * *' }, to: 'codex', cwd: '/work/移动控制台' },
        { name: '服务端 · 异常扫描', when: { source: 'local', types: ['tick'] }, to: 'scanner', cwd: '/work/控制台服务端' },
      ],
      agents: [{ id: 'codex', name: 'Codex' }, { id: 'scanner', name: '巡检脚本' }],
    }),
  };
}
function projectsPayload() {
  return { projects: [{ name: '移动控制台', path: '/work/移动控制台' }, { name: '控制台服务端', path: '/work/控制台服务端' }].map(p => ({ ...p, mobileSummary: mobileProjectSummaries([p])[0] })) };
}
function dagRunsPayload() {
  const grant1 = { schema: 1, project: '/work/移动控制台', repo: '移动控制台', mergeStrategy: 'squash', planDigest: 'a'.repeat(64), allowedActions: [...ALLOWED], createdAt: '2026-11-19T09:00:00+08:00', digest: 'b'.repeat(64) };
  const grant2 = { schema: 2, project: '/work/控制台服务端', repo: '控制台服务端', remoteUrl: 'https://example.com/repo.git', mergeStrategy: 'squash', planDigest: 'c'.repeat(64), standardActions: [...ALLOWED], optionalGrants: [], allowedActions: [...ALLOWED], revision: 1, createdAt: '2026-11-19T10:00:00+08:00', digest: 'd'.repeat(64) };
  const runs = [
    { runId: 'dagrun-1', nodeId: '__root__', project: '/work/移动控制台', planId: 'mobile-app', status: 'running', createdAt: '2026-11-19T09:00:00+08:00', authorizationSnapshot: grant1, nodes: [{ id: 'a', contract: { files: ['mobile/src/core/'] } }, { id: 'b', contract: { files: ['src/rules.mjs'] } }] },
    { runId: 'dagrun-2', nodeId: '__root__', project: '/work/控制台服务端', planId: 'service', status: 'queued', createdAt: '2026-11-19T10:00:00+08:00', authorizationSnapshot: grant2, nodes: [] },
  ];
  return { runs: runs.map(run => ({ ...run, mobileSummary: mobileDagSummaries([run])[0] })) };
}
function serialProgressPayload() {
  return { chains: [
    { sourceFile: 'health-serial.json', project: '/work/健康核心', percent: 67, current: 'd1', updatedAt: '2026-11-19T11:00:00+08:00', nodes: [
      { id: 'a1', title: '环境检查', status: 'done', percent: 100 },
      { id: 'd1', title: '内存采样观测 14 天', status: 'in_progress', percent: 2 },
      { id: 'd2', title: '双桥验证', status: 'pending', percent: 0 },
    ] },
  ] };
}
function snapshot(overrides = {}) {
  const responses = { state: statePayload(), projects: projectsPayload(), rules: rulesPayload(), 'dag-runs': dagRunsPayload(), ...overrides };
  return assembleSnapshot(responses);
}

// ---------------------------------------------------------------------------
// RED 1：快照装配——固定中继 key、部分失败逐项标注，不猜内容、不编造状态
// ---------------------------------------------------------------------------
test('CORE_API_KEYS 全部在移动端 API 允许列表内，且页面与导航一一对应', () => {
  for (const key of CORE_API_KEYS) assert.ok(MOBILE_API_KEYS.includes(key), `${key} 必须在固定中继允许列表里`);
  assert.deepEqual(MOBILE_PAGE_IDS, ['overview', 'rules', 'runs', 'todos', 'authorize']);
  assert.equal(MOBILE_PAGE_TITLES.overview, '总览');
  assert.equal(MOBILE_PAGE_TITLES.authorize, '执行授权');
  assert.deepEqual(MOBILE_NAVIGATION.map(item => item.id), [...MOBILE_PAGE_IDS]);
});

test('assembleSnapshot：缺失/坏形态的响应逐项标注原因，其余页面数据照常可用', () => {
  const complete = snapshot();
  assert.deepEqual(Object.keys(complete.available).filter(k => complete.available[k]), ['state', 'projects', 'rules', 'dag-runs']);
  assert.equal(complete.errors.state, undefined);
  assert.equal(complete.state.runs.length, 5);

  const partial = snapshot({ state: null, 'dag-runs': { runs: 'not-an-array' }, stateError: 'Hub 暂时不可达' });
  assert.equal(partial.available.state, false);
  assert.equal(partial.state, null);
  assert.match(partial.errors.state, /Hub 暂时不可达/);
  assert.equal(partial.available['dag-runs'], false);
  assert.equal(partial.dagRuns, null);
  assert.match(partial.errors['dag-runs'], /DAG/);
  assert.equal(partial.available.rules, true, '一个 key 失败不影响其他 key');
  assert.ok(Array.isArray(partial.rules.mobileRules));
});

test('createMobileCore 只请求固定 key，单个 key 抛错不拖垮整轮加载，页面带明确空态', async () => {
  const calls = [];
  const api = async key => {
    calls.push(key);
    if (key === 'dag-runs') throw new Error('DAG 通道超时');
    return { state: statePayload(), projects: projectsPayload(), rules: rulesPayload(), 'dag-runs': dagRunsPayload() }[key];
  };
  const core = createMobileCore({ api, now: () => NOW });
  const { snapshot: snap, pages } = await core.load();
  assert.deepEqual(calls.sort(), [...CORE_API_KEYS].sort());
  assert.equal(snap.available['dag-runs'], false);
  assert.match(snap.errors['dag-runs'], /DAG 通道超时/);
  assert.equal(pages.overview.ready, true, '总览仍能用 state 渲染');
  assert.equal(pages.authorize.ready, false, '执行授权如实标注数据缺失');
  assert.match(pages.authorize.error, /DAG 通道超时/);
  assert.equal(pages.authorize.items.items.length, 0, '不编造授权范围');
});

// ---------------------------------------------------------------------------
// RED 2：总览——四组计数与最近 5 条标题取真实后端状态，费用如实标注
// ---------------------------------------------------------------------------
test('总览四组计数、最近 5 条标题、待调度处理分组与今日用量均来自后端状态', () => {
  const page = buildOverview(snapshot(), { now: NOW });
  assert.equal(page.id, 'overview');
  assert.equal(page.ready, true);
  const byId = Object.fromEntries(page.metrics.items.map(group => [group.id, group]));
  assert.equal(byId.running.count, 1);
  assert.deepEqual(byId.running.titles, ['开发移动端核心页面']);
  assert.equal(byId.retrying.count, 1);
  assert.equal(byId.doneToday.count, 2);
  assert.equal(byId.attention.count, 1, '第四组是「待调度处理」（与网页版一致），待用户处理在待我处理页');
  assert.ok(byId.running.titles.length <= 5 && byId.attention.titles.length <= 5, '每组最多 5 条概要');
  assert.equal(page.scheduler.items.length, 1, 'unknown 轮次归「待调度处理」，不冒充待用户处理');
  assert.match(page.scheduler.note, /不升级给您/);
  assert.match(page.usage, /费用 \$1\.20/, '已上报费用如实显示');
  assert.match(page.usage, /Token/, '同时显示 Token');
  assert.equal(page.projects.items.length, 2, '项目 DAG 进度取 /api/dag-runs');
  assert.equal(page.activity.items.length, 5);
});

test('总览：只有 Token 时写「费用未上报」，完全未上报时写「未上报」，不折算不估算', () => {
  const onlyTokens = statePayload();
  for (const run of onlyTokens.runs) delete run.usage.cost;
  onlyTokens.spending = { today: { tokens: 1370, input: 1110, output: 260 } };
  assert.match(buildOverview(snapshot({ state: onlyTokens }), { now: NOW }).usage, /费用未上报/);
  const none = statePayload();
  for (const run of none.runs) run.usage = {};
  none.spending = {};
  assert.match(buildOverview(snapshot({ state: none }), { now: NOW }).usage, /未上报/);
  assert.equal(billingText({ usage: { input: 3, output: 4 } }), '7 Token · 费用未上报');
});

test('总览：state 缺失时计数不写成 0，整页明确空态；项目进度单独标注 DAG 缺失', () => {
  const page = buildOverview(snapshot({ state: null, stateError: '控制台状态读取失败' }), { now: NOW });
  assert.equal(page.ready, false);
  assert.match(page.error, /控制台状态读取失败/);
  assert.equal(page.metrics.items.length, 0, '没有状态就不编造四组数字');
  assert.equal(page.metrics.empty, true);
  assert.match(page.metrics.reason, /状态/);
  assert.equal(page.projects.items.length, 2, 'DAG 数据仍在，项目进度照常显示');

  const noDag = buildOverview(snapshot({ 'dag-runs': null, 'dag-runsError': 'DAG 通道不可用' }), { now: NOW });
  assert.equal(noDag.projects.empty, true);
  assert.match(noDag.projects.reason, /DAG 通道不可用/);
});


// ---------------------------------------------------------------------------
// 串行链并入总览项目进度：Health Core 这类串行编排不是 DAG，但同属项目进度
// ---------------------------------------------------------------------------
test('总览项目进度并入串行链：标注串行链与总进度，不编造 DAG 入口', () => {
  const page = buildOverview(snapshot({ 'serial-progress': serialProgressPayload() }), { now: NOW });
  assert.equal(page.projects.items.length, 3, 'DAG run 与串行链合并展示');
  const chain = page.projects.items.find(item => item.runId === 'health-serial.json');
  assert.ok(chain, '串行链必须出现在项目进度里（真机事故：Health Core 串行链被漏掉）');
  assert.equal(chain.projectLabel, '健康核心（串行链）');
  assert.equal(chain.statusLabel, '67%');
  assert.equal(chain.nodeCount, 3);
  assert.equal(chain.dagEntry, null, '串行链没有 DAG 页入口，不编造');
});

test('串行链有自己的详情入口：节点清单、当前环节、整体进度来自种子链数据', () => {
  const page = buildOverview(snapshot({ 'serial-progress': serialProgressPayload() }), { now: NOW });
  const chain = page.projects.items.find(item => item.runId === 'health-serial.json');
  assert.equal(chain.chainEntry.label, '串行链详情');
  const d = chain.chainDetail;
  assert.equal(d.percent, 67);
  assert.equal(d.current, 'd1');
  assert.deepEqual(d.nodes.map(n => [n.id, n.title, n.percent, n.isCurrent]), [
    ['a1', '环境检查', 100, false], ['d1', '内存采样观测 14 天', 2, true], ['d2', '双桥验证', 0, false]]);
  assert.equal(page.serialNote, null);
  const none = buildOverview(snapshot({ 'serial-progress': { chains: [] } }), { now: NOW });
  assert.equal(none.serialNote, '暂无活跃串行链');
  const missing = buildOverview(snapshot({}), { now: NOW });
  assert.equal(missing.serialNote, null, '数据缺失不误报为"无活跃链"');
  const empty = buildOverview(snapshot({ 'serial-progress': { chains: [{ sourceFile: 'x.json', project: '/w/p', percent: 0, nodes: [] }] } }), { now: NOW });
  assert.equal(empty.projects.items.find(i => i.runId === 'x.json').chainDetail.empty, true);
});

// 活跃项排前：已完成/已取消的历史 run 会把活跃 DAG 与进行中的串行链挤出首屏（2026-11-24 真机：
// 一屏只见 4 条已完成/已取消，用户误判"活跃项目无展示"，而网页版活跃项目在首屏）。
test('项目进度活跃项排前：done/cancelled 沉底，活跃 DAG 与进行中串行链置顶且组内稳定', () => {
  const runs = [
    { runId: 'dagrun-done', project: '/work/移动控制台', status: 'done', nodes: [] },
    { runId: 'dagrun-queued', project: '/work/移动控制台', status: 'queued', nodes: [] },
    { runId: 'dagrun-cancelled', project: '/work/移动控制台', status: 'cancelled', nodes: [] },
    { runId: 'dagrun-running', project: '/work/健康核心', status: 'running', nodes: [] },
  ];
  const chains = [
    { sourceFile: 'done-serial.json', project: '/work/旧项目', percent: 100, nodes: [{ id: 'a', status: 'done', percent: 100 }] },
    { sourceFile: 'live-serial.json', project: '/work/健康核心', percent: 40, nodes: [{ id: 'b', status: 'in_progress', percent: 40 }] },
  ];
  const page = buildOverview(snapshot({
    'dag-runs': { runs: runs.map(run => ({ ...run, mobileSummary: mobileDagSummaries([run])[0] })) },
    'serial-progress': { chains },
  }), { now: NOW });
  const order = page.projects.items.map(item => item.runId);
  assert.deepEqual(order, ['dagrun-queued', 'dagrun-running', 'live-serial.json', 'done-serial.json', 'dagrun-done', 'dagrun-cancelled'],
    '活跃 DAG（保持原序）→ 进行中串行链 → 已完结串行链 → 已完成/已取消（保持原序）');
});

test('串行进度缺失时项目进度仍只按 DAG 渲染，缺失原因如实标注', () => {
  const page = buildOverview(snapshot({ 'serial-progress': null, 'serial-progressError': '串行通道超时' }), { now: NOW });
  assert.equal(page.projects.items.length, 2, '没有串行数据就不编造链');
  const missing = buildOverview(snapshot({ 'dag-runs': null, 'dag-runsError': 'DAG 通道不可用', 'serial-progress': null, 'serial-progressError': '串行通道超时' }), { now: NOW });
  assert.equal(missing.projects.empty, true);
  assert.match(missing.projects.reason, /DAG 通道不可用/);
  assert.match(missing.projects.reason, /串行通道超时/);
});

// ---------------------------------------------------------------------------
// RED 3：调度规则——复用服务端只读摘要，状态从后端 lines 叠加，缺失不编造
// ---------------------------------------------------------------------------
test('调度规则：项目/Agent/触发/动作来自服务端摘要，状态来自后端 lines', () => {
  const page = buildRules(snapshot());
  assert.equal(page.ready, true);
  const [first, second] = page.items.items;
  assert.equal(first.name, '移动控制台 · 设计推进');
  assert.equal(first.projectLabel, '移动控制台');
  assert.equal(first.agentLabel, 'Codex');
  assert.match(first.trigger, /定时/);
  assert.deepEqual(first.actions, ['run', 'pause', 'resume', 'edit'], '只保留运行/暂停/恢复/编辑，不新增能力');
  assert.equal(first.statusKnown, true);
  assert.equal(first.statusLabel, '运行中');
  assert.equal(second.statusLabel, '已暂停');
  assert.equal(second.statusKnown, true);
  assert.match(second.statusDetail, /冷却/);
});

test('调度规则：state 缺失时状态为明确空态，绝不默认写成「运行中」；规则数据缺失整页空态', () => {
  const noState = buildRules(snapshot({ state: null, stateError: 'Hub 不可达' }));
  assert.equal(noState.items.items.length, 2);
  for (const item of noState.items.items) {
    assert.equal(item.statusKnown, false);
    assert.equal(item.status, null);
    assert.equal(item.statusLabel, '状态未知');
    assert.match(item.statusDetail, /Hub 不可达/);
  }
  const noRules = buildRules(snapshot({ rules: null }));
  assert.equal(noRules.ready, false);
  assert.equal(noRules.items.empty, true);
  assert.equal(noRules.items.items.length, 0);
});

// ---------------------------------------------------------------------------
// RED 4：执行轮次——状态/任务摘要/费用/模型/会话链接/停止均取真实字段
// ---------------------------------------------------------------------------
test('执行轮次：状态、任务摘要、模型、费用、会话链接与停止能力按后端字段如实呈现', () => {
  const page = buildRuns(snapshot());
  assert.equal(page.ready, true);
  const byId = Object.fromEntries(page.items.items.map(item => [item.id, item]));
  assert.equal(byId[128].statusLabel, '运行中');
  assert.equal(byId[128].taskSummary, '开发移动端核心页面');
  assert.equal(byId[128].projectLabel, '移动控制台');
  assert.equal(byId[128].model, 'k3', '显示实际发现的模型');
  assert.equal(byId[128].billing, '150 Token · 费用未上报');
  assert.equal(byId[128].canStop, true);
  assert.equal(byId[127].statusLabel, '等待重试', 'queued + attempts>0 与网页口径一致');
  assert.equal(byId[127].model, '未配置', '未发现的模型写默认文案，不编造');
  assert.equal(byId[126].billing, '$1.20');
  assert.equal(byId[126].canStop, false);
  assert.equal(byId[124].statusLabel, '失联待核实');
});

test('执行轮次：state 缺失或 runs 为空都给明确空态', () => {
  assert.equal(buildRuns(snapshot({ state: null })).ready, false);
  const empty = buildRuns(snapshot({ state: { runs: [], cards: [], lines: [] } }));
  assert.equal(empty.items.empty, true);
  assert.match(empty.items.reason, /没有执行轮次/);
});

// ---------------------------------------------------------------------------
// RED 5：待我处理——保留决策上下文，只给选项/文字/结案，不虚构「进入原始会话」
// ---------------------------------------------------------------------------
test('待我处理：独立事项列表保留上下文与选项，已回答只读，动作不越界', () => {
  const page = buildTodos(snapshot());
  assert.equal(page.ready, true);
  assert.equal(page.items.items.length, 2, 'open / decided，不含已结案');
  const [open, decided] = page.items.items;
  assert.equal(open.title, '移动网络的访问边界');
  assert.equal(open.text, '任意网络还是仅可信私网？');
  assert.deepEqual(open.options, ['任意网络', '仅私网']);
  assert.equal(open.stateLabel, '待处理');
  assert.deepEqual(open.actions, ['answer-choice', 'answer-text', 'resolve']);
  assert.equal(open.actions.includes('open-original-session'), false, '不虚构进入原始会话能力');
  assert.equal(decided.stateLabel, '已回答');
  assert.equal(decided.readOnly, true);
  assert.equal(decided.choice, '提供');
});

test('待我处理：无卡片或 state 缺失时明确空态，不编造待办', () => {
  assert.equal(buildTodos(snapshot({ state: { runs: [], cards: [], lines: [] } })).items.empty, true);
  assert.equal(buildTodos(snapshot({ state: null })).ready, false);
});

// ---------------------------------------------------------------------------
// RED 6：执行授权——目标项目、授权范围、外部动作边界取冻结快照；无数据不编造
// ---------------------------------------------------------------------------
test('执行授权：目标项目/授权范围/外部动作边界来自只读摘要，schema 1/2 都只读不改 digest', () => {
  const before = dagRunsPayload();
  const page = buildAuthorization(snapshot());
  assert.equal(page.ready, true);
  assert.equal(page.items.items.length, 2);
  const [first, second] = page.items.items;
  assert.equal(first.projectLabel, '移动控制台');
  assert.equal(first.planId, 'mobile-app');
  assert.equal(first.statusLabel, '运行中');
  assert.equal(first.nodeCount, 2);
  assert.deepEqual(first.allowedActions, [...ALLOWED].sort());
  assert.deepEqual(first.deniedActions, DENIED);
  assert.deepEqual(first.files.sort(), ['mobile/src/core/', 'src/rules.mjs']);
  assert.match(first.boundary, /不授权部署|不包含部署/);
  assert.equal(first.readOnly, true, '移动端只读展示，不提供确认/创建动作');
  assert.equal(first.actions.length, 0);
  assert.equal(second.remoteUrl, 'https://example.com/repo.git');
  assert.equal(second.authorizationPresent, true);
  // 只读：不改写任何快照字段（含 schema 1 的历史 digest 公式）
  const after = dagRunsPayload();
  assert.deepEqual(after, before, '构造只读视图不得改动授权快照');
});

test('执行授权：DAG 数据缺失或授权快照缺失时明确空态，不编造计划与范围', () => {
  const missing = buildAuthorization(snapshot({ 'dag-runs': null, 'dag-runsError': 'DAG 通道不可用' }));
  assert.equal(missing.ready, false);
  assert.equal(missing.items.empty, true);
  assert.match(missing.items.reason, /DAG 通道不可用/);
  const noGrant = buildAuthorization(snapshot({ 'dag-runs': { runs: [{ runId: 'r', nodeId: '__root__', project: '/work/x', planId: 'p', status: 'queued', nodes: [], mobileSummary: { runId: 'r', project: '/work/x', planId: 'p', status: 'queued', nodeCount: 0, files: [], allowedActions: [], deniedActions: DENIED, authorizationPresent: false, planDigest: null, remoteUrl: null } }] } }));
  assert.equal(noGrant.items.items[0].authorizationPresent, false);
  assert.equal(noGrant.items.items[0].scope.empty, true);
  assert.match(noGrant.items.items[0].scope.reason, /授权快照/);
});

// ---------------------------------------------------------------------------
// RED 7：buildPages 汇总、安全渲染、与后端状态一致
// ---------------------------------------------------------------------------
test('buildPages 五个页面齐全；上游文本是纯字符串，不拼接 HTML、不泄漏密钥', () => {
  const pages = buildPages(snapshot(), { now: NOW });
  for (const id of MOBILE_PAGE_IDS) assert.ok(pages[id], `${id} 必须存在`);
  const dump = JSON.stringify(pages);
  assert.ok(!dump.includes('<script') && !dump.includes('</div>') && !dump.includes('onerror='));
  assert.ok(!dump.includes('deviceToken') && !dump.includes('ownerKey') && !dump.includes('server-secret'));
  assert.equal(pages.overview.openTodoCount, 1);
  assert.equal(pages.todos.items.items.length, 2);
});

test('状态与卡片标签口径与现有网页控制台一致（未知如实显示「未知」）', () => {
  assert.equal(statusLabel('claimed'), '运行中');
  assert.equal(statusLabel('done'), '已完成');
  assert.equal(statusLabel('unknown-state'), 'unknown-state');
  assert.equal(cardStateLabel('open'), '待处理');
  assert.equal(projectName('/work/移动控制台/'), '移动控制台');
  assert.equal(projectName(''), '未识别');
  assert.equal(scheduleLabel({ when: { cron: '0 9 * * *' } }), '定时 · 0 9 * * *');
  assert.equal(ruleStatus(null).known, false);
  assert.equal(ruleStatus({ paused: { reason: '维护' } }).label, '已暂停');
  assert.deepEqual(emptyState('没有数据'), { empty: true, reason: '没有数据' });
  assert.equal(collection([], '暂无').empty, true);
  assert.equal(collection([1], '暂无').empty, false);
});

test('core 模块是纯逻辑：不依赖 DOM 与 Node 内置模块，可作为浏览器模块直接打包', () => {
  for (const name of ['contract.mjs', 'snapshot.mjs', 'pages.mjs', 'index.mjs']) {
    const source = readFileSync(path.join(CORE_DIR, name), 'utf8');
    assert.ok(!/from\s+['"]node:/.test(source), `${name} 不得 import node: 内置模块`);
    assert.ok(!/\bdocument\.|\bwindow\.|\blocalStorage\b/.test(source.replace(/\/\/.*$/gm, '')), `${name} 不得直接碰 DOM/浏览器存储`);
    assert.ok(!/innerHTML|insertAdjacentHTML/.test(source), `${name} 不得拼接 HTML`);
  }
});

// ---------------------------------------------------------------------------
// RED 8：服务端只读摘要——由真实数据投影，进入既有 API 输出，不写盘不重算 digest
// ---------------------------------------------------------------------------
test('src/projects.mjs 只读摘要：稳定 id/显示名，空列表返回空，不改发现逻辑', () => {
  const projects = [{ name: '移动控制台', path: '/work/移动控制台' }, { name: '服务端', path: '/work/服务端' }];
  assert.deepEqual(mobileProjectSummaries(projects), [
    { id: '/work/移动控制台', label: '移动控制台' }, { id: '/work/服务端', label: '服务端' },
  ]);
  assert.deepEqual(mobileProjectOptions(projects)[0], { id: '全部', label: '全部' });
  assert.equal(mobileProjectSummaries(null).length, 0);
  assert.equal(mobileProjectSummaries([{ name: '', path: '' }]).length, 0, '无效项目不编造条目');
  const root = mkdtempSync(path.join(tmpdir(), 'mobile-core-projects-'));
  try {
    mkdirSync(path.join(root, 'alpha', '.git'), { recursive: true });
    const found = discoverGitProjects({ roots: [root] });
    assert.equal(found.length, 1);
    assert.deepEqual(found[0].mobileSummary, { id: path.join(root, 'alpha'), label: 'alpha' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('src/rules.mjs 只读摘要：不读 Hub 状态、不编造运行/暂停，只暴露既有动作', () => {
  const options = rulesPayload();
  const summaries = mobileRuleSummaries(options);
  assert.equal(summaries.length, 2);
  assert.equal(summaries[0].name, '移动控制台 · 设计推进');
  assert.equal(summaries[0].project, '/work/移动控制台');
  assert.equal(summaries[0].agentLabel, 'Codex');
  assert.match(summaries[0].trigger, /定时/);
  assert.deepEqual(summaries[0].actions, ['run', 'pause', 'resume', 'edit']);
  assert.equal(summaries[0].status, undefined, '服务端不编造运行状态');
  assert.equal(mobileRuleSummaries({ rules: null }).length, 0);
  // 进入既有 /api/rules 输出（live code），且不破坏原有字段。
  const root = mkdtempSync(path.join(tmpdir(), 'mobile-core-rules-'));
  try {
    const rulesFile = path.join(root, 'rules.json');
    writeFileSync(rulesFile, JSON.stringify({ sources: {}, agents: { codex: { name: 'Codex' } }, rules: [{ name: 'r', when: { cron: '0 9 * * *' }, to: 'codex', cwd: '/work/x', prompt: 'p' }] }));
    const data = readRuleOptions({ rulesFile });
    assert.equal(data.rules[0].name, 'r');
    assert.equal(data.mobileRules[0].name, 'r');
    assert.equal(data.mobileRules[0].agentLabel, 'Codex');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('src/dag-service.mjs 只读摘要：schema 1/2 都按真实字段投影，进入 list() 且不改 digest', () => {
  const raw = dagRunsPayload().runs.map(({ mobileSummary, ...run }) => run);
  const summaries = mobileDagSummaries(raw);
  assert.equal(summaries.length, 2);
  assert.equal(summaries[0].authorizationPresent, true);
  assert.equal(summaries[0].planDigest, 'a'.repeat(64));
  assert.deepEqual(summaries[0].deniedActions, DENIED);
  assert.equal(summaries[1].remoteUrl, 'https://example.com/repo.git');
  assert.equal(mobileDagSummaries(null).length, 0);
  // list() 必须附上摘要，同时原样保留授权快照（含历史 digest）。
  const service = createDagService({ root: '/tmp/unused', store: {
    listRuns: () => raw,
  } });
  const listed = service.list();
  assert.equal(listed.length, 2);
  assert.equal(listed[0].authorizationSnapshot.digest, 'b'.repeat(64));
  assert.equal(listed[0].mobileSummary.runId, 'dagrun-1');
  assert.equal(listed[1].mobileSummary.authorizationPresent, true);
  assert.deepEqual(mobileDagSummaries(raw), listed.map(run => run.mobileSummary));
});

// ---------------------------------------------------------------------------
// RED 9：端到端——移动端 core 经固定只读中继读取真实控制台 API，页面与后端一致
// ---------------------------------------------------------------------------
test('端到端：经 /api/mobile/api/<key> 读取真实服务端响应，五个页面数据一致', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'mobile-core-e2e-'));
  const hub = await fakeHub((req, res) => {
    if (req.url === '/v1/state') return json(res, statePayload());
    return json(res, { ok: true });
  });
  const rulesFile = path.join(root, 'rules.json');
  writeFileSync(rulesFile, JSON.stringify({ sources: {}, agents: { codex: { name: 'Codex', access: 'edit', use: 'acp' } }, rules: [{ name: '移动控制台 · 设计推进', when: { cron: '*/10 * * * *' }, to: 'codex', cwd: '/work/移动控制台', prompt: 'p' }] }));
  const deviceAuth = createDeviceStore({ file: path.join(root, 'device-auth.json') });
  const server = createConsoleServer({ hubUrl: hub.url, ownerKey: 'server-secret', host: '127.0.0.1', root, rulesFile, deviceAuth, projectRoots: [root], dagService: createDagService({ root, store: { listRuns: () => dagRunsPayload().runs.map(({ mobileSummary, ...run }) => run) } }) });
  const url = await listen(server);
  t.after(async () => { await close(server); await close(hub.server); rmSync(root, { recursive: true, force: true }); });

  // 绑定一台设备，core 用与壳相同的设备级授权头经固定中继拿数据。
  const qr = deviceAuth.createBinding();
  const bound = await fetch(`${url}/api/mobile/bind`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: qr.token, name: 'Pixel', platform: 'Android' }) });
  assert.equal(bound.status, 201);
  const deviceToken = (await bound.json()).deviceToken;
  const api = async key => {
    const response = await fetch(`${url}/api/mobile/api/${key}`, { headers: { 'x-device-token': deviceToken } });
    if (!response.ok) throw new Error(`${key} 返回 ${response.status}`);
    return response.json();
  };
  const core = createMobileCore({ api, now: () => NOW });
  const { snapshot: snap, pages } = await core.load();
  assert.equal(snap.available.state, true);
  assert.equal(snap.available.rules, true);
  assert.equal(pages.overview.metrics.items.find(g => g.id === 'running').count, 1);
  assert.equal(pages.rules.items.items[0].name, '移动控制台 · 设计推进');
  assert.equal(pages.runs.items.items.length, 5);
  assert.equal(pages.todos.items.items.length, 2);
  assert.equal(pages.authorize.items.items.length, 2);
  const dump = JSON.stringify(pages);
  assert.ok(!dump.includes('server-secret') && !dump.includes(deviceToken), '页面不得含密钥或设备凭证');
});

// ---------------------------------------------------------------------------
// RED 10：core 页面写操作——只打固定写路由、带设备凭证，501/失败可读且保留草稿
// ---------------------------------------------------------------------------
function writeClient({ token = 'device-token-abc', origin = 'http://127.0.0.1:50761' } = {}) {
  return { origin, api: async () => ({}), tokenStore: { get: async () => token } };
}

test('createCoreWrite：选项/文字回答与规则动作都钉在固定写路径并带齐凭证头', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const write = createCoreWrite(writeClient(), { fetchImpl });
  await write.answerCard(9, { choice: 1 });
  await write.answerCard('c/x', { text: '文字回答' });
  await write.ruleAction('移动控制台 · 设计推进', 'pause');

  assert.deepEqual(calls.map(call => call.url), [
    'http://127.0.0.1:50761/api/mobile/cards/9/answer',
    'http://127.0.0.1:50761/api/mobile/cards/c%2Fx/answer',
    'http://127.0.0.1:50761/api/mobile/rules/%E7%A7%BB%E5%8A%A8%E6%8E%A7%E5%88%B6%E5%8F%B0%20%C2%B7%20%E8%AE%BE%E8%AE%A1%E6%8E%A8%E8%BF%9B/pause',
  ]);
  for (const call of calls) {
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.headers['content-type'], 'application/json');
    assert.equal(call.init.headers['x-console-request'], '1');
    assert.equal(call.init.headers['x-device-token'], 'device-token-abc');
  }
  assert.deepEqual(JSON.parse(calls[0].init.body), { choice: 1 });
  assert.deepEqual(JSON.parse(calls[1].init.body), { text: '文字回答' });
  await assert.rejects(() => write.ruleAction('r', 'delete'), /不支持|不支持的动作/);
});

test('createCoreWrite：501/失败给出人话错误，不泄漏设备凭证；未绑定时不发请求', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return { ok: false, status: 501, json: async () => ({ error: '卡片回答尚未实现', route: 'card-answer', declared: true }) };
  };
  const write = createCoreWrite(writeClient(), { fetchImpl });
  await assert.rejects(() => write.answerCard(9, { text: '草稿' }), error => {
    assert.equal(error.status, 501);
    assert.match(error.message, /尚未实现/);
    assert.ok(!String(error.message).includes('device-token-abc'));
    assert.ok(!JSON.stringify(error).includes('device-token-abc'));
    return true;
  });
  const offline = createCoreWrite(writeClient({ token: null }), { fetchImpl });
  await assert.rejects(() => offline.answerCard(9, { text: '草稿' }), /绑定/);
  assert.equal(calls.length, 1, '未绑定时不得发请求');
});

test('core 页面模块：安全 DOM 渲染五页、接写路由与角标，接口失败可重试', () => {
  const code = readFileSync(path.join(ROOT, 'mobile', 'app', 'www', 'pages', 'core.mjs'), 'utf8');
  assert.match(code, /export function mount\s*\(/);
  assert.ok(code.includes('../src/core/index.mjs'), '页面通过相对路径引用视图模型');
  assert.match(code, /createMobileCore/);
  assert.match(code, /createCoreWrite/);
  assert.match(code, /setBadge/);
  assert.match(code, /textContent/);
  assert.match(code, /MutationObserver/, '解锁进入主界面后才拉数据');
  for (const id of ['overview', 'rules', 'runs', 'todos', 'authorize']) assert.ok(code.includes(id), `必须渲染 ${id}`);
  assert.ok(!/innerHTML|insertAdjacentHTML/.test(code), '不得拼接不可信 HTML');
  assert.ok(!/\bfetch\s*\(/.test(code.replace(/\/\/.*$/gm, '')), '页面不直接发请求，写操作走 write 助手');
});

// ---------------------------------------------------------------------------
// RED 11：浏览器回归必须在无浏览器环境显式跳过——CI 的 npm test 阶段尚未安装
// Playwright（浏览器在 test:browser 之前才装），直接 chromium.launch 会让整条 CI 失败。
// ---------------------------------------------------------------------------
test('浏览器回归在无浏览器环境下显式跳过，不在 npm test 阶段直接 launch', () => {
  const src = readFileSync(path.join(ROOT, 'test', 'mobile-ui-core.browser.test.mjs'), 'utf8');
  assert.match(src, /existsSync\(chromium\.executablePath\(\)\)/, '以浏览器可执行文件是否存在来判定');
  assert.match(src, /skip:\s*browserSkip/, '测试声明 skip，缺浏览器时跳过而不是失败');
  assert.match(src, /chromium\.launch/, '浏览器可用时仍执行真实浏览器回归');
});
