// 流式输出回归：运行中 liveText 气泡可见；轮次结束后最终消息必须留在转录里，不得被前端吞掉。
// 真机反馈（2026-11-25）：流式有，但「输出完之后马上会被前端给吞掉」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { createConsoleServer } from '../src/server.mjs';
import { createDeviceStore } from '../src/device-auth.mjs';
import { fakeHub, json, listen, close } from './helpers.mjs';

const browserSkip = (() => {
  try { return existsSyncGuard() ? false : 'npm test 阶段未安装 Playwright Chromium，跳过浏览器回归'; }
  catch { return '无法探测 Playwright Chromium，跳过浏览器回归'; }
  function existsSyncGuard() { return Boolean(chromium.executablePath()); }
})();

test('浏览器：流式气泡运行中可见，轮次结束后最终消息留在转录（不得吞掉）', { skip: browserSkip }, async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'stream-'));
  const hub = await fakeHub((req, res) => json(res, { runs: [], cards: [], lines: [], spending: {} }));
  const rulesFile = path.join(root, 'rules.json');
  writeFileSync(rulesFile, JSON.stringify({ sources: {}, agents: {}, rules: [] }));
  const deviceAuth = createDeviceStore({ file: path.join(root, 'device-auth.json') });
  const record = {
    id: 'sess-stream', kind: 'scheduling', project: '/work/x', cwd: root,
    status: 'running', liveText: '正在输出的第一段', activity: '思考', turnStartedAt: new Date().toISOString(),
    prompt: '看一下进度', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    messages: [{ role: 'user', text: '看一下进度', at: new Date().toISOString() }],
    queue: [],
  };
  const sessions = {
    async list() { return [snapshotRecord()]; },
    async listArchived() { return []; },
  };
  function snapshotRecord() {
    return { ...record, messages: record.messages.map(m => ({ ...m })) };
  }
  const server = createConsoleServer({
    hubUrl: hub.url, ownerKey: 'k', host: '127.0.0.1', root, rulesFile, deviceAuth, projectRoots: [root],
  }, sessions);
  const url = await listen(server);
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await close(server); await close(hub.server);
    rmSync(root, { recursive: true, force: true });
  });

  const qr = deviceAuth.createBinding();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', e => console.log('PAGE_ERROR', e.message));
  await page.addInitScript(() => {
    let stored = null;
    window.AutoloopSecureStorage = { async get() { return stored; }, async set(v) { stored = v; }, async remove() { stored = null; } };
    window.AutoloopBiometric = { async verify() { return true; } };
  });
  await page.goto(`${url}/mobile/`);
  await page.locator('#bind-payload').fill(qr.qrPayload);
  await page.locator('#bind-submit').click();
  await page.waitForFunction(() => document.getElementById('bind-status')?.textContent?.includes('绑定成功'));
  await page.locator('#unlock').click();
  await page.locator('#app-main').waitFor({ state: 'visible' });

  // 进会话页，点开目标会话详情
  await page.locator('[data-tab="sessions"]').click();
  await page.waitForFunction(() => document.querySelector('.sessions-item, [data-session-id], .session-row'), null, { timeout: 5000 }).catch(() => {});
  const opened = await page.evaluate(() => {
    // 经壳接缝打开详情：优先点列表行
    const row = document.querySelector('#page-sessions .sessions-item') || document.querySelector('#page-sessions button');
    if (row) { row.click(); return true; }
    return false;
  });
  assert.ok(opened, '应能点开会话详情');

  // 运行中：流式气泡可见
  await page.waitForFunction(() => document.querySelector('#page-sessions')?.innerText?.includes('正在输出的第一段'), null, { timeout: 6000 });

  // 阶段二：仍在等回复（running）但 liveText 暂时为空、最终消息还没进转录的间隙——
  // 防吞：此刻流式气泡必须留在界面上（旧实现会把它整体摘掉，已流出的文字蒸发）。
  record.liveText = '';
  record.activity = '';
  record.updatedAt = new Date().toISOString();
  await page.waitForTimeout(1500);
  const midState = await page.evaluate(() => document.querySelector('#page-sessions')?.innerText || '');
  assert.ok(midState.includes('正在输出的第一段'), '终态消息迟到一拍时，流式文本不得从界面消失（防吞）');

  // 阶段三：轮次落定——最终消息入转录、状态转 idle（与 ACP finish / Hub 对账终态同一形状），气泡被接住后离场。
  record.status = 'idle';
  record.turnStartedAt = null;
  record.messages.push({ role: 'agent', text: '最终完整回答：全部做完了', at: new Date().toISOString() });
  record.updatedAt = new Date().toISOString();

  await page.waitForFunction(() => {
    const text = document.querySelector('#page-sessions')?.innerText || '';
    return text.includes('最终完整回答：全部做完了');
  }, null, { timeout: 8000 });
  const finalState = await page.evaluate(() => document.querySelector('#page-sessions')?.innerText || '');
  assert.ok(!finalState.includes('正在输出的第一段'), '转录接住最终消息后，流式气泡应正常离场');
  const swallowed = await page.evaluate(() => {
    const text = document.querySelector('#page-sessions')?.innerText || '';
    return text.includes('正在输出的第一段') && !text.includes('最终完整回答');
  });
  assert.equal(swallowed, false, '轮次结束后最终消息必须留在转录，流式文本不得整体消失');

  // 阶段四（review P2-1）：打断/出错终态不推 agent 消息——气泡必须随终态离场，不得永久残留。
  record.status = 'idle';
  record.liveText = '';
  record.error = '被主人打断';
  record.turnStartedAt = null;
  record.updatedAt = new Date().toISOString();
  await page.waitForTimeout(1500);
  const afterInterrupt = await page.evaluate(() => document.querySelector('#page-sessions')?.innerText || '');
  assert.ok(!afterInterrupt.includes('正在输出的第一段'), '打断/出错终态不得残留流式气泡（否则下一轮还会拼到它尾巴上）');
});
