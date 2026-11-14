import { spawn } from 'node:child_process';
import { hubRequest } from './hub.mjs';

// macOS 系统通知：文本做 AppleScript 安全清洗（去引号/反斜杠/控制字符并截断），
// 通知失败绝不影响控制台主流程。
const sanitize = value => String(value || '').replace(/["\\\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
const shortProject = value => {
  const text = String(value || '').trim().replace(/[\/]+$/, '');
  return text ? (text.split(/[\/]/).filter(Boolean).pop() || text) : '未识别';
};

export function macosNotify({ title, body }) {
  if (process.platform !== 'darwin') return;
  const script = `display notification ${JSON.stringify(sanitize(body))} with title ${JSON.stringify(sanitize(title))} sound name "Glass"`;
  try {
    const child = spawn('osascript', ['-e', script], { stdio: 'ignore' });
    child.on('error', () => { /* 通知不可用则静默跳过 */ });
  } catch { /* 同上 */ }
}

// 轮询 Hub，发现新出现的「待我处理」开放卡片时发系统通知。
// 首次轮询只做种子（避免重启后对存量卡片刷屏）；去重键为 id+createdAt（无 createdAt
// 时退化为 id）：关闭的卡片会在下一轮 poll 从去重表移除，重开即再提醒；只有在同一
// 轮询间隔内完成「关闭+重开」才会漏一次提醒，可接受。
export class CardNotifier {
  constructor({ config, intervalMs = 15000, notify = macosNotify, fetchState, setTimer = setInterval, clearTimer = clearInterval } = {}) {
    this.intervalMs = intervalMs;
    this.notify = notify;
    this.fetchState = fetchState || (() => hubRequest(config, '/v1/state', { timeout: 5000 }));
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

  async poll() {
    let state;
    try { state = await this.fetchState(); } catch { return; } // 中台断线等下次轮询
    const open = (state?.cards || []).filter(card => card.state === 'open');
    const openKeys = new Map(open.map(card => [String(card.id), String(card.createdAt || '')]));
    if (!this.seeded) {
      this.seeded = true;
      this.notified = openKeys;
      return;
    }
    for (const card of open) {
      const id = String(card.id);
      if (this.notified.get(id) === String(card.createdAt || '')) continue;
      this.notified.set(id, String(card.createdAt || ''));
      try {
        this.notify({ title: 'Autoloop 有待您决策的事项', body: `${card.title || '新卡片'} · 项目 ${shortProject(card.project || card.cwd)}` });
      } catch { /* 通知失败不影响后续轮询 */ }
    }
    for (const id of [...this.notified.keys()]) if (!openKeys.has(id)) this.notified.delete(id);
  }
}
