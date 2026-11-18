// §6 调度会话 Hub 原生接线：kind=scheduling 会话由 Hub 事件/run 驱动。
// 本模块只做 Hub 侧事件适配，不派生任何私有 ACP 进程；normal/design 仍走既有 ACP 路径。
// 凭据只经 config 在服务端使用，绝不进入浏览器；不新增执行状态登记，状态从 Hub 事件读取。
import { loadConsoleConfig } from './config.mjs';
import { hubRequest, postSchedulingEvent, readSchedulingEvent } from './hub.mjs';

export const HUB_SCHEDULING_AGENT_LABEL = 'Hub 事项';

// #100：活跃 Hub 会话在 list（前端轮询）时的最小对账间隔；避免每次轮询都打 Hub。
export const HUB_RECONCILE_INTERVAL_MS = 5000;

export class HubSchedulingError extends Error {
  constructor(message, { status = 502 } = {}) {
    super(message);
    this.name = 'HubSchedulingError';
    this.status = status;
  }
}

const safeMessage = error => String(error?.message || error || '未知错误').replace(/[\r\n]+/g, ' ');

// §6.2 事件与事项契约：subject = scheduling:<sessionUUID>；event.id = console:<sessionUUID>:turn:<monotonic-n>
export function schedulingSubject(sessionId) {
  return `scheduling:${sessionId}`;
}

export function schedulingEventId(sessionId, turn) {
  return `console:${sessionId}:turn:${turn}`;
}

// #89: 真实中台 POST /v1/events 只接受 id/type/subject/summary/detail/link。
// project/text 进 detail（worker 可解析的 JSON 字符串），summary 为首轮文本摘要；
// 续接语义由中台规则/事项承担，不属于事件字段（删除 resume）。
export function buildSchedulingEvent({ sessionId, turn, project, text } = {}) {
  const message = String(text ?? '');
  return {
    id: schedulingEventId(sessionId, turn),
    subject: schedulingSubject(sessionId),
    type: 'scheduling.message',
    summary: message.slice(0, 80) || `调度会话${project ? ` ${project}` : ''}`,
    detail: JSON.stringify({ project, text }),
  };
}

// 从事项里恢复已用的最大轮次（兼容旧事项形状）：lastEventId / events[].id / turn / eventCount 取最大，至少为 1。
// #92 起正常的重启恢复走 console-sessions 存档，不再读 /v1/matters；本函数只保留给旧形状解析。
export function matterTurn(sessionId, matter = {}) {
  const prefix = `console:${sessionId}:turn:`;
  const parse = id => {
    const text = String(id || '');
    if (!text.startsWith(prefix)) return 0;
    const n = Number(text.slice(prefix.length));
    return Number.isInteger(n) && n > 0 ? n : 0;
  };
  const ids = [matter.lastEventId, ...(Array.isArray(matter.events) ? matter.events.map(e => (typeof e === 'string' ? e : e?.id)) : [])];
  const counts = [matter.turn, matter.eventCount].map(Number).filter(n => Number.isInteger(n) && n > 0);
  return Math.max(1, ...ids.map(parse), ...counts);
}

// #92 真实 POST /v1/events 回 {event,duplicate,routed,paused}；event 是中台分配的数字事件 id。
// 旧的 {id,runId,state} 形状必须坚决拒绝，避免再次把字符串 id 当数字、把 undefined state 当 idle。
export function numericEventId(result) {
  const value = result?.event;
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

// #92 真实 GET /v1/events/<数字 id> 回 {event,routed,paused,runs:[{run,rule,state,...}]}。
// 会话状态与 runId 一律从 runs[0] 派生，POST 响应里没有这些信息。
export function readHubRun(payload) {
  const run = Array.isArray(payload?.runs) ? payload.runs[0] : null;
  if (!run || typeof run !== 'object') return null;
  return { runId: run.run ?? null, state: run.state ?? null };
}

// #100 权威词表来源（只读核对，不复制实现）：中台 host/state.ts 的 tally/active 查询与
// 本仓库 src/dag-runtime.mjs 的 HUB_STATES —— queued / claimed / unknown / done / nothing / cancelled
// 是中台实际写入的 run.state；failed / refusal 为执行异常或被拒终态。其余 running/active/in_progress、
// completed/succeeded/idle 为兼容别名。终态（done/nothing/failed/refusal/...）绝不映射 running；
// 词表外的值一律 unknown，视图保持「待复核」可读，不编造完成或运行中。
const HUB_RUNNING_STATES = ['claimed', 'running', 'queued', 'active', 'in_progress'];
const HUB_ERROR_STATES = ['failed', 'error', 'cancelled', 'canceled', 'refusal', 'refused'];
const HUB_IDLE_STATES = ['done', 'completed', 'succeeded', 'idle', 'nothing'];

export function mapHubStateToStatus(state) {
  if (HUB_RUNNING_STATES.includes(state)) return 'running';
  if (HUB_ERROR_STATES.includes(state)) return 'error';
  // done（有结果）与 nothing（本轮无事）都是完成语义 → idle，不再等待该 run。
  if (HUB_IDLE_STATES.includes(state)) return 'idle';
  return 'unknown';
}

// #100：done 与 nothing 同为 idle，但文案要区分「本轮无事」与「有结果」，
// 避免把「没事可做」误读成有产出。供需要细化展示的视图/存档取用；非完成态返回 null。
export function hubStateCompletionText(state) {
  if (state === 'nothing') return '本轮无事';
  if (state === 'done' || state === 'completed' || state === 'succeeded') return '已完成';
  return null;
}

// 默认 Hub 客户端：所有 HTTP 都经 hub.mjs 的固定路径允许列表，不暴露任意 URL 代理。
const defaultHubClient = {
  async postEvent(config, event) { return postSchedulingEvent(config, event); },
  async readEvent(config, eventId) { return readSchedulingEvent(config, eventId); },
  async cancelRun(config, runId) { return hubRequest(config, `/v1/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST', body: {} }); },
};

export class HubSchedulingSessionAdapter {
  constructor({ hubConfig = null, hubClient = defaultHubClient, now = () => new Date() } = {}) {
    this.hubConfig = hubConfig;
    this.hubClient = hubClient;
    this.now = now;
    // 本地幂等：同一 event.id 只向 Hub 投递一次，防重复轮次造成重复执行。
    this.posted = new Map();
  }

  #config() {
    if (this.hubConfig) return this.hubConfig;
    try {
      this.hubConfig = loadConsoleConfig(process.env.AGENT_AUTOLOOP_HOME);
      return this.hubConfig;
    } catch (error) {
      throw new HubSchedulingError(`没有可用的中台配置，调度会话未接线：${safeMessage(error)}（输入已保留）`, { status: 503 });
    }
  }

  async postTurn({ sessionId, turn, project, text }) {
    const event = buildSchedulingEvent({ sessionId, turn, project, text });
    if (this.posted.has(event.id)) return this.posted.get(event.id);
    let result;
    try {
      result = await this.hubClient.postEvent(this.#config(), event);
    } catch (error) {
      const clientStatus = error?.status;
      const reason = clientStatus === 404 || /规则|not\s*found|no match/i.test(safeMessage(error))
        ? '没有匹配的调度规则或规则未接线'
        : '中台不可用或调度未接线';
      const status = clientStatus >= 400 && clientStatus < 500 ? clientStatus : 502;
      throw new HubSchedulingError(`${reason}：${safeMessage(error)}（输入已保留，未派生本地进程）`, { status });
    }
    this.posted.set(event.id, result);
    return result;
  }

  // #92 读取 Hub 事件状态；失败必须抛出，交给调用方如实标成 unknown/待复核，
  // 绝不能吞成 null 让上层误以为「无 run / 会话消失」。
  async readStatus({ eventId }) {
    if (!eventId) return null;
    try { return await this.hubClient.readEvent(this.#config(), eventId); }
    catch (error) {
      if (error instanceof HubSchedulingError) throw error;
      throw new HubSchedulingError(`读取 Hub 事件状态失败（查 run）：${safeMessage(error)}`, {
        status: error?.status >= 400 && error.status < 600 ? error.status : 502,
      });
    }
  }

  async cancelRun(runId) {
    if (!runId) return;
    try { await this.hubClient.cancelRun(this.#config(), runId); }
    catch (error) { throw new HubSchedulingError(`取消 Hub run 失败：${safeMessage(error)}`, { status: 502 }); }
  }
}
