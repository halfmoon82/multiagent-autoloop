// 全局项目筛选的浏览器侧接线（DOM 无关）：把 /api/projects 的真实项目投影成筛选选项，
// 管理唯一选中值并向订阅页面广播。纯逻辑：不碰 DOM/window、不 import node 内置模块；
// 浏览器里由 pages/project-filter.mjs 注入 api，Node 边界测试注入假 load。

import { ALL_PROJECTS_ID, ALL_PROJECTS_LABEL, buildProjectFilter, switchProject } from './index.mjs';

// 与后端 src/projects.mjs 的 mobileProjectOptions 同口径：只投影真实 name/path，坏项不生成。
// 这里不 import 后端模块（它依赖 node:fs，浏览器不可加载）；「全部」哨兵由本 feature 定义并由测试守门一致。
export function projectOptionsFrom(response) {
  const rows = Array.isArray(response)
    ? response
    : (response && typeof response === 'object' && Array.isArray(response.projects) ? response.projects : []);
  const projects = rows
    .map(project => ({
      id: String(project?.path ?? project?.id ?? '').trim(),
      label: String(project?.name ?? project?.label ?? '').trim(),
    }))
    .filter(option => option.id && option.label);
  return [{ id: ALL_PROJECTS_ID, label: ALL_PROJECTS_LABEL }, ...projects];
}

// 纯控制器：load 返回 /api/projects 的响应；订阅者在 reload/select 后收到新的筛选视图。
// 切换不可变（switchProject 返回新对象）；加载失败保留明确错误，不编造项目，也不覆盖会话上下文。
export function createProjectFilterController({ load } = {}) {
  let filter = buildProjectFilter([]);
  let error = null;
  let loading = false;
  const listeners = new Set();

  const notify = () => {
    for (const listener of [...listeners]) {
      try { listener(filter); } catch { /* 单个订阅者出错不影响其他页面 */ }
    }
  };

  return {
    get filter() { return filter; },
    get error() { return error; },
    get loading() { return loading; },
    snapshot() { return { filter, error, loading }; },
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async reload() {
      loading = true;
      try {
        const response = typeof load === 'function' ? await load() : null;
        filter = buildProjectFilter(projectOptionsFrom(response), filter.selectedId);
        error = null;
      } catch (cause) {
        error = `项目数据缺失：${cause?.message || cause || '未读取到项目列表'}`;
        filter = buildProjectFilter([], filter.selectedId);
      } finally {
        loading = false;
        notify();
      }
      return filter;
    },
    select(id) {
      filter = switchProject(filter, id);
      notify();
      return filter;
    },
  };
}
