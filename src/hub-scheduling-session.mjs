// §6 调度会话 Hub 原生接线：kind=scheduling 会话由 Hub 事项（matter）/run/resume 驱动。
// 本模块只做 Hub 侧事项与事件的适配，不派生任何私有 ACP 进程；normal/design 仍走既有 ACP 路径。
// 凭据只经 config 在服务端使用，绝不进入浏览器；不新增执行状态登记，状态从 Hub 事件/事项读取。
import { loadConsoleConfig } from './config.mjs';
import { hubRequest, postSchedulingEvent, readSchedulingEvent } from './hub.mjs';

export const HUB_SCHEDULING_AGENT_LABEL = 'Hub 事项';

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

export function buildSchedulingEvent({ sessionId, turn, project, text } = {}) {
  return {
    id: schedulingEventId(sessionId, turn),
    subject: schedulingSubject(sessionId),
    type: 'scheduling.message',
    resume: true,
    project,
    text,
  };
}

export function mapHubStateToStatus(state) {
  if (['running', 'queued', 'active', 'in_progress'].includes(state)) return 'running';
  if (['failed', 'error', 'cancelled', 'canceled'].includes(state)) return 'error';
  return 'idle';
}

// 默认 Hub 客户端：所有 HTTP 都经 hub.mjs 的固定路径允许列表，不暴露任意 URL 代理。
const defaultHubClient = {
  async postEvent(config, event) { return postSchedulingEvent(config, event); },
  async readEvent(config, eventId) { return readSchedulingEvent(config, eventId); },
  async listMatters(config) { return hubRequest(config, '/v1/matters?kind=scheduling'); },
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

  async readStatus({ eventId }) {
    if (!eventId) return null;
    try { return await this.hubClient.readEvent(this.#config(), eventId); }
    catch { return null; }
  }

  async listMatters() {
    try {
      const matters = await this.hubClient.listMatters(this.#config());
      return Array.isArray(matters) ? matters : (matters?.matters || []);
    } catch { return []; }
  }

  async cancelRun(runId) {
    if (!runId) return;
    try { await this.hubClient.cancelRun(this.#config(), runId); }
    catch (error) { throw new HubSchedulingError(`取消 Hub run 失败：${safeMessage(error)}`, { status: 502 }); }
  }
}
