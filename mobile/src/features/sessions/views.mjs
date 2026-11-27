// 会话页面纯视图模型（Spec §8.2.4 / §8.2.6 / DAG 节点 sessions）：
// 会话列表（类型筛选/搜索/当前会话/新建入口/已归档与历史）、新建会话与语义分类推荐、
// 已归档会话的只读查看与恢复。输入是后端投影后的普通对象，输出是可安全渲染的普通对象。
// 每个列表都是 collection（空时带明确 reason）；任何状态、模型、转录都只取真实字段。
// 本节点只读展示 + 生成恢复请求，不启动会话、不写存档、不发请求，调用方负责执行并回传结果。

import { collection } from '../../core/contract.mjs';
import { pollIntervalMs, isResponding } from '../composer-autogrow/autogrow.mjs';
import {
  SESSION_KINDS, SESSION_KIND_FILTERS, sessionKindLabel, RESTORE_INJECTED_TURNS,
} from './contract.mjs';

const object = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const matchesQuery = (session, query) => {
  if (!query) return true;
  const haystack = [session?.title, session?.project, session?.projectLabel, session?.kindLabel]
    .map(value => String(value ?? '').toLowerCase()).join(' ');
  return haystack.includes(query.toLowerCase());
};

// 会话列表：类型筛选 + 搜索作用于列表；当前会话单列，新建入口与已归档折叠区齐备。
// 数据缺失时整页 ready=false，各集合显示明确空态，绝不编造会话条目。
export function buildSessionList(snapshot = {}, options = {}) {
  const src = object(snapshot);
  const sessionsAvailable = Array.isArray(src.sessions);
  const archivesAvailable = Array.isArray(src.archives);
  const sessionReason = '会话数据缺失，未读取到会话列表';
  const sessionError = String(src.sessionsError || '').trim() || sessionReason;
  const archiveReason = '归档数据缺失，未读取到已归档会话';
  const allSessions = sessionsAvailable ? src.sessions : [];
  const archives = archivesAvailable ? src.archives : [];
  const kind = SESSION_KIND_FILTERS.some(item => item.id === options.kind) ? options.kind : 'all';
  const query = String(options.query ?? '').trim();
  const filtered = allSessions.filter(session =>
    (kind === 'all' || session?.kind === kind) && matchesQuery(session, query));
  const current = src.currentId && sessionsAvailable
    ? (allSessions.find(session => session?.id === src.currentId) ?? null)
    : null;

  return {
    id: 'sessions', title: '会话',
    ready: sessionsAvailable,
    error: sessionsAvailable ? null : sessionError,
    kindFilter: { selected: kind, options: SESSION_KIND_FILTERS },
    query,
    current,
    sessions: collection(filtered, sessionsAvailable ? '暂无会话' : sessionReason),
    newSession: {
      available: sessionsAvailable,
      action: 'create-session',
      hint: '选择项目并输入首轮提示词后创建会话',
    },
    archived: {
      collapsed: true,
      count: archives.length,
      expandAction: 'toggle-archived',
      ...collection(archives, archivesAvailable ? '暂无已归档会话' : archiveReason),
    },
  };
}

// 新建会话表单：语义分类推荐来自 /api/session-classify 的结果（调用方传入），默认采用推荐、
// 用户可手动覆盖；推荐缺失时不编造。首轮提示词与项目是提交前提。
export function buildNewSessionForm({ projects = [], prompt = '', classification = null, selectedKind = null, platforms = [], selectedPlatform = '' } = {}) {
  const options = (Array.isArray(projects) ? projects : [])
    .filter(item => item && typeof item.id === 'string' && item.id.length > 0)
    .map(item => ({ id: item.id, label: String(item.label || item.id) }));
  const cleanPrompt = String(prompt ?? '');
  const classified = object(classification);
  const recommendation = SESSION_KINDS.includes(classified.kind)
    ? { kind: classified.kind, label: sessionKindLabel(classified.kind), reason: String(classified.reason ?? '').trim() }
    : null;
  const chosen = SESSION_KINDS.includes(selectedKind) ? selectedKind : (recommendation?.kind || 'normal');

  const platformItems = (Array.isArray(platforms) ? platforms : []).filter(item => item && typeof item.id === 'string' && item.id)
    .map(item => ({ id: item.id, label: `${item.name || item.id}${item.defaultModel ? ` · ${item.defaultModel}` : ''}`, selected: item.id === selectedPlatform }));
  return {
    // 平台选择：首项「默认」= 管理后台设置的会话平台；其余是可写的 Codex / Claude Code / WorkBuddy 等。
    platformOptions: [{ id: '', label: '默认平台', selected: !platformItems.some(item => item.selected) }, ...platformItems],
    selectedPlatform: platformItems.some(item => item.selected) ? selectedPlatform : '',
    projectOptions: collection(options, '暂无可选项目'),
    prompt: cleanPrompt,
    recommendation,
    selectedKind: chosen,
    kindOptions: SESSION_KINDS.map(kind => ({
      id: kind,
      label: sessionKindLabel(kind),
      recommended: kind === recommendation?.kind,
      selected: kind === chosen,
    })),
    canSubmit: cleanPrompt.trim().length > 0 && options.length > 0,
    action: 'create-session',
    hint: recommendation?.reason || '输入首轮提示词后自动推荐会话类型，可手动修改',
  };
}

// 只读详情：接受 mobileArchiveTranscript 的输出，补上恢复入口；转录保持原样，不改写文本。
export function buildArchiveDetail(transcript = null) {
  const src = object(transcript);
  if (!src.id) {
    return {
      id: null, empty: true, reason: '会话存档不存在或数据缺失', readOnly: true,
      messages: collection([], '会话存档不存在或数据缺失'),
      restore: { action: 'restore-session', available: false, keepsOriginal: true },
    };
  }
  return {
    id: src.id,
    shortId: src.shortId || String(src.id).slice(0, 8),
    project: src.project || null,
    projectLabel: src.projectLabel || '未识别',
    kindLabel: src.kindLabel || null,
    endStatus: src.endStatus || null,
    endStatusLabel: src.endStatusLabel || '未知',
    transcriptCount: src.transcriptCount || 0,
    readOnly: true,
    messages: src.messages && Array.isArray(src.messages.items)
      ? src.messages : collection([], '暂无转录记录'),
    restore: {
      action: 'restore-session',
      available: true,
      keepsOriginal: true,
      injectedTurns: RESTORE_INJECTED_TURNS,
    },
  };
}

// 恢复请求：走既有 continue 端点（服务端用存档转录新建会话并注入最近 N 轮），不在此发起请求。
export function buildRestoreRequest(record = null) {
  const id = String(record?.id ?? '').trim();
  return {
    method: 'POST',
    path: id ? `/api/scheduling-sessions/${encodeURIComponent(id)}/continue` : null,
    body: null,
    originalId: id || null,
    available: Boolean(id),
    keepsOriginal: true,
    injectedTurns: RESTORE_INJECTED_TURNS,
    note: `恢复创建新会话并注入最近 ${RESTORE_INJECTED_TURNS} 轮转录，原记录保留`,
  };
}

// 恢复结果回填：无论成功或失败都不从归档列表删除原记录——失败带 restoreError，成功带 restoredTo。
export function applyRestoreResult(archiveCollection, recordId, result = {}) {
  const col = archiveCollection && Array.isArray(archiveCollection.items)
    ? archiveCollection
    : collection([], '暂无已归档会话');
  const ok = result.ok === true;
  const items = col.items.map(item => (item?.id === recordId ? {
    ...item,
    restoreError: ok ? null : String(result.error || '恢复失败，原记录已保留'),
    restoredTo: ok ? (result.newSessionId || null) : null,
  } : item));
  return { ...col, items, empty: false, reason: null };
}

// ---- 会话行左滑关闭（纯手势状态机，不碰 DOM） ----
// 左滑露出「关闭」操作位；越过阈值（或松手时已超半幅）才停在展开态，否则回弹。
// 滑动（含已展开后的再次拖动）不算点击：end() 返回 result==='tap' 才允许进入会话。
export const ROW_SWIPE_REVEAL_PX = 88;
export const ROW_SWIPE_AXIS_LOCK_PX = 8;
export const ROW_SWIPE_TAP_SLOP_PX = 10;

const finiteNumber = value => typeof value === 'number' && Number.isFinite(value);

export function createRowSwipe({ reveal = ROW_SWIPE_REVEAL_PX } = {}) {
  let open = false;
  let origin = null;
  let axis = null;
  let offset = 0;
  const clamp = value => Math.max(-reveal, Math.min(0, value));
  const base = () => (open ? -reveal : 0);
  return {
    get open() { return open; },
    get offset() { return offset; },
    start({ x, y }) {
      if (!finiteNumber(x) || !finiteNumber(y)) return false;
      origin = { x, y }; axis = null; offset = base();
      return true;
    },
    move({ x, y }) {
      if (!origin || !finiteNumber(x) || !finiteNumber(y)) return { dragging: false, offset };
      const dx = x - origin.x; const dy = y - origin.y;
      if (!axis) {
        if (Math.abs(dx) < ROW_SWIPE_AXIS_LOCK_PX && Math.abs(dy) < ROW_SWIPE_AXIS_LOCK_PX) return { dragging: false, offset };
        axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      }
      if (axis !== 'x') return { dragging: false, offset };
      offset = clamp(base() + dx);
      return { dragging: true, offset };
    },
    // 取消（指针被系统夺走/页面滚动）：回到手势前的状态，不触发任何动作。
    cancel() { origin = null; axis = null; offset = base(); },
    end() {
      if (!origin) return { result: 'revert', open, offset: base() };
      const dragged = axis === 'x';
      const slop = Math.abs(offset - base()) < ROW_SWIPE_TAP_SLOP_PX;
      origin = null;
      if (!dragged) {
        const wasAxisY = axis === 'y';
        axis = null; offset = base();
        return { result: wasAxisY ? 'revert' : 'tap', open, offset: base() };
      }
      axis = null;
      if (slop) { offset = base(); return { result: 'revert', open, offset: base() }; }
      const was = open;
      open = offset <= -reveal / 2;
      offset = open ? -reveal : 0;
      return { result: open ? 'open' : (was ? 'close' : 'revert'), open, offset };
    },
    close() { open = false; origin = null; axis = null; offset = 0; },
  };
}

// 关闭失败/成功后的列表收口：成功才移除该行；失败保留原状并带可读原因。
export function applyCloseResult(sessionCollection, id, result = {}) {
  const col = sessionCollection && Array.isArray(sessionCollection.items)
    ? sessionCollection : collection([], '暂无会话');
  if (result.ok === true) {
    const items = col.items.filter(item => item?.id !== id);
    return items.length ? { ...col, items } : collection([], '暂无会话');
  }
  return {
    ...col,
    items: col.items.map(item => (item?.id === id
      ? { ...item, closeError: String(result.error || '关闭失败，会话保持原状') } : item)),
  };
}

// 设计会话卡片的操作按钮：「确认计划·放行落盘」仅未放行时出现；旧的范围确认入口已随 issue #355 移除。
export function designSessionActions(session = null) {
  if (!session || session.kind !== 'design') return [];
  const actions = [];
  if (session.planApproved !== true) actions.push({ id: 'approve-plan', label: '确认计划 · 放行落盘', primary: true });
  return actions;
}

// ---- 卡两处一致性：办结幂等的轻提示（card-two-places，2026-11-26 晨）----
// 另一处已把卡办结（409/幂等成功）时不再报错，只给一条可见的轻提示；真失败返回 null，
// 由调用方照常显示错误并保留卡片。文案固定，不回显 Hub 错误体。
export const CARD_HANDLED_NOTICE = '该卡已在别处办结，本地一并收起';
export function buildCardAnsweredNotice(result = {}, card = null) {
  if (result?.idempotent !== true) return null;
  const title = String(card?.title ?? '').trim();
  return { tone: 'ok', role: 'status', text: `${title ? `${title}：` : ''}${CARD_HANDLED_NOTICE}` };
}

// 关闭会话的二次确认状态机（closeConfirm）：第一次点「关闭」只进入确认态，
// 再点「确认关闭」才提交；失败或超时回到初始态。滑动手势与此无关。
export const CLOSE_CONFIRM_LABELS = Object.freeze({ idle: '关闭', confirm: '确认关闭', busy: '关闭中…' });
export function createCloseConfirm() {
  let state = 'idle';
  return {
    get state() { return state; },
    get label() { return CLOSE_CONFIRM_LABELS[state]; },
    press() {
      if (state === 'idle') { state = 'confirm'; return 'arm'; }
      if (state === 'confirm') { state = 'busy'; return 'submit'; }
      return 'ignore';
    },
    reset() { state = 'idle'; },
  };
}

// ---- 输入区视图模型（composer-ux）：发送后即时响应态、自适应轮询、页面隐藏暂停、liveText 流式气泡 ----
// 乐观上屏（sendMessage 发送中→成功/可重试）由 composer-autogrow 的 optimisticMessage/settleMessage 承载；
// 这里只把「现在该是什么状态」算成纯对象，页面按它渲染，不发请求。
export function mergeLiveText(frames) {
  return (Array.isArray(frames) ? frames : []).map(frame => String(frame ?? '')).join('');
}
export function buildComposerView({ session = null, respondingSince = 0, hidden = false, now = Date.now() } = {}) {
  const responding = isResponding(respondingSince, now);
  const pollMs = pollIntervalMs({
    hidden: hidden === true, // 页面隐藏（document.hidden / visibilitychange）暂停轮询
    busy: session?.busy === true,
    turnStartedAt: session?.turnStartedAt || null,
    responding,
  });
  const live = typeof session?.liveText === 'string' ? session.liveText : '';
  return {
    responding: responding || session?.busy === true,
    paused: pollMs === null,
    pollMs,
    // 流式气泡：与网页「正在输出…」等效；无 liveText 则不出气泡
    stream: live ? { role: '会话', text: live, at: '', streaming: true } : null,
  };
}
