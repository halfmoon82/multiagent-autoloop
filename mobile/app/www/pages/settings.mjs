// 「设备与偏好」设置页：头部齿轮进入，页内三分区（设备绑定 / 通知偏好 / 系统字体）。
// 分区内容仍由既有 devices.mjs / notify.mjs / font-touch.mjs 各自 mount 到分区内的原挂点
// （#page-devices / #notify-root / #font-touch-root），本模块只负责入口接线，不编辑那三个文件。
export const SETTINGS_SECTIONS = Object.freeze([
  { title: '设备绑定', host: 'page-devices' },
  { title: '通知偏好', host: 'notify-root' },
  { title: '系统字体', host: 'font-touch-root' },
]);

/** 挂载点。齿轮按钮经 ctx.hooks.openSettings 进入页面栈；返回键逐级返回由 app.mjs 的页面栈负责。 */
export function mount(ctx) {
  if (typeof document === 'undefined') return;
  const gear = document.getElementById('open-settings');
  if (gear) gear.addEventListener('click', () => ctx.hooks.openSettings());
}
