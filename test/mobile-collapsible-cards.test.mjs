import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const skip = existsSync(chromium.executablePath()) ? false : '未安装 Playwright Chromium';

test('长卡片默认限高可展开，短卡片不加按钮，button 卡片无嵌套按钮', { skip }, async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', e => console.log('PAGE_ERROR', e.message));
  page.on('console', m => console.log('PAGE_CONSOLE', m.type(), m.text()));
  await page.route('**/collapsible-cards.mjs', route => route.fulfill({
    status: 200, contentType: 'text/javascript', body: readFileSync('mobile/app/www/collapsible-cards.mjs', 'utf8'),
  }));
  await page.setContent(`<div id="page-core">
    <button id="long" class="card sessions-item">${'很长的会话内容。'.repeat(80)}</button>
    <div id="short" class="card">短内容</div>
    <div id="confirm" class="card"><button>确认保存</button>${'保存确认内容。'.repeat(80)}</div>
    <div id="model" class="card"><select><option>模型选择必须直接可用</option></select>${'模型配置内容。'.repeat(80)}</div>
    <div id="auth" class="core-card">${'执行授权与路径。'.repeat(80)}</div>
  </div><div id="page-dag"><div id="dag" class="card">${'DAG 不折叠。'.repeat(80)}</div></div>
`);
  await page.addStyleTag({ content: '.collapsible-card{max-height:160px;overflow:hidden}.collapsible-card[data-expanded="true"]{max-height:none;overflow:auto}' });
  await page.addScriptTag({ type: 'module', content: "import { attachCollapsibleCards } from 'https://test.local/collapsible-cards.mjs'; attachCollapsibleCards(document);" });
  await page.waitForFunction(() => document.querySelector('.card-expand'), null, { timeout: 2000 });
  assert.equal(await page.locator('#long > .card-expand').count(), 0, '展开按钮不嵌套在原 button 内');
  assert.equal(await page.locator('.card-expand').count(), 2, '短卡、保存确认、模型表单与 DAG 都不加按钮');
  assert.equal(await page.locator('#confirm').getAttribute('data-collapsible'), 'interactive');
  assert.equal(await page.locator('#confirm').getAttribute('data-expanded'), 'true');
  assert.equal(await page.locator('#model').getAttribute('data-collapsible'), 'interactive');
  assert.equal(await page.evaluate(() => document.querySelector('#model select').disabled), false);
  assert.equal(await page.locator('#auth').getAttribute('data-expanded'), 'false');
  const collapsed = await page.evaluate(() => { const el = document.querySelector('#long'); return { max: getComputedStyle(el).maxHeight, expanded: el.dataset.expanded }; });
  assert.equal(collapsed.expanded, 'false');
  assert.notEqual(collapsed.max, 'none');
  await page.locator('.card-expand').first().click();
  assert.equal(await page.locator('#long').getAttribute('data-expanded'), 'true');
  assert.equal(await page.locator('.card-expand').first().innerText(), '收起');
  await page.locator('.card-expand').first().click();
  assert.equal(await page.locator('#long').getAttribute('data-expanded'), 'false');
});

// 回归：非激活 Tab（display:none）里的长卡片不能在量不到高度时被永久标记 not-needed，
// Tab 可见后必须由折叠机制重新评估（2026-11-23 真机：待办页执行授权长卡从不折叠）。
test('隐藏 Tab 里的长卡片先不判定，可见后经观察器折叠', { skip }, async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.route('**/collapsible-cards.mjs', route => route.fulfill({
    status: 200, contentType: 'text/javascript', body: readFileSync('mobile/app/www/collapsible-cards.mjs', 'utf8'),
  }));
  await page.setContent(`<div id="tab-todos" hidden><div id="pending-card" class="core-card">${'待办页执行授权长内容。'.repeat(80)}</div></div>
<div id="tab-core"><div id="core-card" class="core-card">${'总览页长内容。'.repeat(80)}</div></div>`);
  await page.addStyleTag({ content: '.collapsible-card{max-height:160px;overflow:hidden}.collapsible-card[data-expanded="true"]{max-height:none;overflow:auto}' });
  await page.addScriptTag({ type: 'module', content: "import { observeCollapsibleCards } from 'https://test.local/collapsible-cards.mjs'; window.__observer = observeCollapsibleCards(document);" });
  await page.waitForFunction(() => document.querySelector('#core-card[data-expanded="false"]'), null, { timeout: 2000 });
  assert.equal(await page.locator('#pending-card').getAttribute('data-collapsible'), null, '隐藏 Tab 中的卡片不得被永久标记');
  // 切到待办 Tab：hidden 属性变化必须触发重新评估。
  await page.evaluate(() => { document.getElementById('tab-todos').hidden = false; document.getElementById('tab-core').hidden = true; });
  await page.waitForFunction(() => document.querySelector('#pending-card[data-expanded="false"]'), null, { timeout: 2000 });
  assert.equal(await page.locator('#pending-card').getAttribute('data-collapsible'), '');
  assert.equal(await page.evaluate(() => document.getElementById('pending-card').previousElementSibling?.className || ''), 'card-expand');
});
