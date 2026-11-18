import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildSchedulingContext, composeTurnText, contextTrailer, truncateToBytes,
  EVENT_DETAIL_BUDGET, CONTEXT_DIR,
} from '../src/scheduling-context.mjs';

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

test('正文+提示 ≤3950 字节；超长正文截断且提示完整保留', async () => {
  const trailer = contextTrailer('/tmp/x.md');
  const text = '正'.repeat(6000); // 中文字符 3 字节
  const composed = composeTurnText({ text, trailer });
  assert.ok(Buffer.byteLength(composed, 'utf8') <= EVENT_DETAIL_BUDGET, `got ${Buffer.byteLength(composed, 'utf8')}`);
  assert.ok(composed.endsWith(trailer), '提示必须完整保留在末尾');
  assert.match(composed, /\[已截断\]/);
});

test('正文放不下提示时整段丢弃，不产生半截提示', () => {
  const trailer = contextTrailer('/x'.repeat(3900)); // 荒谬长路径
  const text = 'y'.repeat(EVENT_DETAIL_BUDGET);
  const composed = composeTurnText({ text, trailer });
  assert.ok(Buffer.byteLength(composed, 'utf8') <= EVENT_DETAIL_BUDGET);
  assert.ok(!composed.includes('动手前先读它'), '提示不得半截出现');
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
