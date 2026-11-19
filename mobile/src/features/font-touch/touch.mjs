// 触控热区与整卡选项状态机（Spec §9.10–§9.11 / 设计评审 §3.4）：
// 图标视觉保持轻巧，但交互热区扩张到 44–48 dp；选项有按压/选中/禁用态且可测。
// 纯函数、无隐藏状态；任何输入都返回新值，不修改入参。

import {
  TOUCH_TARGET_MIN_DP, TOUCH_TARGET_MAX_DP, ICON_VISUAL_DP, OPTION_STATES,
} from './contract.mjs';

// 热区 = 视觉尺寸扩张到 [44,48] dp：小图标扩到下限，超大视觉尺寸收敛到上限。
// 非法视觉尺寸回退默认图标尺寸；meetsMin/withinMax 让验收可断言。
export function touchTarget(visualDp = ICON_VISUAL_DP) {
  const numeric = Number(visualDp);
  const visual = Number.isFinite(numeric) && numeric > 0 ? numeric : ICON_VISUAL_DP;
  const hit = Math.max(TOUCH_TARGET_MIN_DP, Math.min(visual, TOUCH_TARGET_MAX_DP));
  return {
    visualDp: visual,
    hitDp: hit,
    meetsMin: hit >= TOUCH_TARGET_MIN_DP,
    withinMax: hit <= TOUCH_TARGET_MAX_DP,
  };
}

// 整卡选项状态机：禁用态是 absorption 态，只有 enable 才能回到默认。
// 已选中再按压保持选中；按压后未提交则释放回默认；提交进入选中，可改选或取消。
export function reduceOptionState(state, action) {
  const current = OPTION_STATES.includes(state) ? state : 'idle';
  if (current === 'disabled') return action === 'enable' ? 'idle' : 'disabled';

  switch (action) {
    case 'disable': return 'disabled';
    case 'press': return current === 'selected' ? 'selected' : 'pressed';
    case 'release': return current === 'pressed' ? 'idle' : current;
    case 'select': return 'selected';
    case 'deselect': return 'idle';
    default: return current;
  }
}

// 只有禁用态不可交互；按压/选中态仍可被后续动作改变。
export function isInteractive(state) {
  return state !== 'disabled';
}
