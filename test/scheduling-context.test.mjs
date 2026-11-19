import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildSchedulingContext, composeTurnText, contextTrailer, truncateToBytes, codePoints,
  prevAgentFrom, hasOpenCardsFor, snapshotLinesFrom, isBareContinuation, runsOfSubject,
  EVENT_DETAIL_BUDGET, CONTEXT_DIR,
} from '../src/scheduling-context.mjs';

const detailOf = (project, text) => JSON.stringify({ project, text });

function fixture({ agentsMd = '# 项目规则\n必须 TDD。', contract = '# 调度契约\n最小门禁。' } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'sched-ctx-root-'));
  const project = mkdtempSync(path.join(tmpdir(), 'sched-ctx-proj-'));
  if (agentsMd !== null) writeFileSync(path.join(project, 'AGENTS.md'), agentsMd);
  if (contract !== null) {
    mkdirSync(path.join(project, 'docs'), { recursive: true });
    writeFileSync(path.join(project, 'docs', 'scheduling-contract.md'), contract);
  }
  return { root, project };
}

test('资料文件含五段：AGENTS.md、契约、快照、上一轮结论、未收尾事项', async () => {
  const { root, project } = fixture();
  const file = await buildSchedulingContext({
    root, sessionId: 's1', turn: 3, project, lastSummary: '上一轮：已定位失败',
    openItems: 'open 卡片 7 待核实', prevAgent: 'claude',
    providers: {
      rules: async () => ['调度会话执行｜scheduling.message｜codex-full｜无'],
      runs: async () => ['run 12｜调度会话执行｜failed｜refusal｜$0.01'],
      cards: async () => ['#7｜是否重试｜等待调度'],
      dag: async () => ['dagrun-x｜计划A｜n1 done / n2 claimed'],
    },
  });
  assert.ok(file && existsSync(file));
  const body = readFileSync(file, 'utf8');
  assert.match(body, /## 项目 AGENTS\.md/);
  assert.match(body, /必须 TDD/);
  assert.match(body, /## 调度契约/);
  assert.match(body, /## 状态快照/);
  assert.match(body, /调度会话执行｜scheduling\.message｜codex-full/);
  assert.match(body, /#7｜是否重试/);
  assert.match(body, /dagrun-x/);
  assert.match(body, /## 上一轮结论/);
  assert.match(body, /已定位失败/);
  assert.match(body, /## 未收尾事项/);
  assert.match(body, /open 卡片 7/);
  assert.match(body, /上一轮执行者：claude/);
});

test('AGENTS.md 超过 60KB 截断并注明原文路径', async () => {
  const big = 'x'.repeat(70 * 1024);
  const { root, project } = fixture({ agentsMd: big });
  const file = await buildSchedulingContext({ root, sessionId: 's2', turn: 1, project });
  const body = readFileSync(file, 'utf8');
  assert.match(body, /已截断：原文超过 61440 字节/);
  assert.ok(Buffer.byteLength(body.match(/## 项目 AGENTS\.md\n([\s\S]*?)## 调度契约/)?.[1] || '', 'utf8') < 70 * 1024);
});

test('序列化后的 detail ≤3950 码点：中文长正文截断且提示完整保留', () => {
  const project = '/Volumes/Storage/auto调度';
  const trailer = contextTrailer('/tmp/x.md');
  const composed = composeTurnText({ text: '正'.repeat(6000), trailer, project });
  assert.ok(codePoints(detailOf(project, composed)) <= EVENT_DETAIL_BUDGET, `got ${codePoints(detailOf(project, composed))}`);
  assert.ok(composed.endsWith(trailer), '提示必须完整保留在末尾');
  assert.match(composed, /\[已截断：完整原话见本轮资料文件/);
});

test('JSON 转义计入预算：大量换行与引号的正文序列化后仍 ≤3950 码点（P1 回归）', () => {
  const project = '/Volumes/Storage/auto调度';
  const text = Array.from({ length: 3000 }, (_, i) => `"行${i}"`).join('\n');
  const composed = composeTurnText({ text, trailer: contextTrailer('/tmp/x.md'), project });
  assert.ok(codePoints(detailOf(project, composed)) <= EVENT_DETAIL_BUDGET, `got ${codePoints(detailOf(project, composed))}`);
  assert.match(composed, /动手前先读它。$/);
});

test('短正文原样保留，不加截断标记', () => {
  const trailer = contextTrailer('/tmp/x.md');
  assert.equal(composeTurnText({ text: '首轮调度', trailer, project: '/p' }), `首轮调度${trailer}`);
});

test('正文放不下提示时整段丢弃，不产生半截提示', () => {
  const trailer = contextTrailer('/x'.repeat(3900)); // 荒谬长路径
  const composed = composeTurnText({ text: 'y'.repeat(EVENT_DETAIL_BUDGET), trailer, project: '/p' });
  assert.ok(codePoints(detailOf('/p', composed)) <= EVENT_DETAIL_BUDGET);
  assert.ok(!composed.includes('动手前先读它'), '提示不得半截出现');
});

// 复刻 Hub host/state.ts 的真实 /v1/state 形状：runs 只有 id（没有 run/lane），用量在 usage，事件带 subject。
const REAL_STATE = {
  lines: [{ name: '调度会话执行', types: ['scheduling.message'], agent: 'codex-full', paused: null }],
  runs: [
    { id: 12, rule: '调度会话执行', agent: 'claude', state: 'done', error: '', usage: { cost: 0.0123 }, events: [{ source: 'local', type: 'scheduling.message', subject: 'scheduling:s1' }] },
    { id: 15, rule: '调度会话执行', agent: 'codex-full', state: 'claimed', error: '', usage: null, events: [{ source: 'local', type: 'scheduling.message', subject: 'scheduling:s1' }] },
    { id: 14, rule: '调度会话执行', agent: 'workbuddy', state: 'done', error: '', usage: null, events: [{ source: 'local', type: 'scheduling.message', subject: 'scheduling:other' }] },
    { id: 9, rule: '调度会话执行', agent: 'codex', state: 'nothing', error: '', usage: null, events: [{ source: 'local', type: 'scheduling.message', subject: 'scheduling:s1' }] },
  ],
  cards: [{ id: 7, title: '是否重试', state: 'open', lane: 'scheduling:s1', rule: '调度会话执行' }],
};

test('prevAgentFrom 按真实 /v1/state 形状（id + events[].subject）找同事项最近结束轮的执行者（P1）', () => {
  assert.equal(prevAgentFrom(REAL_STATE, 'scheduling:s1'), 'claude', '#15 还在跑不算；#12 比 #9 新');
  assert.equal(prevAgentFrom(REAL_STATE, 'scheduling:other'), 'workbuddy');
  assert.equal(prevAgentFrom(REAL_STATE, 'scheduling:none'), null, '查不到不编造');
  assert.equal(runsOfSubject(REAL_STATE, 'scheduling:s1').length, 3);
});

test('snapshotLinesFrom 用 id 与 usage.cost，不出现 undefined（P1）', () => {
  const lines = snapshotLinesFrom(REAL_STATE);
  assert.equal(lines.runs[0], '#12｜调度会话执行｜claude｜done｜$0.0123');
  assert.match(lines.runs[1], /费用未上报/);
  assert.ok(lines.runs.every(line => !line.includes('undefined')));
  assert.equal(lines.cards[0], '#7｜是否重试｜调度会话执行');
});

test('hasOpenCardsFor 与 isBareContinuation', () => {
  assert.equal(hasOpenCardsFor(REAL_STATE, 'scheduling:s1'), true);
  assert.equal(hasOpenCardsFor(REAL_STATE, 'scheduling:other'), false);
  for (const text of ['继续', '已解决。', 'ok', '继续吧！']) assert.equal(isBareContinuation(text), true, text);
  for (const text of ['继续处理卡片 7', '看看 DAG 进度']) assert.equal(isBareContinuation(text), false, text);
});

test('资料文件包含护栏段（换执行者后靠它重建）', async () => {
  const { root, project } = fixture();
  const file = await buildSchedulingContext({ root, sessionId: 'g1', turn: 2, project, guide: '【行为护栏】重试纪律…' });
  assert.match(readFileSync(file, 'utf8'), /## 调度会话护栏与任务[\s\S]*重试纪律/);
});

test('truncateToBytes 按字节截断不在多字节字符中间切断', () => {
  const text = '中文字'.repeat(10); // 每字 3 字节
  const cut = truncateToBytes(text, 10);
  assert.equal(Buffer.byteLength(cut, 'utf8'), 9); // 3 个中文字
  assert.equal(cut, '中文字');
});

test('providers 抛错时快照降级为可读占位，不中断落盘', async () => {
  const { root, project } = fixture();
  const file = await buildSchedulingContext({
    root, sessionId: 's3', turn: 1, project,
    providers: { rules: async () => { throw new Error('hub 挂了'); }, runs: async () => ['r1 ok'] },
  });
  const body = readFileSync(file, 'utf8');
  assert.match(body, /### 规则/);
  assert.match(body, /### 最近轮次/);
  assert.match(body, /r1 ok/);
});

test('缺参数返回 null；project 缺失时资料照常落盘（路径本身也是资料）', async () => {
  assert.equal(await buildSchedulingContext({ root: '', sessionId: 's', turn: 1, project: '/p' }), null);
  const { root } = fixture();
  const file = await buildSchedulingContext({ root, sessionId: 's', turn: 1, project: '/no/such/dir' });
  assert.ok(file && existsSync(file));
  assert.match(readFileSync(file, 'utf8'), /未找到 AGENTS\.md/);
});

test('超预算的用户原话完整写进资料文件，正文截断标记指向它（P2 回归）', async () => {
  const { root, project } = fixture();
  const userText = `${'需求'.repeat(3000)}末尾关键句`;
  const file = await buildSchedulingContext({ root, sessionId: 'u1', turn: 1, project, userText });
  const body = readFileSync(file, 'utf8');
  assert.match(body, /## 本轮用户原话（完整）/);
  assert.ok(body.includes(userText), '资料文件必须有完整原话，含被正文截掉的末尾');
  const composed = composeTurnText({ text: userText, trailer: contextTrailer(file), project });
  assert.ok(!composed.includes('末尾关键句'), '夹具确实被截断');
  assert.match(composed, /完整原话见本轮资料文件/);
});
