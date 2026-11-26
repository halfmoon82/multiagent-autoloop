// compact-ui-density：会话页授权双按钮单行小按钮 + 全局 oversized 排查。
// 小屏优先：可点区域 ≥36px、不横向滚动、信息密度向网页版靠拢。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sessionsCss = readFileSync(path.join(ROOT, 'mobile/app/www/pages/sessions.css'), 'utf8');
const stylesCss = readFileSync(path.join(ROOT, 'mobile/app/www/styles.css'), 'utf8');

function rule(css, selector) {
  const esc = selector.replace(/[.[\]()*+?^$|\\]/g, '\\$&');
  const matches = [...css.matchAll(new RegExp(`(?:^|\\}|\\*/)\\s*${esc}\\s*\\{([^}]*)\\}`, 'g'))];
  assert.ok(matches.length, `缺少规则 ${selector}`);
  return matches.map(m => m[1]).join(';');
}
const px = (body, prop) => {
  const m = body.match(new RegExp(`(?:^|[;\\s])${prop}:\\s*(\\d+(?:\\.\\d+)?)px`));
  return m ? Number(m[1]) : null;
};
const inRange = (v, label) => assert.ok(v >= 36 && v <= 40, `${label}=${v}`);

test('授权双按钮：单行小按钮，min-height 36–40px，不换行成大块', () => {
  const body = rule(sessionsCss, '.sessions-design-btn');
  inRange(px(body, 'min-height'), 'design-btn min-height');
  assert.doesNotMatch(body, /flex:\s*1 1 10rem/);
  assert.match(body, /font-size:\s*0\.8\d*rem|font-size:\s*1[23]px/);
  assert.match(body, /white-space:\s*nowrap/);
  const row = rule(sessionsCss, '.sessions-design-actions, .sessions-detail-actions .sessions-design-actions');
  assert.match(row, /flex-wrap:\s*nowrap/);
  assert.doesNotMatch(body, /min-width:\s*\d+(px|rem)/, '不强制最小宽，避免横向滚动');
});

test('会话页工具栏与浮标紧凑，仍 ≥36px', () => {
  inRange(px(rule(sessionsCss, '.sessions-back-bottom'), 'min-height'), 'back-bottom');
  inRange(px(rule(sessionsCss, '.sessions-mic, .sessions-send'), 'min-height'), 'mic/send');
  const input = rule(sessionsCss, '.sessions-question-input, .sessions-composer-input, .sessions-new-prompt');
  assert.match(input, /min-height:\s*2\.\d+rem/, '输入框默认单行');
  inRange(px(rule(sessionsCss, '.sessions-back, .sessions-auth-back, .sessions-artifacts-btn'), 'min-height'), 'back');
  assert.match(rule(sessionsCss, '.sessions-question-card'), /padding:\s*0\.[5-7]\d*rem/);
});

test('全局：按钮与输入框默认高度降档，且仍 ≥36px', () => {
  inRange(px(rule(stylesCss, 'button'), 'min-height'), 'button');
  inRange(px(stylesCss.match(/input\[type="text"\][^{]*\{[^}]*\}/)[0], 'min-height'), 'input');
});
