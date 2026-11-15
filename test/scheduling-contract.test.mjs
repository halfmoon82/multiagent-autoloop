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
