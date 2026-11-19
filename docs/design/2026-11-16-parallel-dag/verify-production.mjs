// 当前控制台原生 DAG 的定向生产 UI 验证。由已批准 design-manifest 的 verifierPath 调用。
// 仅本机临时服务 + 假 Hub + 临时浏览器 profile；截图写服务端 evidenceDir，不写槽位。
import http from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const listen = async server => { await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject)); return `http://127.0.0.1:${server.address().port}`; };
const close = server => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
const json = (res, value) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
const viewportSize = value => { const [width, height] = value.split('x').map(Number); return { width, height }; };

async function importFrom(worktree, relative) {
  return import(pathToFileURL(path.join(worktree, relative)).href);
}

export async function verify({ worktree, contract, evidenceDir }) {
  // 显式支持清单：未声明的维度 fail closed，不得静默按 normal 页面通过。
  const supportedStates = new Set(['normal']);
  const supportedInteractions = new Set(['load-plan', 'confirm-scope']);
  for (const state of contract.states || []) if (!supportedStates.has(state)) throw new Error(`当前生产 verifier 不支持 state：${state}`);
  for (const interaction of contract.interactions || []) if (!supportedInteractions.has(interaction)) throw new Error(`当前生产 verifier 不支持 interaction：${interaction}`);
  mkdirSync(evidenceDir, { recursive: true });
  const root = mkdtempSync(path.join(tmpdir(), 'design-production-data-'));
  const profile = mkdtempSync(path.join(tmpdir(), 'design-production-profile-'));
  let context; let server; let hub;
  const checks = []; const artifacts = [];
  try {
    const { createConsoleServer } = await importFrom(worktree, 'src/server.mjs');
    const { createDagService } = await importFrom(worktree, 'src/dag-service.mjs');
    const { createRunStore } = await importFrom(worktree, 'src/dag-run.mjs');
    writeFileSync(path.join(root, 'rules.json'), JSON.stringify({ rules: [] }));
    hub = http.createServer((req, res) => json(res, req.url === '/v1/state'
      ? { seq: 1, totals: {}, spending: { today: {} }, cards: [], agents: [], channels: [], lines: [], runs: [], timers: [] }
      : { ok: true }));
    const hubUrl = await listen(hub);
    const store = createRunStore({ directory: path.join(root, 'dag-runs') });
    const dag = createDagService({ root, store });
    // 原生 DAG 不需要 vibe；此处只替代旧 preflight 的外部能力检查，计划读取仍用真实 service。
    const dagService = { ...dag, preflight: project => ({ project, checks: [{ id: 'native', label: '原生 DAG', ok: true, message: '无需 vibe' }] }) };
    const sessions = {
      record: null,
      async list() { return this.record ? [this.record] : []; }, async listArchived() { return []; },
      async start({ prompt = '', project = worktree, kind = 'design' } = {}) {
        const now = '2026-11-17T00:00:00.000Z';
        this.record = { id: 'design-session', sessionId: 'design-session', agent: 'Codex', cwd: project, project, kind, status: 'idle', statusText: '待命', prompt, messages: [{ role: 'user', text: prompt, at: now }], liveText: '', busy: false, queue: [], queued: [], queuedCount: 0, createdAt: now, updatedAt: now };
        return this.record;
      },
      dispose() {},
    };
    server = createConsoleServer({ hubUrl, ownerKey: 'design-verify', rulesFile: path.join(root, 'rules.json'), root, projectRoots: [path.dirname(worktree)], dagService }, sessions);
    const url = await listen(server);
    context = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true, viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('dialog', dialog => dialog.accept());
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });

    for (const surfaceId of contract.surfaceIds) {
      if (!['overview', 'authorize'].includes(surfaceId)) throw new Error(`当前生产 verifier 不支持 surface：${surfaceId}`);
      for (const viewport of contract.viewports || ['1440x900', '390x844']) {
        await page.setViewportSize(viewportSize(viewport));
        if (surfaceId === 'overview') {
          await page.goto(url, { waitUntil: 'load' });
          await page.getByRole('heading', { name: '今天的自动化' }).waitFor();
        } else {
          // 每个视口都从「该项目尚无设计会话」开始：控制台按 (project,kind) 查重，上一视口建的会话会挡住下一轮新建。
          sessions.record = null;
          await page.goto(url, { waitUntil: 'load' });
          await page.getByRole('button', { name: '会话管理', exact: false }).click();
          await page.locator('#session-new').click();
          await page.locator('#new-session-project').selectOption(worktree);
          await page.locator('#new-session-request').fill('设计一个多租户计费方案并进入 PRD、DAG 与授权确认');
          await page.waitForFunction(() => document.querySelector('#classification-title')?.textContent?.includes('设计会话'));
          await page.locator('#create-session').click();
          await page.locator('#session-workspace [data-action="design-authorize"]').waitFor();
          await page.locator('#session-workspace [data-action="design-authorize"]').click();
          await page.locator('#authorize-project').selectOption(worktree);
          await page.locator('#authorize-plan').fill('console-hub-native-and-card-routing');
          await page.locator('#authorize-load').click();
          await page.locator('#authorize-check').waitFor();
          if ((contract.interactions || []).includes('confirm-scope')) {
            await page.locator('#authorize-check').check();
            checks.push({ surfaceId, viewport, kind: 'interaction', id: 'confirm-scope', ok: await page.locator('#authorize-button').isEnabled() });
          }
          if ((contract.interactions || []).includes('load-plan')) {
            const digest = page.locator('[data-plan-digest]');
            checks.push({ surfaceId, viewport, kind: 'interaction', id: 'load-plan', ok: await digest.isVisible() && Boolean((await digest.innerText()).trim()) });
          }
        }
        const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
        checks.push({ surfaceId, viewport, kind: 'layout', id: 'normal', ok: noOverflow });
        const screenshot = path.join(evidenceDir, `${surfaceId}-${viewport}.png`);
        await page.screenshot({ path: screenshot, fullPage: true });
        artifacts.push({ kind: 'screenshot', surfaceId, viewport, path: screenshot });
      }
    }
    checks.push({ kind: 'console', id: 'no-errors', ok: errors.length === 0, detail: errors.join('; ').slice(0, 500) });
    return { ok: checks.every(check => check.ok), checks, artifacts };
  } finally {
    if (context) await context.close();
    if (server) await close(server);
    if (hub) await close(hub);
    rmSync(root, { recursive: true, force: true });
    rmSync(profile, { recursive: true, force: true });
  }
}
