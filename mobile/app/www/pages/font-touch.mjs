// font-touch 全局样式层挂载点：不对应 Tab，由 app.mjs 在装配阶段 mount 一次；样式经
// index.html 作为全局层加载，作用于所有页面而非某个 Tab。
// 把宿主注入的系统字体档交给 feature 的纯逻辑归一，写成 documentElement 上的 CSS 变量与
// data 属性，让所有页面共用同一套原生字体度量与触控热区口径。
// 不读取密钥、不发请求、不拼接 HTML，也不使用网页缩放代替原生字号。

const FONT_SCALE_CHANGED = 'autoloop:font-touch-scale-changed';

// 与 feature/contract.mjs 同一口径的 CSS 缺省值（原生 dp）。接线层只写样式口径，
// 数值口径仍在 feature 里；回归用 feature 常量断言这些值，漂移会立刻失败。
const TOUCH_HIT_MIN_DP = 44;
const TOUCH_HIT_MAX_DP = 48;
const ICON_VISUAL_DP = 22;

// 浏览器 URL 是 /mobile/pages/<kebab>.mjs，../src 指 /mobile/src；
// Node 边界按仓库真实目录，要上溯三级到 mobile/src。同一出口，两种相对路径。
const featureSpecifier = typeof window === 'undefined'
  ? '../../../src/features/font-touch/index.mjs'
  : '../src/features/font-touch/index.mjs';

export const loadViewModel = () => import(featureSpecifier);

// 宿主注入字体档的来源：原生桥优先，网页回归用 AutoloopFontScale 注入。
// 接线层只取值，收敛/非法回退统一交给 feature 的 normalizeFontScale（100–160，默认 100）。
export function fontScaleFromEnv(env = {}) {
  const source = env && typeof env === 'object' ? env : {};
  const candidates = [
    source.AutoloopNativeFontScale,
    source.AutoloopFontScale,
    source.AutoloopDevice?.fontScale,
  ];
  for (const value of candidates) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return 100;
}

// 字体/触控绑定 → 全局 CSS 变量与 data 属性。纯投影，不写业务状态。
// doc 可以是最小文档桩（documentElement.style.setProperty + dataset），便于纯逻辑回归。
export function applyGlobalFontLayer(doc, fontBinding, touchBinding) {
  const font = fontBinding;
  const variables = {
    '--font-scale': String(font.systemFontScale),
    '--font-base-dp': String(font.baseFontDp),
    '--font-size-dp': String(font.scaledFontDp),
    '--touch-hit-min-dp': String(TOUCH_HIT_MIN_DP),
    '--touch-hit-max-dp': String(TOUCH_HIT_MAX_DP),
    '--icon-visual-dp': String(ICON_VISUAL_DP),
  };
  const root = doc?.documentElement;
  if (root && typeof root === 'object') {
    if (root.style && typeof root.style.setProperty === 'function') {
      for (const [name, value] of Object.entries(variables)) root.style.setProperty(name, value);
    }
    if (root.dataset && typeof root.dataset === 'object') {
      root.dataset.fontScale = String(font.systemFontScale);
      root.dataset.fontTouch = font.layout.webZoom ? 'off' : 'on';
      root.dataset.fontWrap = String(font.layout.wrap);
      root.dataset.fontVerticalScroll = String(font.layout.verticalScroll);
    }
  }
  return { font, touch: touchBinding, variables };
}

/** 挂载点。ctx 含 client / state / hooks；Node 边界没有 window/document 时安全跳过。 */
export function mount(ctx) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;
  // 视图模型按需动态加载；装配阶段不等待，CSS 缺省值保证 100% 基线先可用。
  return (async () => {
    const feature = await loadViewModel();
    const layoutOptions = () => {
      const width = window.innerWidth;
      return Number.isFinite(width) && width > 0 ? { viewportWidth: width } : {};
    };
    const touch = feature.buildTouchBinding(ICON_VISUAL_DP, 'idle');
    let layer = applyGlobalFontLayer(
      document,
      feature.buildFontBinding(fontScaleFromEnv(window), layoutOptions()),
      touch,
    );

    const api = {
      get scale() { return layer.font.systemFontScale; },
      get binding() { return layer.font; },
      variables: () => ({ ...layer.variables }),
      touchBinding: (visualDp, state) => feature.buildTouchBinding(visualDp, state),
      setFontScale(value) {
        layer = applyGlobalFontLayer(document, feature.buildFontBinding(value, layoutOptions()), touch);
        window.dispatchEvent(new CustomEvent(FONT_SCALE_CHANGED, { detail: layer.font }));
        return layer.font;
      },
    };
    window.AutoloopFontTouch = api;

    // 原生桥若提供订阅，只受理固定事件名；桥异常不影响页面装配。
    const bridge = window.AutoloopFontScaleBridge;
    if (bridge && typeof bridge.subscribe === 'function') {
      try { bridge.subscribe(scale => api.setFontScale(scale)); } catch { /* 宿主订阅不可用则忽略 */ }
    }
    return api;
  })();
}
