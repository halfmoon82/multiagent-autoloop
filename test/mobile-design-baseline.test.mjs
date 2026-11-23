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

test('会话详情：返回式详情头、上下文工具条与待回答定位齐备', () => {
  const src = read('mobile/app/www/pages/sessions.mjs');
  const cssSessions = read('mobile/app/www/pages/sessions.css');
  for (const marker of ["className: 'sessions-detail-hero'", "className: 'sessions-detail-meta'", "className: 'sessions-context-bar'", "className: 'sessions-tools'", "className: 'sessions-pending-strip'", "className: 'sessions-queue-preview'"]) assert.ok(src.includes(marker), `缺少 ${marker}`);
  assert.match(cssSessions, /\.sessions-message\.user \.sessions-bubble\s*\{[^}]*background:\s*var\(--brand-ink\)/);
  assert.match(cssSessions, /\.sessions-message\.user \.sessions-bubble\s*\{[^}]*color:\s*#fff/);
});

test('会话 composer 与新建表单：使用既有图标语义和完整标题组', () => {
  const src = read('mobile/app/www/pages/sessions.mjs');
  const cssSessions = read('mobile/app/www/pages/sessions.css');
  assert.match(src, /className: 'sessions-mic mic-btn',/);
  assert.match(src, /className: 'sessions-send send-btn',/);
  assert.match(src, /attrs: \{ 'data-icon': 'mic'/);
  assert.match(src, /attrs: \{ 'data-icon': 'send'/);
  assert.match(src, /text: 'NEW SESSION'/);
  assert.match(src, /text: '您想做什么？'/);
  assert.match(cssSessions, /\.sessions-composer\s*\{[^}]*border-radius:\s*16px/);
  assert.match(cssSessions, /\.sessions-send\.send-btn\s*\{[^}]*border-radius:\s*50%/);
});

test('消息与待回答组共用滚动区，composer 独立常驻底部', () => {
  const src = read('mobile/app/www/pages/sessions.mjs');
  const cssSessions = read('mobile/app/www/pages/sessions.css');
  assert.match(src, /messageWindow\.appendChild\(questionBox\)/);
  assert.doesNotMatch(cssSessions, /\.sessions-question\s*\{[^}]*max-height:\s*42%/);
  assert.match(cssSessions, /\.sessions-message-window\s*\{[^}]*min-height:\s*5rem/);
});

test('其余主 Tab 与管理/设置页都有基线标题组和统一卡片层级', () => {
  for (const marker of ['PILOT OVERVIEW', '今天的自动化', '调度规则', '执行轮次', '待我处理', '管理后台', 'DEVICES &amp; PREFERENCES', '设备与偏好']) assert.ok(html.includes(marker), `缺少 ${marker}`);
  const coreCss = read('mobile/app/www/pages/core.css');
  const adminCss = read('mobile/app/www/pages/admin.css');
  assert.match(coreCss, /\.core-section\.card\s*\{[^}]*border-radius:\s*15px/);
  assert.match(adminCss, /\.admin-subnav\s*\{[^}]*border-radius:\s*999px/);
});

test('全局项目筛选使用设计稿卡片条，不改变原生选择器与清除行为', () => {
  const src = read('mobile/app/www/pages/project-filter.mjs');
  const pfCss = read('mobile/app/www/pages/project-filter.css');
  assert.match(src, /className: 'project-filter-bar'/);
  assert.match(src, /root\.replaceChildren\(bar, status\)/);
  assert.match(pfCss, /\.project-filter-bar\s*\{[^}]*border-radius:\s*13px/);
});

test('会话忙碌时提供排队与打断 steer 两种真实发送方式', async () => {
  const src = read('mobile/app/www/pages/sessions.mjs');
  const { createSessionsWrite } = await import('../mobile/src/features/sessions/browser.mjs');
  assert.match(src, /sessions-steer-btn/);
  assert.match(src, /sendComposer\(true\)/);
  assert.match(src, /sendComposer\(false\)/);
  const calls = [];
  const write = createSessionsWrite(
    { origin: 'https://console.example', tokenStore: { async get() { return 'device-token'; } } },
    { fetchImpl: async (url, init) => { calls.push({ url, method: init.method, body: JSON.parse(init.body || '{}') }); return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }); } },
  );
  await write.sendMessage('session 1', { text: '立即处理', interrupt: true });
  assert.deepEqual(calls[0], { url: 'https://console.example/api/mobile/sessions/session%201/messages', method: 'POST', body: { text: '立即处理', interrupt: true } });
});

test('队列投影和写操作覆盖编辑、排序、清空、删除与 steer', async () => {
  const { mobileSessionSummaries } = await import('../mobile/src/features/sessions/projections.mjs');
  const { createSessionsWrite } = await import('../mobile/src/features/sessions/browser.mjs');
  const [session] = mobileSessionSummaries([{ id: 's1', queue: [{ id: 'q1', text: '第一条' }], queuedCount: 1 }]);
  assert.deepEqual(session.queue, [{ id: 'q1', text: '第一条', at: '' }]);
  const src = read('mobile/app/www/pages/sessions.mjs');
  for (const marker of ['queuePanel', 'updateQueued', 'moveQueued', 'removeQueued', 'clearQueued', 'steerQueued']) assert.ok(src.includes(marker), `缺少 ${marker}`);
  const calls = [];
  const write = createSessionsWrite(
    { origin: 'https://console.example', tokenStore: { async get() { return 'device-token'; } } },
    { fetchImpl: async (url, init) => { calls.push({ url, method: init.method, body: JSON.parse(init.body || '{}') }); return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }); } },
  );
  await write.updateQueued('s1', 'q1', { text: '改后' });
  await write.moveQueued('s1', 'q1', { direction: 'up' });
  await write.steerQueued('s1', 'q1');
  await write.removeQueued('s1', 'q1');
  await write.clearQueued('s1');
  assert.deepEqual(calls.map(call => [call.method, call.url]), [
    ['PUT', 'https://console.example/api/mobile/sessions/s1/queue/q1'],
    ['POST', 'https://console.example/api/mobile/sessions/s1/queue/q1/move'],
    ['POST', 'https://console.example/api/mobile/sessions/s1/queue/q1/steer'],
    ['DELETE', 'https://console.example/api/mobile/sessions/s1/queue/q1'],
    ['POST', 'https://console.example/api/mobile/sessions/s1/queue/clear'],
  ]);
});

test('历史区默认扩大，提示词和队列管理按需展开', () => {
  const src = read('mobile/app/www/pages/sessions.mjs');
  const cssSessions = read('mobile/app/www/pages/sessions.css');
  assert.match(src, /sessions-info-toggle/);
  assert.match(src, /sessions-info-panel/);
  assert.match(cssSessions, /\.sessions-message-window\s*\{[^}]*min-height:\s*12rem/);
});

test('总览不再承载移动壳，管理后台新增独立移动壳分区', () => {
  const core = /<div id="page-core"[\s\S]*?<div id="page-rules"/.exec(html)?.[0] || '';
  assert.doesNotMatch(core, /移动端控制台壳|id="reconnect"|id="rebind"/);
  assert.match(html, /data-admin-pane="admin-pane-mobile"/);
  const mobile = /id="admin-pane-mobile"[\s\S]*?<\/section>/.exec(html)?.[0] || '';
  assert.match(mobile, /移动端控制台壳/);
  assert.match(mobile, /id="reconnect"/);
  assert.match(mobile, /id="rebind"/);
  assert.match(mobile, /id="connection-error"/);
  const admin = read('mobile/app/www/pages/admin.mjs');
  assert.match(admin, /'admin-pane-mobile'/);
});

test('项目筛选与连接状态合并到顶栏，保持小屏空间', () => {
  const header = /<header class="app-header">[\s\S]*?<\/header>/.exec(html)?.[0] || '';
  assert.match(header, /class="header-meta"/);
  assert.match(header, /id="connection-status"/);
  assert.match(header, /id="project-filter-root"/);
  assert.match(header, /id="open-settings"/);
  assert.doesNotMatch(html, /<\/header>\s*<div id="project-filter-root"/);
  assert.match(css, /#app-main \.header-meta\s*\{[^}]*display:\s*flex/);
  assert.match(css, /#app-main #project-filter-root \.project-filter-bar\s*\{[^}]*min-height:\s*2\.25rem/);
});

test('非 DAG 卡片统一限高可展开，短卡片不增加控件', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../mobile/app/www/collapsible-cards.mjs', import.meta.url), 'utf8');
  assert.match(src, /dataset\.collapsible/);
  assert.match(src, /dataset\.expanded/);
  assert.match(src, /card-expand/);
  assert.match(src, /closest\('#page-dag'\)/);
  assert.match(src, /before\(button\)/, '展开按钮放在卡片外，允许原卡片本身是 button');
});

test('折叠只处理静态长内容，交互表单默认保持可操作', () => {
  const src = read('mobile/app/www/collapsible-cards.mjs');
  assert.match(src, /querySelector\('button,input,select,textarea'/);
  assert.match(src, /dataset\.collapsible = 'interactive'/);
  assert.match(src, /core-card/);
  assert.match(src, /core-item/);
});

test('项目选择只保留一个无双重边框的控件且不溢出顶栏', () => {
  assert.match(css, /#app-main #project-filter-root \.project-filter-bar\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent/);
  assert.match(css, /#app-main #project-filter-root \.pf-select\s*\{[^}]*max-width:\s*100%/);
});
