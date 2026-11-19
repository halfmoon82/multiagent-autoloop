// 系统字体缩放算法（Spec §9.6–§9.9 / 设计评审 §3.4）：
// 把系统字体档归一成原生字号，并给出放大后的布局决策。纯函数、无隐藏状态，便于 160% 验收。

import {
  FONT_SCALE_STEPS, FONT_SCALE_DEFAULT, FONT_SCALE_MIN, FONT_SCALE_MAX, FONT_BASE_DP,
  FONT_SURFACES, FONT_LAYOUT_POLICY,
} from './contract.mjs';

const round2 = value => Math.round(value * 100) / 100;

// 系统字体档：只接受有限数值，收敛到 100–160；NaN/Infinity/非数值回退默认档。
export function normalizeFontScale(value) {
  const scale = Number(value);
  if (!Number.isFinite(scale)) return FONT_SCALE_DEFAULT;
  return Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, Math.round(scale)));
}

// 是否恰好是 100/130/160 三档之一（越界收敛后的值不算档位）。
export function isCheckStep(value) {
  return FONT_SCALE_STEPS.includes(normalizeFontScale(value)) && Number(value) === normalizeFontScale(value);
}

// 原生字体度量下的字号：基准 × 系统档（%），不是网页缩放。非法基准回退默认基准。
export function scaledFontDp(scale, baseDp = FONT_BASE_DP) {
  const ratio = normalizeFontScale(scale);
  const base = Number.isFinite(baseDp) && baseDp > 0 ? baseDp : FONT_BASE_DP;
  return round2(base * ratio / 100);
}

// 各参与界面使用同一缩放字号，保证正文/长问题/选项/输入框/产物文档/错误信息一起放大。
export function scaledSurfaces(scale) {
  const size = scaledFontDp(scale);
  const surfaces = {};
  for (const surface of FONT_SURFACES) surfaces[surface] = size;
  return surfaces;
}

// 布局决策：放大启用换行、容器增高和纵向滚动，不横向滚动、不截断、不遮挡。
// 只有调用方禁用换行（lineBreak=false）且内容宽于已知视口时，才如实标记横向溢出；
// 视口未知时 fail closed 不编造溢出。任何输入都返回新对象，不修改入参。
export function layoutForFontScale(scale, options = {}) {
  const current = normalizeFontScale(scale);
  const opts = options && typeof options === 'object' ? options : {};
  const wrap = FONT_LAYOUT_POLICY.wrap && opts.lineBreak !== false;
  const contentWidth = Math.max(0, Number(opts.contentWidth) || 0);
  const viewportWidth = Math.max(0, Number(opts.viewportWidth) || 0);
  const viewportKnown = viewportWidth > 0;
  const horizontalOverflow = viewportKnown && !wrap && contentWidth > viewportWidth;

  return {
    scale: current,
    scaledFontDp: scaledFontDp(current),
    wrap,
    growContainer: FONT_LAYOUT_POLICY.growContainer && current > FONT_SCALE_DEFAULT,
    verticalScroll: FONT_LAYOUT_POLICY.verticalScroll && current > FONT_SCALE_DEFAULT,
    horizontalScroll: FONT_LAYOUT_POLICY.horizontalScroll,
    truncated: FONT_LAYOUT_POLICY.truncate,
    occluded: FONT_LAYOUT_POLICY.occlude,
    horizontalOverflow,
    nativeFontMetrics: FONT_LAYOUT_POLICY.nativeFontMetrics,
    webZoom: FONT_LAYOUT_POLICY.webZoom,
  };
}
