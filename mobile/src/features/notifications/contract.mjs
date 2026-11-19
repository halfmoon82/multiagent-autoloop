// 系统通知与锁屏直复共享契约（Spec §7 / DAG plan wave-4）。
// 纯函数：不触碰浏览器全局、不依赖 Node 内置模块，移动端打包器与 Node 边界测试都可导入。
// 通知内容只由白名单字段构建（项目名、待办摘要/详情、节点交付摘要），并再做一次疑似凭据清洗，
// 因此不会把上游事件里的密钥/口令透传进锁屏通知。上游文本全程是纯字符串，由调用方安全渲染。

export const NOTIFICATION_KINDS = Object.freeze({ TODO: 'todo', NODE_DONE: 'node-done' });
export const NODE_DONE_OUTCOMES = Object.freeze(['done']);

// 锁屏直复需系统生物识别；进入 App 后的点击定位路径不额外加验证门槛。
export const DIRECT_REPLY_REQUIRES_BIOMETRIC = true;
export const OPEN_APP_REQUIRES_BIOMETRIC = false;

// 只清洗「疑似凭据值」：凭据键=值、常见令牌前缀、Bearer 令牌。普通项目名、摘要、commit 不受影响。
const SECRET_PATTERNS = Object.freeze([
  [/\b(token|password|passwd|secret|api[_-]?key|apikey|private[_-]?key|credentials?|authorization)\s*[:=]\s*\S+/gi, '$1=[已隐藏]'],
  [/\b(?:gh[pousr]_|github_pat_|sk-|xox[baprs]-)[A-Za-z0-9_\-]+/gi, '[已隐藏]'],
  [/\bBearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer [已隐藏]'],
]);
export function redactSecrets(value) {
  let text = String(value ?? '');
  for (const [pattern, replacement] of SECRET_PATTERNS) text = text.replace(pattern, replacement);
  return text;
}

// 去控制字符、折叠空白、截断；锁屏摘要用较宽上限，保证完整摘要不被截断。
export function sanitizeText(value, max = 240) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export const clean = value => sanitizeText(redactSecrets(value));

export function projectLabel(cwd) {
  const text = String(cwd ?? '').trim().replace(/[/\\]+$/, '');
  if (!text) return '未识别';
  return text.split(/[/\\]/).filter(Boolean).pop() || text;
}

// 去重键：种类 + 稳定 id + revision（待办用 createdAt，节点完成用 advanceId）。
// 同一键只通知一次；重开产生新 revision 才是新决策。
export function notificationKey(kind, id, revision = '') {
  return `${kind}:${id}:${String(revision ?? '').trim()}`;
}

// 是否是可通知的「节点成功完成」事件：普通失败、自动重试、调度自愈都不通知。
// 自愈/其它事件类型直接排除；只有节点完成回执且 outcome 为 done 才成立。
const NODE_RECEIPT_TYPES = Object.freeze(['dag.node.advance', 'dag.auto.dev.advance']);
export function isNotifiableNodeEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
  const type = String(event.type ?? '').trim();
  if (type && !NODE_RECEIPT_TYPES.includes(type)) return false;
  return NODE_DONE_OUTCOMES.includes(String(event.outcome ?? '').trim());
}

// App 图标角标数量 = 待我处理（开放待办）数量；处理后同步清零。
export function badgeCount(cards) {
  return (Array.isArray(cards) ? cards : []).filter(card => String(card?.state ?? '').trim() === 'open').length;
}

// 每项「待我处理」对应一条独立系统通知：锁屏内容、点击定位、锁屏直接选择/文字回复。
export function buildTodoNotification(card = {}) {
  const src = card && typeof card === 'object' ? card : {};
  const id = src.id ?? src.cardId ?? null;
  const revision = String(src.createdAt ?? src.updatedAt ?? '').trim();
  const project = projectLabel(src.project ?? src.cwd);
  const summary = clean(src.title ?? src.summary ?? '待处理事项') || '待处理事项';
  const detail = clean(src.text ?? src.detail ?? '');
  const options = (Array.isArray(src.options) ? src.options : []).map(option => clean(String(option))).filter(Boolean);
  return {
    kind: NOTIFICATION_KINDS.TODO,
    id: `todo:${id}`,
    key: notificationKey(NOTIFICATION_KINDS.TODO, id, revision),
    title: 'Autoloop 有待您决策的事项',
    body: `${summary} · 项目 ${project}`,
    project,
    summary,
    lockScreen: { project, summary, detail },
    click: {
      page: 'todos', cardId: id,
      requiresBiometric: OPEN_APP_REQUIRES_BIOMETRIC, // 进 App 后高风险操作不额外加门槛
    },
    reply: {
      requiresBiometric: DIRECT_REPLY_REQUIRES_BIOMETRIC, // 锁屏直复需系统生物识别
      choices: options.map(label => ({ id: label, label })),
      allowText: true,
      draft: '',
    },
    badgeKey: `todo:${id}`, // 计入角标
  };
}

// 每个成功完成的节点对应一条独立系统通知：点击进入节点交付详情，不计角标、不支持直复。
export function buildNodeDoneNotification(event = {}) {
  const src = event && typeof event === 'object' ? event : {};
  const detail = src.detail && typeof src.detail === 'object' && !Array.isArray(src.detail) ? src.detail : {};
  const runId = String(src.runId ?? '').trim() || null;
  const nodeId = String(src.nodeId ?? '').trim() || null;
  const advanceId = String(src.advanceId ?? src.id ?? '').trim();
  const project = projectLabel(src.project ?? src.cwd);
  const summary = clean(src.title ?? src.summary ?? (nodeId ? `节点 ${nodeId} 已完成` : '节点已完成')) || '节点已完成';
  // 只取白名单交付字段（prUrl/commit/tests），不把 detail 里的任意字段透传进锁屏。
  const parts = [
    detail.prUrl ? `PR ${clean(detail.prUrl)}` : '',
    detail.commit ? `commit ${clean(detail.commit)}` : '',
    detail.tests ? `测试 ${clean(detail.tests)}` : '',
  ].filter(Boolean);
  const delivery = parts.join(' · ') || summary;
  return {
    kind: NOTIFICATION_KINDS.NODE_DONE,
    id: `node-done:${runId}:${nodeId}:${advanceId}`,
    key: notificationKey(NOTIFICATION_KINDS.NODE_DONE, `${runId}:${nodeId}`, advanceId),
    title: 'Autoloop 节点已完成',
    body: `${summary} · 项目 ${project}`,
    project, runId, nodeId, advanceId, outcome: 'done',
    summary,
    detail: delivery,
    lockScreen: { project, summary, detail: delivery },
    click: { page: 'node-delivery', runId, nodeId },
    reply: null,
    badgeKey: null, // 节点完成不占角标
  };
}
