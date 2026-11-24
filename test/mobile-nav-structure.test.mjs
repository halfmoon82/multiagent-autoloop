// nav-collapse 节点边界测试：底部 6 Tab、头部齿轮设置入口、管理后台/设置页骨架与页面栈适配。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MOBILE_PAGES, createViewStack } from '../mobile/app/www/app.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => readFileSync(path.join(ROOT, rel), 'utf8');
const html = read('mobile/app/www/index.html');
const tabBar = /<nav id="tab-bar"[\s\S]*?<\/nav>/.exec(html)?.[0] || '';
const tabs = [...tabBar.matchAll(/<button[^>]*class="tab"[^>]*data-tab="([^"]+)"[^>]*aria-selected="(true|false)"[^>]*>([\s\S]*?)<\/button>/g)]
  .map(m => ({ key: m[1], selected: m[2], label: /<span>([^<]*)<\/span>/.exec(m[3])?.[1] ?? '' }));

test('tab-bar 恰 6 个 Tab，顺序与文案按设计稿', () => {
  assert.deepEqual(tabs.map(t => t.label), ['总览', '规则', '会话', '轮次', '待办', '管理后台']);
  assert.deepEqual(tabs.map(t => t.key), ['core', 'rules', 'sessions', 'rounds', 'todos', 'admin']);
  assert.equal((tabBar.match(/class="tab"/g) || []).length, 6);
  assert.deepEqual(tabs.map(t => t.selected), ['true', 'false', 'false', 'false', 'false', 'false']);
});

test('产物/DAG/设备不再是 Tab，但页面容器仍保留可达', () => {
  for (const label of ['产物', 'DAG', '设备']) assert.ok(!tabs.some(t => t.label === label), `不应有 Tab ${label}`);
  for (const key of ['artifacts', 'dag']) assert.match(html, new RegExp(`id="page-${key}"[^>]*data-page="${key}"`));
  assert.match(html, /id="page-devices"/);
});

test('头部有齿轮设置入口，设置页含设备/通知/字体三分区并挂载既有挂点', () => {
  assert.match(html, /<header class="app-header">[\s\S]*id="open-settings"[\s\S]*<\/header>/);
  assert.match(html, /id="page-settings"[^>]*data-page="settings"/);
  const settings = /id="page-settings"[\s\S]*?<\/main>/.exec(html)[0];
  for (const id of ['page-devices', 'notify-root', 'font-touch-root']) assert.match(settings, new RegExp(`id="${id}"`), `设置页缺少 ${id}`);
  for (const title of ['设备绑定', '通知偏好', '系统字体']) assert.ok(settings.includes(title), `设置页缺少分区 ${title}`);
});

test('管理后台页含「平台与模型 / 运行环境」两 pane 与分区导航', () => {
  const admin = /id="page-admin"[\s\S]*?id="page-settings"/.exec(html)?.[0] || '';
  assert.match(admin, /data-admin-pane="admin-pane-platform"/);
  assert.match(admin, /data-admin-pane="admin-pane-runtime"/);
  assert.ok(admin.includes('平台与模型') && admin.includes('运行环境'));
});

test('MOBILE_PAGES 增 admin/settings；对应 mjs 与 css 存在', () => {
  assert.ok(MOBILE_PAGES.includes('admin') && MOBILE_PAGES.includes('settings'));
  for (const name of ['admin', 'settings']) {
    assert.match(read(`mobile/app/www/pages/${name}.mjs`), /export function mount\s*\(/);
    assert.ok(existsSync(path.join(ROOT, 'mobile/app/www/pages', `${name}.css`)));
    assert.match(html, new RegExp(`pages/${name}\\.css`));
  }
});

test('admin 骨架：未加载显示加载态与重试，不白屏；不直接访问 Hub', () => {
  const src = read('mobile/app/www/pages/admin.mjs');
  assert.match(src, /加载中/);
  assert.match(src, /重试/);
  assert.doesNotMatch(src, /innerHTML/);
});

test('app.mjs：settings 经页面栈进出，不改 devices/notify/font-touch 三个文件语义', () => {
  const app = read('mobile/app/www/app.mjs');
  assert.match(app, /openSettings/);
  assert.match(app, /id:\s*'settings'/);
  assert.match(read('mobile/app/www/pages/settings.mjs'), /open-settings/);
  const stack = createViewStack();
  stack.push({ id: 'settings' });
  assert.deepEqual(stack.back(), { action: 'pop', view: { id: 'settings' } });
  assert.deepEqual(stack.back(), { action: 'confirm-exit' });
});

test('DESIGN_REVIEW 基线为六栏并记录主人 2026-11-21 决策', () => {
  const doc = read('docs/design/2026-11-17-mobile-app/DESIGN_REVIEW.md');
  assert.match(doc, /底部六栏/);
  assert.doesNotMatch(doc, /底部五栏/);
  assert.match(doc, /2026-11-21/);
});
