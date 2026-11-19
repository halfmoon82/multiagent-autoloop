import { chromium } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const shots = path.join(root, 'screenshots');
const profile = mkdtempSync(path.join(tmpdir(), 'autoloop-mobile-design-'));
const context = await chromium.launchPersistentContext(profile, { headless: true, viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 1 });
const page = context.pages()[0];
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const url = pathToFileURL(path.join(root, 'index.html')).href;
const results = [];
const check = (name, condition = true) => { assert.ok(condition, name); results.push(`PASS ${name}`); };
async function shot(name) {
  await page.locator('.device').screenshot({ path: path.join(shots, `${name}.png`), animations: 'disabled' });
}
async function go(screen) { await page.locator(`#prototype-nav [data-screen="${screen}"]`).click(); }
async function font(scale) { await page.locator(`[data-font="${scale}"]`).click(); }
async function device(name) { await page.locator(`[data-device="${name}"]`).click(); }
try {
  await page.goto(url);
  await page.locator('#app .mobile-shell').waitFor();
  for (const screen of ['overview','conversation','artifacts','artifact-preview','sessions','rules','rule-form','runs','cards','dag','authorize','new-session','notifications','biometric','devices']) {
    await go(screen);
    await page.locator('#app').waitFor();
    check(`${screen}: renders without blank app`, (await page.locator('#app').innerText()).trim().length > 20);
    await shot(`phone-${screen}`);
  }


  // Global project filter is a higher-level scope and is available on every main tab.
  for (const screen of ['overview','rules','sessions','runs','cards','dag','artifacts','conversation']) {
    await go(screen);
    check(`${screen}: global project filter is visible`, await page.locator('.project-filter-bar').first().isVisible());
  }
  await go('overview');
  await page.locator('[data-action="open-project-filter"]').click();
  check('project filter: sheet opens', await page.locator('.project-sheet').isVisible());
  await page.locator('[data-project-option="控制台服务端"]').click();
  check('project filter: selecting a project filters overview cards', await page.locator('[data-project="移动控制台"]').first().isHidden() && await page.locator('[data-project="控制台服务端"]').first().isVisible());
  for (const screen of ['rules','sessions','runs','cards']) {
    await go(screen);
    check(`${screen}: selected project remains active`, (await page.locator('.project-filter-bar strong').first().innerText()) === '控制台服务端');
  }
  await page.locator('[data-action="open-project-filter"]').click();
  await page.locator('[data-project-option="全部"]').click();
  check('project filter: all projects restores items', await page.locator('[data-project="移动控制台"]').first().isVisible());

  // DAG baseline: circular progress, wave nodes, slot and usage facts.
  await go('overview');
  check('DAG overview: circular progress ring exists', await page.locator('.dag-ring').count() >= 2);
  check('DAG overview: wave/node legend exists', await page.locator('.dag-wave-map').count() >= 2);
  check('DAG overview: capacity and usage are shown', (await page.locator('.dag-card-meta').first().innerText()).includes('路占用') && (await page.locator('.dag-card-meta').first().innerText()).includes('Token'));
  await go('dag');
  check('DAG detail: circular progress and wave stack exist', await page.locator('.dag-detail-visual .dag-ring').isVisible() && await page.locator('.dag-wave-stack').isVisible());
  check('DAG detail: node contract facts exist', (await page.locator('.fact-list').innerText()).includes('槽位') && (await page.locator('.fact-list').innerText()).includes('费用 / Token'));

  // Archived sessions remain part of the sessions tab.
  await go('sessions');
  check('sessions: archived section is present and collapsed by default', await page.locator('.archived-sessions').isVisible() && !(await page.locator('.archived-entry').first().isVisible().catch(() => false)));
  await page.locator('[data-action="toggle-archived"]').click();
  check('sessions: archived entries expand', await page.locator('.archived-entry').first().isVisible());
  await page.locator('[data-action="view-archive"]').first().click();
  check('archived session: read-only view opens', (await page.locator('#app').innerText()).includes('只读转录'));
  check('archived session: restore creates a new session', await page.locator('[data-action="restore-archive"]').first().isVisible());

  // Existing web parity: rules and cards do not invent an original-session jump.
  await go('rules');
  check('rules: actions stay run/edit/pause/resume', (await page.locator('.rule-item').first().innerText()).includes('立即运行') && !(await page.locator('.rule-item').first().innerText()).includes('进入会话'));
  await go('cards');
  check('cards: answer and resolve actions stay in-card', (await page.locator('.rule-item').first().innerText()).includes('结案') && !(await page.locator('.rule-item').first().innerText()).includes('进入会话'));

  // Artifacts are both globally managed and directly openable from their session/task context.
  await go('conversation');
  check('conversation: in-session artifact panel is visible', await page.locator('.session-artifact-panel').isVisible());
  await page.locator('[data-action="open-session-artifact"]').first().click();
  check('conversation artifact: reader shows session/task origin', (await page.locator('.app-header').innerText()).includes('来自会话'));
  await page.locator('[data-action="go-conversation"]').first().click();
  check('conversation artifact: back returns to the session', await page.locator('.session-artifact-panel').isVisible());
  await page.locator('[data-action="go-session-artifacts"]').first().click();
  check('artifact manager: opens from session and remains available', await page.locator('.file-list').isVisible());
  await go('conversation');
  await page.locator('[data-option]').first().click();
  check('decision: option selection enables submit', await page.locator('[data-action="submit-answer"]').isEnabled());
  await page.locator('[data-action="submit-answer"]').click();
  check('decision: answered question remains in conversation', await page.locator('.answered-card').count() === 1);
  check('decision: moves to second question', (await page.locator('.question-count').last().innerText()).includes('2 / 3'));
  await page.locator('[data-action="voice"]').click();
  check('voice: listening state visible', await page.locator('.voice-status').innerText() === '正在聆听 · 再点麦克风完成，文字可编辑');
  await page.locator('[data-action="voice"]').click();
  check('voice: transcript is editable and not auto-sent', (await page.locator('#question-input').inputValue()).includes('任意移动网络'));
  await page.locator('[data-action="submit-answer"]').click();
  await page.locator('[data-option]').first().click();
  await page.locator('[data-action="submit-answer"]').click();
  check('decision: all answered state', (await page.locator('.decision-question').innerText()).includes('3 个问题均已回答'));
  await shot('phone-conversation-all-answered');

  await go('notifications');
  await page.locator('[data-action="notification-reply"]').click();
  check('notification: inline reply expands', await page.locator('#notification-input').isVisible());
  await page.locator('[data-action="notification-send"]').click();
  check('notification: direct reply requires biometrics', (await page.locator('.biometric-screen').innerText()).includes('解锁 Autoloop'));
  await page.locator('[data-action="biometric-success"]').click();
  check('biometric: success state', (await page.locator('.biometric-screen').innerText()).includes('验证成功'));
  await page.locator('[data-action="finish-biometric"]').click();
  check('biometric: returns to conversation context', await page.locator('#decision-group').isVisible());

  await go('artifacts');
  await page.locator('[data-action="open-artifact"]').first().click();
  check('artifact: opens reader', (await page.locator('.document-view').innerText()).includes('Autoloop'));
  await page.locator('[data-preview="source"]').click();
  check('artifact: source view', await page.locator('.code-view').isVisible());
  await page.locator('[data-preview="rendered"]').click();
  await page.locator('[data-action="go-artifacts"]').click();
  check('artifact: back returns to file browser', await page.locator('.file-list').isVisible());

  await font('1.6');
  for (const screen of ['conversation','artifacts','artifact-preview','overview','devices']) {
    await go(screen);
    const overflow = await page.evaluate(() => document.querySelector('.device-surface').scrollWidth > document.querySelector('.device-surface').clientWidth);
    check(`${screen}: 160% font has no device-level horizontal overflow`, !overflow);
    await shot(`phone-${screen}-font160`);
  }
  await font('1');

  await device('fold');
  for (const screen of ['overview','conversation','artifacts']) {
    await go(screen);
    check(`${screen}: fold layout renders`, await page.locator('#app').innerText() !== '');
    await shot(`fold-${screen}`);
    if (screen === 'conversation') check('fold conversation: sidebar and main are both visible', await page.locator('.conversation-sidebar').isVisible() && await page.locator('.conversation-main').isVisible());
  }
  await go('artifacts');
  check('fold artifacts: list and preview are both visible', await page.locator('.artifact-browser-pane').isVisible() && await page.locator('.artifact-preview-pane').isVisible());
  await font('1.6');
  await shot('fold-artifacts-font160');
  check('no JavaScript errors', errors.length === 0);
  writeFileSync(path.join(root, 'verification.txt'), `${results.join('\n')}\n\n${results.length} checks passed. Browser errors: ${JSON.stringify(errors)}\n`);
  console.log(`${results.length} checks passed`);
} finally {
  await context.close();
  rmSync(profile, { recursive: true, force: true });
}
