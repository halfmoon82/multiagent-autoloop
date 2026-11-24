// composer-ux 节点：自适应轮询、乐观上屏、输入区结构（纯逻辑 + 源码结构断言）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  pollIntervalMs, isResponding, optimisticMessage, settleMessage, computeAutogrow,
  POLL_BUSY_MS, POLL_IDLE_MS, RESPONDING_TTL_MS, COMPOSER_MAX_ROWS, AUTOGROW_MAX_ROWS,
} from '../mobile/src/features/composer-autogrow/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => readFileSync(path.join(ROOT, rel), 'utf8');

test('轮询：busy/turnStartedAt/本地响应态 1 秒，空闲 5 秒', () => {
  assert.equal(POLL_BUSY_MS, 1000); assert.equal(POLL_IDLE_MS, 5000);
  assert.equal(pollIntervalMs({ busy: true }), 1000);
  assert.equal(pollIntervalMs({ turnStartedAt: '2026-11-24T00:00:00Z' }), 1000);
  assert.equal(pollIntervalMs({ responding: true }), 1000);
  assert.equal(pollIntervalMs({}), 5000);
  assert.equal(pollIntervalMs({ busy: false, turnStartedAt: null }), 5000);
});

test('轮询：页面隐藏时不轮询（null）', () => {
  assert.equal(pollIntervalMs({ hidden: true, busy: true }), null);
  assert.equal(pollIntervalMs({ hidden: true }), null);
});

test('本地响应态：TTL 内有效，过期/无效失效', () => {
  assert.equal(isResponding(1000, 1000 + RESPONDING_TTL_MS - 1), true);
  assert.equal(isResponding(1000, 1000 + RESPONDING_TTL_MS), false);
  assert.equal(isResponding(0, 5), false);
  assert.equal(isResponding(undefined), false);
});

test('乐观上屏：发送中 → 成功/失败，按 localId 精确更新且不重复入账', () => {
  const m = optimisticMessage('你好', 'local-1');
  assert.deepEqual([m.role, m.text, m.sendState, m.localId], ['主人', '你好', 'sending', 'local-1']);
  const list = [{ role: '会话', text: 'x', at: '' }, m];
  const failed = settleMessage(list, 'local-1', 'failed');
  assert.equal(failed[1].sendState, 'failed'); assert.equal(failed.length, 2);
  const retried = settleMessage(failed, 'local-1', 'sending');
  assert.equal(retried.length, 2, '重发复用同一条，不新增');
  assert.equal(settleMessage(list, 'nope', 'sent'), list);
});

test('输入框上限约 4 行，且小于通用上限', () => {
  assert.equal(COMPOSER_MAX_ROWS, 4); assert.ok(COMPOSER_MAX_ROWS < AUTOGROW_MAX_ROWS);
  const r = computeAutogrow({ contentHeight: 9 * 24, lineHeight: 24, maxRows: COMPOSER_MAX_ROWS });
  assert.equal(r.rows, 4); assert.equal(r.height, 96); assert.equal(r.overflow, true);
});

test('页面接线：工具行独立、自适应轮询、乐观上屏、隐藏不轮询', () => {
  const js = read('mobile/app/www/pages/sessions.mjs');
  const css = read('mobile/app/www/pages/sessions.css');
  assert.match(js, /sessions-composer-tools/);
  assert.match(js, /\[composerInput, composerTools\]|sendMode, composerInput, composerTools/);
  assert.doesNotMatch(js, /setInterval\(\(\) => \{\s*if \(state\.view === 'detail'/, '不再写死 5 秒 setInterval');
  assert.match(js, /buildComposerView/); assert.match(js, /visibilitychange/);
  assert.match(js, /optimisticMessage/); assert.match(js, /sessions-retry/);
  assert.match(js, /maxRows: 4/);
  assert.match(css, /\.sessions-composer-tools\s*\{[^}]*height:\s*2\.75rem/);
  assert.match(css, /\.sessions-composer\s*\{[^}]*flex-direction:\s*column/);
});

// ---- 设计偏差返工：会话视图模型（sessions/views.mjs）承载发送/流式/隐藏暂停 ----
import { buildComposerView, mergeLiveText } from '../mobile/src/features/sessions/index.mjs';

test('视图模型：发送后立即进入响应态，隐藏页暂停轮询', () => {
  const now = 100000;
  const sent = buildComposerView({ session: { busy: false }, respondingSince: now - 500, hidden: false, now });
  assert.equal(sent.responding, true);
  assert.equal(sent.pollMs, 1000);
  const idle = buildComposerView({ session: { busy: false }, respondingSince: 0, hidden: false, now });
  assert.equal(idle.responding, false);
  assert.equal(idle.pollMs, 5000);
  const hidden = buildComposerView({ session: { busy: true }, respondingSince: now, hidden: true, now });
  assert.equal(hidden.paused, true);
  assert.equal(hidden.pollMs, null);
});

test('视图模型：liveText 作为「正在输出…」流式气泡，空文本无气泡', () => {
  assert.equal(buildComposerView({ session: { busy: true, liveText: '' } }).stream, null);
  const view = buildComposerView({ session: { busy: true, liveText: '你好' } });
  assert.deepEqual(view.stream, { role: '会话', text: '你好', at: '', streaming: true });
  assert.equal(mergeLiveText(['你', '好']), '你好');
});

test('sessions.mjs 用视图模型：rAF 合帧渲染与 visibilitychange 接线', () => {
  const src = read('mobile/app/www/pages/sessions.mjs');
  assert.match(src, /buildComposerView/);
  assert.match(src, /requestAnimationFrame/);
  assert.match(src, /visibilitychange/);
});
