import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildSchedulingContext, composeTurnText, contextTrailer, truncateToBytes, codePoints,
  prevAgentFrom, hasOpenCardsFor, snapshotLinesFrom, isBareContinuation, runsOfSubject,
  exchangesFrom, handoverSection, previousUnanswered,
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

test('snapshotLinesFrom 用 id 与 usage.cost，最近在前，不出现 undefined（P1）', () => {
  const lines = snapshotLinesFrom(REAL_STATE);
  assert.deepEqual(lines.runs.map(line => line.split('｜')[0]), ['#15', '#14', '#12', '#9'], '按轮次号倒序');
  assert.equal(lines.runs[2], '#12｜调度会话执行｜claude｜done｜$0.0123');
  assert.match(lines.runs[0], /费用未上报/);
  assert.ok(lines.runs.every(line => !line.includes('undefined')));
  assert.equal(lines.cards[0], '#7｜是否重试｜调度会话执行');
});

test('规则快照本项目在前、暂停其次，并带本项目标记', () => {
  const state = { lines: [
    { name: '别的项目', types: ['x.*'], agent: 'claude', paused: null },
    { name: '暂停的', types: [], every: '每 5 分钟', agent: 'scan', paused: { reason: '上游在修' } },
    { name: '调度会话执行', types: ['scheduling.message'], agent: 'codex-full', paused: null },
  ] };
  const ruleCwds = new Map([['别的项目', '/other'], ['暂停的', '/other'], ['调度会话执行', '/Volumes/Storage/auto调度']]);
  const { rules } = snapshotLinesFrom(state, { project: '/Volumes/Storage/auto调度', ruleCwds });
  assert.deepEqual(rules.map(line => line.split('｜')[0]), ['调度会话执行', '暂停的', '别的项目']);
  assert.match(rules[0], /本项目$/);
  assert.equal(rules[1], '暂停的｜每 5 分钟｜scan｜已暂停:上游在修');
});

test('快照每节写出总数，超出上限时注明只列前 N 条（不再静默截断，P1 回归）', async () => {
  const { root, project } = fixture();
  const rules = Array.from({ length: 58 }, (_, i) => `规则${i}｜t｜a`);
  const file = await buildSchedulingContext({ root, sessionId: 'n1', turn: 1, project, providers: { rules: () => rules, runs: () => [], cards: () => [], dag: () => [] } });
  const body = readFileSync(file, 'utf8');
  assert.match(body, /### 规则[^\n]*（共 58 条）/);
  assert.match(body, /共 58 条，此处只列前 20 条；其余未列出，不代表不存在/);
  assert.match(body, /### 待处理卡片[^\n]*（共 0 条）/);
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

test('上一轮结论超过上限时注明截断，不静默丢尾（P2）', async () => {
  const { root, project } = fixture();
  const longSummary = `${'汇'.repeat(9000)}尾巴`;
  const file = await buildSchedulingContext({ root, sessionId: 'l1', turn: 2, project, lastSummary: longSummary });
  const body = readFileSync(file, 'utf8');
  assert.match(body, /\[已截断：超过 8000 字，完整内容见会话转录\]/);
  const medium = '汇'.repeat(3000);
  const file2 = await buildSchedulingContext({ root, sessionId: 'l2', turn: 2, project, lastSummary: medium });
  assert.ok(readFileSync(file2, 'utf8').includes(medium), '3000 字的结论完整保留（旧上限 1200 会截掉）');
});

// —— 交接段：换执行者后新会话没有聊天记忆，要能看到「上一轮问了什么」（绕行演练发现的缺口）——
const transcript = [
  { role: 'user', text: '第一问' }, { role: 'agent', text: '第一答' },
  { role: 'user', text: '第二问 A' }, { role: 'user', text: '第二问 B（排队）' }, { role: 'agent', text: '第二答' },
  { role: 'user', text: '第三问' }, { role: 'agent', text: '第三答' },
  { role: 'user', text: '第四问' }, { role: 'agent', text: '第四答' },
];

test('exchangesFrom pairs user messages with the next reply, merges queued messages, keeps the latest rounds', () => {
  const rounds = exchangesFrom(transcript, { rounds: 3 });
  assert.deepEqual(rounds.map(r => r.agent), ['第二答', '第三答', '第四答']);
  assert.equal(rounds[0].user, '第二问 A\n\n第二问 B（排队）', '排队的多条消息合成一轮');
  assert.equal(rounds.at(-1).user, '第四问');
});

test('exchangesFrom keeps a trailing unanswered user message as the previous round (P2: failed/interrupted turn)', () => {
  const rounds = exchangesFrom([...transcript, { role: 'user', text: '没得到回答的上一问' }], { rounds: 2 });
  assert.deepEqual(rounds.at(-1), { user: '没得到回答的上一问', agent: null }, '结尾没回答的是上一轮，不得丢弃');
  assert.equal(rounds[0].user, '第四问');
  assert.deepEqual(exchangesFrom([{ role: 'user', text: '只有问' }]), [{ user: '只有问', agent: null }]);
  assert.deepEqual(exchangesFrom(undefined), []);
});

test('handoverSection marks an unanswered previous round and the context file relabels the older answer (P2)', async () => {
  const exchanges = exchangesFrom([...transcript, { role: 'user', text: '频限失败的那一问' }]);
  const text = handoverSection(exchanges);
  assert.match(text, /## 上一轮用户原话（完整，未得到回答：失败、被打断或仍在执行）\n+频限失败的那一问/);
  assert.match(text, /### 往前第 2 轮\n- 用户：第四问\n- 回答：第四答/);
  const { root, project } = fixture();
  const file = await buildSchedulingContext({ root, sessionId: 'u9', turn: 6, project, lastSummary: '第四答', exchanges });
  const body = readFileSync(file, 'utf8');
  assert.match(body, /## 最近一次得到的回答（属于更早一轮；上一轮未得到回答）\n+第四答/);
  assert.doesNotMatch(body, /## 上一轮结论/, '更早一轮的回答不得冒充上一问的结论');
});

test('an empty previous question (late answer merged two rounds) is stated, not silently dropped (P3)', () => {
  const late = exchangesFrom([
    { role: 'user', text: 'Q1' }, { role: 'agent', text: 'A1' },
    { role: 'user', text: 'Q2' }, { role: 'user', text: 'Q3' }, { role: 'agent', text: 'A2 迟到' }, { role: 'agent', text: 'A3' },
  ]);
  const text = handoverSection(late);
  assert.match(text, /## 上一轮用户原话（完整）\n+（转录里上一轮没有对应的用户消息，可能是迟到的回答；以会话转录为准）/);
});

test('handoverSection writes the previous question in full and earlier rounds as capped summaries', () => {
  const longEarlier = '早'.repeat(700);
  const text = handoverSection([
    { user: longEarlier, agent: '早答' },
    { user: '第三问', agent: '第三答' },
    { user: '上一轮的完整原话', agent: '上一轮回答' },
  ]);
  assert.match(text, /## 上一轮用户原话（完整）\n+上一轮的完整原话/);
  assert.match(text, /## 更早的对话（最近 2 轮，旧的在前，每条最多 600 字）/);
  assert.match(text, /### 往前第 3 轮\n- 用户：早{600}\n\[已截断：原文 700 字，此处只列前 600 字\]/);
  assert.match(text, /### 往前第 2 轮\n- 用户：第三问\n- 回答：第三答/);
  assert.equal(handoverSection([]), '');
});

test('previous question longer than the limit is cut with a note pointing to the transcript', () => {
  const text = handoverSection([{ user: '问'.repeat(9000), agent: '答' }]);
  assert.match(text, /\[已截断：上一轮用户原话共 9000 字，此处只列前 8000 字，完整内容见会话转录\]/);
});

test('buildSchedulingContext writes the handover section into the context file', async () => {
  const { root, project } = fixture();
  const file = await buildSchedulingContext({ root, sessionId: 'h1', turn: 5, project, lastSummary: '第四答', exchanges: exchangesFrom(transcript) });
  const body = readFileSync(file, 'utf8');
  assert.match(body, /## 上一轮用户原话（完整）\n+第四问/);
  assert.match(body, /## 更早的对话/);
  assert.match(body, /## 上一轮结论\n+第四答/);
});
