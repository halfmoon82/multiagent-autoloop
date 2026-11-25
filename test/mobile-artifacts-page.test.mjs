// 产物页（artifacts-sync）接线回归：异步 hooks.artifacts 装载列表、html 产物沙箱预览。
// 真机事故（2026-11-24）：数据源从未接线，页面恒空；预览缺失。DOM 断言跑在真实 Chromium 上。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const skip = existsSync(chromium.executablePath()) ? false : '未安装 Playwright Chromium';

const pageSource = readFileSync(new URL('../mobile/app/www/pages/artifacts.mjs', import.meta.url), 'utf8');

async function boot(t, { artifacts, artifactFile, downloadImpl = 'ok' }) {
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
  await page.evaluate(({ impl }) => {
    const table = { ok: () => Promise.resolve({ started: true }), done: () => Promise.resolve({ started: true, id: 7 }), fail: () => Promise.resolve({ started: false, reason: 'net' }), notoken: () => Promise.resolve({ started: false, reason: 'AUTOLOOP_DOWNLOAD_NO_TOKEN' }) };
    window.__downloadImpl = table[impl];
  }, { impl: downloadImpl });
  await page.evaluate(async ({ artifactsJson, fileJson }) => {
    const mod = await import('https://test.local/artifacts.mjs');
    const F = await import('https://test.local/src/features/artifacts/index.mjs');
    const hooks = {
      artifacts: () => Promise.resolve(JSON.parse(artifactsJson)),
      selectTab() {}, pushView() {}, popView() {},
      download: (url, name) => { window.__dl = (window.__dl || []).concat([{ url, name }]); return window.__downloadImpl(); },
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

const ROW = [{ id: 's1:a.md', name: 'a.md', path: 'a.md', sessionId: 's1', taskLabel: 't', sizeText: '1KB', kindLabel: 'MD' }];
async function openReader(page) {
  await page.evaluate(() => { window.AutoloopConsoleBase = 'https://auto.example'; window.__mod.mount(window.__ctx, { feature: window.__F }); });
  await page.waitForSelector('.artifacts-row');
  await page.locator('.artifacts-row').click();
}

test('下载成功：立即出现「已开始下载」，原生回传完成后出现成功提示', { skip }, async t => {
  const page = await boot(t, { artifacts: ROW, artifactFile: {}, downloadImpl: 'done' });
  await openReader(page);
  await page.locator('.artifacts-download').click();
  await page.waitForSelector('.artifacts-download-feedback[data-phase="downloading"]');
  assert.match(await page.locator('.artifacts-download-feedback').innerText(), /已开始下载 a\.md/);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('autoloop:download-complete', { detail: { id: 7, ok: true } })));
  await page.waitForSelector('.artifacts-download-feedback[data-phase="success"]');
  assert.match(await page.locator('.artifacts-download-feedback').innerText(), /已下载完成/);
});

test('下载失败：就地可读提示与重试，不清空选中、不跳页；重试重新发起', { skip }, async t => {
  const page = await boot(t, { artifacts: ROW, artifactFile: {}, downloadImpl: 'fail' });
  await openReader(page);
  await page.locator('.artifacts-download').click();
  await page.waitForSelector('.artifacts-download-feedback[data-phase="failure"]');
  assert.match(await page.locator('.artifacts-download-feedback').innerText(), /下载失败.*重试/s);
  assert.equal(await page.locator('.artifacts-download').count(), 1, '阅读视图仍在');
  await page.locator('.artifacts-download-retry').click();
  await page.waitForSelector('.artifacts-download-feedback[data-phase="failure"]');
  assert.equal(await page.evaluate(() => window.__dl.length), 2);
});

test('未绑定/令牌缺失：引导重新绑定，不给重试', { skip }, async t => {
  const page = await boot(t, { artifacts: ROW, artifactFile: {}, downloadImpl: 'notoken' });
  await openReader(page);
  await page.locator('.artifacts-download').click();
  await page.waitForSelector('.artifacts-download-feedback[data-phase="failure"]');
  assert.match(await page.locator('.artifacts-download-feedback').innerText(), /重新绑定/);
  assert.equal(await page.locator('.artifacts-download-retry').count(), 0);
  assert.equal(await page.locator('.artifacts-download-rebind').count(), 1);
});

test('pages/artifacts.mjs 含三态字面量标记（设计 verifier 依赖）', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../mobile/app/www/pages/artifacts.mjs', import.meta.url), 'utf8');
  for (const m of ['download-start', 'download-success', 'download-failed']) assert.ok(src.includes(m), m);
});
