// 移动端核心页面数据装配：只消费固定只读中继（/api/mobile/api/<key>）的响应。
// 单个 key 失败/坏形态只把该 key 标成缺失并记原因，其余页面照常渲染；不猜内容、不补默认值。
import { buildPages } from './pages.mjs';

// 这些 key 必须全部落在壳的 MOBILE_API_KEYS 允许列表里（test/mobile-core.test.mjs 守门）。
export const CORE_API_KEYS = Object.freeze(['state', 'projects', 'rules', 'dag-runs', 'serial-progress']);

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const VALIDATORS = {
  state: value => isObject(value),
  projects: value => isObject(value) && Array.isArray(value.projects),
  rules: value => isObject(value) && Array.isArray(value.rules),
  'dag-runs': value => isObject(value) && Array.isArray(value.runs),
  'serial-progress': value => isObject(value) && Array.isArray(value.chains),
};
const MISSING = Object.freeze({
  state: '状态数据缺失，未读取到控制台状态',
  projects: '项目数据缺失，未读取到项目列表',
  rules: '规则数据缺失，未读取到调度规则',
  'dag-runs': 'DAG 数据缺失，未读取到项目 DAG 进度',
  'serial-progress': '串行进度数据缺失，未读取到串行链进度',
});

export function assembleSnapshot(responses = {}) {
  const source = isObject(responses) ? responses : {};
  const available = {};
  const errors = {};
  const normalized = {};
  for (const key of CORE_API_KEYS) {
    const value = source[key];
    const ok = VALIDATORS[key](value);
    available[key] = ok;
    normalized[key] = ok ? value : null;
    if (!ok) errors[key] = String(source[`${key}Error`] || MISSING[key]).trim() || MISSING[key];
  }
  return {
    available, errors,
    state: normalized.state,
    projects: normalized.projects ? normalized.projects.projects : null,
    rules: normalized.rules,
    dagRuns: normalized['dag-runs'] ? normalized['dag-runs'].runs : null,
    serial: normalized['serial-progress'],
  };
}

// api(key) 由调用方注入（壳的 createMobileClient().api）；core 自身不发请求、不碰设备凭证。
export function createMobileCore({ api, now = () => new Date() } = {}) {
  if (typeof api !== 'function') throw new TypeError('createMobileCore 需要 api(key) 函数');
  return {
    async load() {
      const responses = {};
      await Promise.all(CORE_API_KEYS.map(async key => {
        try { responses[key] = await api(key); }
        catch (error) { responses[`${key}Error`] = String(error?.message || error || '读取失败'); }
      }));
      const snapshot = assembleSnapshot(responses);
      return { snapshot, pages: buildPages(snapshot, { now: now() }) };
    },
  };
}
