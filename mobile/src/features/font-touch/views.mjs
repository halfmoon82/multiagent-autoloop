// font-touch 视图模型（Spec §9.3 / §9.6–§9.11 / 设计评审 §3.4 / DAG 节点 font-touch）：
// 把系统字体档投影成「各界面字号 + 布局决策 + 检查档」，把视觉尺寸/选项态投影成「热区 + 状态」。
// 不读取系统设置、不触碰 DOM、不发请求；所有文本都是普通字符串，由调用方用 textContent 之类安全渲染。

import {
  FONT_SCALE_STEPS, FONT_BASE_DP, FONT_LAYOUT_POLICY, optionStateLabel,
} from './contract.mjs';
import {
  normalizeFontScale, isCheckStep, scaledFontDp, scaledSurfaces, layoutForFontScale,
} from './font.mjs';
import { touchTarget } from './touch.mjs';

// 字体视图模型：系统档、三档检查表、各参与界面字号、放大后的布局决策。
export function buildFontBinding(fontScale, layoutOptions = {}) {
  const scale = normalizeFontScale(fontScale);
  const layout = layoutForFontScale(scale, layoutOptions);
  return {
    systemFontScale: scale,
    checkSteps: [...FONT_SCALE_STEPS],
    isCheckStep: isCheckStep(fontScale),
    baseFontDp: FONT_BASE_DP,
    scaledFontDp: scaledFontDp(scale),
    surfaces: scaledSurfaces(scale),
    layout,
    nativeFontMetrics: layout.nativeFontMetrics,
    webZoom: FONT_LAYOUT_POLICY.webZoom,
  };
}

// 触控视图模型：视觉尺寸、扩张后的热区是否达标、整卡选项的按压/选中/禁用态。
export function buildTouchBinding(visualDp, optionState) {
  const target = touchTarget(visualDp);
  const state = optionState === 'pressed' || optionState === 'selected' || optionState === 'disabled'
    ? optionState
    : 'idle';
  return {
    visualDp: target.visualDp,
    hitDp: target.hitDp,
    meetsMin: target.meetsMin,
    withinMax: target.withinMax,
    optionState: state,
    optionStateLabel: optionStateLabel(state),
    disabled: state === 'disabled',
    selected: state === 'selected',
    pressed: state === 'pressed',
  };
}
