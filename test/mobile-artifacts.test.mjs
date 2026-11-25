// artifacts 节点（Spec §8.2.5 / §8.3 / DAG 节点 artifacts）边界测试：
// 产物双入口（全局管理页 + 会话内产物）、只读预览、可读错误与「返回会话恢复草稿/滚动」。
// 移动端 feature 是纯逻辑：不碰 DOM、不依赖 node: 内置模块；服务端产物服务单独在 Node 侧验收。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ARTIFACT_ENTRY_POINTS, ARTIFACT_ENTRY_LABELS, artifactEntryLabel,
  ARTIFACT_LAYOUTS, artifactLayoutLabel,
  ARTIFACT_VIEW_EXTENSIONS, artifactKindLabel,
  ARTIFACT_MOBILE_READ_ONLY, ARTIFACT_SHARE_READ_ONLY, ARTIFACT_FILE_TOUCH_TARGET_DP,
  ARTIFACT_ERRORS,
  createArtifact, createArtifactBrowser, createArtifactBrowsers,
  openArtifacts, openFromSession, openFromGlobal,
  selectArtifact, closeReader, filterArtifacts,
  setListScrollTop, setReaderScrollTop, setError, clearError,
  backFromArtifacts, snapshotBrowser, restoreBrowser,
  buildArtifactBrowserBinding,
} from '../mobile/src/features/artifacts/index.mjs';
import {
  listSessionArtifacts, readSessionArtifact, readableArtifactError,
} from '../src/artifacts.mjs';
import {
  createQuestionGroup, setDraft, setScrollTop, snapshotGroup, restoreGroup,
  buildQuestionGroupBinding,
} from '../mobile/src/features/question-group/index.mjs';
import {
  ARTIFACT_READ_VIEW,
  artifactReadView, artifactDownloadUrl, artifactPagePlan,
  openGlobalArtifacts, openSessionArtifacts as wireOpenSessionArtifacts,
  openArtifactReader, backArtifactReader, downloadArtifact,
} from '../mobile/src/features/artifacts/page.mjs';
import { mount as mountArtifactsPage } from '../mobile/app/www/pages/artifacts.mjs';
import * as artifactsFeature from '../mobile/src/features/artifacts/index.mjs';

const FEATURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'mobile', 'src', 'features', 'artifacts');

function rawArtifacts() {
  return [
    { id: 'a1', path: 'docs/plan.md', name: 'plan.md', size: 2048, at: '2026-11-19T04:00:00.000Z', sessionId: 's1', task: '梳理方案' },
    { id: 'a2', path: 'docs/dashboard.html', name: 'dashboard.html', size: 512, at: '2026-11-19T03:00:00.000Z', sessionId: 's1', task: '梳理方案' },
    { id: 'a3', path: 'report.md', name: 'report.md', size: 128, at: '2026-11-19T05:00:00.000Z', sessionId: 's2', task: '验收报告' },
  ];
}

function groupSnapshot() {
  let group = createQuestionGroup({
    id: 'g1', sessionId: 's1',
    questions: [{ id: 'q1', kind: 'text', prompt: '补充背景？' }],
  });
  group = setDraft(group, 'q1', '未发送的草稿');
  group = setScrollTop(group, 168);
  return snapshotGroup(group);
}

function serviceFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'mobile-artifacts-'));
  mkdirSync(path.join(root, 'docs'), { recursive: true });
  writeFileSync(path.join(root, 'docs', 'plan.md'), '# 计划\n');
  writeFileSync(path.join(root, 'docs', 'board.html'), '<h1>看板</h1>');
  writeFileSync(path.join(root, 'docs', 'old.md'), '# 旧\n');
  const old = new Date('2026-01-01T00:00:00Z');
  utimesSync(path.join(root, 'docs', 'old.md'), old, old);
  return root;
}

// ---------------------------------------------------------------------------
// RED 1：契约词表与常量——双入口/双布局、只读、热区、可读错误，不编造
// ---------------------------------------------------------------------------
test('契约词表覆盖双入口与双布局，移动端只读且分享只读，热区 48dp', () => {
  assert.deepEqual([...ARTIFACT_ENTRY_POINTS], ['global', 'session']);
  assert.equal(artifactEntryLabel('session'), '本会话产物');
  assert.equal(artifactEntryLabel('unknown'), ARTIFACT_ENTRY_LABELS.global, '未知入口回退全局，不编造');
  assert.deepEqual([...ARTIFACT_LAYOUTS], ['phone', 'fold']);
  assert.equal(artifactLayoutLabel('fold'), '折叠双栏');
  assert.equal(artifactLayoutLabel('weird'), artifactLayoutLabel('phone'));
  assert.deepEqual([...ARTIFACT_VIEW_EXTENSIONS], ['.md', '.markdown', '.html', '.htm']);
  assert.equal(artifactKindLabel('.md'), 'Markdown');
  assert.equal(artifactKindLabel('.HTML'), 'HTML');
  assert.equal(artifactKindLabel('.txt'), '未知类型', '不支持类型给出可读说明而非空白');
  assert.equal(ARTIFACT_MOBILE_READ_ONLY, true);
  assert.equal(ARTIFACT_SHARE_READ_ONLY, true);
  assert.equal(ARTIFACT_FILE_TOUCH_TARGET_DP, 48);
  for (const key of ['missing', 'outOfBounds', 'noSession', 'unsupported', 'missingState']) {
    assert.equal(typeof ARTIFACT_ERRORS[key], 'string');
    assert.ok(ARTIFACT_ERRORS[key].length > 0);
  }
});

// ---------------------------------------------------------------------------
// RED 2：产物元数据归一化——会话/任务/路径齐全，上游文本是纯字符串
// ---------------------------------------------------------------------------
test('createArtifact 归一化产物：会话、任务、路径齐全，类型可读，只读', () => {
  const a = createArtifact(rawArtifacts()[0]);
  assert.equal(a.id, 'a1');
  assert.equal(a.sessionId, 's1');
  assert.equal(a.task, '梳理方案');
  assert.equal(a.path, 'docs/plan.md');
  assert.equal(a.kindLabel, 'Markdown');
  assert.equal(a.readOnly, true);
  assert.equal(a.size, 2048);
  const noMeta = createArtifact({ path: 'docs/a.MD', sessionId: 's9', task: 'T' });
  assert.equal(noMeta.name, 'a.MD', '无 name 时从路径取文件名');
  assert.equal(noMeta.kindLabel, 'Markdown', '扩展名大小写不敏感');
  assert.ok(noMeta.id, '始终有稳定 id');
});

// ---------------------------------------------------------------------------
// RED 3：初态——全局入口、产物列表、无选中、无错误
// ---------------------------------------------------------------------------
test('createArtifactBrowser 初态：默认全局入口、无选中、无错误', () => {
  const b = createArtifactBrowser({ id: 'b1', artifacts: rawArtifacts() });
  assert.equal(b.id, 'b1');
  assert.equal(b.entry, 'global');
  assert.equal(b.layout, 'phone');
  assert.equal(b.artifacts.length, 3);
  assert.equal(b.selectedId, null);
  assert.equal(b.opened, false);
  assert.equal(b.error, null);
  assert.equal(b.listScrollTop, 0);
  assert.equal(b.readerScrollTop, 0);
  assert.equal(b.returnState, null);
  const registry = createArtifactBrowsers([b, createArtifactBrowser({ id: 'b2', entry: 'session', sessionId: 's1' })]);
  assert.deepEqual(Object.keys(registry), ['b1', 'b2']);
  assert.equal(registry.b2.entry, 'session');
});

// ---------------------------------------------------------------------------
// RED 4：双入口——会话内打开保留返回态，全局打开不带会话返回态
// ---------------------------------------------------------------------------
test('会话内打开产物保留返回态；全局产物页不携带会话返回态', () => {
  const base = createArtifactBrowser({ id: 'b1', artifacts: rawArtifacts() });
  const restore = groupSnapshot();
  const fromSession = openFromSession(base, { sessionId: 's1', returnState: restore });
  assert.equal(fromSession.entry, 'session');
  assert.equal(fromSession.sessionId, 's1');
  assert.deepEqual(fromSession.returnState, restore, '进入产物时完整保留待回答组快照');
  assert.notEqual(fromSession.returnState, restore, '保留的是副本，不与外部同源引用');

  const fromGlobal = openFromGlobal(fromSession);
  assert.equal(fromGlobal.entry, 'global');
  assert.equal(fromGlobal.sessionId, '', '全局入口不绑定会话');
  assert.equal(fromGlobal.returnState, null, '从全局进入不产生「返回会话」');

  const bad = openArtifacts(base, { entry: 'foreign' });
  assert.equal(bad, base, '未知入口无副作用');
});

// ---------------------------------------------------------------------------
// RED 5：打开产物——不存在给可读错误；有效则选中；折叠布局只动阅读侧
// ---------------------------------------------------------------------------
test('打开产物：缺失产物给可读错误，有效产物进入只读预览，折叠只更新阅读侧', () => {
  const base = createArtifactBrowser({ id: 'b1', artifacts: rawArtifacts(), listScrollTop: 42 });
  const missing = selectArtifact(base, 'nope');
  assert.equal(missing.error, ARTIFACT_ERRORS.missing, '不抛出内部路径');
  assert.equal(missing.selectedId, null);
  assert.equal(missing.opened, false);

  let opened = selectArtifact(base, 'a1');
  assert.equal(opened.error, null);
  assert.equal(opened.selectedId, 'a1');
  assert.equal(opened.opened, true);
  assert.equal(opened.listScrollTop, 42, '选中文件不丢列表滚动位置');
  const back = closeReader(opened);
  assert.equal(back.opened, false, '逐级返回：阅读回到列表');
  assert.equal(back.selectedId, 'a1');
  assert.equal(back.listScrollTop, 42);

  const fold = createArtifactBrowser({ id: 'b2', layout: 'fold', artifacts: rawArtifacts(), listScrollTop: 77 });
  const foldOpened = selectArtifact(fold, 'a2');
  assert.equal(foldOpened.layout, 'fold');
  assert.equal(foldOpened.listScrollTop, 77, '折叠屏选择文件只更新右侧，左侧列表位置不动');
  assert.equal(foldOpened.selectedId, 'a2');
});

// ---------------------------------------------------------------------------
// RED 6：滚动位置与可读错误——切页/旋转不丢浏览进度，错误可读可清
// ---------------------------------------------------------------------------
test('列表与阅读滚动位置分别记住；错误可读且可清除', () => {
  let b = createArtifactBrowser({ id: 'b1', artifacts: rawArtifacts() });
  b = setListScrollTop(b, 120);
  b = setReaderScrollTop(b, 88);
  assert.equal(b.listScrollTop, 120);
  assert.equal(b.readerScrollTop, 88);
  assert.equal(setListScrollTop(b, 120), b, '同值返回原对象，避免无谓重渲染');

  b = setError(b, ARTIFACT_ERRORS.outOfBounds);
  assert.equal(b.error, ARTIFACT_ERRORS.outOfBounds);
  b = clearError(b);
  assert.equal(b.error, null);
});

// ---------------------------------------------------------------------------
// RED 7：验收核心——从会话内产物返回后，草稿与滚动位置原样恢复
// ---------------------------------------------------------------------------
test('返回会话保留草稿与滚动位置（与 question-group 快照对接）', () => {
  const original = groupSnapshot();
  const restoredGroupBefore = restoreGroup(original);
  const beforeBinding = buildQuestionGroupBinding(restoredGroupBefore);
  assert.equal(beforeBinding.active.draft, '未发送的草稿');
  assert.equal(beforeBinding.scrollTop, 168);

  let b = openFromSession(createArtifactBrowser({ id: 'b1', artifacts: rawArtifacts() }), {
    sessionId: 's1', returnState: original,
  });
  b = setListScrollTop(b, 240);
  b = selectArtifact(b, 'a1');
  b = setReaderScrollTop(b, 96);

  const { state, return: back } = backFromArtifacts(b);
  assert.equal(state.opened, false);
  assert.equal(state.selectedId, null, '返回会话后清空选中，下次从列表重新进入');
  assert.equal(state.listScrollTop, 240, '产物列表进度仍在');
  assert.equal(back.sessionId, 's1');
  assert.equal(back.entry, 'session');
  assert.deepEqual(back.restore, original, '交回的会话状态与进入前逐字一致');

  const restoredAfter = restoreGroup(back.restore);
  const afterBinding = buildQuestionGroupBinding(restoredAfter);
  assert.deepEqual(afterBinding, beforeBinding, '返回后视图与打开产物前完全一致');
  assert.equal(afterBinding.active.draft, '未发送的草稿');
  assert.equal(afterBinding.scrollTop, 168);

  const fromGlobal = openFromGlobal(createArtifactBrowser({ id: 'b2', artifacts: rawArtifacts() }));
  assert.equal(backFromArtifacts(fromGlobal).return, null, '全局入口无会话可返回');
});

// ---------------------------------------------------------------------------
// RED 8：全局产物页按会话/关键字过滤，不虚构内容
// ---------------------------------------------------------------------------
test('filterArtifacts 按会话与关键字过滤全局产物', () => {
  const b = createArtifactBrowser({ id: 'b1', artifacts: rawArtifacts() });
  assert.equal(filterArtifacts(b).length, 3);
  assert.deepEqual(filterArtifacts(b, { sessionId: 's1' }).map(a => a.id), ['a1', 'a2']);
  assert.deepEqual(filterArtifacts(b, { query: 'dashboard' }).map(a => a.id), ['a2']);
  assert.deepEqual(filterArtifacts(b, { sessionId: 's2', query: 'plan' }).map(a => a.id), []);
  assert.equal(filterArtifacts(b, { query: '     ' }).length, 3, '空白关键字不过滤');
});

// ---------------------------------------------------------------------------
// RED 9：快照/恢复——旋转与折叠后产物浏览状态不丢
// ---------------------------------------------------------------------------
test('快照恢复保留入口、布局、选中与双滚动位置', () => {
  let b = openFromSession(createArtifactBrowser({ id: 'b1', artifacts: rawArtifacts() }), {
    sessionId: 's1', returnState: groupSnapshot(),
  });
  b = setListScrollTop(b, 300);
  b = selectArtifact(b, 'a3');
  b = setReaderScrollTop(b, 64);
  const snapshot = snapshotBrowser(b);
  assert.deepEqual(snapshot, JSON.parse(JSON.stringify(snapshot)), '快照是可 JSON 化的纯数据');
  const restored = restoreBrowser(snapshot);
  assert.deepEqual(buildArtifactBrowserBinding(restored), buildArtifactBrowserBinding(b));
  assert.equal(restored.entry, 'session');
  assert.equal(restored.selectedId, 'a3');
  assert.equal(restored.listScrollTop, 300);
  assert.equal(restored.readerScrollTop, 64);
  assert.deepEqual(restoreBrowser(null), createArtifactBrowser(), '坏快照回退初态，不抛错');
});

// ---------------------------------------------------------------------------
// RED 10：视图模型——显示所属会话/任务/路径、只读标记、按布局切换栏位，安全渲染
// ---------------------------------------------------------------------------
test('视图模型展示会话/任务/路径与只读标记，按布局切换栏位，不拼接 HTML', () => {
  const b = selectArtifact(
    openFromSession(createArtifactBrowser({ id: 'b1', artifacts: rawArtifacts() }), {
      sessionId: 's1', returnState: groupSnapshot(),
    }), 'a1',
  );
  const binding = buildArtifactBrowserBinding(b);
  assert.equal(binding.entryLabel, '本会话产物');
  assert.equal(binding.count, 3);
  assert.equal(binding.readOnly, true);
  assert.equal(binding.shareReadOnly, true);
  assert.equal(binding.touchTargetDp, 48);
  assert.equal(binding.pane, 'stack');
  assert.equal(binding.returnAvailable, true);
  assert.equal(binding.artifacts[0].sessionId, 's1');
  assert.equal(binding.artifacts[0].taskLabel, '梳理方案');
  assert.equal(binding.artifacts[0].path, 'docs/plan.md');
  assert.equal(binding.artifacts[0].selected, true);
  assert.equal(binding.artifacts[1].selected, false);

  const fold = buildArtifactBrowserBinding(createArtifactBrowser({ id: 'b2', layout: 'fold', artifacts: rawArtifacts() }));
  assert.equal(fold.pane, 'dual', '折叠屏左右双栏');

  const dump = JSON.stringify(binding);
  assert.equal(Object.hasOwn(binding, 'html'), false);
  assert.ok(!dump.includes('<script') && !dump.includes('</div>') && !dump.includes('onerror='));
  assert.ok(!dump.includes('deviceToken') && !dump.includes('server-secret') && !dump.includes('apiKey'));
});

// ---------------------------------------------------------------------------
// RED 11：feature 纯逻辑守门
// ---------------------------------------------------------------------------
test('feature 是纯逻辑：不依赖 node: 内置模块、不碰 DOM、不拼接 HTML', () => {
  const files = readdirSync(FEATURE_DIR).filter(name => name.endsWith('.mjs'));
  assert.ok(files.length > 0, 'feature 目录至少有一个 .mjs');
  for (const name of files) {
    const source = readFileSync(path.join(FEATURE_DIR, name), 'utf8');
    assert.ok(!/from\s+['"]node:/.test(source), `${name} 不得 import node: 内置模块`);
    assert.ok(!/\bdocument\.|\bwindow\.|\blocalStorage\b/.test(source.replace(/\/\/.*$/gm, '')), `${name} 不得直接碰 DOM/浏览器存储`);
    assert.ok(!/innerHTML|insertAdjacentHTML/.test(source), `${name} 不得拼接 HTML`);
  }
});

// ---------------------------------------------------------------------------
// RED 12：服务端——全局产物跨会话汇总，标明会话/任务/路径，按时间倒序封顶
// ---------------------------------------------------------------------------
test('listSessionArtifacts 跨会话汇总，标记会话与任务，按时间倒序并封顶', () => {
  const root = serviceFixture();
  const sessions = [
    { id: 's1', task: '梳理方案', cwd: root, startedAt: '2026-11-19T02:00:00Z' },
    { id: 's2', task: '缺失工作目录' },
  ];
  const files = listSessionArtifacts(sessions, { maxFiles: 10 });
  assert.deepEqual(files.map(f => f.path), ['docs/board.html', 'docs/plan.md'], '旧产物按会话开始时间过滤');
  assert.ok(files.every(f => f.sessionId === 's1' && f.task === '梳理方案'));
  assert.ok(files.every(f => typeof f.size === 'number' && typeof f.at === 'string'));
  assert.equal(listSessionArtifacts([], {}).length, 0);
  assert.equal(listSessionArtifacts(null, {}).length, 0);
});

// ---------------------------------------------------------------------------
// RED 13：服务端——按会话读取产物，越界/不存在都可映射为可读错误
// ---------------------------------------------------------------------------
test('readSessionArtifact 按会话读取；越界与缺失映射为可读错误且不泄漏绝对路径', () => {
  const root = serviceFixture();
  const sessions = [
    { id: 's1', task: '梳理方案', cwd: root },
    { id: 's2', task: '别的会话', cwd: mkdtempSync(path.join(tmpdir(), 'other-')) },
  ];
  const got = readSessionArtifact(sessions, 's1', 'docs/plan.md');
  assert.match(got.content, /# 计划/);
  assert.equal(got.sessionId, 's1');
  assert.equal(got.task, '梳理方案');
  assert.throws(() => readSessionArtifact(sessions, 's9', 'docs/plan.md'), /会话不存在/);
  assert.equal(readableArtifactError(new Error('路径越界：只允许会话工作目录内的相对路径')), ARTIFACT_ERRORS.outOfBounds);
  assert.equal(readableArtifactError(new Error('产物文件不存在：missing.md')), ARTIFACT_ERRORS.missing);
  assert.equal(readableArtifactError(new Error('不支持的产物类型：.txt')), ARTIFACT_ERRORS.unsupported);
  const leaked = readableArtifactError(new Error('boom /Users/macmini/secret'));
  assert.ok(!leaked.includes('/Users/'), '任何错误都不把绝对路径回给移动端');
  symlinkSync('/etc/passwd', path.join(root, 'docs', 'evil.md'));
  assert.throws(() => readSessionArtifact(sessions, 's1', 'docs/evil.md'), /越界/);
});

// ---------------------------------------------------------------------------
// 接线层（pages/artifacts.mjs 的 mount 使用；Node 侧直接断言，无 DOM）
// ---------------------------------------------------------------------------

test('artifactDownloadUrl 只生成 HTTPS 的 GET sessions download，路径安全编码', () => {
  const url = artifactDownloadUrl('https://auto.example/', 's 1', 'docs/计划 稿.md');
  assert.match(url, /^https:\/\/auto\.example\/api\/mobile\/sessions\/s%201\/download\?path=/);
  assert.ok(url.includes('path=docs%2F'), '路径整体编码，不拼接普通链接跳转');
  assert.equal(new URL(url).searchParams.get('path'), 'docs/计划 稿.md');
  assert.equal(artifactDownloadUrl('http://auto.example', 's1', 'a.md'), null, '明文 HTTP 基址一律拒绝');
  assert.equal(artifactDownloadUrl('', 's1', 'a.md'), null, '无基址不编造下载地址');
  assert.equal(artifactDownloadUrl('not a url', 's1', 'a.md'), null);
});

test('artifactReadView 登记阅读视图，返回键据此逐级退出', () => {
  const b = openArtifactReader(
    createArtifactBrowser({ id: 'b1', entry: 'session', sessionId: 's1', artifacts: rawArtifacts() }), 'a1',
  ).browser;
  const view = artifactReadView(b);
  assert.equal(view.id, ARTIFACT_READ_VIEW);
  assert.equal(view.entry, 'session');
  assert.equal(view.sessionId, 's1');
  assert.equal(view.artifactId, 'a1');
});

test('全局入口与会话入口打开同一产物浏览器：会话保留返回态，全局不带会话态', () => {
  const base = createArtifactBrowser({ id: 'artifacts', artifacts: rawArtifacts(), layout: 'phone' });
  const global = openGlobalArtifacts(base, { artifacts: rawArtifacts(), layout: 'fold' });
  assert.equal(global.browser.entry, 'global');
  assert.equal(global.browser.sessionId, '');
  assert.equal(global.browser.returnState, null);
  assert.equal(global.browser.layout, 'fold');
  assert.deepEqual(global.effects, [{ type: 'selectTab', page: 'artifacts' }]);

  const restore = groupSnapshot();
  const session = wireOpenSessionArtifacts(base, {
    artifacts: rawArtifacts(), sessionId: 's1', returnState: restore, layout: 'phone',
  });
  assert.equal(session.browser.entry, 'session');
  assert.equal(session.browser.sessionId, 's1');
  assert.deepEqual(session.browser.returnState, restore, '会话入口完整保留返回态副本');
  assert.deepEqual(session.effects, [{ type: 'selectTab', page: 'artifacts' }]);

  // 两个入口打开的产物集合一致（同一产物在两处都能选中阅读）
  const gRead = openArtifactReader(global.browser, 'a1').browser;
  const sRead = openArtifactReader(session.browser, 'a1').browser;
  assert.equal(gRead.selectedId, 'a1');
  assert.equal(sRead.selectedId, 'a1');
});

test('打开产物登记 pushView；返回键逐级 popView 再回会话且不丢返回态', () => {
  const restore = groupSnapshot();
  let b = wireOpenSessionArtifacts(createArtifactBrowser({ id: 'artifacts' }), {
    artifacts: rawArtifacts(), sessionId: 's1', returnState: restore,
  }).browser;

  const opened = openArtifactReader(b, 'a1');
  assert.equal(opened.effects.length, 1);
  assert.equal(opened.effects[0].type, 'pushView');
  assert.equal(opened.effects[0].view.id, ARTIFACT_READ_VIEW);
  b = opened.browser;

  // 第一级返回：阅读侧退出，交回一次 popView，不动会话返回态
  const back1 = backArtifactReader(b);
  assert.equal(back1.browser.opened, false);
  assert.deepEqual(back1.effects, [{ type: 'popView' }]);
  assert.equal(back1.browser.entry, 'session');
  assert.deepEqual(back1.browser.returnState, restore);

  // 第二级返回：从会话内产物退回会话，交回返回态并切回会话页
  const back2 = backArtifactReader(back1.browser);
  const restoreEffect = back2.effects.find(e => e.type === 'restoreSession');
  assert.ok(restoreEffect, '会话入口返回时交回返回态');
  assert.deepEqual(restoreEffect.payload.restore, restore);
  assert.ok(back2.effects.some(e => e.type === 'selectTab' && e.page === 'sessions'));
});

test('下载只经原生桥：产出 download 副作用；无 HTTPS 基址给可读错误可重试', () => {
  const b = createArtifactBrowser({ id: 'artifacts', artifacts: rawArtifacts() });
  const ok = downloadArtifact(b, 'a1', 'https://auto.example/');
  assert.equal(ok.effects.length, 1);
  assert.equal(ok.effects[0].type, 'download');
  assert.equal(ok.effects[0].name, 'plan.md');
  assert.match(ok.effects[0].url, /^https:\/\/auto\.example\/api\/mobile\/sessions\/s1\/download\?path=/);
  assert.equal(Object.hasOwn(ok.effects[0], 'href'), false, '不产出普通链接跳转');

  const bad = downloadArtifact(b, 'a1', 'http://auto.example');
  assert.ok(bad.browser.error, '无 HTTPS 基址给可读错误，用户可重试');
  assert.equal(bad.effects.length, 0);

  const missing = downloadArtifact(b, 'nope', 'https://auto.example/');
  assert.equal(missing.browser.error, ARTIFACT_ERRORS.missing);
});

test('artifactPagePlan：手机单栈与折叠双栏，只按状态刷新阅读侧', () => {
  const artifacts = rawArtifacts();
  const phone = createArtifactBrowser({ id: 'b1', artifacts, layout: 'phone' });
  const plan0 = artifactPagePlan(phone);
  assert.equal(plan0.dualPane, false);
  assert.equal(plan0.readerVisible, false);
  assert.equal(plan0.count, 3);

  let opened = openArtifactReader(phone, 'a1').browser;
  const plan1 = artifactPagePlan(opened);
  assert.equal(plan1.readerVisible, true);
  assert.equal(plan1.download.name, 'plan.md');

  const fold = createArtifactBrowser({ id: 'b2', artifacts, layout: 'fold', listScrollTop: 77 });
  const foldOpened = openArtifactReader(fold, 'a2').browser;
  const plan2 = artifactPagePlan(foldOpened);
  assert.equal(plan2.dualPane, true, '折叠/宽屏双栏');
  assert.equal(plan2.listVisible, true, '双栏时列表保持不动，只刷新右侧');
  assert.equal(plan2.listScrollTop, 77, '选择产物不丢列表滚动位置');
  assert.equal(plan2.download.name, 'dashboard.html');
});

// ---- mount（假 DOM）：覆盖钩子、渲染、逐级返回、下载走原生桥 ----
function fakeEl(tag = 'div') {
  const el = {
    tag, children: [], _text: '', hidden: false, dataset: {}, attrs: {}, listeners: {},
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v ?? ''); this.children = []; },
    appendChild(child) { this.children.push(child); return child; },
    replaceChildren(...nodes) { this.children = nodes; },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k] ?? null; },
    click() { for (const fn of this.listeners.click || []) fn({ target: this }); },
  };
  return el;
}
function fakeDoc() {
  const byId = {};
  return {
    getElementById(id) { return byId[id] || null; },
    createElement(tag) { return fakeEl(tag); },
    add(id) { byId[id] = fakeEl('div'); return byId[id]; },
  };
}
function collect(node, out = []) {
  out.push(node);
  for (const child of node.children || []) collect(child, out);
  return out;
}
const elText = node => collect(node).map(n => n.textContent || '').join(' ');
const buttonsNamed = (node, name) => collect(node).filter(n => n.tag === 'button' && (n.textContent || '').includes(name));

test('mount 覆盖 openSessionArtifacts：会话入口与全局页打开同一产物，双栏渲染', () => {
  const doc = fakeDoc();
  const root = doc.add('page-artifacts');
  const winListeners = {};
  const win = {
    innerWidth: 1200,
    location: { origin: 'https://auto.example' },
    addEventListener(type, fn) { (winListeners[type] ||= []).push(fn); },
  };
  const calls = [];
  const hooks = {
    openSessionArtifacts() { calls.push('default-noop'); },
    pushView(view) { calls.push(['pushView', view]); },
    popView() { calls.push(['popView']); },
    selectTab(page) { calls.push(['selectTab', page]); },
    download(url, name) { calls.push(['download', url, name]); return Promise.resolve(); },
  };
  const ctx = { client: {}, state: {}, hooks };
  const artifacts = rawArtifacts();

  mountArtifactsPage(ctx, { doc, win, feature: artifactsFeature });
  assert.ok(!calls.includes('default-noop'), 'mount 覆盖了默认空操作钩子');

  // 会话页调用入口：切到产物页并渲染同一份产物列表
  hooks.openSessionArtifacts('s1', { artifacts, returnState: groupSnapshot() });
  assert.ok(calls.some(c => Array.isArray(c) && c[0] === 'selectTab' && c[1] === 'artifacts'));
  assert.match(elText(root), /plan\.md/);
  assert.match(elText(root), /本会话产物|折叠双栏/, '双栏布局可见');

  // 宽屏点文件只刷新阅读侧：pushView 登记阅读页
  buttonsNamed(root, 'plan.md')[0].click();
  assert.ok(calls.some(c => Array.isArray(c) && c[0] === 'pushView' && c[1].id === ARTIFACT_READ_VIEW));
  assert.match(elText(root), /docs\/plan\.md/, '阅读侧显示所选产物路径');

  // 下载走原生桥，不是普通链接跳转
  calls.length = 0;
  buttonsNamed(root, '下载')[0].click();
  const dl = calls.find(c => Array.isArray(c) && c[0] === 'download');
  assert.ok(dl, '下载经 ctx.hooks.download');
  assert.match(dl[1], /^https:\/\/auto\.example\/api\/mobile\/sessions\/s1\/download\?path=/);
  assert.equal(collect(root).some(n => n.tag === 'a'), false, '页面不产生可跳转链接');
});

test('mount 返回键逐级退出：阅读页 popView；无栈时回会话交回返回态', () => {
  const doc = fakeDoc();
  const root = doc.add('page-artifacts');
  const winListeners = {};
  const win = {
    innerWidth: 400, location: { origin: 'https://auto.example' },
    addEventListener(type, fn) { (winListeners[type] ||= []).push(fn); },
  };
  const calls = [];
  const restored = [];
  const hooks = {
    pushView(v) { calls.push(['pushView', v]); },
    popView() { calls.push(['popView']); },
    selectTab(page) { calls.push(['selectTab', page]); },
    restoreSession(payload) { restored.push(payload); },
    download() { return Promise.resolve(); },
  };
  mountArtifactsPage({ client: {}, state: {}, hooks }, { doc, win, feature: artifactsFeature });

  const restore = groupSnapshot();
  hooks.openSessionArtifacts('s1', { artifacts: rawArtifacts(), returnState: restore });
  buttonsNamed(root, 'plan.md')[0].click();
  assert.ok(calls.some(c => Array.isArray(c) && c[0] === 'pushView'));

  // 应用返回键弹出阅读视图 → 只收起阅读侧，不再重复 popView
  calls.length = 0;
  for (const fn of winListeners['autoloop:view-popped'] || []) fn({ detail: { id: ARTIFACT_READ_VIEW } });
  assert.ok(!calls.some(c => Array.isArray(c) && c[0] === 'popView'));

  // 页内返回按钮：无阅读栈时退回会话并交回返回态
  const backButtons = buttonsNamed(root, '返回会话');
  assert.ok(backButtons.length > 0, '会话入口提供返回会话按钮');
  backButtons[0].click();
  assert.equal(restored.length, 1);
  assert.deepEqual(restored[0].restore, restore, '返回会话不丢草稿与滚动');
});

test('downloadFeedback 三态文案：开始/成功/失败（令牌缺失引导重新绑定）', async () => {
  const { downloadFeedback } = await import('../mobile/src/features/artifacts/index.mjs');
  assert.match(downloadFeedback('downloading', { name: 'a.md' }).text, /已开始下载 a\.md/);
  assert.match(downloadFeedback('success', { name: 'a.md' }).text, /已下载完成/);
  const net = downloadFeedback('failure', { name: 'a.md', reason: 'x' });
  assert.equal(net.retry, true);
  const nt = downloadFeedback('failure', { name: 'a.md', reason: 'AUTOLOOP_DOWNLOAD_NO_TOKEN' });
  assert.equal(nt.rebind, true);
  assert.equal(nt.retry, false);
});
