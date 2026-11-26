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
      client: {
        sessionPreviewTicket: () => Promise.resolve({ ticket: 't1', url: '/mobile/preview?ticket=t1' }),
        sessionArtifactFile: () => Promise.resolve(JSON.parse(fileJson)),
      },
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

test('md 产物点「在线预览」：真实 Chromium 中走只读文件路由，纯文本可读、不解析 HTML', { skip }, async t => {
  const page = await boot(t, {
    artifacts: [{ id: 's1:docs/plan.md', name: 'plan.md', path: 'docs/plan.md', sessionId: 's1', taskLabel: '核心任务', sizeText: '1KB', kindLabel: 'MD' }],
    artifactFile: { name: 'plan.md', path: 'docs/plan.md', content: '# 在线可读\n<b data-x="1">按纯文本显示</b>' },
  });
  await page.evaluate(() => {
    window.AutoloopConsoleBase = 'https://auto.example';
    window.__mod.mount(window.__ctx, { feature: window.__F });
  });
  await page.waitForSelector('.artifacts-row');
  await page.locator('.artifacts-row').click();
  const preview = page.locator('.artifacts-preview-toggle');
  assert.match(await preview.innerText(), /在线预览/);
  await preview.click();
  await page.waitForFunction(() => {
    const node = document.querySelector('.artifacts-preview-text');
    return node && !node.closest('.artifacts-preview').hidden && /在线可读/.test(node.textContent);
  }, null, { timeout: 3000 });
  const text = await page.locator('.artifacts-preview-text').innerText();
  assert.ok(text.includes('<b data-x="1">按纯文本显示</b>'), '不可信内容按纯文本显示，不拼接 HTML');
  assert.equal(await page.locator('.artifacts-preview-frame').count(), 0, 'md 不走 HTML iframe');
  assert.equal(await page.evaluate(() => document.querySelectorAll('b[data-x]').length), 0, '不解析为元素');
  assert.match(await page.locator('.artifacts-download').innerText(), /下载 plan\.md/, '下载按钮保留');
});

test('md 长行预览在 390px 手机上换行、限高可滚动（审阅返工 P2 真机样式回归）', { skip }, async t => {
  const page = await boot(t, {
    artifacts: [{ id: 's1:docs/long.md', name: 'long.md', path: 'docs/long.md', sessionId: 's1', taskLabel: '核心任务', sizeText: '4KB', kindLabel: 'MD' }],
    artifactFile: { name: 'long.md', path: 'docs/long.md', content: `# 长行\n${'A'.repeat(4000)}\n结尾` },
  });
  await page.evaluate(() => {
    window.AutoloopConsoleBase = 'https://auto.example';
    window.__mod.mount(window.__ctx, { feature: window.__F });
  });
  await page.waitForSelector('.artifacts-row');
  await page.locator('.artifacts-row').click();
  await page.locator('.artifacts-preview-toggle').click();
  await page.waitForFunction(() => {
    const node = document.querySelector('.artifacts-preview-text');
    return node && !node.closest('.artifacts-preview').hidden && node.textContent.includes('长行');
  }, null, { timeout: 3000 });
  const layout = await page.evaluate(() => {
    const node = document.querySelector('.artifacts-preview-text');
    const cs = getComputedStyle(node);
    return {
      whiteSpace: cs.whiteSpace,
      overflowWrap: cs.overflowWrap || cs.wordWrap,
      overflowY: cs.overflowY,
      maxHeight: cs.maxHeight,
      scrollWidth: node.scrollWidth,
      clientWidth: node.clientWidth,
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
    };
  });
  assert.equal(layout.whiteSpace, 'pre-wrap', '长行换行，不靠横向滚动才能读全');
  assert.equal(layout.overflowWrap, 'anywhere', '超长不可断词也能断行');
  assert.equal(layout.overflowY, 'auto', '超限时纵向滚动');
  assert.notEqual(layout.maxHeight, 'none', '正文限高，不把阅读页撑到无限长');
  assert.ok(layout.scrollWidth <= layout.clientWidth + 1, `4000 字符长行不横向溢出（${layout.scrollWidth} > ${layout.clientWidth}）`);
  assert.ok(layout.scrollHeight > layout.clientHeight, '长文可纵向滚动读完');
});

test('pdf/word 产物在真实 Chromium 中如实提示暂不支持，保留下载', { skip }, async t => {
  const page = await boot(t, {
    artifacts: [{ id: 's1:out/手册.pdf', name: '手册.pdf', path: 'out/手册.pdf', sessionId: 's1', taskLabel: '核心任务', sizeText: '2KB', kindLabel: 'PDF' }],
    artifactFile: {},
  });
  await page.evaluate(() => {
    window.AutoloopConsoleBase = 'https://auto.example';
    window.__mod.mount(window.__ctx, { feature: window.__F });
  });
  await page.waitForSelector('.artifacts-row');
  await page.locator('.artifacts-row').click();
  assert.match(await page.locator('.artifacts-reader').innerText(), /暂不支持在线预览，请下载后查看/);
  assert.equal(await page.locator('.artifacts-preview-toggle').count(), 0, '不支持格式不给在线预览按钮');
  assert.match(await page.locator('.artifacts-download').innerText(), /下载 手册\.pdf/);
});

test('pages/artifacts.mjs 含三态字面量标记（设计 verifier 依赖）', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../mobile/app/www/pages/artifacts.mjs', import.meta.url), 'utf8');
  for (const m of ['download-start', 'download-success', 'download-failed']) assert.ok(src.includes(m), m);
});
