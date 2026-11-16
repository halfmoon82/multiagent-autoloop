// 本地设计稿渲染与交互验收：使用临时浏览器 profile，不连接真实控制台或 Hub。
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { readFileSync } from 'node:fs';

const require = createRequire('/Volumes/Storage/auto调度/package.json');
const { chromium } = require('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'renders');
mkdirSync(out, { recursive: true });
const profile = mkdtempSync(path.join(tmpdir(), 'autoloop-dag-design-'));
const browser = await chromium.launchPersistentContext(profile, {
  headless: true,
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const assets = new Map([
  ['/prototype.html', ['text/html; charset=utf-8', readFileSync(path.join(here, 'prototype.html'))]],
  ['/prototype.css', ['text/css; charset=utf-8', readFileSync(path.join(here, 'prototype.css'))]],
  ['/prototype.mjs', ['text/javascript; charset=utf-8', readFileSync(path.join(here, 'prototype.mjs'))]],
]);
const server = http.createServer((req, res) => {
  const asset = assets.get(new URL(req.url, 'http://localhost').pathname);
  if (!asset) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': asset[0] }); res.end(asset[1]);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/prototype.html`;
const screens = ['overview', 'design', 'dag', 'preflight', 'authorize'];
const sizes = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } };
let assertions = 0;
const assert = (condition, message) => { assertions++; if (!condition) throw new Error(message); };

try {
  for (const [device, viewport] of Object.entries(sizes)) {
    await page.setViewportSize(viewport);
    for (const screen of screens) {
      await page.goto(`${base}?screen=${screen}`, { waitUntil: 'load' });
      await page.locator(`#screen-${screen}`).waitFor({ state: 'visible' });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      assert(!overflow, `${device}/${screen} 出现页面级横向溢出`);
      await page.screenshot({ path: path.join(out, `${screen}-${device}.png`), fullPage: false });
      if (screen === 'overview') {
        assert((await page.locator('.project-usage').first().textContent()).includes('累计 Token'), `${device} 总览缺少项目费用/Token`);
        assert(await page.locator('.progress-node .node-task-summary').count() >= 10, `${device} 总览节点缺少任务摘要`);
        assert(await page.locator('.progress-node .node-agent').count() >= 10, `${device} 总览节点缺少 Agent/模型`);
      }
      if (screen === 'dag') {
        assert(await page.locator('.dag-node .node-task-summary').count() === 8, `${device} 运行详情节点缺少任务摘要`);
        assert(await page.locator('.dag-node .node-agent').count() === 8, `${device} 运行详情节点缺少 Agent/模型`);
        await page.locator('[data-action="toggle-run-history"]').click();
        assert((await page.locator('#run-history-list').textContent()).includes('费用 $4.28 · Token 182K'), `${device} 历史 DAG 未直接显示费用/Token`);
        await page.screenshot({ path: path.join(out, `dag-history-${device}.png`), fullPage: false });
        await page.locator('[data-action="toggle-run-history"]').click();
      }
    }
    await page.goto(`${base}?screen=design&newSession=1`, { waitUntil: 'load' });
    await page.locator('#new-session-request').fill('设计一个多租户计费方案，并拆解为可并行执行的 DAG');
    await page.locator('#new-session-dialog').waitFor({ state: 'visible' });
    assert((await page.locator('#classification-title').textContent()).includes('设计会话'), `${device} 复杂需求未识别为设计会话`);
    await page.screenshot({ path: path.join(out, `session-new-${device}.png`), fullPage: false });
  }

  await page.setViewportSize(sizes.desktop);
  await page.goto(`${base}?screen=design`, { waitUntil: 'load' });
  await page.locator('[data-screen="authorize"]').first().click();
  assert(await page.locator('#screen-authorize').isVisible(), 'Spec/DAG 确认入口未进入授权页');
  assert(await page.locator('#authorize-button').isDisabled(), '未阅读确认前授权按钮应禁用');
  await page.locator('#authorize-check').check();
  assert(await page.locator('#authorize-button').isEnabled(), '勾选阅读确认后授权按钮应启用');
  await page.locator('#authorize-button').click();
  await page.waitForTimeout(650);
  assert(await page.locator('#screen-dag').isVisible(), '授权后应进入 DAG 运行详情');

  await page.locator('[data-node="api"]').click();
  assert((await page.locator('#node-detail h3').textContent()) === '账单 API', '节点选择未更新详情');
  assert((await page.locator('#detail-agent').textContent()) === 'Claude', '节点详情未更新执行 Agent');
  assert((await page.locator('#detail-model').textContent()) === 'Sonnet 5.5', '节点详情未更新模型');

  for (const state of ['empty', 'loading', 'error', 'blocked']) {
    await page.locator('#state-select').selectOption(state);
    assert(await page.locator('#state-banner').isVisible(), `${state} 状态未展示`);
    assert((await page.locator('#state-banner').textContent()).length > 10, `${state} 状态说明为空`);
  }
  await page.locator('#state-select').selectOption('normal');
  assert(await page.locator('#state-banner').isHidden(), '正常状态不应展示状态横幅');

  await page.goto(`${base}?screen=preflight`, { waitUntil: 'load' });
  await page.locator('[data-action="attest-help"]').click();
  assert(await page.locator('#toast').isVisible(), '能力记录修复说明未显示');
  await page.goto(`${base}?screen=design`, { waitUntil: 'load' });
  await page.locator('.session-kind-tabs [data-kind="normal"]').click();
  assert((await page.locator('#session-title').textContent()) === '账单 API 依赖分析', '普通会话子 tab 未显示普通会话');
  assert((await page.locator('#session-access').textContent()).includes('无附加提示词'), '普通会话不应组装额外提示词');
  await page.locator('.session-kind-tabs [data-kind="scheduling"]').click();
  assert((await page.locator('#session-title').textContent()) === 'V6 调度与恢复', '原调度会话未保留');
  await page.locator('.session-item:not([hidden]) [data-action="collapse"]').first().click();
  assert((await page.locator('.session-item:not([hidden])').first().getAttribute('class')).includes('collapsed'), '会话折叠无效');
  await page.locator('.session-item:not([hidden]) [data-action="delete"]').first().click();
  assert(await page.locator('#delete-session-dialog').isVisible(), '删除会话未出现二次确认');
  await page.locator('[data-action="cancel-delete"]').click();
  await page.locator('#screen-design .page-heading [data-action="new-session"]').click();
  await page.locator('#new-session-request').fill('分析一下账单 API 的依赖关系');
  assert((await page.locator('#classification-title').textContent()).includes('普通会话'), '普通分析未识别为普通会话');
  await page.locator('#new-session-request').fill('排查失败任务并恢复调度规则');
  assert((await page.locator('#classification-title').textContent()).includes('调度会话'), '调度诊断未识别为调度会话');
  await page.locator('[data-type-override="design"]').click();
  assert((await page.locator('#classification-title').textContent()).includes('手动指定'), '手动覆盖会话类型无效');
  await page.locator('[data-action="close-new-session"]').first().click();
  await page.goto(`${base}?screen=overview`, { waitUntil: 'load' });
  await page.locator('#screen-overview .page-heading [data-action="new-session"]').click();
  assert(await page.locator('#screen-design').isVisible(), '总览新建会话入口不可达');
  assert(await page.locator('#new-session-dialog').isVisible(), '新建会话对话框未打开');
  assert(errors.length === 0, `浏览器脚本错误：${errors.join('; ')}`);
  console.log(JSON.stringify({ status: 'ok', screenshots: screens.length * 2 + 4, assertions, browserErrors: errors.length, out }, null, 2));
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  rmSync(profile, { recursive: true, force: true });
}
