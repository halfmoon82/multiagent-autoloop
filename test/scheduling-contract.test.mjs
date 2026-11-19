import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const contract = readFileSync(new URL('../docs/scheduling-contract.md', import.meta.url), 'utf8');
const agents = readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf8');

test('scheduling contract requires cost-effective model dispatch by task complexity', () => {
  const normalized = contract.replace(/\s+/g, '');
  assert.match(normalized, /##模型派发规则/);
  assert.match(normalized, /调度会话必须根据任务复杂度、失败成本和审阅风险选择最具性价比的平台\/模型/);
  assert.match(normalized, /独立审阅.*不得为省钱降低资金、数据或安全审阅质量/);
  assert.match(agents.replace(/\s+/g, ''), /调度会话.*任务复杂度.*最具性价比的模型/);
});

test('console contract requires task summaries to show their project', () => {
  const normalized = contract.replace(/\s+/g, '');
  assert.match(normalized, /任务概要必须展示该任务所属项目/);
});

test('cards shown to the owner must speak product language and carry benefit and cost per option', () => {
  const normalized = contract.replace(/\s+/g, '');
  assert.match(normalized, /##待我处理卡片陈述规则/);
  assert.match(normalized, /产品经理能听懂/);
  assert.match(normalized, /禁止.*函数名.*内部文件名/);
  assert.match(normalized, /每个选项必须注明收益和代价/);
  assert.match(normalized, /推荐理由/);
});

test('serial orchestrators must publish node progress for the console task bar', () => {
  const normalized = contract.replace(/\s+/g, '');
  assert.match(normalized, /##节点进度上报/);
  assert.match(normalized, /serial\.json/);
  assert.match(normalized, /plan/);
  assert.match(normalized, /part.*percent|percent.*part/);
});

test('§12 documents the automated quota-detour mechanism with policy, thresholds and cron templates', () => {
  const normalized = contract.replace(/\s+/g, '');
  assert.match(normalized, /##12\./);
  assert.match(normalized, /开发.*workbuddy.*claude/);
  assert.match(normalized, /审阅.*claude.*codex-full/);
  assert.match(normalized, /连续3次|连续3/);
  assert.match(normalized, /quota-scan\.mjs/);
  assert.match(normalized, /verify-all/);
  assert.match(normalized, /\*\/30\*+/);
  assert.match(normalized, /退出码/);
  assert.match(normalized, /证据原文/);
});

// 调度会话给用户的控制台操作指引必须指向真实、任何状态下都能到达的入口（11-19 事故：指引里的入口只在有运行中 DAG 时才出现）。
test('scheduling prompt console entry labels all exist in the console UI, and the DAG entry is always reachable from the overview', async () => {
  const { CONSOLE_DAG_ENTRY_LABELS, CONSOLE_DAG_ENTRY_TEXT, buildSchedulingPrompt } = await import('../src/scheduling-session.mjs');
  const { readdirSync } = await import('node:fs');
  const publicDir = new URL('../public/', import.meta.url);
  const ui = readdirSync(publicDir).filter(name => /\.(html|mjs)$/.test(name)).map(name => readFileSync(new URL(name, publicDir), 'utf8')).join('\n');
  for (const label of CONSOLE_DAG_ENTRY_LABELS) {
    assert.ok(ui.includes(label), `界面里找不到入口文字「${label}」`);
    assert.ok(CONSOLE_DAG_ENTRY_TEXT.includes(label), `提示词入口说明漏了「${label}」`);
  }
  assert.match(buildSchedulingPrompt({ project: '/p' }), /【控制台入口】.*新建 DAG（执行授权）.*不要编造其他界面路径/);
  // 常驻入口：总览视图里直接有按钮，不依赖是否存在运行中的 DAG。
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const overview = html.slice(html.indexOf('id="view-overview"'), html.indexOf('id="view-rules"'));
  assert.match(overview, /id="overview-dag-new"[^>]*>新建 DAG（执行授权）</);
});
