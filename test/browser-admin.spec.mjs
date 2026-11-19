// 管理后台 · 平台与模型 浏览器回归：临时运行目录 + 假 Hub + 临时浏览器 profile，不调用真实模型、不碰真实规则。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createConsoleServer } from '../src/server.mjs';
import { fakeHub, json, listen, close } from './helpers.mjs';

const root = mkdtempSync(path.join(tmpdir(), 'console-admin-data-'));
const repo = path.join(root, 'auto'); mkdirSync(path.join(repo, '.git'), { recursive: true });
const profile = mkdtempSync(path.join(tmpdir(), 'console-admin-profile-'));
const output = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rulesFile = path.join(root, 'rules.json');
const rawRules = {
  sources: { local: { name: '本机' } },
  agents: {
    workbuddy: { name: 'WorkBuddy AI', worker: 'w', use: 'acp', command: ['/bin/wb.sh', '--acp'], access: 'full' },
    claude: { name: 'Claude Code', worker: 'w', use: 'claude', access: 'full', model: 'claude-sonnet-5-5' },
    'codex-full': { name: 'Codex 可写调度', worker: 'w', use: 'codex', access: 'full' },
    gemini: { name: 'Gemini CLI', worker: 'w', use: 'gemini', access: 'full' },
  },
  rules: [
    { name: 'DAG自动开发', when: { source: 'local', types: ['dag.auto.dev'] }, to: 'workbuddy', cwd: repo, prompt: 'dev', parallel: 5, resume: false },
    { name: 'DAG自动审阅', when: { source: 'local', types: ['dag.auto.review'] }, to: 'claude', cwd: repo, prompt: 'review', resume: false },
    { name: '调度会话执行', when: { source: 'local', types: ['scheduling.message'] }, to: 'codex-full', cwd: repo, prompt: 's', resume: true },
  ],
  elsewhere: [],
};
writeFileSync(rulesFile, JSON.stringify(rawRules, null, 2));
const catalog = { acp: () => ['hy4flash-free', 'hy4std', 'deepseek-v4-pro'], codex: () => ['deepseek-v4.1-flash', 'kimi-for-coding', 'k3.1-pro'], claude: () => ['haiku', 'sonnet', 'opus'] };
const snapshot = { seq: 1, totals: { running: 0, queued: 0, retrying: 0, unknown: 0, doneToday: 0 }, spending: { today: { rounds: 0, tokens: 0, cost: 0, missingCost: 0 } }, cards: [], agents: [], channels: [], lines: [], runs: [], timers: [], hasMore: false };
const hub = await fakeHub((req, res) => json(res, req.url.startsWith('/v1/state') ? snapshot : {}));
const sessions = { async list() { return []; }, async listArchived() { return []; }, async restoreFromHub() {}, dispose() {} };
const consoleServer = createConsoleServer({ hubUrl: hub.url, ownerKey: 'not-returned', rulesFile, cliPath: '/nonexistent', root, projectRoots: [root], platformCatalog: catalog, platformCheck: async () => {} }, sessions);
const url = await listen(consoleServer);
let context;
try {
  context = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage(); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(url);
  await page.getByRole('button', { name: '管理后台', exact: true }).click();
  await page.getByRole('heading', { name: '管理后台' }).waitFor();
  await page.getByRole('heading', { name: '平台分档模型' }).waitFor();

  // 平台自动发现：四个 AI 执行者都在；读不到清单的 Gemini 改手填
  for (const name of ['WorkBuddy AI', 'Claude Code', 'Codex 可写调度', 'Gemini CLI']) await page.locator('tr[data-platform] .admin-name', { hasText: name }).first().waitFor();
  assert.equal(await page.locator('tr[data-platform="gemini"] input').count(), 3, 'Gemini 读不到模型清单 → 三档手填');
  // 首次进入：开关显示真实状态（关闭），表中预填建议值
  await page.locator('.pill.off', { hasText: '已关闭' }).waitFor();
  assert.equal(await page.getByLabel('WorkBuddy AI 便宜档').inputValue(), 'hy4flash-free');
  assert.equal(await page.getByLabel('Claude Code 高档').inputValue(), 'opus');
  assert.equal(await page.getByLabel('Codex 可写调度 中档').inputValue(), 'kimi-for-coding');
  assert.equal(await page.getByLabel('Claude Code 中档').inputValue(), 'claude-sonnet-5-5');
  assert.equal(await page.getByText('（不可用）').count(), 0, '预填值都必须是可选项');

  // 会话平台：WorkBuddy / Claude 显示未接入且不可选
  const designOptions = await page.getByLabel('设计会话平台').locator('option').evaluateAll(nodes => nodes.map(n => ({ text: n.textContent, disabled: n.disabled })));
  assert.ok(designOptions.some(o => o.text === 'WorkBuddy AI（未接入）' && o.disabled));
  assert.ok(designOptions.some(o => o.text === 'Codex 可写调度' && !o.disabled));

  // 打开开关 → 改调度会话档位 → 预览实时变化
  await page.getByRole('switch', { name: '按档位选模型' }).click();
  await page.locator('.pill.on', { hasText: '已开启' }).waitFor();
  await page.getByLabel('调度会话档位').selectOption('heavy');
  await page.locator('#admin-preview', { hasText: '调度会话 → Codex 可写调度 · k3.1-pro' }).waitFor();

  // 校验失败：Gemini 只填一档 → 服务端拒绝并在页面上说明，rules.json 不变
  await page.getByLabel('Gemini CLI 便宜档').fill('gemini-flash');
  await page.getByLabel('Gemini CLI 便宜档').press('Tab');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.locator('#admin-error', { hasText: '三档要么都填，要么都不填' }).waitFor();
  assert.deepEqual(JSON.parse(readFileSync(rulesFile, 'utf8')), rawRules);
  await page.getByLabel('Gemini CLI 便宜档').fill('');
  await page.getByLabel('Gemini CLI 便宜档').press('Tab');

  // 保存：生成分档执行者与规则、备份、最近保存信息
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText(/^最近保存：/).waitFor();
  const saved = JSON.parse(readFileSync(rulesFile, 'utf8'));
  assert.equal(saved.agents['claude-tier-heavy'].model, 'opus');
  assert.deepEqual(saved.agents['workbuddy-tier-light'].command, ['/bin/wb.sh', '--acp', '--model', 'hy4flash-free']);
  assert.equal(saved.rules.find(r => r.when.types?.includes('dag.auto.dev.light')).to, 'workbuddy-tier-light');
  assert.equal(saved.rules.find(r => r.when.types?.includes('scheduling.message')).to, 'codex-full-tier-heavy');
  assert.ok(readdirSync(root).some(f => /^rules\.json\.bak-.*platform-models$/.test(f)));
  // 已保存后，没配三档的 Gemini 标「新发现」
  await page.locator('tr[data-platform="gemini"] .pill', { hasText: '新发现' }).waitFor();
  await page.screenshot({ path: path.join(output, 'console-admin.png'), fullPage: true });

  // 关闭开关 → 生成物清掉，调度会话回到主平台
  await page.getByRole('switch', { name: '按档位选模型' }).click();
  await page.locator('#admin-preview', { hasText: '分档已关闭' }).waitFor();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.locator('.pill.off', { hasText: '已关闭' }).waitFor();
  await page.waitForFunction(() => document.querySelector('#admin-save')?.textContent === '保存');
  const off = JSON.parse(readFileSync(rulesFile, 'utf8'));
  assert.ok(!Object.keys(off.agents).some(id => /-tier-/.test(id)));
  assert.equal(off.rules.find(r => r.when.types?.includes('scheduling.message')).to, 'codex-full');

  // 窄屏不横向溢出
  await page.setViewportSize({ width: 390, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, '窄屏不得横向溢出（表格自身可横滚）');
  const expected400 = errors.filter(text => /status of 400/.test(text));
  assert.equal(expected400.length, 1, '只有故意触发的那次校验失败返回 400');
  assert.deepEqual(errors.filter(text => !/status of 400/.test(text)), []);
  console.log('PASS browser-admin: platform discovery, prefill, session platform gating, preview, validation error, save, disable, narrow layout');
} finally {
  if (context) await context.close(); await close(consoleServer); await close(hub.server); rmSync(root, { recursive: true, force: true }); rmSync(profile, { recursive: true, force: true });
}
