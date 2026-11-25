// DAG collapsible-expand 节点回归：静态长卡片可展开/再收起，展开态跨常规刷新保持，
// 展开内容加载失败就地重试。DOM 断言跑在真实 Chromium 页面上（仓库无 jsdom，沿用 mobile 浏览器回归口径）。
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
    <div id="long" class="card sessions-item">${'很长的会话内容。'.repeat(80)}</div>
    <button id="clickable" class="sessions-item">${'可点击会话条目。'.repeat(80)}</button>
    <div id="short" class="card">短内容</div>
    <div id="confirm" class="card"><button>确认保存</button>${'保存确认内容。'.repeat(80)}</div>
    <div id="model" class="card"><select><option>模型选择必须直接可用</option></select>${'模型配置内容。'.repeat(80)}</div>
    <div id="auth" class="core-card">${'执行授权与路径。'.repeat(80)}</div>
  </div><div id="page-dag"><div id="dag" class="card">${'DAG 不折叠。'.repeat(80)}</div></div>
`);
  await page.addStyleTag({ content: '.collapsible-card{position:relative;max-height:160px;overflow:hidden;padding-bottom:2.5rem}.collapsible-card[data-expanded="true"]{max-height:none;overflow:auto}.card-expand{position:absolute;right:0.35rem;bottom:0.35rem}' });
  await page.addScriptTag({ type: 'module', content: "import { attachCollapsibleCards } from 'https://test.local/collapsible-cards.mjs'; attachCollapsibleCards(document);" });
  await page.waitForFunction(() => document.querySelector('.card-expand'), null, { timeout: 2000 });
  assert.equal(await page.locator('#clickable').getAttribute('data-collapsible'), 'interactive', '卡片自身是按钮时不折叠');
  assert.equal(await page.locator('#clickable > .card-expand').count(), 0, '展开按钮不嵌套在可点击卡片内');
  assert.equal(await page.locator('#long > .card-expand').count(), 1, '每张可折叠卡片内部有自己的展开按钮');
  assert.equal(await page.locator('.card-expand').count(), 2, '短卡、可点击条目、保存确认、模型表单与 DAG 都不加按钮');
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
  await page.addStyleTag({ content: '.collapsible-card{position:relative;max-height:160px;overflow:hidden;padding-bottom:2.5rem}.collapsible-card[data-expanded="true"]{max-height:none;overflow:auto}.card-expand{position:absolute;right:0.35rem;bottom:0.35rem}' });
  await page.addScriptTag({ type: 'module', content: "import { observeCollapsibleCards } from 'https://test.local/collapsible-cards.mjs'; window.__observer = observeCollapsibleCards(document);" });
  await page.waitForFunction(() => document.querySelector('#core-card[data-expanded="false"]'), null, { timeout: 2000 });
  assert.equal(await page.locator('#pending-card').getAttribute('data-collapsible'), null, '隐藏 Tab 中的卡片不得被永久标记');
  // 切到待办 Tab：hidden 属性变化必须触发重新评估。
  await page.evaluate(() => { document.getElementById('tab-todos').hidden = false; document.getElementById('tab-core').hidden = true; });
  await page.waitForFunction(() => document.querySelector('#pending-card[data-expanded="false"]'), null, { timeout: 2000 });
  assert.equal(await page.locator('#pending-card').getAttribute('data-collapsible'), '');
  assert.equal(await page.locator('#pending-card > .card-expand').count(), 1, '可见后卡片内部补上自己的展开按钮');
});


// 折叠视觉由页面 CSS 提供；测试页内联同一规则，节点模块本身只管状态与控件。
const PAGE_CSS = `.collapsible-card{position:relative;max-height:160px;overflow:hidden;padding-bottom:2.5rem}
.collapsible-card[data-expanded="true"]{max-height:none;overflow:auto}
.card-expand{position:absolute;right:0.35rem;bottom:0.35rem}`;

function moduleSource() {
  return readFileSync(new URL('../mobile/app/www/collapsible-cards.mjs', import.meta.url), 'utf8');
}

function testPage(body) {
  return `<!doctype html><meta charset="utf-8"><style>${PAGE_CSS}</style>${body}
<script type="module">
  import { attachCollapsibleCards } from 'https://test.local/collapsible-cards.mjs';
  attachCollapsibleCards(document);
</script>`;
}

async function openPage(t, body, routes = []) {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', error => console.log('PAGE_ERROR', error.message));
  await page.route('**/collapsible-cards.mjs', route => route.fulfill({
    status: 200, contentType: 'text/javascript', body: moduleSource(),
  }));
  for (const [pattern, handler] of routes) await page.route(pattern, handler);
  await page.route('**/test-page', route => route.fulfill({
    status: 200, contentType: 'text/html', body: testPage(body),
  }));
  await page.goto('https://test.local/test-page');
  return page;
}

const LONG = '很长的静态信息内容，仅供折叠测试使用。'.repeat(40);

test('长卡片折叠→展开→再折叠：展开控件、aria 与状态同步', { skip }, async t => {
  const page = await openPage(t, `<div id="page-core">
    <div id="long" class="card">${LONG}</div>
    <div id="short" class="card">短内容</div>
  </div>`);
  await page.waitForFunction(() => document.querySelector('#long[data-expanded="false"]'));
  assert.equal(await page.locator('#long').getAttribute('data-collapsible'), '');
  assert.equal(await page.locator('.card-expand').count(), 1, '短卡片不加展开控件');
  assert.equal(await page.locator('#long > .card-expand').count(), 1, '展开按钮在卡片内部');
  assert.equal(await page.locator('.card-expand').getAttribute('aria-expanded'), 'false');

  await page.locator('.card-expand').click();
  assert.equal(await page.locator('#long').getAttribute('data-expanded'), 'true');
  assert.equal(await page.locator('.card-expand').innerText(), '收起');
  assert.equal(await page.locator('.card-expand').getAttribute('aria-expanded'), 'true');

  await page.locator('.card-expand').click();
  assert.equal(await page.locator('#long').getAttribute('data-expanded'), 'false');
  assert.equal(await page.locator('.card-expand').innerText(), '展开');
  assert.equal(await page.locator('.card-expand').getAttribute('aria-expanded'), 'false');
});

test('展开态在页面常规刷新后保持', { skip }, async t => {
  const page = await openPage(t, `<div id="page-core"><div id="long" class="card">${LONG}</div></div>`);
  await page.waitForFunction(() => document.querySelector('#long[data-expanded="false"]'));
  await page.locator('.card-expand').click();
  assert.equal(await page.locator('#long').getAttribute('data-expanded'), 'true');

  await page.reload();
  await page.waitForFunction(() => document.querySelector('#long[data-expanded="true"]'), null, { timeout: 3000 });
  assert.equal(await page.locator('.card-expand').innerText(), '收起');
  // 刷新后再次点击仍能收起，状态回写持久化层。
  await page.locator('.card-expand').click();
  assert.equal(await page.locator('#long').getAttribute('data-expanded'), 'false');
});

test('展开内容加载失败就地重试，成功后展示内容', { skip }, async t => {
  let attempts = 0;
  const page = await openPage(t, `<div id="page-core">
    <div id="long" class="card" data-expand-src="https://test.local/detail.txt">${LONG}</div>
  </div>`, [['**/detail.txt', route => {
    attempts += 1;
    if (attempts === 1) route.fulfill({ status: 500, contentType: 'text/plain', body: 'boom' });
    else route.fulfill({ status: 200, contentType: 'text/plain', body: '详情加载成功' });
  }]]);
  await page.waitForFunction(() => document.querySelector('#long[data-expanded="false"]'));
  await page.locator('.card-expand').click();
  await page.waitForFunction(() => document.querySelector('.card-expand-retry'), null, { timeout: 3000 });
  assert.equal(await page.locator('.card-expand-retry').innerText(), '加载失败，重试');
  assert.equal(await page.evaluate(() => document.querySelector('.card-expand-retry').closest('#long')?.id), 'long', '重试入口就地出现在卡片内');

  await page.locator('.card-expand-retry').click();
  await page.waitForFunction(() => document.querySelector('#long [data-expand-content="loaded"]'), null, { timeout: 3000 });
  assert.equal(await page.locator('#long').getAttribute('data-expanded'), 'true');
  assert.equal(await page.evaluate(() => document.querySelector('#long [data-expand-content="loaded"]').textContent), '详情加载成功');
  assert.equal(await page.locator('.card-expand-retry').count(), 0, '成功后移除重试入口');
});

// 用户报告回归：整页右上角只有一个按钮、只能展开最底下一张卡片。
// 修好后每张卡片内部右下角各有独立按钮，定位基准是自己的卡片，点击一张不影响其他卡片。
test('多张卡片各有独立右下角按钮，逐张展开互不影响', { skip }, async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 402, height: 874 } });
  await page.route('**/collapsible-cards.mjs', route => route.fulfill({
    status: 200, contentType: 'text/javascript', body: moduleSource(),
  }));
  await page.addStyleTag({ content: readFileSync('mobile/app/www/styles.css', 'utf8') });
  await page.setContent(`<!doctype html><meta charset="utf-8"><div class="app"><main id="app-main"><div class="content" id="page-core">
    <div id="card-a" class="card">${LONG}</div>
    <div id="card-b" class="card">${LONG}</div>
    <div id="card-c" class="card">${LONG}</div>
  </div></main></div>`);
  await page.addScriptTag({ type: 'module', content: "import { attachCollapsibleCards } from 'https://test.local/collapsible-cards.mjs'; attachCollapsibleCards(document);" });
  await page.waitForFunction(() => document.querySelectorAll('.card-expand').length === 3, null, { timeout: 3000 });

  const layout = await page.evaluate(() => ['card-a', 'card-b', 'card-c'].map(id => {
    const card = document.getElementById(id);
    const button = card.querySelector(':scope > .card-expand');
    if (!button) return { id, directChild: false, count: 0, inside: false, bottomRight: false, pos: 'none' };
    const c = card.getBoundingClientRect();
    const b = button.getBoundingClientRect();
    return {
      id,
      directChild: !!button,
      count: card.querySelectorAll('.card-expand').length,
      inside: b.left >= c.left - 1 && b.right <= c.right + 1 && b.top >= c.top - 1 && b.bottom <= c.bottom + 1,
      bottomRight: c.right - b.right < 24 && c.bottom - b.bottom < 24,
      pos: `${Math.round(b.x)},${Math.round(b.y)}`,
    };
  }));
  for (const item of layout) {
    assert.equal(item.directChild, true, `${item.id} 内部有自己的展开按钮`);
    assert.equal(item.count, 1, `${item.id} 恰好一个按钮`);
    assert.equal(item.inside, true, `${item.id} 按钮在自己卡片范围内`);
    assert.equal(item.bottomRight, true, `${item.id} 按钮在卡片右下角`);
  }
  assert.equal(new Set(layout.map(item => item.pos)).size, 3, '三个按钮位置各不相同，不再叠在整页右上角');

  // 只点第二张：只有第二张展开，第一、三张保持折叠。
  await page.locator('#card-b > .card-expand').click();
  assert.equal(await page.locator('#card-b').getAttribute('data-expanded'), 'true');
  assert.equal(await page.locator('#card-a').getAttribute('data-expanded'), 'false');
  assert.equal(await page.locator('#card-c').getAttribute('data-expanded'), 'false');
  assert.equal(await page.locator('#card-b > .card-expand').innerText(), '收起');
  assert.equal(await page.locator('#card-a > .card-expand').innerText(), '展开');
  // 再点第一张：第二张已展开不受影响。
  await page.locator('#card-a > .card-expand').click();
  assert.equal(await page.locator('#card-a').getAttribute('data-expanded'), 'true');
  assert.equal(await page.locator('#card-b').getAttribute('data-expanded'), 'true');
  assert.equal(await page.locator('#card-c').getAttribute('data-expanded'), 'false');
  assert.equal(await page.locator('#card-c > .card-expand').innerText(), '展开');
});
