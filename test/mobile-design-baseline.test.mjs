// NoMoTo 设计基线返工：共享壳、会话视觉与同视口验收。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = rel => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const html = read('mobile/app/www/index.html');
const css = read('mobile/app/www/styles.css');

test('共享壳：六栏位于主内容之后，带图标且不再横向挤压', () => {
  const contentAt = html.indexOf('<div class="content">');
  const navAt = html.indexOf('<nav id="tab-bar"');
  assert.ok(contentAt > 0 && navAt > contentAt, '底部导航必须位于主内容之后');
  assert.match(html, /<nav id="tab-bar" class="tab-bar bottom-nav"/);
  const nav = html.slice(navAt, html.indexOf('</nav>', navAt));
  const icons = [...nav.matchAll(/data-icon="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(icons, ['home', 'rules', 'chat', 'runs', 'cards', 'admin']);
  assert.match(css, /\.tab-bar\s*\{[^}]*grid-template-columns:\s*repeat\(6,\s*minmax\(0,\s*1fr\)\)/);
  assert.doesNotMatch(css, /\.tab-bar\s*\{[^}]*overflow-x:\s*auto/);
});

test('共享壳：主区使用视口内纵向滚动，底部导航常驻且不被内容推走', () => {
  assert.match(css, /#app-main\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*height:\s*100dvh/);
  assert.match(css, /\.content\s*\{[^}]*flex:\s*1 1 auto;[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto/);
  assert.match(css, /\.tab-bar\s*\{[^}]*flex:\s*none/);
});

test('共享图标来自既有设计语义，六栏含管理后台图标', async () => {
  const icons = await import('../mobile/app/www/icons.mjs');
  assert.equal(typeof icons.renderIcons, 'function');
  for (const name of ['home', 'rules', 'chat', 'runs', 'cards', 'admin', 'search', 'mic', 'send', 'back', 'file', 'plus']) {
    assert.match(icons.icon(name), /viewBox="0 0 24 24"/);
  }
});
