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

test('会话忙碌发送、打断 steer 与队列管理全链路', { skip }, async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'mobile-queue-ui-'));
  const rulesFile = path.join(root, 'rules.json');
  writeFileSync(rulesFile, JSON.stringify({ sources: {}, agents: {}, rules: [] }));
  const record = {
    id: 'busy-1', sessionId: 'busy-1', kind: 'design', title: '队列交互验收', project: '/work/移动控制台',
    status: 'running', statusText: '运行中', agent: 'Codex', model: 'GPT', prompt: '继续完成设计',
    messages: [{ role: 'agent', text: '正在执行当前轮。', at: '2026-11-22T09:00:00Z' }],
    queue: [{ id: 'q1', text: '请同步检查折叠屏', at: '' }, { id: 'q2', text: '字体跟随系统', at: '' }],
    queued: [], queuedCount: 2, liveText: '', busy: true, createdAt: '2026-11-22T09:00:00Z', updatedAt: '2026-11-22T09:00:00Z',
  };
  record.queued = record.queue;
  const calls = [];
  const sync = () => { record.queued = record.queue; record.queuedCount = record.queue.length; };
  const sessions = {
    async list() { return [record]; },
    async listArchived() { return []; },
    async send(id, text, opts) { calls.push(['send', id, text, opts]); if (!opts?.interrupt) { record.queue = [...record.queue, { id: `q${record.queue.length + 3}`, text, at: '' }]; sync(); } return record; },
    async updateQueued(id, itemId, text) { calls.push(['updateQueued', id, itemId, text]); record.queue = record.queue.map(item => item.id === itemId ? { ...item, text } : item); sync(); return record; },
    async moveQueued(id, itemId, direction) { calls.push(['moveQueued', id, itemId, direction]); const i = record.queue.findIndex(item => item.id === itemId); const j = direction === 'up' ? i - 1 : i + 1; if (i >= 0 && j >= 0 && j < record.queue.length) [record.queue[i], record.queue[j]] = [record.queue[j], record.queue[i]]; sync(); return record; },
    async steerQueued(id, itemId) { calls.push(['steerQueued', id, itemId]); record.queue = record.queue.filter(item => item.id !== itemId); sync(); return record; },
    async removeQueued(id, itemId) { calls.push(['removeQueued', id, itemId]); record.queue = record.queue.filter(item => item.id !== itemId); sync(); return record; },
    async clearQueued(id) { calls.push(['clearQueued', id]); record.queue = []; sync(); return record; },
  };
  const hub = await fakeHub((req,res) => json(res, req.url === '/v1/state' ? { runs: [], cards: [], lines: [], spending: {} } : { ok: true }));
  const deviceAuth = createDeviceStore({ file:path.join(root,'device-auth.json') });
  const server = createConsoleServer({ hubUrl:hub.url, ownerKey:'secret', host:'127.0.0.1', root, rulesFile, deviceAuth, projectRoots:[] }, sessions);
  const url = await listen(server);
  const browser = await chromium.launch({headless:true});
  t.after(async () => { await browser.close(); await close(server); await close(hub.server); rmSync(root,{recursive:true,force:true}); });
  const page = await browser.newPage({viewport:{width:390,height:844}});
  const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(() => { let stored=null; window.AutoloopSecureStorage={async get(){return stored;},async set(v){stored=v;},async remove(){stored=null;}}; window.AutoloopBiometric={async verify(){return true;}}; });
  await page.goto(`${url}/mobile/`);
  await page.locator('#bind-payload').fill(deviceAuth.createBinding().qrPayload);
  await page.locator('#bind-submit').click();
  await page.locator('#unlock').click();
  await page.locator('[data-tab="sessions"]').click();
  await page.locator('.sessions-item').click();
  await page.locator('.sessions-steer-btn').waitFor({state:'visible'});
  assert.match(await page.locator('.sessions-send-mode').innerText(), /默认排队/);
  const historyHeight = await page.evaluate(() => document.querySelector('.sessions-message-window').clientHeight);
  assert.ok(historyHeight >= 180, '历史区默认展开');

  await page.locator('.sessions-composer-input').fill('请立即处理这个问题');
  await page.locator('.sessions-steer-btn').click();
  await page.waitForFunction(() => document.querySelector('.sessions-composer-input').value === '');
  assert.deepEqual(calls.find(call => call[0] === 'send'), ['send', 'busy-1', '请立即处理这个问题', { interrupt: true }]);

  await page.locator('.sessions-composer-input').fill('忙完后接着处理');
  await page.locator('.sessions-send').click();
  await page.waitForFunction(() => document.querySelector('.sessions-queue-toggle').textContent.includes('3'));
  assert.deepEqual(calls.filter(call => call[0] === 'send').at(-1), ['send', 'busy-1', '忙完后接着处理', { interrupt: false }]);

  await page.locator('.sessions-queue-toggle').click();
  await page.locator('[data-queue-id="q2"] [aria-label="上移第 2 条"]').click();
  assert.ok(calls.some(call => call[0] === 'moveQueued' && call[1] === 'busy-1' && call[2] === 'q2' && call[3] === 'up'));
  const edit = page.locator('[data-queue-id="q1"] .sessions-queue-input');
  await edit.fill('修改后的排队消息');
  await edit.dispatchEvent('change');
  await page.waitForTimeout(100);
  assert.ok(calls.some(call => call[0] === 'updateQueued' && call[2] === 'q1' && call[3] === '修改后的排队消息'));
  await page.locator('[data-queue-id="q2"] .sessions-queue-steer').click();
  await page.waitForTimeout(100);
  assert.ok(calls.some(call => call[0] === 'steerQueued' && call[2] === 'q2'));
  await page.locator('.sessions-queue-clear').click();
  await page.waitForFunction(() => document.querySelector('.sessions-queue-toggle').textContent.includes('0'));
  assert.ok(calls.some(call => call[0] === 'clearQueued'));
  assert.deepEqual(errors, []);
});
