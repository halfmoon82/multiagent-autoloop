// DOM 稳定守卫（2026-11-17 全局修复）：控制台每 2s 轮询重建列表，整棵 replaceChildren 会拆除
// 用户正在交互的节点——选区被打散导致内容无法选定复制、按下的按钮被拆除导致 click 丢失、
// 输入框重建打断组词。键控列表（cards-list / session-workspace）已有原地钉住更新
// （app.mjs replaceKeyedPreserving）；本模块给所有非键控容器提供同语义的容器级守卫：
// 交互存在期间跳过本次替换（该容器内容冻结），交互结束后下一轮轮询用最新数据自动补齐。
let pressTarget = null;
// 只有"正在键入"的控件需要冻结保护（输入法组词/半输入草稿）；复选框、单选、按钮等
// 聚焦重建无损失，且聚焦态常驻——不区分会把点过的复选框卡片永久冻住（2026-11-17 DAG 授权页实测）
const EDITABLE_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'password', 'number']);
function isTextEditing(node) {
  if (!node) return false;
  if (node.isContentEditable) return true;
  if (node.tagName === 'TEXTAREA' || node.tagName === 'SELECT') return true;
  return node.tagName === 'INPUT' && EDITABLE_INPUT_TYPES.has(node.type);
}

if (typeof document !== 'undefined') {
  // 捕获阶段挂在 document 上：任何容器（包括 dag-app 等独立模块）无需自行跟踪按压状态
  document.addEventListener('pointerdown', event => { pressTarget = event.target; }, true);
  document.addEventListener('pointerup', () => { pressTarget = null; }, true);
  document.addEventListener('pointercancel', () => { pressTarget = null; }, true);
}

function hostOf(node) {
  return node ? (node.nodeType === 1 ? node : node.parentElement) : null;
}

// 容器内是否存在"活体交互"：文本输入控件聚焦（含输入法组词）、非折叠选区、指针按下未抬起。
// 选区在 mouseup 后仍然保留，因此复制场景靠选区判定冻结；点击场景靠 pressTarget 判定。
export function hasLiveInteraction(container) {
  if (!container) return false;
  const active = document.activeElement;
  if (active !== document.body && isTextEditing(active) && container.contains(active)) return true;
  const selection = document.getSelection?.();
  if (selection && !selection.isCollapsed) {
    const host = hostOf(selection.anchorNode);
    if (host && container.contains(host)) return true;
  }
  if (pressTarget && container.contains(pressTarget)) return true;
  return false;
}

// 稳定替换：容器内有活体交互时跳过本轮（冻结），未受影响的容器照常更新。
// 跳过不缓存任何节点——render() 每轮都用最新数据重新计算，冻结容器在交互结束后自然补齐。
export function stableReplace(idOrElement, nodes = []) {
  const container = typeof idOrElement === 'string' ? document.getElementById(idOrElement) : idOrElement;
  if (!container) return;
  if (hasLiveInteraction(container)) return;
  container.replaceChildren(...nodes);
}
