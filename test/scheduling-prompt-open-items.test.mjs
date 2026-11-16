import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOpenItemsTasks } from '../src/scheduling-prompt-open-items.mjs';
import { buildSchedulingPrompt } from '../src/scheduling-session.mjs';

test('open-items task section leads with git open issues/PRs and demotes state scanning', () => {
  const lines = buildOpenItemsTasks({ project: '/workspace/demo' });
  const text = lines.join('\n');
  assert.match(lines[0], /开局/);
  assert.match(lines[0], /open/);
  assert.match(text, /issue/);
  assert.match(text, /PR/);
  assert.match(text, /派发/);
  assert.match(text, /跟踪/);
  assert.match(text, /收敛/);
  const openIdx = text.indexOf('open 事项');
  const scanIdx = text.indexOf('list_rules');
  assert.ok(openIdx >= 0 && scanIdx > openIdx, 'open items come first; state scan (list_rules) is auxiliary and later');
  assert.match(text, /辅助/);
  assert.doesNotMatch(text, /全量状态扫描/);
});

test('scheduling prompt uses the open-items task section and keeps guardrails', () => {
  const text = buildSchedulingPrompt({ project: '/workspace/demo', writableDir: '/tmp/w' });
  assert.match(text, /逐项判断推进方式/);
  assert.match(text, /升级最小门禁/);
  assert.match(text, /禁止本会话亲自写项目代码/);
});
