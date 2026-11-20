# NoMoTo App 全面修复与接线（DAG 计划说明）

## 背景
- 用户实测（2026-11-20）：安装 `work/apk/nomoto-release.apk` 后停在设备绑定页：「扫码绑定」调不起摄像头、「生物识别解锁」按钮无反应；后台复制的备用码要手输 `autoloop://bind?token=` 前缀才能绑定。后续会话、待办、产物、通知等功能也因此全部无法验证。
- 事实核对：两轮 DAG 交付的 App 实际上只有"绑定页 + 空壳主界面"可达；`mobile/src/features/*` 九个业务模块（会话、待回答组、产物、DAG 环、通知、语音、字体、项目筛选、设备同步）**无一被 `mobile/app/www/` 引用**；spec 假定的原生桥（`window.AutoloopBiometric`/`AutoloopSecureStorage`/`AutoloopScanCamera`）没有任何节点实现，`capacitor.plugins.json` 为空，manifest 只有 INTERNET/CAMERA；服务端移动端路由绑定后只允许 GET，`device-auth.mjs` 的 `submitDecision` 是无路由死代码，无推送路径，token 无持久存储。

## 已确认决策（2026-11-20）
- 目标设备：华为旧鸿蒙，无谷歌服务 → 不用 FCM/ML Kit/Play API。
- 通知：本期常驻通知保活（前台服务 + 常驻通知 + 轮询待办 + RemoteInput 锁屏直复 + 角标）；华为 Push Kit 列后续。
- 原生能力不引入第三方插件：自写 Capacitor 插件（相机 WebChromeClient 授权、androidx.biometric、Keystore 存储、前台服务、语音识别桥），扫码解码复用已入库的 `vendor/qr-decoder.mjs`。
- UI 交互唯一基线：`docs/design/2026-11-17-mobile-app/index.html`；页面逻辑复用 `mobile/src/*` 现有视图模型，不复制业务状态。

## 范围
按 `docs/dag-plans/2026-11-22-nomoto-app-foundation.json` 13 个节点执行：
1. `native-platform`：Android 原生插件（相机权限转发/生物识别/安全存储/前台通知服务/语音桥）与 manifest 权限。
2. `bind-ux`：备用码显示全 payload、输入端接受裸 64hex 自动补前缀。
3. `mobile-write-api`：服务端移动端写路由最小集（卡片回答/授权、会话恢复、产物下载）+ 契约测试。
4. `ui-shell-nav`、`ui-sessions-artifacts`、`ui-dag-rings`：把 `mobile/src/*` 视图模型接进 `www/` 的 Tab 化页面。
5. `foreground-notify`：常驻通知 + 轮询/去重/角标 + 直复回写。
6. `voice-input`、`font-fold`、`sync-audit`：语音输入、系统字体/折叠适配、多设备同步与审计。
7. `apk-rebuild`：打包脚本补插件与 manifest patch。
8. `smoke-emulator` → `smoke-device`：模拟器实测（扫码弹窗、解锁、Tab 可达、通知直复）与真机验收（真机授权独立）。

## 非目标
不改设备授权协议与 Hub；不接 FCM/华为推送；不做真机安装（独立授权）；不引入第二套业务状态。

## 验收
`npm test` 与 `npm run test:browser` 全绿；每节点独立审阅 P0–P2 清零；`smoke-emulator` 产模拟器截图/录屏证据；新 APK 真机安装与验收由所有者另行授权。
