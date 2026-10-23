# GGB DSH 兼容矩阵

| 组件 | 固定候选 | 用途 | 当前证据 |
| --- | --- | --- | --- |
| Node.js | `^22.19.0 || >=24.0.0` | API、Worker、SQLite、DSH SDK | 不锁具体小版本；发布前按 DSH SDK 支持范围复验 |
| pnpm | 11.7.0 | workspace 与冻结锁文件 | `packageManager` 固定 |
| DSH / 安装插件 | SDK 0.2.1-rc.2 / plugin 0.8.3 | `sdk-minimal`、安装包四工具与 Worker Skill、工具协议 3、回执 2、内部通道 8 | 完整依赖与包摘要固定；离线装配、SDK 初始化与迁移检查见 [兼容契约](./dsh-sdk-compatibility.md)；真实浏览器/Provider 验收记录见 [Backlog](../../docs/ggb-dsh-backlog.md) |
| GeoGebra | 5.4.929.3 | applet 与 `.ggb` | 官方 ZIP 摘要已实测；同源自托管、版本门禁和真实 Chromium ready 已验收 |
| TypeScript | 6.0.3 | 严格类型检查 | 根构建配置固定 |
| Zod | 4.5.4 | HTTP/事务边界 | 锁文件固定；内部包兼容 4.3.6 |

正式发布需要在每个声明支持的操作系统上运行同一套真实 applet、SQLite、恢复和 DSH 生命周期检查。
Node 继续使用兼容范围，不锁定具体小版本；每个发布环境记录实际 Node 版本和验证结果。
