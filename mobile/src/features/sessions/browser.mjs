// 会话页数据/体验纯助手：只打固定只读路径与固定写路由，设备凭证只放请求头。
// 不碰 DOM、不依赖 node: 内置模块；fetch 与取凭证函数由调用方注入，便于边界测试。

import { buildSessionList, buildArchiveDetail } from './views.mjs';
import { mobileSessionSummaries, mobileArchiveSummaries, mobileArchiveTranscript } from './projections.mjs';

// 固定只读路径：只打服务端 /api/mobile/api/<key> 隧道中继（允许列表见壳的 MOBILE_API_KEYS），
// 绝不直连网页桌面接口——隧道只转发 /api/mobile/*，直连会被 ingress 404。
export const SESSION_READ_PATHS = Object.freeze(['/api/mobile/api/sessions', '/api/mobile/api/session-archives']);
export const SESSION_CONTEXT_KEY = 'nomoto-sessions-context';

function resolveUrl(origin, path) {
  const base = typeof origin === 'string' && origin ? origin : globalThis.location?.origin;
  const url = new URL(path, base || 'https://localhost');
  if (!base || url.origin !== new URL(base).origin) throw new Error('读取目标不是当前控制台');
  return url.toString();
}

// 只读数据：两个接口独立成功/失败；任一路失败只影响对应集合，不编造会话。
export function createSessionsReader({ origin = '', fetchImpl, getToken, isActive } = {}) {
  const doFetch = fetchImpl || ((url, init) => globalThis.fetch(url, init));
  // 活性闸：解除授权/锁屏会翻转为 false，在途加载在两次读取之间被取消，
  // 避免拿着刚失效的令牌去打中继（401 资源噪音 + 无意义请求）。调用方注入壳状态。
  const stillActive = () => typeof isActive !== 'function' || isActive();
  const read = async path => {
    if (!stillActive()) throw new Error('连接已失效，跳过读取');
    const url = resolveUrl(origin, path);
    const headers = { accept: 'application/json' };
    if (typeof getToken === 'function') {
      const token = await getToken();
      if (token) headers['x-device-token'] = token;
    }
    let response;
    try { response = await doFetch(url, { method: 'GET', headers }); }
    catch { throw new Error('无法连接控制台，请检查网络或地址'); }
    if (!response.ok) throw new Error(`读取失败（${response.status}），请重试`);
    let payload = {};
    try { payload = await response.json(); } catch { throw new Error('控制台返回的数据无法解析'); }
    return payload;
  };

  return {
    async load(options = {}) {
      const errors = {};
      // null 代表读取失败：视图模型会给出明确空态，绝不把失败伪装成「暂无数据」。
      let active = null;
      let archived = null;
      try {
        if (!stillActive()) throw new Error('连接已失效，跳过读取');
        const payload = await read(SESSION_READ_PATHS[0]);
        active = Array.isArray(payload) ? payload : (Array.isArray(payload?.sessions) ? payload.sessions : []);
      } catch (error) { errors.sessionsError = String(error?.message || error || '读取失败'); }
      try {
        if (!stillActive()) throw new Error('连接已失效，跳过读取');
        const payload = await read(SESSION_READ_PATHS[1]);
        archived = Array.isArray(payload?.sessions) ? payload.sessions : (Array.isArray(payload) ? payload : []);
      } catch (error) { errors.archivesError = String(error?.message || error || '读取失败'); }

      // 新会话置顶：接口返回顺序是插入序，按更新时间倒序后取第一条作为当前会话。
      const stamp = value => { const parsed = Date.parse(value); return Number.isNaN(parsed) ? 0 : parsed; };
      // updatedAt 不可解析时回退 createdAt，坏时间戳沉底。
      const recency = item => stamp(item.updatedAt) || stamp(item.createdAt);
      // 放行状态来自后端公开会话的 planApproved；摘要投影不带它，这里按 id 并回（只并布尔值）。
      const approved = new Set((active || []).filter(item => item?.planApproved === true).map(item => item.id));
      const summaries = mobileSessionSummaries(active)
        .map(item => ({ ...item, planApproved: approved.has(item.id) }))
        .sort((a, b) => recency(b) - recency(a));
      const snapshot = {
        sessions: active === null ? null : summaries,
        archives: archived === null ? null : mobileArchiveSummaries(archived),
        currentId: summaries[0]?.id || null,
        ...errors,
      };
      return {
        snapshot,
        rawArchives: archived,
        list: buildSessionList(snapshot, options),
      };
    },
    archiveDetail(record) {
      return buildArchiveDetail(mobileArchiveTranscript(record));
    },
  };
}

// 写操作：只打 src/mobile-write.mjs 已登记的固定写路由；同源、设备凭证在头。
export function createSessionsWrite(client, { fetchImpl } = {}) {
  if (!client || !client.origin || typeof client.tokenStore?.get !== 'function') {
    throw new TypeError('createSessionsWrite 需要带 origin/tokenStore 的移动端客户端');
  }
  const doFetch = fetchImpl || ((url, init) => globalThis.fetch(url, init));
  const call = async (path, body) => {
    const token = await client.tokenStore.get();
    if (typeof token !== 'string' || !token) throw new Error('尚未绑定设备，请重新绑定后再操作');
    const url = new URL(path, client.origin);
    if (url.origin !== client.origin) throw new Error('写操作目标不是当前控制台');
    let response;
    try {
      response = await doFetch(url.toString(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-console-request': '1',
          'x-device-token': token,
        },
        body: JSON.stringify(body),
      });
    } catch { throw new Error('无法连接控制台，操作未提交，请重试'); }
    let payload = {};
    try { payload = await response.json(); } catch { /* 非 JSON 响应用通用错误文案 */ }
    if (!response.ok) {
      throw new Error(String(payload?.error || `操作失败（${response.status}），请重试`));
    }
    return payload;
  };

  return {
    continueSession(id) {
      const value = encodeURIComponent(String(id ?? '').trim());
      if (!value) throw new Error('会话不存在或已失效');
      return call(`/api/mobile/sessions/${value}/continue`, {});
    },
    answerCard(id, { choice, text } = {}) {
      const cardId = encodeURIComponent(String(id ?? '').trim());
      if (!cardId) throw new Error('事项不存在或已失效');
      const payload = choice !== undefined ? { choice: Number(choice) } : { text: String(text ?? '') };
      return call(`/api/mobile/cards/${cardId}/answer`, payload);
    },
    // 关闭会话：会话已结束时服务端返回 alreadyClosed，不重复操作。
    closeSession(id) {
      const value = encodeURIComponent(String(id ?? '').trim());
      if (!value) throw new Error('会话不存在或已失效');
      return call(`/api/mobile/sessions/${value}/close`, {});
    },
    approvePlan(id) {
      const value = encodeURIComponent(String(id ?? '').trim());
      if (!value) throw new Error('会话不存在或已失效');
      return call(`/api/mobile/sessions/${value}/approve-plan`, {});
    },
    sendMessage(id, { text } = {}) {
      const value = encodeURIComponent(String(id ?? '').trim());
      if (!value) throw new Error('会话不存在或已失效');
      return call(`/api/mobile/sessions/${value}/messages`, { text: String(text ?? '') });
    },
    // 新建与分类只打移动端网关已登记写路由；项目必须来自下拉的真实选项。
    classify(text) {
      return call('/api/mobile/session-classify', { text: String(text ?? '') });
    },
    createSession({ project, prompt, kind } = {}) {
      const value = String(project ?? '').trim();
      const firstTurn = String(prompt ?? '').trim();
      if (!value || !firstTurn) throw new Error('请选择项目并输入首轮提示词');
      const payload = { project: value, prompt: firstTurn };
      if (kind) payload.kind = String(kind);
      return call('/api/mobile/sessions', payload);
    },
  };
}

// 虚拟列表：只算可视区上下 overscan 条，超长会话不整表渲染。
export function visibleRange({ scrollTop = 0, viewportHeight = 0, itemHeight = 1, total = 0, overscan = 4 } = {}) {
  const height = Math.max(1, Number(itemHeight) || 1);
  const viewport = Math.max(0, Number(viewportHeight) || 0);
  const top = Math.max(0, Number(scrollTop) || 0);
  const count = Math.max(0, Number(total) || 0);
  const overs = Math.max(0, Number(overscan) || 0);
  const first = Math.floor(top / height);
  const visible = Math.ceil(viewport / height);
  const start = Math.min(count, Math.max(0, first - overs));
  const end = Math.min(count, Math.max(start, first + visible + overs));
  return { start, end };
}

// 流式分片合成为一帧文本，避免逐字触发整列表重渲染。
export function mergeStreamFrames(frames) {
  return (Array.isArray(frames) ? frames : []).map(frame => String(frame ?? '')).join('');
}

// 用户在底部才自动跟随；上翻时返回 false，由页面显示「回到底部」。
export function shouldFollowScroll({ scrollTop = 0, scrollHeight = 0, clientHeight = 0, threshold = 80 } = {}) {
  const remaining = Number(scrollHeight) - (Number(scrollTop) + Number(clientHeight));
  if (!Number.isFinite(remaining) || remaining <= 0) return true;
  return remaining <= Math.max(0, Number(threshold) || 0);
}

// 默认 attachVoice 是空操作；只有真正实现（函数体非空）才显示麦克风按钮。
export function hasVoiceHook(hooks) {
  const fn = hooks && hooks.attachVoice;
  if (typeof fn !== 'function') return false;
  const source = Function.prototype.toString.call(fn)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/\s+/g, '');
  const open = source.indexOf('{');
  const close = source.lastIndexOf('}');
  if (open < 0 || close <= open) return false;
  return source.slice(open + 1, close).length > 0;
}
