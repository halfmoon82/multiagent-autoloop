// 会话页数据/体验纯助手：只打固定只读路径与固定写路由，设备凭证只放请求头。
// 不碰 DOM、不依赖 node: 内置模块；fetch 与取凭证函数由调用方注入，便于边界测试。

import { buildSessionList, buildArchiveDetail } from './views.mjs';
import { mobileSessionSummaries, mobileArchiveSummaries, mobileArchiveTranscript } from './projections.mjs';

// 固定只读路径：只打服务端 /api/mobile/api/<key> 隧道中继（允许列表见壳的 MOBILE_API_KEYS），
// 绝不直连网页桌面接口——隧道只转发 /api/mobile/*，直连会被 ingress 404。
export const SESSION_READ_PATHS = Object.freeze(['/api/mobile/api/sessions', '/api/mobile/api/session-archives']);
export const SESSION_CONTEXT_KEY = 'nomoto-sessions-context';

// ---- 统一「卡已答」状态源（card-two-places，2026-11-26 晨）----
// fix4 的 markCardAnswered 只改会话页的 state.cards，待办页另持 answeredIds，两处各自为政，
// 于是在「待办」答完的卡仍留在会话窗。这里把本机已办结的卡收敛到唯一状态源：
// 会话页与待办页共用同一个 sessions 写客户端（index.mjs → browser.mjs），任一处办结成功都登记，
// 会话卡归属过滤（openCardsBySession）从同一处取，切回会话窗时该卡即随待办一起收起。
// 只记本机观察到的办结；Hub 重读到已结案后自然不再出现，不编造远端状态。
const locallyAnsweredCards = new Map(); // id -> { answer, at }
const cardKey = id => String(id ?? '').trim();

export function markCardAnsweredLocal(id, payload = {}) {
  const key = cardKey(id);
  if (!key) return false;
  locallyAnsweredCards.set(key, {
    answer: payload && payload.choice !== undefined
      ? { choice: Number(payload.choice) }
      : { text: String(payload?.text ?? '') },
    at: Date.now(),
  });
  notifyLocallyAnswered(key);
  return true;
}
export function isCardAnsweredLocal(id) { return locallyAnsweredCards.has(cardKey(id)); }
export function locallyAnsweredIds() { return [...locallyAnsweredCards.keys()]; }
export function resetLocallyAnswered() { locallyAnsweredCards.clear(); }

// 状态源变化订阅（2026-11-26 review P2-1）：任一处办结登记后立刻通知订阅方
// （待办页据此重渲染收起该卡并同步角标），不等切页重载或下拉刷新。
const answeredListeners = new Set();
export function onLocallyAnsweredChange(listener) {
  if (typeof listener !== 'function') return () => {};
  answeredListeners.add(listener);
  return () => answeredListeners.delete(listener);
}
function notifyLocallyAnswered(key) {
  for (const listener of answeredListeners) {
    try { listener(key); } catch { /* 单个监听器异常不影响登记与其他监听器 */ }
  }
}

// 与 fix4 的 markCardAnswered 合并为同一入口：既产出标记已答的卡片副本，又登记统一状态源。
// 不改原数组，与 cardsToQuestionGroup 的 HANDLED_STATES 过滤衔接。
export function markCardAnswered(cards, id, payload = {}) {
  const key = cardKey(id);
  const answer = payload && payload.choice !== undefined
    ? { choice: Number(payload.choice) }
    : { text: String(payload?.text ?? '') };
  markCardAnsweredLocal(key, payload);
  return (Array.isArray(cards) ? cards : []).map(card => (
    card && typeof card === 'object' && cardKey(card.id) === key
      ? { ...card, state: 'answered', answer }
      : card
  ));
}

function resolveUrl(origin, path) {
  const base = typeof origin === 'string' && origin ? origin : globalThis.location?.origin;
  const url = new URL(path, base || 'https://localhost');
  if (!base || url.origin !== new URL(base).origin) throw new Error('读取目标不是当前控制台');
  return url.toString();
}

// 只读数据：两个接口独立成功/失败；任一路失败只影响对应集合，不编造会话。
export function createSessionsReader({ origin = '', fetchImpl, getToken, isActive, now = () => globalThis.performance?.now?.() ?? Date.now() } = {}) {
  const doFetch = fetchImpl || ((url, init) => globalThis.fetch(url, init));
  // 活性闸：解除授权/锁屏会翻转为 false，在途加载在两次读取之间被取消，
  // 避免拿着刚失效的令牌去打中继（401 资源噪音 + 无意义请求）。调用方注入壳状态。
  const stillActive = () => typeof isActive !== 'function' || isActive();
  // 每个接口最近一次往返耗时（毫秒）：定位「服务端 vs 隧道 vs 轮询间隔」延迟来源用，不进入界面数据。
  let lastTimings = [];
  const read = async path => {
    const startedAt = now();
    try { return await readOnce(path); }
    finally { lastTimings = [...lastTimings.filter(item => item.path !== path), { path, ms: Math.round(now() - startedAt) }]; }
  };
  const readOnce = async path => {
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

  const readActive = async () => {
    try {
      const payload = await read(SESSION_READ_PATHS[0]);
      return { active: Array.isArray(payload) ? payload : (Array.isArray(payload?.sessions) ? payload.sessions : []) };
    } catch (error) { return { active: null, sessionsError: String(error?.message || error || '读取失败') }; }
  };
  const readArchives = async () => {
    try {
      const payload = await read(SESSION_READ_PATHS[1]);
      return { archived: Array.isArray(payload?.sessions) ? payload.sessions : (Array.isArray(payload) ? payload : []) };
    } catch (error) { return { archived: null, archivesError: String(error?.message || error || '读取失败') }; }
  };
  // 新会话置顶：接口返回顺序是插入序，按更新时间倒序后取第一条作为当前会话。
  const stamp = value => { const parsed = Date.parse(value); return Number.isNaN(parsed) ? 0 : parsed; };
  // updatedAt 不可解析时回退 createdAt，坏时间戳沉底。
  const recency = item => stamp(item.updatedAt) || stamp(item.createdAt);
  // null 代表读取失败：视图模型会给出明确空态，绝不把失败伪装成「暂无数据」。
  const assemble = ({ active, archived, sessionsError, archivesError, summarizedArchives }, options) => {
    // 放行状态来自后端公开会话的 planApproved；摘要投影不带它，这里按 id 并回（只并布尔值）。
    const approved = new Set((active || []).filter(item => item?.planApproved === true).map(item => item.id));
    const summaries = mobileSessionSummaries(active)
      .map(item => ({ ...item, planApproved: approved.has(item.id) }))
      .sort((a, b) => recency(b) - recency(a));
    const snapshot = {
      sessions: active === null ? null : summaries,
      archives: archived === null ? null : (summarizedArchives ?? mobileArchiveSummaries(archived)),
      currentId: summaries[0]?.id || null,
      ...(sessionsError ? { sessionsError } : {}),
      ...(archivesError ? { archivesError } : {}),
    };
    return { snapshot, rawArchives: archived, list: buildSessionList(snapshot, options) };
  };

  return {
    timings: () => lastTimings.map(item => ({ ...item })),
    // 两路并行：此前串行，手机隧道每多一次往返就多一份延迟。
    async load(options = {}) {
      const [a, b] = await Promise.all([readActive(), readArchives()]);
      return assemble({ ...a, ...b }, options);
    },
    // 详情页轮询用：只重读活跃会话（回复就在这里），存档沿用上次结果——
    // 存档接口要把全部历史会话读盘并整表回传，随历史增长越来越慢，且与新回复无关。
    async refreshActive(previous, options = {}) {
      const a = await readActive();
      const archived = previous?.rawArchives ?? null;
      const archivesError = previous?.snapshot?.archivesError;
      return assemble({ ...a, archived, ...(archivesError ? { archivesError } : {}), summarizedArchives: previous?.snapshot?.archives }, options);
    },
    archiveDetail(record) {
      return buildArchiveDetail(mobileArchiveTranscript(record));
    },
  };
}

// 办结类写路由 → 卡片 id；非卡路径返回 null，不进统一已答源。
const cardIdFromWriteUrl = url => {
  const match = /^\/api\/mobile\/cards\/([^/]+)\/(?:answer|resolve|delegate|authorize)$/.exec(new URL(url).pathname);
  return match ? decodeURIComponent(match[1]) : null;
};

// 写操作：只打 src/mobile-write.mjs 已登记的固定写路由；同源、设备凭证在头。
export function createSessionsWrite(client, { fetchImpl } = {}) {
  if (!client || !client.origin || typeof client.tokenStore?.get !== 'function') {
    throw new TypeError('createSessionsWrite 需要带 origin/tokenStore 的移动端客户端');
  }
  const doFetch = fetchImpl || ((url, init) => globalThis.fetch(url, init));
  const call = async (path, body, method = 'POST') => {
    const token = await client.tokenStore.get();
    if (typeof token !== 'string' || !token) throw new Error('尚未绑定设备，请重新绑定后再操作');
    const url = new URL(path, client.origin);
    if (url.origin !== client.origin) throw new Error('写操作目标不是当前控制台');
    let response;
    try {
      response = await doFetch(url.toString(), {
        method,
        headers: {
          'content-type': 'application/json',
          'x-console-request': '1',
          'x-device-token': token,
        },
        ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new Error('无法连接控制台，操作未提交，请重试'); }
    let payload = {};
    try { payload = await response.json(); } catch { /* 非 JSON 响应用通用错误文案 */ }
    if (!response.ok) {
      // 对端明示「已办结」的 409 是幂等成功：静默收起、不报错残留（普通 409 错误仍按失败处理）。
      if (response.status === 409 && payload?.idempotent === true) {
        const answeredId = cardIdFromWriteUrl(url);
        if (answeredId) markCardAnsweredLocal(answeredId, body);
        return { ...payload, ok: true };
      }
      throw new Error(String(payload?.error || `操作失败（${response.status}），请重试`));
    }
    // 办结类写成功（含幂等成功）都登记统一「卡已答」源；非卡路径不受影响。
    const answeredId = cardIdFromWriteUrl(url);
    if (answeredId) markCardAnsweredLocal(answeredId, body);
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
    // 已处理：无需文字的快速办结，复用网页 resolve 端点，原因固定为「已处理」。
    markHandled(id) {
      const cardId = encodeURIComponent(String(id ?? '').trim());
      if (!cardId) throw new Error('事项不存在或已失效');
      return call(`/api/mobile/cards/${cardId}/resolve`, { reason: '已处理' });
    },
    // 结案：与网页「结案」按钮同语义（resolve），原因固定为「结案」。
    resolveCard(id) {
      const cardId = encodeURIComponent(String(id ?? '').trim());
      if (!cardId) throw new Error('事项不存在或已失效');
      return call(`/api/mobile/cards/${cardId}/resolve`, { reason: '结案' });
    },
    // 退回调度（delegate-return）：经设备鉴权走服务端 card-delegate 事务——落调度事件、
    // 入待代理决策列表并结案原卡；Hub 拒绝时失败抛错，卡片保留可重试。
    delegateCard(id) {
      const cardId = encodeURIComponent(String(id ?? '').trim());
      if (!cardId) throw new Error('事项不存在或已失效');
      return call(`/api/mobile/cards/${cardId}/delegate`, {});
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
    sendMessage(id, { text, interrupt = false, attachments = [] } = {}) {
      const value = encodeURIComponent(String(id ?? '').trim());
      if (!value) throw new Error('会话不存在或已失效');
      return call(`/api/mobile/sessions/${value}/messages`, { text: String(text ?? ''), ...(interrupt === true ? { interrupt: true } : {}), ...(attachments.length ? { attachments } : {}) });
    },
    updateQueued(id, itemId, { text } = {}) {
      return call(`/api/mobile/sessions/${encodeURIComponent(String(id))}/queue/${encodeURIComponent(String(itemId))}`, { text: String(text ?? '') }, 'PUT');
    },
    moveQueued(id, itemId, { direction } = {}) {
      return call(`/api/mobile/sessions/${encodeURIComponent(String(id))}/queue/${encodeURIComponent(String(itemId))}/move`, { direction: String(direction ?? '') });
    },
    steerQueued(id, itemId) {
      return call(`/api/mobile/sessions/${encodeURIComponent(String(id))}/queue/${encodeURIComponent(String(itemId))}/steer`, {});
    },
    removeQueued(id, itemId) {
      return call(`/api/mobile/sessions/${encodeURIComponent(String(id))}/queue/${encodeURIComponent(String(itemId))}`, {}, 'DELETE');
    },
    clearQueued(id) {
      return call(`/api/mobile/sessions/${encodeURIComponent(String(id))}/queue/clear`, {});
    },
    // 新建与分类只打移动端网关已登记写路由；项目必须来自下拉的真实选项。
    classify(text) {
      return call('/api/mobile/session-classify', { text: String(text ?? '') });
    },
    // 会话内决策卡：choice = allow（仅允许一次）| reject（拒绝）。
    answerPermission(id, requestId, choice) {
      const sid = encodeURIComponent(String(id ?? '').trim()); const rid = encodeURIComponent(String(requestId ?? '').trim());
      if (!sid || !rid) throw new Error('这条授权请求已失效');
      if (choice !== 'allow' && choice !== 'reject') throw new Error('答复必须是 allow 或 reject');
      return call(`/api/mobile/sessions/${sid}/permissions/${rid}`, { choice });
    },
    // 可开会话的平台清单（Codex / Claude Code / WorkBuddy …），只读。
    async listPlatforms() {
      const result = await call('/api/mobile/session-platforms', undefined, 'GET');
      return Array.isArray(result?.platforms) ? result.platforms : [];
    },
    createSession({ project, prompt, kind, platform } = {}) {
      const value = String(project ?? '').trim();
      const firstTurn = String(prompt ?? '').trim();
      if (!value || !firstTurn) throw new Error('请选择项目并输入首轮提示词');
      const payload = { project: value, prompt: firstTurn };
      if (kind) payload.kind = String(kind);
      if (platform) payload.platform = String(platform);
      return call('/api/mobile/sessions', payload);
    },
  };
}

// 决策卡归属会话（session-bind，2026-11-25 真机反馈「卡出现在不同会话里」）：归属口径沿用
// question-group 的 cardsForSession（lane = 会话 hubSubject；无 lane 的卡按项目），本函数只再收窄到
// 仍 open 的卡，作为会话卡组「哪些题还该留着」的依据。别的会话的卡仍完整留在「待我处理」，过滤不丢数据。
export function openCardsBySession(cards, session, cardsForSession) {
  const scoped = typeof cardsForSession === 'function' ? cardsForSession(cards, session) : [];
  // 连同本机已答源一起过滤：另一处（待办/别的会话）办结后，会话窗重建卡组时一并收起。
  return (Array.isArray(scoped) ? scoped : []).filter(card =>
    String(card?.state ?? '').trim() === 'open' && !isCardAnsweredLocal(card?.id));
}

// 回答后移除（answer-vanish）：卡片回答/结案后立即离开会话卡组——只保留仍在 openIds 里的题
// （已答回看行一并去掉），焦点落到剩余第一道未答题；组无变化时返回原对象，避免无谓重渲染。
export function pruneQuestionGroup(group, openIds) {
  if (!group || typeof group !== 'object' || !Array.isArray(group.questions)) return group;
  const keep = new Set([...(openIds || [])].map(String));
  const questions = group.questions.filter(question => keep.has(String(question?.id)));
  if (questions.length === group.questions.length) return group;
  const ids = new Set(questions.map(question => question.id));
  const active = questions.find(question => question.id === group.activeId && question.state !== 'answered')
    || questions.find(question => question.state !== 'answered');
  return {
    ...group,
    questions,
    answered: (Array.isArray(group.answered) ? group.answered : []).filter(id => ids.has(id)),
    expanded: (Array.isArray(group.expanded) ? group.expanded : []).filter(id => ids.has(id)),
    activeId: active ? active.id : null,
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

// 会话在等回复：详情轮询据此切到快拍。busy 是服务端 running 的同义投影。
const AWAITING_STATUSES = new Set(['running', 'initializing', 'unknown']);
export function isAwaitingReply(session) {
  if (!session || typeof session !== 'object') return false;
  return session.busy === true || AWAITING_STATUSES.has(session.status);
}

// 详情页消息 = 已落定转录 + 本轮正在输出的 liveText（流式气泡）+ 服务端尚未记下的本地发送回显。
// 根因：服务端边收模型分片边累积 liveText，但移动端此前只渲染落定 messages，
// 整轮结束前一个字都不显示，体感延迟等于整轮耗时而不是首个分片耗时。
export function buildDetailMessages(session, previous = []) {
  const messages = (Array.isArray(session?.messages) ? session.messages : []).map(message => ({
    role: message?.role === 'user' ? '主人' : '会话',
    text: String(message?.text ?? ''),
    at: String(message?.at ?? ''),
  }));
  const echo = [...(Array.isArray(previous) ? previous : [])].reverse().find(message => message?.role === '主人' && !message.at);
  if (echo && !messages.some(message => message.role === '主人' && message.text === echo.text)) messages.push({ role: '主人', text: String(echo.text ?? ''), at: '' });
  const live = typeof session?.liveText === 'string' ? session.liveText : '';
  if (live.trim()) messages.push({ role: '会话', text: live, at: '', streaming: true });
  return messages;
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
