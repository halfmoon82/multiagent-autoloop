// PRD 引导与设计稿门禁提示词契约（提炼自 vibe guide 的 PRD 引导协议 §2/§5）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { PRD_GUIDE_PROMPT } from '../src/prd-guide.mjs';
import { buildDesignPrompt, BRANCH_DISCIPLINE_PROMPT } from '../src/scheduling-session.mjs';

test('PRD 引导含五话题、来源标记、needs_confirmation 单问、设计稿门与 decisions 记录', () => {
  for (const clause of ['问题', '目标', '成功标准', '非目标', '用户场景',
    'user_confirmed', 'system_inferred', 'needs_confirmation', 'unverified',
    '一次只问一个', '设计稿', 'decisions']) {
    assert.ok(PRD_GUIDE_PROMPT.includes(clause), `PRD 引导缺少关键条款：${clause}`);
  }
  // 设计稿门：涉及界面时稿件必须可直接打开查看，未确认不得进入拆解与实现。
  assert.match(PRD_GUIDE_PROMPT, /纯文字描述不算/);
  assert.match(PRD_GUIDE_PROMPT, /确认.{0,12}不进入拆解/);
});

test('设计会话提示词内嵌 PRD 引导，并写清什么时候必须写 design 块', () => {
  const prompt = buildDesignPrompt({ project: 'demo' });
  assert.ok(prompt.includes(PRD_GUIDE_PROMPT), '设计会话必须把 PRD 引导全文内嵌');
  // 门禁触发契约：凡界面改动必须带 design 块（manifestPath + approvalPath）；纯逻辑不写。
  assert.match(prompt, /contract\.design/);
  assert.match(prompt, /manifestPath/);
  assert.match(prompt, /approvalPath/);
  assert.match(prompt, /纯后端|纯逻辑/);
  assert.match(prompt, /不写 design 块|不需要 design 块/);
});

test('普通会话分支纪律含 PRD/设计会话及时触发提示', () => {
  for (const clause of ['设计会话', 'PRD', '设计稿']) {
    assert.ok(BRANCH_DISCIPLINE_PROMPT.includes(clause), `普通会话提示缺少：${clause}`);
  }
});
