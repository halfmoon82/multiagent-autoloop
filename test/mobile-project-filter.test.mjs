// project-filter 节点（Spec §8.2 / Issue 5 / DAG wave-4）边界测试：
// 全局一级项目筛选与主导航的纯只读视图模型。
// 覆盖：与真实项目模型一致、空项目列表明确空态、所有主要 Tab 共用唯一选中值并同步过滤、
// 切换项目后返回会话上下文不变、会话自身项目不被全局筛选覆盖、纯逻辑可安全渲染。
// 不调用真实模型、不操作真实规则；feature 为纯逻辑，可在 Node 里直接做边界测试。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collection } from '../mobile/src/core/contract.mjs';
import {
  ALL_PROJECTS_ID, ALL_PROJECTS_LABEL, PROJECT_FILTER_TABS, MAIN_NAVIGATION, MAIN_NAVIGATION_IDS,
  buildProjectFilter, switchProject, buildFilterTabs, buildNavigation,
  filterByProject, applyGlobalFilter, buildSessionView, sessionProjectContext,
} from '../mobile/src/features/project-filter/index.mjs';
import {
  ALL_PROJECTS_ID as BACKEND_ALL, ALL_PROJECTS_LABEL as BACKEND_ALL_LABEL,
  mobileProjectOptions, mobileProjectFilterOptions, mobileProjectSummaries,
} from '../src/projects.mjs';

const FEATURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'mobile', 'src', 'features', 'project-filter');

// 真实形态的项目（与 /api/projects 的 {name, path} 一致），由 src/projects.mjs 投影成筛选选项。
const P1 = { name: '移动控制台', path: '/work/移动控制台' };
const P2 = { name: '控制台服务端', path: '/work/控制台服务端' };
const PROJECTS = [P1, P2];
const OPTIONS = () => mobileProjectFilterOptions(PROJECTS).options;
const filterAll = () => buildProjectFilter(OPTIONS());
const filterP1 = () => buildProjectFilter(OPTIONS(), P1.path);
const filterP2 = () => buildProjectFilter(OPTIONS(), P2.path);

// ---------------------------------------------------------------------------
// RED 1：契约与常量——与后端共享同一「全部」哨兵，覆盖 Spec §8.2 的所有主要 Tab
// ---------------------------------------------------------------------------
test('全局筛选与后端共用「全部」哨兵；主导航与筛选 Tab 一一对应且不编造', () => {
  assert.equal(ALL_PROJECTS_ID, BACKEND_ALL, 'feature 与 src/projects.mjs 的「全部」哨兵必须一致');
  assert.equal(ALL_PROJECTS_LABEL, BACKEND_ALL_LABEL);
  assert.deepEqual(PROJECT_FILTER_TABS.map(tab => tab.id),
    ['overview', 'rules', 'sessions', 'runs', 'todos', 'dag', 'artifacts'], 'Spec §8.2 七个主要 Tab');
  assert.deepEqual(MAIN_NAVIGATION_IDS, ['overview', 'rules', 'sessions', 'runs', 'todos'], '底部主导航五栏');
  assert.deepEqual(MAIN_NAVIGATION.map(tab => tab.id), [...MAIN_NAVIGATION_IDS]);
  for (const tab of [...PROJECT_FILTER_TABS, ...MAIN_NAVIGATION]) {
    assert.equal(typeof tab.title, 'string');
    assert.ok(tab.title.length > 0, '每个 Tab 都有可读标题');
  }
  for (const id of MAIN_NAVIGATION_IDS) {
    assert.ok(PROJECT_FILTER_TABS.some(tab => tab.id === id), '主导航是筛选 Tab 的子集');
  }
});

// ---------------------------------------------------------------------------
// RED 2：buildProjectFilter——真实选项、默认「全部」、空列表明确空态、失效选择回退
// ---------------------------------------------------------------------------
test('全局筛选按真实项目构造选项，默认「全部」，isAll/选中标签正确', () => {
  const filter = filterAll();
  assert.equal(filter.selectedId, ALL_PROJECTS_ID);
  assert.equal(filter.selectedLabel, ALL_PROJECTS_LABEL);
  assert.equal(filter.isAll, true);
  assert.deepEqual(filter.all, { id: ALL_PROJECTS_ID, label: ALL_PROJECTS_LABEL });
  assert.equal(filter.options.length, 3, '全部 + 两个真实项目');
  assert.equal(filter.options[0].id, ALL_PROJECTS_ID);
  assert.equal(filter.options[0].selected, true);
  assert.deepEqual(filter.options[1], { id: P1.path, label: P1.name, selected: false });
  assert.deepEqual(filter.projects.items.map(o => o.id), [P1.path, P2.path]);
  assert.equal(filter.projects.empty, false);
  assert.equal(filter.empty, false);
  assert.equal(filter.emptyReason, null);
});

test('选中具体项目：isAll 为假，选中值/标签是该真实项目且只有一个选项被选中', () => {
  const filter = filterP1();
  assert.equal(filter.selectedId, P1.path);
  assert.equal(filter.selectedLabel, P1.name);
  assert.equal(filter.isAll, false);
  assert.equal(filter.options.filter(o => o.selected).length, 1);
  assert.equal(filter.options.find(o => o.selected).id, P1.path);
});

test('项目列表为空时显示明确空态，不编造项目；「全部」仍是合法选中值', () => {
  const empty = mobileProjectFilterOptions([]);
  assert.equal(empty.empty, true);
  assert.match(empty.reason, /暂无|没有|空/);
  assert.deepEqual(empty.options, [empty.all], '空列表只有「全部」，但绝不编造具体项目');
  const filter = buildProjectFilter(empty.options);
  assert.equal(filter.empty, true);
  assert.match(filter.emptyReason, /暂无|没有|空/);
  assert.equal(filter.projects.empty, true);
  assert.match(filter.projects.reason, /暂无|没有|空/);
  assert.equal(filter.selectedId, ALL_PROJECTS_ID, '空列表默认「全部」= 不过滤');
  assert.equal(filter.isAll, true);
});

test('无效/坏形态选项与失效选中值不抛错、不编造，未知选择回退「全部」', () => {
  const bad = mobileProjectFilterOptions([null, { name: '', path: '' }, { name: '孤立名字' }, P1]);
  assert.equal(bad.options.length, 2, '只保留可投影的真实项目 + 全部');
  assert.deepEqual(bad.options[1], { id: P1.path, label: P1.name });
  assert.doesNotThrow(() => buildProjectFilter(null));
  assert.equal(buildProjectFilter(null).selectedId, ALL_PROJECTS_ID);
  assert.equal(buildProjectFilter(OPTIONS(), '/work/不存在的').selectedId, ALL_PROJECTS_ID, '失效选择回退全部，不静默按不存在项目过滤');
  assert.equal(buildProjectFilter(OPTIONS(), undefined).selectedId, ALL_PROJECTS_ID);
});

// ---------------------------------------------------------------------------
// RED 3：switchProject——不可变状态迁移，所有 Tab 共用唯一选中值
// ---------------------------------------------------------------------------
test('切换项目是不可变迁移：返回新选中值，原 filter 不变；切回「全部」恢复不过滤', () => {
  const original = filterAll();
  const switched = switchProject(original, P2.path);
  assert.equal(switched.selectedId, P2.path);
  assert.equal(switched.selectedLabel, P2.name);
  assert.equal(original.selectedId, ALL_PROJECTS_ID, '原状态不被改写');
  assert.notEqual(switched, original);
  const back = switchProject(switched, ALL_PROJECTS_ID);
  assert.equal(back.isAll, true);
  assert.equal(back.selectedId, ALL_PROJECTS_ID);
});

test('切换到失效项目回退「全部」，不产生不存在的选中值', () => {
  const switched = switchProject(filterP1(), '/work/已被删除');
  assert.equal(switched.selectedId, ALL_PROJECTS_ID);
  assert.equal(switched.isAll, true);
});

// ---------------------------------------------------------------------------
// RED 4：主导航与筛选 Tab——所有主要 Tab 显示同一当前项目（全局一级，非局部筛选）
// ---------------------------------------------------------------------------
test('buildFilterTabs：七个主要 Tab 全部携带同一当前项目，切换一次即全部同步', () => {
  const all = buildFilterTabs(filterAll());
  assert.equal(all.length, 7);
  for (const tab of all) {
    assert.equal(tab.project, ALL_PROJECTS_ID);
    assert.equal(tab.projectLabel, ALL_PROJECTS_LABEL);
  }
  // 单一状态源：切换一次后重建，七个 Tab 的 project 全部变为新值，没有任何 Tab 停留在旧值。
  const switched = switchProject(filterAll(), P1.path);
  const tabs = buildFilterTabs(switched, 'rules');
  assert.equal(tabs.length, 7);
  for (const tab of tabs) {
    assert.equal(tab.project, P1.path, `${tab.id} 必须同步到新项目`);
    assert.equal(tab.projectLabel, P1.name);
  }
  assert.equal(tabs.find(tab => tab.id === 'rules').active, true);
  assert.equal(tabs.find(tab => tab.id === 'overview').active, false);
  assert.equal(all[0].project, ALL_PROJECTS_ID, '旧 Tab 快照不被改写');
});

test('buildNavigation：底部五栏主导航都显示当前项目，active 标记正确', () => {
  const nav = buildNavigation(filterP2(), 'sessions');
  assert.equal(nav.length, 5);
  assert.deepEqual(nav.map(item => item.id), [...MAIN_NAVIGATION_IDS]);
  for (const item of nav) {
    assert.equal(item.project, P2.path);
    assert.equal(item.projectLabel, P2.name);
    assert.equal(typeof item.title, 'string');
  }
  assert.equal(nav.find(item => item.id === 'sessions').active, true);
  assert.equal(nav.find(item => item.id === 'overview').active, false);
});

// ---------------------------------------------------------------------------
// RED 5：filterByProject / applyGlobalFilter——切换后所有 Tab 同步过滤，空集合明确空态
// ---------------------------------------------------------------------------
test('filterByProject：「全部」不过滤；具体项目按真实 project 字段过滤，无项目字段的项不混入', () => {
  const items = [
    { id: 'a', project: P1.path },
    { id: 'b', project: P2.path },
    { id: 'c', project: '/work/移动控制台/' }, // 路径尾斜杠，basename 仍匹配
    { id: 'd' }, // 没有项目字段
  ];
  assert.equal(filterByProject(items, filterAll()).length, 4, '全部 = 不过滤');
  const filtered = filterByProject(items, filterP1());
  assert.deepEqual(filtered.map(item => item.id), ['a', 'c'], '只保留 P1 的项');
  assert.ok(!filtered.some(item => item.id === 'd'), '无项目字段的项在具体筛选下不混入');
  assert.equal(items.length, 4, '原数组不被改写');
});

test('filterByProject 支持数据以显示名给出 + getProject 自定义取值，仍不编造', () => {
  const items = [{ id: 'a', name: P1.name }, { id: 'b', name: P2.name }];
  // 选中以稳定 id（路径）为准；列表数据若只有显示名，按选中标签匹配。
  assert.deepEqual(filterByProject(items, filterP1(), item => item.name).map(i => i.id), ['a']);
  assert.deepEqual(filterByProject(null, filterP1()), []);
});

test('applyGlobalFilter：多个 Tab 的列表用同一选中值同步过滤，且分别给出明确空态', () => {
  const tabs = {
    rules: collection([{ id: 'r1', project: P1.path }, { id: 'r2', project: P2.path }], '暂无调度规则'),
    runs: collection([{ id: 'n1', project: P2.path }], '没有执行轮次'),
    todos: collection([{ id: 't1', project: P1.path }], '没有待办'),
    dag: collection([{ id: 'g1', project: P1.path }, { id: 'g2', project: P2.path }], '暂无项目 DAG'),
  };
  const p1 = applyGlobalFilter(tabs, filterP1());
  assert.deepEqual(p1.rules.items.map(i => i.id), ['r1']);
  assert.deepEqual(p1.runs.items.map(i => i.id), [], '该 Tab 在 P1 下无内容');
  assert.equal(p1.runs.empty, true);
  assert.match(p1.runs.reason, /项目|暂无|没有/, '过滤后空集合带明确原因');
  assert.deepEqual(p1.todos.items.map(i => i.id), ['t1']);
  assert.deepEqual(p1.dag.items.map(i => i.id), ['g1']);
  // 原始数据不被改写（只读视图模型）。
  assert.equal(tabs.rules.items.length, 2);
  assert.equal(tabs.runs.items.length, 1, '原始集合不被改写');
  assert.equal(tabs.runs.reason, null, '非空集合的 reason 保持原样');

  const all = applyGlobalFilter(tabs, filterAll());
  assert.equal(all.rules.items.length, 2, '切回全部恢复全部 Tab 的内容');
  assert.equal(all.runs.items.length, 1);
  assert.equal(all.runs.reason, null, '非空集合不残留旧空态原因');

  const p2 = applyGlobalFilter(tabs, filterP2());
  assert.deepEqual(p2.rules.items.map(i => i.id), ['r2']);
  assert.deepEqual(p2.runs.items.map(i => i.id), ['n1']);
});

test('applyGlobalFilter：原本就因数据缺失为空的 Tab 保留其缺失原因，不被改写成「所选项目下无内容」', () => {
  const tabs = { rules: collection([], '规则数据缺失：Hub 不可达') };
  const result = applyGlobalFilter(tabs, filterP1());
  assert.equal(result.rules.empty, true);
  assert.match(result.rules.reason, /Hub 不可达/);
});

// ---------------------------------------------------------------------------
// RED 6：会话内上下文——全局筛选不改变会话所属项目，返回会话后上下文不变
// ---------------------------------------------------------------------------
test('sessionProjectContext：会话显示自身所属项目，绝不被全局筛选覆盖', () => {
  const session = { id: 's-1', title: '设计推进', project: P1.path };
  const ctx = sessionProjectContext(session, filterP2());
  assert.equal(ctx.project, P1.path, '仍显示会话自身项目，不是筛选选中的 P2');
  assert.equal(ctx.projectLabel, P1.name);
  assert.equal(ctx.globalFilter, P2.path, '全局筛选只作为参考字段保留');
  assert.equal(ctx.overridden, false);
});

test('切换项目后返回会话，原会话所属项目保持正确；筛选往返都不改写会话上下文', () => {
  const session = { id: 's-1', title: '设计推进', project: P1.path };
  const before = buildSessionView(session, filterP2());
  assert.equal(before.context.project, P1.path);
  assert.equal(before.filtered, false, '会话正文/上下文不做项目级裁剪');

  const switchedAll = switchProject(filterP2(), ALL_PROJECTS_ID);
  const switchedP2 = switchProject(switchedAll, P2.path);
  const after = buildSessionView(session, switchedP2);
  assert.equal(after.context.project, P1.path, '筛选往返后会话项目仍正确');
  assert.equal(after.context.projectLabel, P1.name);
  assert.equal(after.filtered, false);
  assert.deepEqual(after.context.project, before.context.project, '上下文不变');
  assert.equal(session.project, P1.path, '会话对象本身从不被改写');
});

test('会话列表按全局筛选过滤，但进入会话详情后上下文仍取其自身项目', () => {
  const sessions = [
    { id: 's-1', project: P1.path },
    { id: 's-2', project: P2.path },
  ];
  const list = filterByProject(sessions, filterP2());
  assert.deepEqual(list.map(s => s.id), ['s-2'], '会话列表按筛选只显示 P2');
  // 列表被过滤，不改变 s-1 自己的上下文。
  const detail = buildSessionView(sessions[0], filterP2());
  assert.equal(detail.context.project, P1.path);
  assert.equal(detail.context.projectLabel, P1.name);
});

test('无项目字段或坏形态会话也只给「未识别」空态，不编造、不抛错', () => {
  assert.doesNotThrow(() => buildSessionView(null, filterAll()));
  const view = buildSessionView(null, filterAll());
  assert.equal(view.context.project, null);
  assert.equal(view.context.projectLabel, '未识别');
  assert.equal(view.context.overridden, false);
});

// ---------------------------------------------------------------------------
// RED 7：后端 src/projects.mjs 选项——真实投影、空态、不编造，与 feature 共用后端数据
// ---------------------------------------------------------------------------
test('mobileProjectFilterOptions：全部 + 真实项目，空列表明确空态，与 mobileProjectSummaries 一致', () => {
  const result = mobileProjectFilterOptions(PROJECTS);
  assert.deepEqual(result.all, { id: ALL_PROJECTS_ID, label: ALL_PROJECTS_LABEL });
  assert.deepEqual(result.options[0], result.all);
  assert.deepEqual(result.options.slice(1), mobileProjectSummaries(PROJECTS));
  assert.equal(result.empty, false);
  assert.equal(result.reason, null);
  assert.deepEqual(mobileProjectOptions(PROJECTS)[0], result.all, '既有 mobileProjectOptions 与筛选选项共用同一口径');
  const empty = mobileProjectFilterOptions([]);
  assert.equal(empty.empty, true);
  assert.match(empty.reason, /暂无|没有|空/);
  assert.deepEqual(empty.options, [empty.all]);
});

// ---------------------------------------------------------------------------
// RED 8：端到端装配 + 纯逻辑/安全渲染
// ---------------------------------------------------------------------------
test('端到端：真实 /api/projects 选项 → 筛选 → 所有 Tab 同步 → 返回会话上下文不变', () => {
  const backend = mobileProjectFilterOptions(PROJECTS);
  const filter = buildProjectFilter(backend.options, P1.path);
  const tabs = buildFilterTabs(filter);
  assert.equal(tabs.length, 7);
  for (const tab of tabs) assert.equal(tab.project, P1.path, '所有主要 Tab 同步到 P1');
  const nav = buildNavigation(filter);
  for (const item of nav) assert.equal(item.project, P1.path, '主导航同步到 P1');

  const lists = applyGlobalFilter({
    overview: collection([{ project: P1.path }, { project: P2.path }], '暂无'),
    artifacts: collection([{ project: P2.path }], '暂无'),
  }, filter);
  assert.equal(lists.overview.items.length, 1);
  assert.equal(lists.artifacts.items.length, 0);

  const session = { id: 's-1', project: P1.path };
  assert.equal(buildSessionView(session, filter).context.project, P1.path);
  const restored = switchProject(filter, P2.path);
  assert.equal(buildSessionView(session, restored).context.project, P1.path, '切换项目后返回会话，上下文不变');
});

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

test('上游文本全程是纯字符串：视图模型可安全渲染，不泄漏密钥或拼接标签', () => {
  const filter = filterP1();
  const dump = JSON.stringify({
    filter, tabs: buildFilterTabs(filter), nav: buildNavigation(filter),
    view: buildSessionView({ id: 's', project: P1.path }, filter),
  });
  assert.ok(!dump.includes('<script') && !dump.includes('</div>') && !dump.includes('onerror='));
  assert.ok(!dump.includes('deviceToken') && !dump.includes('ownerKey') && !dump.includes('server-secret'));
});

// ---------------------------------------------------------------------------
// RED 9：浏览器侧筛选控制器——DOM 无关的纯接线（投影 / 加载 / 订阅 / 切换广播）
// ---------------------------------------------------------------------------
const PF_BROWSER = '../mobile/src/features/project-filter/browser.mjs';

test('projectOptionsFrom：把 /api/projects 真实行投影成筛选选项，坏项不编造', async () => {
  const { projectOptionsFrom } = await import(PF_BROWSER);
  const options = projectOptionsFrom({ projects: [P1, null, { name: '', path: '' }, P2] });
  assert.deepEqual(options, [
    { id: ALL_PROJECTS_ID, label: ALL_PROJECTS_LABEL },
    { id: P1.path, label: P1.name },
    { id: P2.path, label: P2.name },
  ]);
  const empty = [{ id: ALL_PROJECTS_ID, label: ALL_PROJECTS_LABEL }];
  assert.deepEqual(projectOptionsFrom(null), empty);
  assert.deepEqual(projectOptionsFrom({ projects: [] }), empty);
  assert.deepEqual(projectOptionsFrom([P1]), [
    { id: ALL_PROJECTS_ID, label: ALL_PROJECTS_LABEL },
    { id: P1.path, label: P1.name },
  ]);
});

test('createProjectFilterController：加载/切换不可变并通知订阅者，失效选择回退全部', async () => {
  const { createProjectFilterController } = await import(PF_BROWSER);
  let rows = { projects: PROJECTS };
  const controller = createProjectFilterController({ load: async () => rows });
  assert.equal(controller.filter.selectedId, ALL_PROJECTS_ID, '初始为「全部」= 不过滤');

  const events = [];
  const off = controller.subscribe(filter => events.push(filter.selectedId));
  await controller.reload();
  assert.equal(controller.filter.selectedId, ALL_PROJECTS_ID);
  assert.equal(controller.filter.options.length, 3);
  assert.deepEqual(events, [ALL_PROJECTS_ID], 'reload 完成通知一次');

  controller.select(P1.path);
  assert.equal(controller.filter.selectedId, P1.path);
  assert.equal(controller.filter.isAll, false);
  assert.deepEqual(events, [ALL_PROJECTS_ID, P1.path]);

  controller.select('/work/已被删除');
  assert.equal(controller.filter.isAll, true, '失效值回退全部，不静默按不存在项目过滤');
  off();
  controller.select(P2.path);
  assert.equal(events.length, 3, '取消订阅后不再收到通知');
});

test('createProjectFilterController：加载失败保留明确错误，不编造项目', async () => {
  const { createProjectFilterController } = await import(PF_BROWSER);
  const controller = createProjectFilterController({ load: async () => { throw new Error('Hub 不可达'); } });
  await controller.reload();
  assert.equal(controller.filter.isAll, true);
  assert.equal(controller.filter.empty, true);
  assert.match(controller.error, /Hub 不可达/);
  assert.equal(controller.loading, false);
});
