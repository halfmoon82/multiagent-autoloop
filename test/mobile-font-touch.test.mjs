// font-touch 节点（Spec §9.6–§9.12 / §9.3 / DAG 节点 font-touch）边界测试：
// 字体随系统设置缩放（原生字体度量，不以网页缩放代替）、放大后换行/增高/纵向滚动、
// 不截断/不遮挡/不强制横向滚动；触控热区 44–48dp，整卡选项按压/选中/禁用态可测。
// 纯逻辑：feature 不碰 DOM、不依赖 node: 内置模块；上游文本全程纯字符串，由调用方安全渲染。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FONT_SCALE_STEPS, FONT_SCALE_DEFAULT, FONT_SCALE_MIN, FONT_SCALE_MAX, FONT_BASE_DP,
  FONT_SURFACES, FONT_LAYOUT_POLICY,
  TOUCH_TARGET_MIN_DP, TOUCH_TARGET_MAX_DP, ICON_VISUAL_DP,
  OPTION_STATES, OPTION_STATE_LABELS, optionStateLabel,
  normalizeFontScale, isCheckStep, scaledFontDp, scaledSurfaces, layoutForFontScale,
  touchTarget, reduceOptionState, isInteractive,
  buildFontBinding, buildTouchBinding,
} from '../mobile/src/features/font-touch/index.mjs';
import {
  fontScaleFromEnv, applyGlobalFontLayer, mount as mountFontTouch, loadViewModel as loadFontTouchViewModel,
} from '../mobile/app/www/pages/font-touch.mjs';

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FEATURE_DIR = path.join(REPO_DIR, 'mobile', 'src', 'features', 'font-touch');
const WWW_PAGES_DIR = path.join(REPO_DIR, 'mobile', 'app', 'www', 'pages');

// ---------------------------------------------------------------------------
// RED 1：契约词表与常量（Spec §9.3 / §9.10 / 设计评审 §3.4）
// ---------------------------------------------------------------------------
test('契约给出 100/130/160 系统字体检查档与默认/边界，不编造', () => {
  assert.deepEqual([...FONT_SCALE_STEPS], [100, 130, 160]);
  assert.equal(FONT_SCALE_DEFAULT, 100);
  assert.equal(FONT_SCALE_MIN, 100);
  assert.equal(FONT_SCALE_MAX, 160);
  assert.ok(FONT_SCALE_STEPS.every(step => step >= FONT_SCALE_MIN && step <= FONT_SCALE_MAX));
});

test('所有参与缩放的界面都列出；布局策略是换行/增高/纵向滚动，非截断/遮挡/横向', () => {
  assert.deepEqual([...FONT_SURFACES], ['body', 'long-question', 'option', 'input', 'artifact-doc', 'error']);
  assert.equal(FONT_LAYOUT_POLICY.wrap, true);
  assert.equal(FONT_LAYOUT_POLICY.growContainer, true);
  assert.equal(FONT_LAYOUT_POLICY.verticalScroll, true);
  assert.equal(FONT_LAYOUT_POLICY.horizontalScroll, false);
  assert.equal(FONT_LAYOUT_POLICY.truncate, false);
  assert.equal(FONT_LAYOUT_POLICY.occlude, false);
  assert.equal(FONT_LAYOUT_POLICY.nativeFontMetrics, true);
  assert.equal(FONT_LAYOUT_POLICY.webZoom, false, '不改用网页缩放代替原生字体度量');
});

test('触控热区 44–48dp，图标视觉尺寸小于热区；选项含按压/选中/禁用态', () => {
  assert.ok(TOUCH_TARGET_MIN_DP >= 44 && TOUCH_TARGET_MIN_DP <= 48);
  assert.ok(TOUCH_TARGET_MAX_DP >= TOUCH_TARGET_MIN_DP && TOUCH_TARGET_MAX_DP <= 48);
  assert.ok(ICON_VISUAL_DP < TOUCH_TARGET_MIN_DP, '图标视觉轻巧，热区独立扩张');
  assert.deepEqual([...OPTION_STATES], ['idle', 'pressed', 'selected', 'disabled']);
  for (const state of OPTION_STATES) assert.equal(typeof OPTION_STATE_LABELS[state], 'string');
  assert.equal(optionStateLabel('selected'), OPTION_STATE_LABELS.selected);
  assert.equal(optionStateLabel('unknown'), OPTION_STATE_LABELS.idle, '未知态回退默认，不编造');
});

// ---------------------------------------------------------------------------
// RED 2：系统字体缩放归一与原生字号
// ---------------------------------------------------------------------------
test('normalizeFontScale 只接受有限数值，越界收敛到 100–160，非法回退默认', () => {
  assert.equal(normalizeFontScale(160), 160);
  assert.equal(normalizeFontScale(130), 130);
  assert.equal(normalizeFontScale(50), FONT_SCALE_MIN, '低于下限收敛');
  assert.equal(normalizeFontScale(300), FONT_SCALE_MAX, '高于上限收敛');
  for (const bad of [undefined, null, NaN, Infinity, 'abc', {}, []]) {
    assert.equal(normalizeFontScale(bad), FONT_SCALE_DEFAULT, `${String(bad)} 回退默认`);
  }
});

test('scaledFontDp 按原生字体度量放大，160% 约为基准的 1.6 倍', () => {
  assert.equal(scaledFontDp(100), FONT_BASE_DP);
  assert.equal(scaledFontDp(160), Math.round(FONT_BASE_DP * 1.6 * 100) / 100);
  assert.equal(scaledFontDp('abc'), FONT_BASE_DP, '非法输入回退基准字号');
  assert.equal(scaledFontDp(160, 0), Math.round(FONT_BASE_DP * 1.6 * 100) / 100, '非法基准回退默认基准');
});

test('isCheckStep 只认 100/130/160 三档，不把越界收敛后的值误判为档位', () => {
  assert.equal(isCheckStep(100), true);
  assert.equal(isCheckStep(160), true);
  assert.equal(isCheckStep(150), false, '150 虽在范围内但不是检查档');
  assert.equal(isCheckStep(300), false, '越界值先收敛也不是检查档');
});

test('scaledSurfaces 让正文/长问题/选项/输入框/产物文档/错误信息一起参与缩放', () => {
  const surfaces = scaledSurfaces(160);
  assert.deepEqual(Object.keys(surfaces), [...FONT_SURFACES]);
  for (const value of Object.values(surfaces)) assert.equal(value, scaledFontDp(160));
});

// ---------------------------------------------------------------------------
// RED 3：放大后的布局（160% 无横向溢出、不截断、不遮挡）
// ---------------------------------------------------------------------------
test('160% 布局启用换行/增高/纵向滚动，禁用横向滚动/截断/遮挡', () => {
  const layout = layoutForFontScale(160, { contentWidth: 900, viewportWidth: 360 });
  assert.equal(layout.scale, 160);
  assert.equal(layout.wrap, true);
  assert.equal(layout.growContainer, true);
  assert.equal(layout.verticalScroll, true);
  assert.equal(layout.horizontalScroll, false);
  assert.equal(layout.truncated, false);
  assert.equal(layout.occluded, false);
  assert.equal(layout.nativeFontMetrics, true);
  assert.equal(layout.webZoom, false);
  assert.equal(layout.horizontalOverflow, false, '换行生效，宽内容也不横向溢出');
});

test('只有关闭换行时宽于视口的内容才判定横向溢出，符合“不强制横向滚动”', () => {
  const wrapped = layoutForFontScale(160, { contentWidth: 900, viewportWidth: 360, lineBreak: true });
  assert.equal(wrapped.horizontalOverflow, false);
  const noWrap = layoutForFontScale(160, { contentWidth: 900, viewportWidth: 360, lineBreak: false });
  assert.equal(noWrap.horizontalOverflow, true, '禁用换行是调用方违规，布局如实标记溢出');
  assert.equal(noWrap.horizontalScroll, false, '即便违规也不偷偷开启横向滚动');
  const narrow = layoutForFontScale(160, { contentWidth: 300, viewportWidth: 360, lineBreak: false });
  assert.equal(narrow.horizontalOverflow, false, '内容窄于视口不报溢出');
  const unknownViewport = layoutForFontScale(160, { contentWidth: 900 });
  assert.equal(unknownViewport.horizontalOverflow, false, '视口未知时 fail closed，不编造溢出');
});

test('100% 基线不增高、不强制滚动；布局函数不改入参', () => {
  const base = layoutForFontScale(100, { contentWidth: 100, viewportWidth: 360 });
  assert.equal(base.growContainer, false);
  assert.equal(base.verticalScroll, false);
  assert.equal(base.wrap, true);
  const options = { contentWidth: 900, viewportWidth: 360 };
  const snapshot = JSON.stringify(options);
  layoutForFontScale(160, options);
  assert.equal(JSON.stringify(options), snapshot, '入参不被修改');
});

// ---------------------------------------------------------------------------
// RED 4：触控热区（视觉轻巧、热区 44–48dp）
// ---------------------------------------------------------------------------
test('touchTarget 把小图标热区扩到下限 44dp 且不超过上限 48dp', () => {
  const small = touchTarget(20);
  assert.equal(small.visualDp, 20);
  assert.equal(small.hitDp, TOUCH_TARGET_MIN_DP);
  assert.equal(small.meetsMin, true);
  assert.equal(small.withinMax, true);
  const medium = touchTarget(46);
  assert.equal(medium.hitDp, 46, '本来就在区间内则不改动');
  const large = touchTarget(60);
  assert.equal(large.hitDp, TOUCH_TARGET_MAX_DP, '超大视觉尺寸被上限收敛');
  const fallback = touchTarget();
  assert.equal(fallback.visualDp, ICON_VISUAL_DP);
  assert.equal(fallback.hitDp, TOUCH_TARGET_MIN_DP);
});

test('touchTarget 非法输入回退安全热区', () => {
  for (const bad of [0, -5, NaN, Infinity, 'big', null]) {
    const target = touchTarget(bad);
    assert.equal(target.hitDp, TOUCH_TARGET_MIN_DP, `${String(bad)} 回退到最小热区`);
    assert.equal(target.meetsMin, true);
  }
});

// ---------------------------------------------------------------------------
// RED 5：整卡选项按压/选中/禁用态
// ---------------------------------------------------------------------------
test('选项状态机：默认→按压→释放回默认；选择/改选与取消', () => {
  assert.equal(reduceOptionState('idle', 'press'), 'pressed');
  assert.equal(reduceOptionState('pressed', 'release'), 'idle');
  assert.equal(reduceOptionState('idle', 'select'), 'selected');
  assert.equal(reduceOptionState('selected', 'deselect'), 'idle');
  assert.equal(reduceOptionState('selected', 'press'), 'selected', '已选中再按压保持选中');
  assert.equal(reduceOptionState('pressed', 'select'), 'selected', '按压后提交为选中');
});

test('禁用态不可按压/选中/取消，只有启用才回默认；未知态回退默认', () => {
  for (const action of ['press', 'release', 'select', 'deselect', 'disable']) {
    assert.equal(reduceOptionState('disabled', action), 'disabled', `禁用态忽略 ${action}`);
  }
  assert.equal(reduceOptionState('disabled', 'enable'), 'idle');
  assert.equal(reduceOptionState('selected', 'disable'), 'disabled');
  assert.equal(reduceOptionState('unknown', 'select'), 'selected', '未知态按默认态处理');
  assert.equal(reduceOptionState('idle', 'noop'), 'idle', '未知动作无副作用');
});

test('isInteractive 只有禁用态为不可交互', () => {
  assert.equal(isInteractive('idle'), true);
  assert.equal(isInteractive('pressed'), true);
  assert.equal(isInteractive('selected'), true);
  assert.equal(isInteractive('disabled'), false);
});

// ---------------------------------------------------------------------------
// RED 6：视图模型安全渲染 + 纯逻辑边界
// ---------------------------------------------------------------------------
test('字体视图模型给出系统档、三档、各界面字号与布局决策，不产出 html', () => {
  const binding = buildFontBinding(160);
  assert.equal(binding.systemFontScale, 160);
  assert.deepEqual(binding.checkSteps, [100, 130, 160]);
  assert.equal(binding.isCheckStep, true);
  assert.equal(binding.scaledFontDp, scaledFontDp(160));
  assert.deepEqual(binding.surfaces, scaledSurfaces(160));
  assert.equal(binding.layout.wrap, true);
  assert.equal(binding.layout.horizontalOverflow, false);
  assert.equal(binding.nativeFontMetrics, true);
  assert.equal(binding.webZoom, false);
  assert.equal(Object.hasOwn(binding, 'html'), false);
});

test('触控视图模型给出热区与选项态，禁用/选中/按压可测，不产出 html', () => {
  const idle = buildTouchBinding(20, 'idle');
  assert.equal(idle.visualDp, 20);
  assert.equal(idle.hitDp, TOUCH_TARGET_MIN_DP);
  assert.equal(idle.meetsMin, true);
  assert.equal(idle.disabled, false);
  assert.equal(idle.selected, false);
  assert.equal(idle.pressed, false);
  assert.equal(idle.optionStateLabel, OPTION_STATE_LABELS.idle);

  const selected = buildTouchBinding(20, 'selected');
  assert.equal(selected.selected, true);
  const disabled = buildTouchBinding(20, 'disabled');
  assert.equal(disabled.disabled, true);
  assert.equal(disabled.optionStateLabel, OPTION_STATE_LABELS.disabled);
  assert.equal(Object.hasOwn(disabled, 'html'), false);
});

test('feature 是纯逻辑：不依赖 node: 内置模块、不碰 DOM、不拼接 HTML', () => {
  const files = readdirSync(FEATURE_DIR).filter(name => name.endsWith('.mjs'));
  assert.ok(files.length > 0, 'feature 目录至少有一个 .mjs');
  for (const name of files) {
    const source = readFileSync(path.join(FEATURE_DIR, name), 'utf8');
    assert.ok(!/from\s+['"]node:/.test(source), `${name} 不得 import node: 内置模块`);
    assert.ok(!/\bdocument\.|\bwindow\.|\blocalStorage\b/.test(source.replace(/\/\/.*$/gm, '')), `${name} 不得直接碰 DOM/浏览器存储`);
    assert.ok(!/innerHTML|insertAdjacentHTML/.test(source), `${name} 不得拼接 HTML`);
  }
});

test('视图模型不泄漏凭据或注入标记，上游文本以纯字符串暴露', () => {
  const dump = JSON.stringify([
    buildFontBinding(160),
    buildTouchBinding(20, 'disabled'),
  ]);
  assert.ok(!dump.includes('<script') && !dump.includes('</div>') && !dump.includes('onerror='));
  assert.ok(!dump.includes('deviceToken') && !dump.includes('server-secret') && !dump.includes('apiKey'));
  assert.equal(typeof buildTouchBinding(20, 'selected').optionStateLabel, 'string');
});

test('端到端：160% 全界面缩放无横向溢出，热区达标，选项态可改选与禁用', () => {
  let state = 'idle';
  state = reduceOptionState(state, 'press');
  assert.equal(state, 'pressed');
  state = reduceOptionState(state, 'select');
  assert.equal(state, 'selected');
  state = reduceOptionState(state, 'disable');
  assert.equal(state, 'disabled');

  const font = buildFontBinding(160);
  for (const surface of FONT_SURFACES) assert.ok(font.surfaces[surface] > FONT_BASE_DP);
  assert.equal(font.layout.horizontalOverflow, false);
  assert.equal(font.layout.truncated, false);
  assert.equal(font.layout.occluded, false);
  const touch = buildTouchBinding(ICON_VISUAL_DP, state);
  assert.ok(touch.hitDp >= TOUCH_TARGET_MIN_DP && touch.hitDp <= TOUCH_TARGET_MAX_DP);
  assert.equal(touch.disabled, true);
});

// ---------------------------------------------------------------------------
// RED 7：页面接线——page 模块把系统字体档投影为全局样式层（由 app.mjs mount）
// ---------------------------------------------------------------------------
test('page 模块导出挂载与纯辅助函数，Node 边界无 DOM 时安全', async () => {
  assert.equal(typeof fontScaleFromEnv, 'function');
  assert.equal(typeof applyGlobalFontLayer, 'function');
  assert.equal(typeof mountFontTouch, 'function');
  assert.equal(typeof loadFontTouchViewModel, 'function');
  assert.equal(await mountFontTouch({}), null, 'Node 边界没有 window/document 时不挂载');
});

test('fontScaleFromEnv 读取宿主注入的系统字体档，缺失回退 100，不在接线层私自换算', () => {
  assert.equal(fontScaleFromEnv({ AutoloopFontScale: 160 }), 160);
  assert.equal(fontScaleFromEnv({ AutoloopNativeFontScale: 130 }), 130);
  assert.equal(fontScaleFromEnv({ AutoloopDevice: { fontScale: 160 } }), 160);
  assert.equal(fontScaleFromEnv({}), 100);
  assert.equal(fontScaleFromEnv({ AutoloopFontScale: 'bad' }), 'bad', '归一交给 feature 的 normalizeFontScale');
});

test('applyGlobalFontLayer 在 160% 写全局 CSS 变量与 data 属性，原生度量不缩放网页', () => {
  const props = new Map();
  const dataset = {};
  const doc = { documentElement: { style: { setProperty: (k, v) => props.set(k, v) }, dataset } };
  const layer = applyGlobalFontLayer(
    doc, buildFontBinding(160, { viewportWidth: 360 }), buildTouchBinding(ICON_VISUAL_DP, 'idle'),
  );
  assert.equal(layer.font.systemFontScale, 160);
  assert.equal(props.get('--font-scale'), '160');
  assert.equal(props.get('--font-base-dp'), String(FONT_BASE_DP));
  assert.equal(props.get('--font-size-dp'), String(scaledFontDp(160)));
  assert.equal(props.get('--touch-hit-min-dp'), String(TOUCH_TARGET_MIN_DP));
  assert.equal(props.get('--touch-hit-max-dp'), String(TOUCH_TARGET_MAX_DP));
  assert.equal(dataset.fontScale, '160');
  assert.equal(dataset.fontTouch, 'on');
  assert.equal(layer.font.layout.wrap, true);
  assert.equal(layer.font.layout.growContainer, true);
  assert.equal(layer.font.layout.verticalScroll, true);
  assert.equal(layer.font.layout.webZoom, false);
  assert.equal(layer.font.layout.horizontalOverflow, false);
  assert.equal(layer.touch.hitDp, TOUCH_TARGET_MIN_DP);
});

test('applyGlobalFontLayer 容忍不完整文档对象、不改入参、不产出 html', () => {
  const layer = applyGlobalFontLayer(null, buildFontBinding(100), buildTouchBinding(ICON_VISUAL_DP, 'idle'));
  assert.equal(layer.font.systemFontScale, 100);
  assert.equal(Object.hasOwn(layer, 'html'), false);
  const doc = { documentElement: { style: { setProperty() {} }, dataset: {} } };
  const options = { viewportWidth: 360 };
  applyGlobalFontLayer(doc, buildFontBinding(130, options), buildTouchBinding(ICON_VISUAL_DP, 'idle'));
  assert.deepEqual(options, { viewportWidth: 360 }, '入参不被修改');
});

// ---------------------------------------------------------------------------
// RED 8：全局样式层 CSS——原生字号、换行增高纵滚、热区、整卡选项态
// ---------------------------------------------------------------------------
test('font-touch.css 是全局样式层：原生字号不缩放网页，160% 无横向溢出', () => {
  const css = readFileSync(path.join(WWW_PAGES_DIR, 'font-touch.css'), 'utf8');
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(stripped, /:root\s*\{[\s\S]*?--font-size-dp\s*:/, '用 CSS 变量承载原生字号');
  assert.match(stripped, /font-size:\s*calc\(\s*var\(--font-size-dp/, '1rem = 系统档原生字号，不是网页缩放');
  assert.doesNotMatch(stripped, /(?:^|[^-])\bzoom\s*:/, '不用 zoom 缩放网页');
  assert.doesNotMatch(stripped, /transform\s*:\s*scale\(/, '不用 transform scale 缩放网页');
  assert.match(stripped, /overflow-wrap\s*:\s*anywhere/, '长文本换行');
  assert.match(stripped, /word-break\s*:/, '长词断行');
  assert.match(stripped, /overflow-y\s*:\s*auto/, '增高后纵向滚动');
  assert.match(stripped, /overflow-x\s*:\s*hidden/, '不横向滚动正文');
  assert.match(stripped, /max-width\s*:\s*100%\s*;/, '容器不超出视口');
  assert.match(stripped, /min-height:\s*calc\(\s*var\(--touch-hit-min-dp/, '热区不小于 44dp');
});

test('font-touch.css 给出整卡选项按压/选中/禁用态', () => {
  const css = readFileSync(path.join(WWW_PAGES_DIR, 'font-touch.css'), 'utf8');
  for (const state of ['pressed', 'selected', 'disabled']) {
    assert.match(css, new RegExp(`\\[data-option-state="${state}"\\]`), `${state} 态有样式`);
  }
});
