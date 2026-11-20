# NoMoTo App 全面修复与接线（DAG 计划说明）

## 背景
- 用户实测（2026-11-20）：安装 `work/apk/nomoto-release.apk` 后停在设备绑定页：「扫码绑定」调不起摄像头、「生物识别解锁」按钮无反应；后台复制的备用码要手输 `autoloop://bind?token=` 前缀才能绑定。后续会话、待办、产物、通知等功能也因此全部无法验证。
- 事实核对：两轮 DAG 交付的 App 实际上只有"绑定页 + 空壳主界面"可达；`mobile/src/features/*` 九个业务模块（会话、待回答组、产物、DAG 环、通知、语音、字体、项目筛选、设备同步）**无一被 `mobile/app/www/` 引用**；spec 假定的原生桥（`window.AutoloopBiometric`/`AutoloopSecureStorage`/`AutoloopScanCamera`）没有任何节点实现，`capacitor.plugins.json` 为空，manifest 只有 INTERNET/CAMERA；服务端移动端路由绑定后只允许 GET，`device-auth.mjs` 的 `submitDecision` 是无路由死代码，无推送路径，token 无持久存储。

## 已确认决策（2026-11-20）
- 目标设备：华为旧鸿蒙，无谷歌服务 → 不用 FCM/ML Kit/Play API。
- 通知：本期常驻通知保活（前台服务 + 常驻通知 + 轮询待办 + RemoteInput 锁屏直复 + 角标）；华为 Push Kit 列后续。
- 原生能力不引入第三方插件：自写 Capacitor 插件（相机 WebChromeClient 授权、androidx.biometric、Keystore 存储、前台服务、语音识别桥），扫码解码复用已入库的 `vendor/qr-decoder.mjs`。
- UI 交互唯一基线：`docs/design/2026-11-17-mobile-app/index.html`；页面逻辑复用 `mobile/src/*` 现有视图模型，不复制业务状态。

## 范围（脚手架先行、最大并行）
按 `docs/dag-plans/2026-11-22-nomoto-app-foundation.json` 18 个节点执行，依赖只按真实写范围设置：

- **wave-0（2 并行）**：`mobile-scaffold` 一次性预留全部共享接缝——www 页面拆成 `www/pages/<name>.mjs` 独立模块（app.mjs 只装配）、`/mobile/pages/` 与 `/mobile/src/` 受限目录静态服务（取代固定白名单，后续节点不再改 server.mjs）、`src/mobile-write.mjs` 写路由钩子（挂在 GET-only 闸之前，先 501 占位）、原生源码入库 `mobile/app/native/`（MainActivity 预注册全部插件、权限一次写全，build-apk 在 cap add 后拷入合并）；`bind-ux` 后台备用码显示完整载荷+一键复制、移动端接受裸 64hex。
- **wave-1（9 并行）**：原生 `native-auth`（相机授权转发/生物识别/Keystore）、`native-notify`（前台常驻服务/通知/RemoteInput 直复/角标）、`native-speech`（系统语音识别）；服务端 `mobile-write-api`；页面 `ui-core-pages`、`ui-sessions`、`ui-artifacts`、`ui-dag-filter`、`font-touch`。
- **wave-2（4 并行）**：`notify-wiring`、`voice-wiring`、`sync-audit`（含管理后台审计列表）、`session-early-device`（会话页一就绪即打预览包请所有者真机试用，不阻塞其他节点）。
- **wave-3/4/5**：`apk-verify` 打包集成校验 → `smoke-emulator` 模拟器全链路 smoke（独立 npm 脚本，不进 `npm test`）→ `smoke-device` 真机验收（另行授权）。

## 体验补救（2026-11-20 追加）
会话页等全部是 H5，为接近原生聊天 App 体验，以下作为硬性验收：
- 脚手架：系统返回键逐级返回（不直接退出）、断网内置离线页、键盘弹起适配（adjustResize + visualViewport）、原生震动反馈。
- 会话页：虚拟列表、流式输出按帧刷新且不乱跳、「回到底部」、输入栏随键盘不遮挡、自定义长按菜单；500 条消息滚动、30 秒流式、10 次键盘升降作为模拟器验收项。
- 原生：H5 文件选择走系统选择器，产物下载走系统下载管理器（WebView 默认点下载无反应）。
- 早期真机试用：旧鸿蒙 WebView 是最大变数，会话页先上真机；不达标再决定是否单独改原生。

## 非目标
不改设备授权协议与 Hub；不接 FCM/华为推送；不做真机安装（独立授权）；不引入第二套业务状态；附件上传（网页控制台目前也无此能力）列为后续需求。

## 验收
`npm test` 与 `npm run test:browser` 全绿；每节点独立审阅 P0–P2 清零；`smoke-emulator` 产模拟器截图/录屏证据；新 APK 真机安装与验收由所有者另行授权。
