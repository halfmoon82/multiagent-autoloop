import { spawn } from 'node:child_process';
import { hubRequest } from './hub.mjs';
import { getCardRouting } from './card-routing.mjs';
import {
  buildTodoNotification, buildNodeDoneNotification, isNotifiableNodeEvent, badgeCount,
} from '../mobile/src/features/notifications/index.mjs';

// macOS 桌面系统通知：文本做 AppleScript 安全清洗（去引号/反斜杠/控制字符并截断），
// 通知失败绝不影响控制台主流程。移动端系统通知复用同一事件分发（见 CardNotifier），
// 通知内容/去重/角标由 mobile/src/features/notifications 提供，不新建第二套通知状态。
const sanitize = value => String(value || '').replace(/["\\\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);

export function macosNotify({ title, body }) {
  if (process.platform !== 'darwin') return;
  const script = `display notification ${JSON.stringify(sanitize(body))} with title ${JSON.stringify(sanitize(title))} sound name "Glass"`;
  try {
    const child = spawn('osascript', ['-e', script], { stdio: 'ignore' });
    child.on('error', () => { /* 通知不可用则静默跳过 */ });
  } catch { /* 同上 */ }
}

// 单一通知事件分发：轮询「待我处理」开放卡片与「节点成功完成」回执，分别构建独立系统通知并去重。
// 去重状态只此一份（this.notified）；角标数量由 badgeCount(open) 同步；通知失败不影响主流程。
// 首次轮询只做种子（避免重启后对存量刷屏）；重开产生新 revision 才是新决策，已处理事项不重复提交。
// 普通失败、自动重试、调度自愈不通知：isNotifiableNodeEvent 只放行 done 回执；
// 失败若形成待办，则只发该待办通知（卡片照常分发）。
export class CardNotifier {
  constructor({ config, intervalMs = 15000, notify = macosNotify, fetchState, setTimer = setInterval, clearTimer = clearInterval, routing, fetchNodeEvents, setBadge } = {}) {
    // 路由装配复用本轮询周期；无数据目录（如纯通知测试）则不启用。
    this.routing = routing === undefined ? getCardRouting(config) : routing;
    this.intervalMs = intervalMs;
    this.notify = notify;
    this.fetchState = fetchState || (() => hubRequest(config, '/v1/state', { timeout: 5000 }));
    this.fetchNodeEvents = fetchNodeEvents || null;
    this.setBadge = setBadge || (() => {});
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.seeded = false;
    this.notified = new Map();
    this.handle = null;
  }

  start() {
    if (this.handle) return;
    this.poll();
    this.handle = this.setTimer(() => { this.poll(); }, this.intervalMs);
    this.handle?.unref?.(); // 通知轮询不得阻止进程退出
  }

  stop() {
    if (!this.handle) return;
    this.clearTimer(this.handle);
    this.handle = null;
  }

  async nodeCompletionEvents(state) {
    if (this.fetchNodeEvents) {
      try { const list = await this.fetchNodeEvents(); return Array.isArray(list) ? list : []; }
      catch { return []; }
    }
    return Array.isArray(state?.nodeEvents) ? state.nodeEvents : [];
  }

  syncBadge(open) {
    try { this.setBadge(badgeCount(open)); } catch { /* 角标同步失败不影响主流程 */ }
  }

  async poll() {
    let state;
    try { state = await this.fetchState(); } catch { return; } // 中台断线等下次轮询

    let open = (state?.cards || []).filter(card => card?.state === 'open');
    if (this.routing) {
      try {
        const delegated = new Set((await this.routing.routeOpenCards(open)).map(String));
        open = open.filter(card => !delegated.has(String(card.id))); // 已自动退回调度的卡不再打扰人
      } catch { /* 路由失败不隐藏卡片、不影响通知 */ }
    }
    const events = await this.nodeCompletionEvents(state);

    const descriptors = [
      ...open.map(card => buildTodoNotification(card)),
      ...events.filter(isNotifiableNodeEvent).map(event => buildNodeDoneNotification(event)),
    ];

    if (!this.seeded) {
      this.seeded = true;
      this.notified = new Map(descriptors.map(d => [d.key, true]));
      this.syncBadge(open);
      return;
    }

    for (const descriptor of descriptors) {
      if (this.notified.has(descriptor.key)) continue;
      this.notified.set(descriptor.key, true);
      try { this.notify(descriptor); } catch { /* 通知失败不影响主流程与后续轮询 */ }
    }
    this.syncBadge(open);
  }
}
