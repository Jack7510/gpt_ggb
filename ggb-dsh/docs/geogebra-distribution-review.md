# GeoGebra applet 分发审查

状态：Approved for non-commercial distribution

更新日期：2026-09-07

关联任务：GGB-008

## 摘要

工程采用自托管 GeoGebra Math Apps Bundle 5.4.929.3，使核心画布不依赖 CDN。官方许可把完整软件、
Web 服务、语言文件和界面素材置于不同条款下；商业用途需要与 GeoGebra 签订单独协议。因此，在项目
负责人或法务书面确认用途与许可前，ZIP 只能用于本地原型和 CI，不得进入公开或商业发布资产。

## 资源来源

- 官方嵌入文档提供[离线和自托管方案](https://geogebra.github.io/docs/reference/en/GeoGebra_Apps_Embedding/#offline-and-self-hosted-solution)，要求本地加载 `deployggb.js` 并设置 HTML5 codebase。
- 2026-09-07 官方下载地址重定向到 `geogebra-math-apps-bundle-5-4-929-3.zip`。
- ZIP 的 SHA-256 已下载实测为 `8855e7577fb766108e3feed1991c42649b691ef4a4d88c2ddb431b893d58811e`。
- 版本、URL 和摘要由 [`runtime-versions.json`](../config/runtime-versions.json) 管理；二进制资源不进入 Git。
- `pnpm run provision:geogebra` 只在摘要匹配后解压；API 启动时再次核对供应清单和必需文件。

## 许可结论

[GeoGebra 官方许可](https://www.geogebra.org/license)允许按其非商业条款复制和分发完整软件，并要求署名；条款给出的署名文字是 “Made with GeoGebra®”。商业用途需要单独的 License and Collaboration Agreement。源代码使用 EUPL 1.2 不代表完整产品、语言文件和界面素材可以不受非商业限制地分发。

项目负责人已于 2026-09-07 书面确认本项目仅作非商业用途。产品须持续限定为符合条款的非商业用途、完成署名，并在任何商业发布前取得 GeoGebra 的书面商业授权。

## 离线与更新要求

- 核心画布必须从 API/Edge 同源本地资源加载，不依赖 `latest` URL、CDN 或 service worker 首次下载。
- 构建只接受清单中的固定 URL和 SHA-256。升级由发布负责人显式修改清单，并重新运行 API、视觉、文件兼容和许可检查。
- CI 缓存可以保存已校验 ZIP，但测试前仍检查摘要。发布产物必须生成第三方许可与署名清单。
- applet 启动后记录 `getVersion()`，并在版本与清单不一致时拒绝进入 Agent 构造流程。

## CSP 基线

GeoGebra 资源通过同源静态路径加载，CSP 不允许远程 script、style、font、frame 或 connect。该固定版
GWT runtime 实测需要 `script-src 'unsafe-eval' 'unsafe-inline'`，样式需要 `'unsafe-inline'`；这是已记录的
第三方兼容例外，不允许扩为 `*` 或任意远程域。浏览器 E2E 必须保持控制台零 CSP 违规。

## 已确认项

- 产品为非商业用途，适用官方非商业条款；任何商业化是新的发布阻断条件。
- 应用画布下方显示 “Made with GeoGebra®”、非商业限制和官网链接；本文作为第三方通知与工程来源记录。
- runtime、字体和语言文件全部从 API/Edge 同源提供，不在首次运行依赖 CDN。
- applet `getVersion()` 必须精确返回 5.4.929.3，否则不进入 ready 状态。
- 2026-09-08 已以真实 Chromium 验证本地 runtime 加载、ready 状态、署名及控制台 0 error/0 warning。

升级负责人必须修改清单、重新核对官方许可与摘要，并重跑真实浏览器验证。商业用途仍需单独书面授权。

## Dev Note

本文是工程审查，不是法律意见，也不表示 GeoGebra 已授权本产品分发。
