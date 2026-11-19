// 产物双入口共享契约（Spec §8.2.5 / §8.3 / DAG 节点 artifacts）。
// 纯函数、不触碰浏览器全局、不依赖 Node 内置模块：Node 边界测试与移动端打包器都可导入。
// 上游文本全程是纯字符串，由调用方用 textContent 之类安全方式渲染。

// 双入口：全局产物管理页；会话流内「本会话产物」。
export const ARTIFACT_ENTRY_POINTS = Object.freeze(['global', 'session']);
export const ARTIFACT_ENTRY_LABELS = Object.freeze({
  global: '全局产物管理页', session: '本会话产物',
});
export const artifactEntryLabel = entry => ARTIFACT_ENTRY_LABELS[entry] || ARTIFACT_ENTRY_LABELS.global;

// 布局：手机单栈逐级返回；折叠屏左列表右阅读双栏。
export const ARTIFACT_LAYOUTS = Object.freeze(['phone', 'fold']);
export const ARTIFACT_LAYOUT_LABELS = Object.freeze({
  phone: '手机单栈', fold: '折叠双栏',
});
export const artifactLayoutLabel = layout => ARTIFACT_LAYOUT_LABELS[layout] || ARTIFACT_LAYOUT_LABELS.phone;

// 只读产物类型（与服务端 src/artifacts.mjs 的 ARTIFACT_EXTENSIONS 对齐）。
export const ARTIFACT_VIEW_EXTENSIONS = Object.freeze(['.md', '.markdown', '.html', '.htm']);
const KIND_LABELS = Object.freeze({ '.md': 'Markdown', '.markdown': 'Markdown', '.html': 'HTML', '.htm': 'HTML' });
export const artifactKindLabel = ext => KIND_LABELS[String(ext || '').toLowerCase()] || '未知类型';

// 移动端产物只读；系统分享导出的是只读副本，不在手机上改写目标项目。
export const ARTIFACT_MOBILE_READ_ONLY = true;
export const ARTIFACT_SHARE_READ_ONLY = true;
// 产物文件卡整行热区约 48dp。
export const ARTIFACT_FILE_TOUCH_TARGET_DP = 48;

// 可读错误：产物不存在或越界都给明确说明，不外泄内部路径。
export const ARTIFACT_ERRORS = Object.freeze({
  missing: '产物不存在或已移出会话目录',
  outOfBounds: '产物路径越界，不能访问会话目录外的文件',
  noSession: '产物所属会话不存在',
  unsupported: '不支持的产物类型，仅可阅读 Markdown 与 HTML',
  missingState: '产物数据缺失，未读取到会话产物',
});
