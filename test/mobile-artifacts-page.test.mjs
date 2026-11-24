// 产物页（artifacts-sync）接线回归：异步 hooks.artifacts 装载列表、html 产物沙箱预览。
// 真机事故（2026-11-24）：数据源从未接线，页面恒空；预览缺失。DOM 断言跑在真实 Chromium 上。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const skip = existsSync(chromium.executablePath()) ? false : '未安装 Playwright Chromium';

const pageSource = readFileSync(new URL('../mobile/app/www/pages/artifacts.mjs', import.meta.url), 'utf8');

async function boot(t, { artifacts, artifactFile }) {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', e => console.log('PAGE_ERROR', e.message));
  await page.route('**/artifacts.mjs', route => route.fulfill({ status: 200, contentType: 'text/javascript', body: pageSource }));
  for (const name of ['index.mjs', 'browser.mjs', 'contract.mjs', 'page.mjs', 'views.mjs']) {
    await page.route('**/src/features/artifacts/' + name, route => route.fulfill({
      status: 200, contentType: 'text/javascript',
      body: readFileSync(new URL('../mobile/src/features/artifacts/' + name, import.meta.url), 'utf8'),
    }));
  }
  await page.setContent(`<main><div id="page-artifacts" class="page" data-page="artifacts"></div></main>`);
  await page.evaluate(async ({ artifactsJson, fileJson }) => {
    const mod = await import('https://test.local/artifacts.mjs');
    const F = await import('https://test.local/src/features/artifacts/index.mjs');
    const hooks = {
      artifacts: () => Promise.resolve(JSON.parse(artifactsJson)),
      selectTab() {}, pushView() {}, popView() {},
      download: () => Promise.resolve(true),
    };
    const ctx = {
      hooks,
      client: { sessionPreviewTicket: () => Promise.resolve({ ticket: 't1', url: '/mobile/preview?ticket=t1' }) },
      state: {},
    };
    window.__mod = mod;
    window.__ctx = ctx;
    window.__F = F;
  }, { artifactsJson: JSON.stringify(artifacts), fileJson: JSON.stringify(artifactFile) });
  return page;
}

test('异步 hooks.artifacts 解析后渲染列表；html 产物预览用 allow-scripts 沙箱 iframe', { skip }, async t => {
  const page = await boot(t,
    { artifacts: [{ id: 's1:docs/看板.html', name: '看板.html', path: 'docs/看板.html', sessionId: 's1', taskLabel: '核心任务', sizeText: '2KB', kindLabel: 'HTML' }], artifactFile: { path: 'docs/看板.html', name: '看板.html', content: '<h1>看板</h1><script>document.body.dataset.ran=1</script>' } });
  await page.evaluate(() => {
    // mount 走默认 feature 加载（浏览器分支 import ../src/features/... 会被 404 兜底），改直接注入：
    const root = document.getElementById('page-artifacts');
    const mod = window.__mod;
    // 用 Node 分支的 loadViewModel 不可行，直接拿 setup：mount 在传入 feature 时同步装配。
    mod.mount(window.__ctx, { feature: window.__F });
  });
  await page.waitForFunction(() => document.querySelector('.artifacts-row'), null, { timeout: 3000 });
  assert.match(await page.locator('.artifacts-row').innerText(), /看板\.html/);
  await page.locator('.artifacts-row').click();
  await page.locator('.artifacts-preview-toggle').click();
  const frame = page.locator('.artifacts-preview-frame');
  await page.waitForFunction(() => {
    const f = document.querySelector('.artifacts-preview-frame');
    return f && !f.closest('.artifacts-preview').hidden && (f.getAttribute('src') || '').includes('/mobile/preview?ticket=');
  }, null, { timeout: 3000 });
  assert.equal(await frame.getAttribute('sandbox'), 'allow-scripts', 'A+ 预览：脚本可运行、不同源');
});
