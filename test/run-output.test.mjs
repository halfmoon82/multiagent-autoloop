import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cleanFinalMessage, finalMessageFromStdout, readFinalMessage, MAX_FINAL_MESSAGE_CHARS } from '../src/run-output.mjs';

// 复刻两种插件的真实输出形状（plugins/codex/agent.ts、plugins/claude/agent.ts 的 read() 解析口径）。
const codexStdout = (...texts) => [
  'profile noise line',
  JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
  JSON.stringify({ type: 'turn.started' }),
  ...texts.map(text => JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } })),
  JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1 } }),
].join('\n');
const claudeStdout = text => [
  JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '中间想法' }] } }),
  JSON.stringify({ type: 'result', subtype: 'success', result: text, num_turns: 3 }),
].join('\n');

function runsRoot(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'run-output-'));
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, 'worker', 'runs', rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return root;
}

test('finalMessageFromStdout reads the last Codex agent_message and the last Claude result', () => {
  assert.equal(finalMessageFromStdout(codexStdout('先说一句', '最终汇报')), '最终汇报');
  assert.equal(finalMessageFromStdout(claudeStdout('Claude 结论\n第二行')), 'Claude 结论\n第二行');
  assert.equal(finalMessageFromStdout('not json at all'), null);
});

test('cleanFinalMessage strips the receipt block and caps length', () => {
  const text = '结论一句\n\n正文\n\n```agent-autoloop\n{"events":[]}\n```\n';
  assert.equal(cleanFinalMessage(text), '结论一句\n\n正文');
  assert.equal(cleanFinalMessage('```agent-autoloop\n{}\n```'), null, '只有回执时视为没有可读回复');
  const long = cleanFinalMessage('字'.repeat(MAX_FINAL_MESSAGE_CHARS + 50));
  assert.match(long, /已截断，完整输出见执行目录/);
});

test('readFinalMessage picks the latest attempt and the latest stdout turn', () => {
  const root = runsRoot({
    '7630-1/stdout-1.log': codexStdout('第一次执行的回复'),
    '7630-2/stdout-1.log': codexStdout('重派后的业务回复'),
    '7630-2/stdout-2.log': codexStdout('回执重写后的最终回复'),
    '7631-1/stdout-1.log': codexStdout('别的轮次'),
  });
  assert.equal(readFinalMessage({ root, runId: 7630 }), '回执重写后的最终回复');
  assert.equal(readFinalMessage({ root, runId: 7631 }), '别的轮次');
});

test('readFinalMessage falls back to an earlier stdout when the latest one has no message', () => {
  const root = runsRoot({
    '9-1/stdout-1.log': claudeStdout('业务回复'),
    '9-1/stdout-2.log': 'garbage',
  });
  assert.equal(readFinalMessage({ root, runId: 9 }), '业务回复');
});

test('an unfinished Codex repair turn (agent_message then turn.failed, no turn.completed) does not override the business turn (P2)', () => {
  const failedRepair = [
    JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '[对齐门] 模式：light' } }),
    JSON.stringify({ type: 'turn.failed', error: { message: '429 rate limit' } }),
  ].join('\n');
  assert.equal(finalMessageFromStdout(failedRepair), null, '没跑完的一轮不算结论');
  const root = runsRoot({ '5721-1/stdout-1.log': codexStdout('真正的业务结论'), '5721-1/stdout-2.log': failedRepair });
  assert.equal(readFinalMessage({ root, runId: 5721 }), '真正的业务结论');
});

test('a Claude error result is not taken as the reply', () => {
  const errored = [JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, result: '半截' })].join('\n');
  assert.equal(finalMessageFromStdout(errored), null);
  const flagged = [JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: '出错了' })].join('\n');
  assert.equal(finalMessageFromStdout(flagged), null);
  const root = runsRoot({ '12-1/stdout-1.log': claudeStdout('业务结论'), '12-1/stdout-2.log': errored });
  assert.equal(readFinalMessage({ root, runId: 12 }), '业务结论');
});

test('Claude lines that are JSON arrays are flattened like the upstream plugin does', () => {
  const line = JSON.stringify([{ type: 'system', subtype: 'init' }, { type: 'result', subtype: 'success', result: '数组行结论' }]);
  assert.equal(finalMessageFromStdout(line), '数组行结论');
});

test('receipt stripping is anchored to line starts like upstream, so inline mentions survive', () => {
  const text = '结论：说明里提到 ```agent-autoloop 这个词也没关系\n\n```agent-autoloop\n{"events":[]}\n```';
  assert.equal(cleanFinalMessage(text), '结论：说明里提到 ```agent-autoloop 这个词也没关系');
});

test('readFinalMessage returns null for unknown runs and rejects non-integer ids (no path traversal)', () => {
  const root = runsRoot({ '5-1/stdout-1.log': codexStdout('x') });
  assert.equal(readFinalMessage({ root, runId: 6 }), null);
  assert.equal(readFinalMessage({ root, runId: '../5' }), null);
  assert.equal(readFinalMessage({ root, runId: 0 }), null);
  assert.equal(readFinalMessage({ root: null, runId: 5 }), null);
});
