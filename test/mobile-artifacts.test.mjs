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
  listSessionArtifacts, readSessionArtifact, readableArtifactError, resolveDownload,
} from '../src/artifacts.mjs';
import * as artifactPageModule from '../mobile/src/features/artifacts/page.mjs';
import { handleMobileWrite } from '../src/mobile-write.mjs';
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
  const leaked = readableArtifactError(new Error('boom /Users/example/secret'));
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

// ---------------------------------------------------------------------------
// artifact-image-preview（2026-11-26）：图片类产物入列表、行内在线查看、封顶提示与下载备选。
// ---------------------------------------------------------------------------
function imageArtifacts() {
  return [
    { id: 'img1', path: 'out/图.png', name: '图.png', size: 2048, sessionId: 's1', task: 't' },
    { id: 'img2', path: 'out/大图.jpg', name: '大图.jpg', size: 6 * 1024 * 1024, sessionId: 's1', task: 't' },
    { id: 'a1', path: 'docs/dashboard.html', name: 'dashboard.html', size: 512, sessionId: 's1', task: 't' },
    { id: 'a2', path: 'docs/plan.md', name: 'plan.md', size: 128, sessionId: 's1', task: 't' },
  ];
}

test('artifactPagePlan 标注图片类产物：在线查看、MIME 与 5MB 封顶，HTML 预览不变', () => {
  const { artifactImageMime, ARTIFACT_IMAGE_MAX_BYTES } = artifactPageModule;
  assert.equal(ARTIFACT_IMAGE_MAX_BYTES, 5 * 1024 * 1024);
  for (const [ext, mime] of [['.png', 'image/png'], ['.JPG', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'], ['.gif', 'image/gif']]) {
    assert.equal(artifactImageMime(ext), mime, ext);
  }
  assert.equal(artifactImageMime('.md'), null, '非图片不返回 MIME');

  const b = createArtifactBrowser({ artifacts: imageArtifacts() });
  const plan = artifactPagePlan(b);
  const byId = Object.fromEntries(plan.artifacts.map(row => [row.id, row]));
  assert.equal(byId.img1.previewKind, 'image');
  assert.equal(byId.img1.imageMime, 'image/png');
  assert.equal(byId.img1.imageOverCap, false);
  assert.equal(byId.img2.previewKind, 'image');
  assert.equal(byId.img2.imageOverCap, true, '超 5MB 图片标注封顶，给提示与下载备选');
  assert.equal(byId.a1.previewKind, 'html', 'HTML 预览保持不变');
  assert.equal(byId.a2.previewKind, 'text', 'Markdown 改为文本在线预览');

  const opened = artifactPagePlan(openArtifactReader(b, 'img1').browser);
  assert.equal(opened.selected.previewKind, 'image');
  assert.equal(opened.download.name, '图.png', '下载按钮仍保留给确实需要落盘的场景');
});

test('mount 图片产物：行内在线查看走只读文件路由，data URL 就地渲染，不触发下载', async () => {
  const doc = fakeDoc();
  const root = doc.add('page-artifacts');
  const win = { innerWidth: 390, location: { origin: 'https://auto.example' }, addEventListener() {}, removeEventListener() {} };
  const fileCalls = [];
  const downloadCalls = [];
  const ctx = {
    client: {
      sessionArtifactFile: async (sid, p) => {
        fileCalls.push([sid, p]);
        return { mimeType: 'image/png', content: 'iVBORw0KGgo=', name: '图.png', size: 10, kind: 'image' };
      },
    },
    state: {},
    hooks: {
      artifacts: () => [imageArtifacts()[0]],
      download() { downloadCalls.push(1); return Promise.resolve({ started: true }); },
    },
  };
  const artifacts = [imageArtifacts()[0]];
  mountArtifactsPage(ctx, { doc, win, feature: artifactsFeature });
  buttonsNamed(root, '图.png')[0].click();
  const previewBtn = buttonsNamed(root, '在线查看')[0];
  assert.ok(previewBtn, '图片产物有行内在线查看按钮（image-preview）');
  assert.match(elText(root), /下载 图\.png/, '下载按钮保留');
  previewBtn.click();
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(fileCalls, [['s1', 'out/图.png']], '在线查看复用只读文件路由，不经原生下载桥');
  assert.equal(downloadCalls.length, 0, '在线查看不触发下载');
  const img = collect(root).find(node => node.tag === 'img');
  assert.ok(img, '图片就地以 img 渲染');
  assert.equal(img.getAttribute('src'), 'data:image/png;base64,iVBORw0KGgo=', 'data URL 不落盘、不下载');
  assert.equal(collect(root).some(node => node.tag === 'iframe'), false, '图片预览不走 HTML iframe');
});

test('mount 图片超封顶给明确提示与下载备选；加载失败就地重试', async () => {
  const doc = fakeDoc();
  const root = doc.add('page-artifacts');
  const win = { innerWidth: 390, location: { origin: 'https://auto.example' }, addEventListener() {}, removeEventListener() {} };
  const big = imageArtifacts()[1];
  const normal = imageArtifacts()[0];
  const ctx = {
    client: { sessionArtifactFile: async () => { throw new Error('no token'); } },
    state: {},
    hooks: {
      artifacts: () => [big, normal],
      download() { return Promise.resolve({ started: true }); },
    },
  };
  mountArtifactsPage(ctx, { doc, win, feature: artifactsFeature });
  buttonsNamed(root, '大图.jpg')[0].click();
  assert.match(elText(root), /超过 5MB/, '超封顶明确提示');
  assert.equal(buttonsNamed(root, '在线查看').length, 0, '超封顶不提供在线查看');
  assert.ok(buttonsNamed(root, '下载').length, '超封顶给下载备选');

  buttonsNamed(root, '返回列表')[0].click();
  buttonsNamed(root, '图.png')[0].click();
  buttonsNamed(root, '在线查看')[0].click();
  await new Promise(r => setTimeout(r, 10));
  assert.match(elText(root), /预览加载失败/, '加载失败就地提示');
  assert.ok(buttonsNamed(root, '重试').length, '失败就地重试');
  buttonsNamed(root, '重试')[0].click();
  await new Promise(r => setTimeout(r, 10));
  assert.ok(buttonsNamed(root, '重试').length, '重试后原状态仍在，可再次重试');
});

test('移动端产物服务：列表返回图片类产物、图片只读文件路由、超封顶给下载备选', async () => {
  const ws = mkdtempSync(path.join(tmpdir(), 'mobile-images-'));
  const bytes = Buffer.from('89504e470d0a1a0a', 'hex');
  const imgDir = path.join(ws, 'out');
  mkdirSync(imgDir, { recursive: true });
  writeFileSync(path.join(imgDir, '图.png'), bytes);
  writeFileSync(path.join(imgDir, '大图.jpg'), Buffer.alloc(6 * 1024 * 1024, 1));
  writeFileSync(path.join(imgDir, 'app.apk'), 'apk');
  writeFileSync(path.join(ws, 'docs.md'), '# 文档');

  const sessions = {
    async list() { return [{ id: 's1', cwd: ws, createdAt: new Date(Date.now() - 3600000).toISOString(), prompt: '任务\n细节' }]; },
    async listSessionArtifacts(id) {
      assert.equal(id, 's1');
      const at = new Date().toISOString();
      return [
        { path: 'out/图.png', name: '图.png', size: bytes.length, at, kind: 'file' },
        { path: 'out/大图.jpg', name: '大图.jpg', size: 6 * 1024 * 1024, at, kind: 'file' },
        { path: 'out/app.apk', name: 'app.apk', size: 3, at, kind: 'file' },
        { path: 'docs.md', name: 'docs.md', size: 6, at, kind: 'doc' },
      ];
    },
    async resolveSessionDownload(id, rel) { return resolveDownload(ws, rel); },
    async readSessionArtifact(id, rel) { return { path: rel, name: String(rel).split('/').pop(), content: '# x' }; },
  };
  const ctx = { config: { schedulingSessions: sessions }, device: { id: 'dev' } };
  const req = { method: 'GET', headers: { origin: 'https://auto.example', host: 'auto.example', 'x-console-request': '1', 'x-device-token': 'dev' } };
  async function call(path) {
    const res = {
      status: null, body: null,
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(body) { this.body = body; },
    };
    const url = new URL('https://auto.example' + path);
    assert.equal(handleMobileWrite(req, res, url, ctx), true, path);
    await new Promise(r => setTimeout(r, 0));
    return { status: res.status, data: JSON.parse(String(res.body)) };
  }

  const global = await call('/api/mobile/artifacts');
  assert.equal(global.status, 200);
  assert.ok(global.data.files.some(f => f.name === '图.png' && f.kind === 'image' && f.mimeType === 'image/png'), '全局列表含图片并标注 MIME');
  assert.ok(global.data.files.some(f => f.name === 'app.apk' && f.kind === 'file' && f.sessionId === 's1'), 'apk 等二进制交付物进移动端全局产物列表（与网页版一致，issue #364 回归恢复）');
  assert.equal(global.data.files.find(f => f.name === '大图.jpg').overCap, true, '超 5MB 图片标注封顶');
  const session = await call('/api/mobile/sessions/s1/artifacts');
  assert.ok(session.data.files.some(f => f.name === '图.png' && f.kind === 'image'), '会话列表同样返回图片');
  assert.ok(session.data.files.some(f => f.name === 'app.apk' && f.kind === 'file'), '会话列表同样返回二进制交付物（与网页版会话产物面板一致）');
  assert.ok(session.data.files.some(f => f.name === 'docs.md'), '会话列表保留文档条目');
  const file = await call('/api/mobile/sessions/s1/file?path=' + encodeURIComponent('out/图.png'));
  assert.equal(file.status, 200);
  assert.equal(file.data.kind, 'image');
  assert.equal(file.data.mimeType, 'image/png');
  assert.equal(Buffer.from(file.data.content, 'base64').toString('hex'), bytes.toString('hex'), '只读路由返回可在线查看的图片字节');
  const over = await call('/api/mobile/sessions/s1/file?path=' + encodeURIComponent('out/大图.jpg'));
  assert.equal(over.status, 413, '超封顶图片明确拒绝');
  assert.match(over.data.error, /5MB|下载/);
  assert.equal(over.data.download, true, '给下载备选');
});

// ---------------------------------------------------------------------------
// artifact-doc-preview（2026-11-27，issue #360）：md/文本类产物在线预览（纯文本安全渲染），
// pdf/word 如实提示保留下载；html/图片与下载反馈不回归。
// ---------------------------------------------------------------------------
function docArtifacts() {
  return [
    { id: 'd1', path: 'docs/plan.md', name: 'plan.md', size: 128, sessionId: 's1', task: 't' },
    { id: 'd2', path: 'docs/big.md', name: 'big.md', size: 600 * 1024, sessionId: 's1', task: 't' },
    { id: 'd3', path: 'out/手册.pdf', name: '手册.pdf', size: 2048, sessionId: 's1', task: 't' },
    { id: 'd4', path: 'out/合同.docx', name: '合同.docx', size: 2048, sessionId: 's1', task: 't' },
    { id: 'd5', path: 'docs/dashboard.html', name: 'dashboard.html', size: 512, sessionId: 's1', task: 't' },
  ];
}

test('artifactPagePlan 标注 md/markdown/txt 文本在线预览、pdf/word 如实提示，html/图片不回归', () => {
  const { artifactPreviewMeta, ARTIFACT_TEXT_MAX_BYTES } = artifactPageModule;
  assert.equal(ARTIFACT_TEXT_MAX_BYTES, 500 * 1024, '文本封顶与服务端只读路由 500KB 对齐');
  for (const ext of ['.md', '.markdown', '.txt', '.MD']) {
    assert.equal(artifactPreviewMeta({ path: `docs/a${ext}`, size: 10 }).previewKind, 'text', ext);
  }
  assert.equal(artifactPreviewMeta({ path: 'docs/a.md', size: 600 * 1024 }).textOverCap, true, '超封顶标注');
  assert.equal(artifactPreviewMeta({ path: 'docs/a.md', size: 10 }).textOverCap, false);
  for (const ext of ['.pdf', '.doc', '.docx']) {
    assert.equal(artifactPreviewMeta({ path: `out/a${ext}` }).previewKind, 'unsupported', ext);
  }
  assert.equal(artifactPreviewMeta({ path: 'a.html' }).previewKind, 'html', 'html 预览不回归');
  assert.equal(artifactPreviewMeta({ path: 'a.png' }).previewKind, 'image', '图片在线查看不回归');

  const plan = artifactPagePlan(createArtifactBrowser({ artifacts: docArtifacts() }));
  const byId = Object.fromEntries(plan.artifacts.map(row => [row.id, row]));
  assert.equal(byId.d1.previewKind, 'text');
  assert.equal(byId.d2.textOverCap, true);
  assert.equal(byId.d3.previewKind, 'unsupported');
  assert.equal(byId.d4.previewKind, 'unsupported');
  assert.equal(byId.d5.previewKind, 'html');
});

test('mount md 产物：点「在线预览」走只读文件路由，纯文本安全渲染，不下载不建 iframe', async () => {
  const doc = fakeDoc();
  const root = doc.add('page-artifacts');
  const win = { innerWidth: 390, location: { origin: 'https://auto.example' }, addEventListener() {}, removeEventListener() {} };
  const fileCalls = [];
  const downloadCalls = [];
  const ctx = {
    client: {
      sessionArtifactFile: async (sid, p) => {
        fileCalls.push([sid, p]);
        return { name: 'plan.md', path: 'docs/plan.md', content: '# 标题\n<script>alert(1)</script>\n<b>粗体</b>' };
      },
    },
    state: {},
    hooks: {
      artifacts: () => [docArtifacts()[0]],
      download() { downloadCalls.push(1); return Promise.resolve({ started: true }); },
    },
  };
  mountArtifactsPage(ctx, { doc, win, feature: artifactsFeature });
  buttonsNamed(root, 'plan.md')[0].click();
  const previewBtn = buttonsNamed(root, '在线预览')[0];
  assert.ok(previewBtn, 'md 产物提供「在线预览」按钮');
  assert.ok(buttonsNamed(root, '下载').length, '下载按钮保留');
  previewBtn.click();
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(fileCalls, [['s1', 'docs/plan.md']], '在线预览复用只读文件路由，不经原生下载桥');
  assert.equal(downloadCalls.length, 0, '在线预览不触发下载');
  const classes = node => String(node.getAttribute('class') || '');
  const box = collect(root).find(node => classes(node).includes('artifacts-preview'));
  assert.ok(box && box.hidden === false, '就地显示预览容器');
  const textNode = collect(root).find(node => classes(node).includes('artifacts-preview-text'));
  assert.ok(textNode, '纯文本预览节点');
  assert.match(textNode.textContent, /# 标题/);
  assert.ok(textNode.textContent.includes('<script>alert(1)</script>'), '脚本按纯文本原样显示，不解析');
  assert.equal(collect(root).some(node => node.tag === 'script' || node.tag === 'iframe'), false, '不建 iframe、不注入脚本');
});

// 审阅返工 P2（PR #361）：预览 <pre> 无换行/滚动样式，手机上长行被 .content 的 overflow-x:clip 截掉。
// CSS 文件不在本节点写域，样式就近写在预览节点上；本断言守长行换行、超长词断行、限高纵向滚动。
test('mount md 纯文本预览：长行换行、超长词断行、限高可滚动，避免手机横向截断', async () => {
  const doc = fakeDoc();
  const root = doc.add('page-artifacts');
  const win = { innerWidth: 390, location: { origin: 'https://auto.example' }, addEventListener() {}, removeEventListener() {} };
  const ctx = {
    client: { sessionArtifactFile: async () => ({ content: `# 标题\n${'A'.repeat(2000)}\n结尾` }) },
    state: {},
    hooks: { artifacts: () => [docArtifacts()[0]], download() { return Promise.resolve({ started: true }); } },
  };
  mountArtifactsPage(ctx, { doc, win, feature: artifactsFeature });
  buttonsNamed(root, 'plan.md')[0].click();
  buttonsNamed(root, '在线预览')[0].click();
  await new Promise(r => setTimeout(r, 10));
  const textNode = collect(root).find(node => String(node.getAttribute('class') || '').includes('artifacts-preview-text'));
  assert.ok(textNode, '纯文本预览节点存在');
  const style = String(textNode.getAttribute('style') || '');
  assert.match(style, /white-space\s*:\s*pre-wrap/, '保留换行同时长行自动换行');
  assert.match(style, /overflow-wrap\s*:\s*anywhere/, '超长不可断词也断行，不被横向裁掉');
  assert.match(style, /max-height\s*:/, '长文限高');
  assert.match(style, /overflow-y\s*:\s*auto/, '超出限高纵向滚动');
});

test('mount pdf/word：如实「暂不支持在线预览，请下载后查看」，保留下载且不提供在线预览', () => {
  const doc = fakeDoc();
  const root = doc.add('page-artifacts');
  const win = { innerWidth: 390, location: { origin: 'https://auto.example' }, addEventListener() {}, removeEventListener() {} };
  const ctx = {
    client: {},
    state: {},
    hooks: { artifacts: () => docArtifacts(), download() { return Promise.resolve({ started: true }); } },
  };
  mountArtifactsPage(ctx, { doc, win, feature: artifactsFeature });
  buttonsNamed(root, '手册.pdf')[0].click();
  assert.match(elText(root), /暂不支持在线预览，请下载后查看/, '不支持格式如实提示');
  assert.equal(buttonsNamed(root, '在线预览').length, 0, '不支持格式不给在线预览按钮');
  assert.ok(buttonsNamed(root, '下载').length, '不支持格式保留下载');
});

test('mount md 超封顶给明确提示与下载备选；加载失败就地重试', async () => {
  const doc = fakeDoc();
  const root = doc.add('page-artifacts');
  const win = { innerWidth: 390, location: { origin: 'https://auto.example' }, addEventListener() {}, removeEventListener() {} };
  let call = 0;
  const ctx = {
    client: {
      sessionArtifactFile: async () => {
        call += 1;
        if (call === 1) throw new Error('no token');
        return { content: '重试成功正文' };
      },
    },
    state: {},
    hooks: { artifacts: () => docArtifacts(), download() { return Promise.resolve({ started: true }); } },
  };
  mountArtifactsPage(ctx, { doc, win, feature: artifactsFeature });
  buttonsNamed(root, 'big.md')[0].click();
  assert.match(elText(root), /超过 500KB/, '超封顶明确提示');
  assert.equal(buttonsNamed(root, '在线预览').length, 0, '超封顶不提供在线预览');
  assert.ok(buttonsNamed(root, '下载').length, '超封顶给下载备选');

  buttonsNamed(root, '返回列表')[0].click();
  buttonsNamed(root, 'plan.md')[0].click();
  buttonsNamed(root, '在线预览')[0].click();
  await new Promise(r => setTimeout(r, 10));
  assert.match(elText(root), /预览加载失败/, '加载失败就地提示');
  assert.ok(buttonsNamed(root, '重试').length, '失败就地重试');
  buttonsNamed(root, '重试')[0].click();
  await new Promise(r => setTimeout(r, 10));
  assert.equal(call, 2, '重试重新走只读文件路由');
  const textNode = collect(root).find(node => String(node.getAttribute('class') || '').includes('artifacts-preview-text'));
  assert.match(textNode.textContent, /重试成功正文/, '重试成功后就地渲染正文');
  assert.equal(buttonsNamed(root, '重试').length, 0, '重试成功后撤掉失败提示');
});
