// 全局一级项目筛选与主导航（Spec §8.2 / Issue 5 / DAG wave-4）。
// 纯只读视图模型：输入是经 src/projects.mjs 投影的 {id,label} 选项与各 Tab 的真实列表，
// 输出是可安全渲染的普通对象。不碰 DOM、不依赖 node 内置模块、不拼接 HTML 字符串；上游文本为纯字符串。
// 唯一选中值由所有主要 Tab 共用；筛选是列表级范围，绝不改写会话自身的项目上下文。
// 复用 mobile/src/core 的共享口径（collection / projectName），保证与网页控制台显示一致。
import { collection, projectName } from '../../core/contract.mjs';

// 「全部」哨兵：不是任何真实项目，表示不过滤。与 src/projects.mjs 的 mobileProjectOptions 首项一致。
export const ALL_PROJECTS_ID = '全部';
export const ALL_PROJECTS_LABEL = '全部';

// 所有主要 Tab：显示当前项目并共用同一全局筛选值（Spec §8.2）。
export const PROJECT_FILTER_TABS = Object.freeze(
  [
    { id: 'overview', title: '总览' },
    { id: 'rules', title: '调度规则' },
    { id: 'sessions', title: '会话' },
    { id: 'runs', title: '执行轮次' },
    { id: 'todos', title: '待我处理' },
    { id: 'dag', title: '项目 DAG' },
    { id: 'artifacts', title: '产物' },
  ].map(tab => Object.freeze(tab)),
);

// 底部主导航五栏（设计稿「主导航」）；是 PROJECT_FILTER_TABS 的子集，同样显示当前项目。
export const MAIN_NAVIGATION_IDS = Object.freeze(['overview', 'rules', 'sessions', 'runs', 'todos']);
export const MAIN_NAVIGATION = Object.freeze(
  MAIN_NAVIGATION_IDS.map(id => PROJECT_FILTER_TABS.find(tab => tab.id === id)),
);

const isOption = value => value && typeof value === 'object' && !Array.isArray(value)
  && typeof value.id === 'string' && value.id.length > 0
  && typeof value.label === 'string' && value.label.length > 0;

// 从真实项目选项构造全局筛选视图模型。
// options 来自 src/projects.mjs 的 mobileProjectFilterOptions().options（首项是「全部」）。
export function buildProjectFilter(options, requestedId = ALL_PROJECTS_ID) {
  const list = (Array.isArray(options) ? options : []).filter(isOption);
  const all = list.find(option => option.id === ALL_PROJECTS_ID)
    ?? { id: ALL_PROJECTS_ID, label: ALL_PROJECTS_LABEL };
  const projects = list.filter(option => option.id !== ALL_PROJECTS_ID);
  // 未知/失效选中值一律回退「全部」，绝不按不存在的项目静默过滤。
  const valid = requestedId === all.id || projects.some(option => option.id === requestedId);
  const selectedId = valid ? requestedId : all.id;
  const current = list.find(option => option.id === selectedId) ?? all;
  const selectable = [...(list.some(option => option.id === all.id) ? [] : [all]), ...list];
  return {
    all,
    selectedId,
    selectedLabel: current.label,
    isAll: selectedId === all.id,
    options: selectable.map(option => ({
      id: option.id, label: option.label, selected: option.id === selectedId,
    })),
    projects: collection(projects, '暂无可筛选的项目'),
    empty: projects.length === 0,
    emptyReason: projects.length === 0 ? '暂无可筛选的项目' : null,
  };
}

// 切换项目（不可变迁移）：复用当前 filter 的选项，所有 Tab 共用新的唯一选中值。
export function switchProject(filter, id) {
  const options = [filter?.all, ...(Array.isArray(filter?.projects?.items) ? filter.projects.items : [])]
    .filter(isOption);
  return buildProjectFilter(options, id);
}

function tabView(tab, filter, activeId) {
  return {
    id: tab.id,
    title: tab.title,
    active: tab.id === activeId,
    project: filter.selectedId,
    projectLabel: filter.selectedLabel,
  };
}

// 七个主要 Tab 全部携带同一当前项目，证明它是全局一级筛选（切换一次即全部同步）。
export function buildFilterTabs(filter, activeId = null) {
  return PROJECT_FILTER_TABS.map(tab => tabView(tab, filter, activeId));
}

// 底部主导航五栏，同样显示当前项目。
export function buildNavigation(filter, activeId = null) {
  return MAIN_NAVIGATION.map(tab => tabView(tab, filter, activeId));
}

// 单条数据是否落在当前筛选范围：'全部' 全部保留；具体项目按真实 project 值或其显示名匹配。
// 无项目字段的项在具体筛选下不混入（与全局筛选隐藏无归属卡片一致）。
function projectMatches(value, filter) {
  if (filter.isAll) return true;
  const raw = String(value ?? '').trim();
  if (!raw) return false;
  const name = projectName(raw);
  return raw === filter.selectedId || name === filter.selectedId
    || raw === filter.selectedLabel || name === filter.selectedLabel;
}

// 按当前全局选中值过滤一个列表：只读、不改原数据、不编造条目。
export function filterByProject(items, filter, getProject = item => item?.project) {
  const list = Array.isArray(items) ? items : [];
  if (filter.isAll) return list;
  const accessor = typeof getProject === 'function' ? getProject : (item => item?.project);
  return list.filter(item => projectMatches(accessor(item), filter));
}

// 所有主要 Tab 的列表集合用同一选中值同步过滤；返回新的集合映射，不改原数据。
// 每个过滤后为空的集合都带明确原因；原本因数据缺失为空的保留其缺失原因。
export function applyGlobalFilter(tabCollections, filter, getProject) {
  const source = tabCollections && typeof tabCollections === 'object' && !Array.isArray(tabCollections)
    ? tabCollections : {};
  const result = {};
  for (const [tabId, col] of Object.entries(source)) {
    const items = Array.isArray(col?.items) ? col.items : [];
    const originallyEmpty = items.length === 0;
    const filtered = filterByProject(items, filter, getProject);
    const reason = filtered.length === 0
      ? (originallyEmpty ? (col?.reason || '暂无内容') : `项目「${filter.selectedLabel}」下暂无内容`)
      : null;
    result[tabId] = { ...col, items: filtered, empty: filtered.length === 0, reason };
  }
  return result;
}

// 会话内上下文由会话自身数据决定，全局筛选绝不覆盖。
// session.project 是会话所属项目（path/name），只读；进入会话后仍显示它。
export function sessionProjectContext(session, filter) {
  const project = String(session?.project ?? session?.cwd ?? '').trim() || null;
  return {
    project,
    projectLabel: project
      ? (String(session?.projectLabel ?? '').trim() || projectName(project))
      : '未识别',
    globalFilter: filter?.selectedId ?? ALL_PROJECTS_ID,
    globalFilterLabel: filter?.selectedLabel ?? ALL_PROJECTS_LABEL,
    overridden: false,
  };
}

// 会话详情视图：全局筛选只影响列表 Tab，不裁剪会话正文/待回答组/产物的上下文。
export function buildSessionView(session, filter) {
  return {
    id: session?.id ?? null,
    title: String(session?.title ?? '').trim() || '会话',
    context: sessionProjectContext(session, filter),
    filtered: false,
  };
}
