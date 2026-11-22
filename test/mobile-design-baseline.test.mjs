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

test('会话列表：标题组、全宽新建、独立搜索与数量筛选按设计顺序', () => {
  const src = read('mobile/app/www/pages/sessions.mjs');
  const cssSessions = read('mobile/app/www/pages/sessions.css');
  assert.match(src, /className: 'page-heading sessions-heading'/);
  assert.match(src, /text: 'SESSIONS'/);
  assert.match(src, /text: '会话管理'/);
  assert.match(src, /text: '对话、调度与 PRD 设计，各就其位。'/);
  const headingAt = src.indexOf("className: 'page-heading sessions-heading'");
  const newAt = src.indexOf("className: 'sessions-new-btn primary-btn full-btn'");
  const searchAt = src.indexOf("className: 'sessions-search-box search-box'");
  const filtersAt = src.indexOf("const filters = node('div', { className: 'sessions-filters filter-rail'");
  assert.ok(headingAt > 0 && newAt > headingAt && searchAt > newAt && filtersAt > searchAt, '控件顺序应为标题→新建→搜索→筛选');
  assert.match(src, /state\.snapshot\.sessions/);
  assert.match(cssSessions, /\.sessions-new-btn\.primary-btn\.full-btn/);
  assert.match(cssSessions, /\.sessions-search-box\.search-box/);
});

test('会话卡片：标题、状态胶囊、项目/类型与摘要分层，长标题可换行', () => {
  const src = read('mobile/app/www/pages/sessions.mjs');
  const cssSessions = read('mobile/app/www/pages/sessions.css');
  for (const marker of ["className: 'item-top'", "className: 'item-title'", "className: 'status-chip'", "className: 'item-subtitle'", "className: 'item-description'"]) assert.ok(src.includes(marker), `缺少 ${marker}`);
  assert.match(cssSessions, /\.sessions-item\s*\{[^}]*border-radius:\s*15px/);
  assert.match(cssSessions, /\.sessions-item \.item-title\s*\{[^}]*overflow-wrap:\s*anywhere/);
  assert.match(cssSessions, /\.sessions-chip\.active\s*\{[^}]*background:\s*var\(--brand-ink\)/);
});
