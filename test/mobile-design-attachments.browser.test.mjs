import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { createConsoleServer } from '../src/server.mjs';
import { createDeviceStore } from '../src/device-auth.mjs';
import { fakeHub, json, listen, close } from './helpers.mjs';

const skip = existsSync(chromium.executablePath()) ? false : '未安装 Playwright Chromium';

test('输入框添加文本与图片附件并随消息发送', { skip }, async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'mobile-attachments-ui-'));
  const rulesFile = path.join(root, 'rules.json'); writeFileSync(rulesFile, JSON.stringify({ sources: {}, agents: {}, rules: [] }));
  const calls = [];
  const record = { id: 's1', sessionId: 's1', kind: 'design', title: '附件验收', project: '/work/移动控制台', status: 'idle', statusText: '待命', agent: 'Codex', model: 'GPT', prompt: '分析附件', messages: [], queue: [], queued: [], queuedCount: 0, liveText: '', busy: false, createdAt: '2026-11-22T09:00:00Z', updatedAt: '2026-11-22T09:00:00Z' };
  const sessions = { async list() { return [record]; }, async listArchived() { return []; }, async send(id, text, opts) { calls.push({ id, text, opts }); return record; } };
  const hub = await fakeHub((req,res) => json(res, req.url === '/v1/state' ? { runs: [], cards: [], lines: [], spending: {} } : { ok: true }));
  const deviceAuth = createDeviceStore({ file:path.join(root,'device-auth.json') });
  const server = createConsoleServer({ hubUrl:hub.url, ownerKey:'secret', host:'127.0.0.1', root, rulesFile, deviceAuth, projectRoots:[] }, sessions);
  const url = await listen(server);
  const browser = await chromium.launch({headless:true});
  t.after(async () => { await browser.close(); await close(server); await close(hub.server); rmSync(root,{recursive:true,force:true}); });
  const page = await browser.newPage({viewport:{width:390,height:844}});
  await page.addInitScript(() => { let stored=null; window.AutoloopSecureStorage={async get(){return stored;},async set(v){stored=v;},async remove(){stored=null;}}; window.AutoloopBiometric={async verify(){return true;}}; });
  await page.goto(`${url}/mobile/`);
  await page.locator('#bind-payload').fill(deviceAuth.createBinding().qrPayload);
  await page.locator('#bind-submit').click();
  await page.locator('#unlock').click();
  await page.locator('[data-tab="sessions"]').click();
  await page.locator('.sessions-item').click();
  await page.locator('.sessions-composer-input').fill('请分析两个附件');
  await page.locator('.sessions-attachment-input').setInputFiles([
    { name: '说明.md', mimeType: 'text/markdown', buffer: Buffer.from('附件正文') },
    { name: '截图.png', mimeType: 'image/png', buffer: Buffer.from([1, 2, 3]) },
  ]);
  await page.waitForFunction(() => document.querySelectorAll('.sessions-attachment-chip').length === 2);
  assert.equal(await page.locator('.sessions-attachment-chip').count(), 2);
  await page.locator('.sessions-send').click();
  await page.waitForFunction(() => document.querySelectorAll('.sessions-attachment-chip').length === 0);
  assert.equal(calls.length, 1);
  const attachments = calls[0].opts.attachments;
  assert.equal(attachments.length, 2);
  assert.equal(attachments[0].name, '说明.md');
  assert.equal(Buffer.from(attachments[0].dataBase64, 'base64').toString(), '附件正文');
  assert.equal(attachments[1].name, '截图.png');
  assert.equal(attachments[1].type, 'image/png');
});

// 回归：附件「+」不得独占一行。真机反馈（2026-11-23）：窄屏下 + 按钮被挤到单独一行，
// 挤占输入宽度；+ 必须与输入框、发送键在同一行（DOM 上紧邻发送键之前）。
test('附件「+」与发送键同处输入栏一行，窄屏不独占行', { skip }, async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'mobile-attach-layout-'));
  const rulesFile = path.join(root, 'rules.json'); writeFileSync(rulesFile, JSON.stringify({ sources: {}, agents: {}, rules: [] }));
  const record = { id: 's1', sessionId: 's1', kind: 'normal', title: '布局验收', project: '/work/移动控制台', status: 'idle', statusText: '待命', agent: 'Codex', model: 'GPT', prompt: 'x', messages: [], queue: [], queued: [], queuedCount: 0, liveText: '', busy: false, createdAt: '2026-11-22T09:00:00Z', updatedAt: '2026-11-22T09:00:00Z' };
  const sessions = { async list() { return [record]; }, async listArchived() { return []; }, async send() { return record; } };
  const hub = await fakeHub((req, res) => json(res, req.url === '/v1/state' ? { runs: [], cards: [], lines: [], spending: {} } : { ok: true }));
  const deviceAuth = createDeviceStore({ file: path.join(root, 'device-auth.json') });
  const server = createConsoleServer({ hubUrl: hub.url, ownerKey: 'secret', host: '127.0.0.1', root, rulesFile, deviceAuth, projectRoots: [] }, sessions);
  const url = await listen(server);
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await close(server); await close(hub.server); rmSync(root, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 320, height: 700 } });
  await page.addInitScript(() => { let stored = null; window.AutoloopSecureStorage = { async get() { return stored; }, async set(v) { stored = v; }, async remove() { stored = null; } }; window.AutoloopBiometric = { async verify() { return true; } }; });
  await page.goto(`${url}/mobile/`);
  await page.locator('#bind-payload').fill(deviceAuth.createBinding().qrPayload);
  await page.locator('#bind-submit').click();
  await page.locator('#unlock').click();
  await page.locator('[data-tab="sessions"]').click();
  await page.locator('.sessions-item').click();
  const layout = await page.evaluate(() => {
    const composer = document.querySelector('.sessions-composer');
    const attach = composer.querySelector('.sessions-attach-btn');
    const send = composer.querySelector('.sessions-send');
    const input = composer.querySelector('.sessions-composer-input');
    const kids = [...composer.children].filter(el => !el.hidden);
    return {
      // 输入栏 align-items:flex-end：同行元素底边对齐、顶边因高度不同而不同，必须按底边判行。
      // composer-ux：输入框独占上一行，+ 与发送在下方独立工具行（同一行、位于输入框下方）。
      rows: new Set([attach, send].map(el => Math.round(el.getBoundingClientRect().bottom))).size,
      belowInput: attach.getBoundingClientRect().top >= input.getBoundingClientRect().bottom - 1,
      attachIndex: [...attach.parentElement.children].indexOf(attach),
      sendIndex: [...send.parentElement.children].indexOf(send),
      inputIndex: -1,
      attachVisible: !!attach.offsetParent,
      kidCount: kids.length,
    };
  });
  assert.ok(layout.attachVisible, '+ 按钮必须可见');
  assert.equal(layout.rows, 1, `+、发送必须在同一工具行（实测 ${layout.rows} 行）`);
  assert.ok(layout.belowInput, '工具行位于输入框下方');
  assert.ok(layout.attachIndex < layout.sendIndex, '+ 在工具行内位于发送键之前');
});
