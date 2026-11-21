// session-inputs 节点边界测试：输入框自动长高、控制台转写降级链、悬浮底部输入栏结构。
// 纯逻辑部分在 Node 内验证；浏览器回归用假 Hub + 临时 profile，不调用真实模型。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createConsoleServer } from '../src/server.mjs';
import { createDeviceStore } from '../src/device-auth.mjs';
import { fakeHub, json, listen, close } from './helpers.mjs';
import {
  computeAutogrow, canSend, AUTOGROW_MIN_ROWS, AUTOGROW_MAX_ROWS, AUTOGROW_MAX_VIEWPORT_RATIO,
} from '../mobile/src/features/composer-autogrow/index.mjs';
import {
  createVoiceInput, startVoice, commitVoice, failVoice,
  classifyTranscribeStatus, resolveVoiceProvider, transcribeBlob, createRecorder,
  TranscribeUnavailableError, TranscribeRejectedError, TRANSCRIBE_PATH,
} from '../mobile/src/features/voice-input/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => readFileSync(path.join(ROOT, rel), 'utf8');
const LINE = 24;

// ---------- 自动长高：行数边界 ----------

test('auto-grow：空内容/一行内容保持最少 2 行', () => {
  assert.equal(AUTOGROW_MIN_ROWS, 2);
  assert.equal(AUTOGROW_MAX_ROWS, 5);
  assert.equal(AUTOGROW_MAX_VIEWPORT_RATIO, 0.38);
  for (const contentHeight of [0, LINE, 2 * LINE]) {
    const r = computeAutogrow({ contentHeight, lineHeight: LINE });
    assert.equal(r.rows, 2); assert.equal(r.height, 2 * LINE); assert.equal(r.overflow, false);
  }
});

test('auto-grow：随内容长高，到 5 行封顶，超出后内部滚动', () => {
  assert.equal(computeAutogrow({ contentHeight: 3 * LINE, lineHeight: LINE }).rows, 3);
  assert.equal(computeAutogrow({ contentHeight: 5 * LINE, lineHeight: LINE }).overflow, false);
  const over = computeAutogrow({ contentHeight: 9 * LINE, lineHeight: LINE });
  assert.equal(over.rows, 5); assert.equal(over.height, 5 * LINE); assert.equal(over.overflow, true);
});

test('auto-grow：内边距计入，且受主区 38% 上限约束但不低于最少行数', () => {
  const padded = computeAutogrow({ contentHeight: 100, lineHeight: LINE, extraY: 20 });
  assert.equal(padded.height, 100); assert.equal(padded.rows, 3);
  const small = computeAutogrow({ contentHeight: 400, lineHeight: LINE, mainHeight: 250 }); // 38% = 95 < 5 行(120)
  assert.equal(small.height, 95); assert.equal(small.overflow, true);
  const tiny = computeAutogrow({ contentHeight: 400, lineHeight: LINE, mainHeight: 100 }); // 38% = 38 < 最少 2 行
  assert.equal(tiny.height, 2 * LINE, '小屏也保证最少 2 行');
  assert.equal(computeAutogrow({ contentHeight: NaN, lineHeight: 0 }).rows, 2, '异常输入回退默认行高');
});

test('auto-grow：发送后回弹到最少行数；空内容禁用发送', () => {
  const grown = computeAutogrow({ contentHeight: 4 * LINE, lineHeight: LINE });
  assert.equal(grown.rows, 4);
  assert.equal(computeAutogrow({ contentHeight: 0, lineHeight: LINE }).rows, 2, '清空后量到的内容高度为 0 即回弹');
  assert.equal(canSend(''), false); assert.equal(canSend('  \n\t'), false);
  assert.equal(canSend(null), false); assert.equal(canSend('好'), true);
});

// ---------- 控制台转写：状态分类与降级链 ----------

test('transcribe 状态分类：2xx 成功，404/501/502/503/504 降级，其余拒绝', () => {
  assert.equal(classifyTranscribeStatus(200), 'ok');
  for (const status of [404, 501, 502, 503, 504]) assert.equal(classifyTranscribeStatus(status), 'fallback');
  for (const status of [400, 401, 413, 415, 429, 500]) assert.equal(classifyTranscribeStatus(status), 'rejected');
});

test('提供者选择：控制台优先，其次原生，双不可用为 none（隐藏麦克风）', () => {
  assert.equal(resolveVoiceProvider({ consoleAvailable: true, nativeAvailable: true }), 'console');
  assert.equal(resolveVoiceProvider({ consoleAvailable: false, nativeAvailable: true }), 'native');
  assert.equal(resolveVoiceProvider({ consoleAvailable: false, nativeAvailable: false }), 'none');
  assert.equal(resolveVoiceProvider(), 'none');
});

const fakeResponse = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const upload = (fetchImpl, extra = {}) => transcribeBlob({ origin: 'https://console.example', token: 'tok', blob: new Blob(['x']), fetchImpl, ...extra });

test('transcribe 成功分支：POST 到端点、带设备令牌，返回文本并可落草稿（不发送）', async () => {
  let seen;
  const text = await upload(async (url, init) => { seen = { url, init }; return fakeResponse(200, { text: ' 你好世界 ' }); });
  assert.equal(text, '你好世界');
  assert.equal(seen.url, `https://console.example${TRANSCRIBE_PATH}`);
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers['x-device-token'], 'tok');
  assert.equal(seen.init.headers['content-type'], 'audio/webm');
  const done = commitVoice(startVoice(createVoiceInput({ draft: '原稿' })), text);
  assert.equal(done.draft, '原稿 你好世界'); assert.equal(done.sent, 0);
});

test('transcribe 503/网络失败 → 抛出可降级错误；429/413 → 拒绝不降级且保留草稿', async () => {
  await assert.rejects(upload(async () => fakeResponse(503, { error: 'x' })), error => error instanceof TranscribeUnavailableError && error.fallback === true);
  await assert.rejects(upload(async () => { throw new TypeError('network'); }), error => error instanceof TranscribeUnavailableError);
  await assert.rejects(upload(async () => fakeResponse(429, { error: '请稍后再试' })), error => error instanceof TranscribeRejectedError && error.fallback === false && /稍后/.test(error.message));
  await assert.rejects(upload(async () => fakeResponse(413, {})), TranscribeRejectedError);
  const listening = startVoice(createVoiceInput({ draft: '草稿' }));
  const failed = failVoice(listening, '转写失败');
  assert.equal(failed.draft, '草稿', '失败时草稿保留');
});

test('transcribe 未绑定设备令牌直接拒绝，不发请求', async () => {
  let called = false;
  await assert.rejects(transcribeBlob({ origin: 'https://console.example', token: '', blob: new Blob(['x']), fetchImpl: async () => { called = true; } }), TranscribeRejectedError);
  assert.equal(called, false);
});

test('录音器：无录音能力/权限拒绝 → 可降级；正常录音返回 webm Blob 并释放麦克风', async () => {
  await assert.rejects(createRecorder({}).start(), TranscribeUnavailableError);
  const denied = createRecorder({ mediaDevices: { getUserMedia: async () => { throw new Error('NotAllowedError'); } }, MediaRecorderCtor: function Fake() {} });
  await assert.rejects(denied.start(), TranscribeUnavailableError);

  let stopped = 0;
  const stream = { getTracks: () => [{ stop: () => { stopped += 1; } }] };
  class FakeRecorder {
    start() { this.ondataavailable({ data: new Blob(['abc']) }); }
    stop() { this.onstop(); }
  }
  const recorder = createRecorder({ mediaDevices: { getUserMedia: async () => stream }, MediaRecorderCtor: FakeRecorder });
  await recorder.start();
  assert.equal(recorder.recording, true);
  const blob = await recorder.stop();
  assert.equal(blob.type, 'audio/webm'); assert.equal(blob.size, 3);
  assert.equal(stopped, 1); assert.equal(recorder.recording, false);
});

// ---------- 结构断言：悬浮底部 / 16px / 无手动 resize / 新建表单麦克风 ----------

test('composer 悬浮布局 CSS：详情为 flex 列，消息窗唯一滚动，输入栏 flex:none', () => {
  const css = read('mobile/app/www/pages/sessions.css');
  assert.match(css, /\[data-view="detail"\]:not\(\[hidden\]\)\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column/);
  assert.match(css, /\.sessions-message-window\s*\{[^}]*flex:\s*1 1 auto;[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto/);
  assert.match(css, /\.sessions-composer\s*\{[^}]*flex:\s*none/);
  assert.doesNotMatch(css, /resize:\s*vertical/, '移除手动 resize');
  assert.match(css, /resize:\s*none/);
  assert.match(css, /font-size:\s*16px/, '16px 防聚焦缩放');
});

test('页面接线：三处输入框接入 auto-grow，新建表单有麦克风，语音落草稿派发 input', () => {
  const page = read('mobile/app/www/pages/sessions.mjs');
  assert.match(page, /growLater\(composerInput\)/);
  assert.match(page, /growLater\(newPrompt\)/);
  assert.match(page, /grow\(input\);/, '待回答输入也接入');
  assert.match(page, /sessions-new-mic/);
  assert.match(page, /attachVoice\?\.\(newPrompt\)/);
  assert.match(page, /visualViewport/);
  const voice = read('mobile/app/www/pages/voice.mjs');
  assert.match(voice, /notifyInput\(el\)/);
  assert.match(voice, /autoloop:voice-unavailable/);
});

// ---------- 浏览器回归（假 Hub；无 Chromium 时显式跳过） ----------

const browserSkip = (() => {
  try { return existsSync(chromium.executablePath()) ? false : 'npm test 阶段未安装 Playwright Chromium，跳过浏览器回归'; }
  catch { return '无法探测 Playwright Chromium，跳过浏览器回归'; }
})();

async function openSessionsNewForm(t, { initScript } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'mobile-inputs-'));
  const hub = await fakeHub((req, res) => json(res, req.url === '/v1/state' ? { runs: [], cards: [], lines: [], spending: {} } : { ok: true }));
  const deviceAuth = createDeviceStore({ file: path.join(root, 'device-auth.json') });
  const server = createConsoleServer({ hubUrl: hub.url, ownerKey: 'server-secret', host: '127.0.0.1', root, deviceAuth, projectRoots: [root] });
  const url = await listen(server);
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await close(server); await close(hub.server); rmSync(root, { recursive: true, force: true }); });
  const page = await (await browser.newContext({ viewport: { width: 390, height: 800 } })).newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => {
    let stored = null;
    window.AutoloopSecureStorage = { async get() { return stored; }, async set(value) { stored = value; }, async remove() { stored = null; } };
    window.AutoloopBiometric = { async verify() { return true; } };
  });
  if (initScript) await page.addInitScript(initScript);
  await page.goto(`${url}/mobile/`);
  await page.waitForFunction(() => Boolean(window.AutoloopHooks));
  await page.locator('#bind-payload').fill(deviceAuth.createBinding().qrPayload);
  await page.locator('#bind-submit').click();
  await page.waitForFunction(() => document.getElementById('bind-status')?.textContent?.includes('绑定成功'));
  await page.locator('#unlock').click();
  await page.locator('#app-main').waitFor({ state: 'visible' });
  await page.locator('[data-tab="sessions"]').click();
  await page.locator('.sessions-new-btn').click();
  await page.locator('.sessions-new-prompt').waitFor({ state: 'visible' });
  return { page, pageErrors };
}

test('浏览器：新建会话输入框随多行长高、封顶后内部滚动、清空回弹，且无手动 resize', { skip: browserSkip }, async t => {
  const { page, pageErrors } = await openSessionsNewForm(t);
  // atomic-ok 不适用：以下均为单个 page.evaluate 内完成的定位+读写
  const measure = () => page.evaluate(() => {
    const el = document.querySelector('.sessions-new-prompt');
    const cs = getComputedStyle(el);
    return { h: el.getBoundingClientRect().height, overflowY: cs.overflowY, resize: cs.resize, fontSize: cs.fontSize };
  });
  const type = text => page.evaluate(value => {
    const el = document.querySelector('.sessions-new-prompt');
    el.value = value; el.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);

  await type('');
  const min = await measure();
  assert.equal(min.resize, 'none'); assert.equal(min.fontSize, '16px'); assert.equal(min.overflowY, 'hidden');
  await type('一\n二\n三');
  const three = await measure();
  assert.ok(three.h > min.h, `3 行应高于最少 2 行：${three.h} vs ${min.h}`);
  await type(Array.from({ length: 30 }, (_, i) => `第${i}行`).join('\n'));
  const capped = await measure();
  assert.equal(capped.overflowY, 'auto', '封顶后内部滚动');
  assert.ok(capped.h <= 800 * 0.38 + 1, `不超过主区 38%：${capped.h}`);
  await type('');
  const back = await measure();
  assert.equal(back.h, min.h, '清空后回弹到最少行数');
  assert.deepEqual(pageErrors, []);
});

test('浏览器：麦克风——无任何提供者时隐藏；有原生识别器时新建表单也显示', { skip: browserSkip }, async t => {
  const none = await openSessionsNewForm(t, { initScript: () => { window.MediaRecorder = undefined; } }); // 无录音能力 + 无原生识别器
  assert.equal(await none.page.evaluate(() => document.querySelector('.sessions-new-mic').hidden), true);
  assert.deepEqual(none.pageErrors, []);

  const withNative = await openSessionsNewForm(t, {
    initScript: () => {
      window.MediaRecorder = undefined;
      window.AutoloopSpeech = {
        async isAvailable() { return true; }, async start() { return true; }, stop() {},
        onPartial() {}, onFinal() {}, onError() {},
      };
    },
  });
  await withNative.page.waitForFunction(() => document.querySelector('.sessions-new-mic') && !document.querySelector('.sessions-new-mic').hidden);
  assert.deepEqual(withNative.pageErrors, []);
});

test('浏览器：会话详情输入栏常驻底部——消息窗内部滚动、输入栏不动；多行输入长高且发送键随内容启停', { skip: browserSkip }, async t => {
  const { page, pageErrors } = await (async () => {
    const opened = await openSessionsNewForm(t);
    return opened;
  })();
  const sessions = [{
    id: 's1', title: '悬浮测试会话', project: '/work/p', status: 'running', kind: 'normal',
    messages: Array.from({ length: 60 }, (_, i) => ({ role: i % 2 ? 'user' : 'assistant', text: `第 ${i} 条消息，用来撑满消息窗`, at: '' })),
  }];
  await page.route('**/api/mobile/api/sessions', route => route.fulfill({ json: { sessions } }));
  await page.locator('.sessions-back').last().click(); // 回列表
  await page.evaluate(() => window.dispatchEvent(new Event('online'))); // 触发重新读取
  await page.locator('.sessions-item').first().waitFor({ state: 'visible' });
  await page.locator('.sessions-item').first().click();
  await page.locator('.sessions-composer-input').waitFor({ state: 'visible' });

  const geometry = () => page.evaluate(() => {
    const win = document.querySelector('.sessions-message-window');
    const composer = document.querySelector('.sessions-composer').getBoundingClientRect();
    const input = document.querySelector('.sessions-composer-input');
    const send = document.querySelector('.sessions-send');
    return {
      scrollable: win.scrollHeight > win.clientHeight, winOverflow: getComputedStyle(win).overflowY,
      composerBottom: Math.round(composer.bottom), composerTop: Math.round(composer.top), viewport: window.innerHeight,
      inputHeight: input.getBoundingClientRect().height, sendDisabled: send.disabled, pageScroll: window.scrollY,
    };
  });
  const before = await geometry();
  assert.equal(before.scrollable, true, '消息窗自身可滚动');
  assert.equal(before.winOverflow, 'auto');
  assert.ok(before.composerBottom <= before.viewport, `输入栏在视口内：${before.composerBottom}/${before.viewport}`);
  assert.equal(before.sendDisabled, true, '空内容禁用发送');

  await page.evaluate(() => { const win = document.querySelector('.sessions-message-window'); win.scrollTop = 0; });
  await page.mouse.wheel(0, 600);
  const after = await geometry();
  assert.equal(after.composerTop, before.composerTop, '消息流滚动时输入栏不动');
  assert.equal(after.pageScroll, 0, '页面本身不滚动');

  await page.evaluate(() => {
    const el = document.querySelector('.sessions-composer-input');
    el.value = '第一行\n第二行\n第三行\n第四行'; el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const typed = await geometry();
  assert.ok(typed.inputHeight > before.inputHeight, '多行输入长高');
  assert.equal(typed.sendDisabled, false, '有内容启用发送');
  assert.ok(typed.composerBottom <= typed.viewport, '长高后输入栏仍在视口内');
  assert.deepEqual(pageErrors, []);
});
