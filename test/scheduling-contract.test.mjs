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
  assert.match(buildSchedulingPrompt({ project: '/p' }), /【控制台入口】.*新建 DAG（执行授权）.*不要编造其他界面路径/);
  // 每一步都要在它声称的位置上，而不只是「界面某处有这几个字」：按钮挪了位置测试必须变红。
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const section = (startId, endId) => {
    const start = html.indexOf(`id="${startId}"`); const end = html.indexOf(`id="${endId}"`, start);
    assert.ok(start >= 0 && end > start, `index.html 里找不到区块 ${startId}`);
    return html.slice(start, end);
  };
  const overview = section('view-overview', 'view-rules');
  const progressPanel = overview.slice(overview.indexOf('aria-labelledby="progress-title"'), overview.indexOf('</section>', overview.indexOf('aria-labelledby="progress-title"')));
  const authorize = section('view-authorize', 'view-cards');
  const authorizeRenderer = readFileSync(new URL('../public/dag-authorize.mjs', import.meta.url), 'utf8');
  const where = {
    '总览': [/data-view="overview"[^>]*>总览</, readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'), '顶部导航'],
    '项目任务进度': [/id="progress-title">项目任务进度</, overview, '总览视图'],
    '新建 DAG（执行授权）': [/id="overview-dag-new"[^>]*>新建 DAG（执行授权）</, progressPanel, '总览「项目任务进度」面板（常驻，不依赖运行中的 DAG）'],
    '读取计划与预检': [/id="authorize-load"[^>]*>读取计划与预检</, authorize, '执行授权页'],
    '确认并进入事件链': [/'确认并进入事件链'[^\n]*go\.id = 'authorize-button'/, authorizeRenderer, '执行授权页渲染（dag-authorize.mjs）'],
  };
  assert.deepEqual(Object.keys(where), [...CONSOLE_DAG_ENTRY_LABELS], '入口步骤清单变了：先同步这里的位置断言');
  for (const label of CONSOLE_DAG_ENTRY_LABELS) {
    const [pattern, scope, place] = where[label];
    assert.match(scope, pattern, `「${label}」不在${place}`);
    assert.ok(CONSOLE_DAG_ENTRY_TEXT.includes(label), `提示词入口说明漏了「${label}」`);
  }
  // 提示词里的步骤顺序必须和用户实际点击顺序一致。
  const positions = CONSOLE_DAG_ENTRY_LABELS.map(label => CONSOLE_DAG_ENTRY_TEXT.indexOf(`「${label}」`));
  assert.ok(positions.every(position => position >= 0), '提示词入口说明里每一步都要用「」标出');
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), '提示词入口说明的步骤顺序与点击顺序不一致');
});
