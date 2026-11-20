# NoMoTo 手机 App 改名与扫码绑定修复（DAG 计划说明）

## 背景
- 用户反馈（2026-11-20）：App 名称不要叫「Autoloop 控制台」，改叫 NoMoTo（no more laptop）；绑定时手机端不能调起摄像头扫码，只能手工粘贴二维码内容，不可用。
- 事实核对：`mobile/app/www/app.mjs` 绑定流程只读 `bind-payload` 输入框；全仓库没有任何摄像头/扫码代码；`cap add android` 生成的清单也没有 CAMERA 权限。

## 范围
1. `nomoto-rename`：对外名称统一为 NoMoTo，包名 `cool.autoloop.console` 不变。
2. `qr-scan-bind`：绑定页扫码（getUserMedia + 入库的纯 JS 解码库），扫到即绑定，手工粘贴保留为兜底。
3. `apk-release-script`：打包脚本补 CAMERA 权限、默认地址 `https://auto.socialmore.net`、签名与产物输出。

## 非目标
不改设备授权协议与接口；不做真机安装；不引入第二套状态。

## 验收
`npm test`、`npm run test:browser` 全绿；每个节点独立审阅 P0–P2 清零后合并。重新打包与真机验证由所有者另行授权。

## 补充根因：手工输入备用码仍提示「无法连接控制台」（2026-11-20）
- 复现（公网实测 `https://auto.socialmore.net`）：同源请求可达服务端，回「绑定令牌无效」；带 `Origin: https://localhost` 且 `Sec-Fetch-Site: cross-site` 的绑定请求被服务端 403 拒绝；带自定义头的预检（OPTIONS）返回 404、无 CORS 头。
- 根因：APK 内置页面源是 `https://localhost`，请求控制台域名属跨站；`/api/mobile/bind` 按设计拒绝跨站、且无预检放行，真机一律失败，与备用码对错无关，App 只显示「无法连接」。
- 处理：`apk-release-script` 节点让 App 直接加载 `https://auto.socialmore.net/mobile/`（同源），服务端安全规则不放宽。
- 边界：根因由公网请求复现与代码核对得出，未在真机上复现；真机验证由所有者另行授权。
