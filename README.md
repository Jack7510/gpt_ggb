# GGB Copilot

GGB Copilot 是一个以 GeoGebra 为画布的数学构图 Agent 项目。用户在浏览器中输入构图任务，
Server 调用模型和插件完成构造、核验，并交付可交互的 `.ggb` 文件。交付结果可以导入画布、
下载到本地，也可以作为下一轮任务的基线。

本文是项目说明书，面向使用者和新加入的开发者。建议按“项目概览 → 架构与目录 → 本地运行”阅读。
Coding Agent 的工作方式、验证要求和操作权限见 [AGENTS.md](AGENTS.md)。

## 项目概览

当前产品使用 **plugin-core** 引擎。浏览器提供可安装的 PWA、本地对话 Session 与 GeoGebra applet；
Server 使用 DeepSeek Harness（DSH）驱动模型，并调用 `ggb-plugins` 的 plugin-core 管线执行和核验。

用户的 DeepSeek API Key 采用 BYOK 方式加密保存在当前浏览器。每次执行时，浏览器将 Key 短暂交给
Server；Server 不保存用户账户、浏览器 Session 或 Provider Key，只保存该 run 所需的题目、过程、
交付证据与用量事实。

Native 九阶段引擎已删除。旧 Native run 的数据库行保留为证据，读取、执行和恢复代码已移除。
相关请求在 token 验证后返回 `409 checkpoint_incompatible`；新的 Native 写请求返回
`409 engine_not_supported`。删除前的完整代码保存在标签 `archive/native-nine-stage-pre-plugin-core`。

## 当前架构

```text
Browser PWA
  ├─ 本地 Session、聊天记录和画布副本（IndexedDB / OPFS）
  ├─ 浏览器加密 BYOK Vault 与 GeoGebra applet
  └─ 导入 / 下载 GGB，提供下一轮任务基线
                 │ HTTPS + SSE + runToken
                 ▼
Plugin-core Server
  ├─ API：HTTP/SSE、run 生命周期和产物鉴权
  ├─ Worker：SDK Server、协议 3 工具网关、可信回执接收与进程清理
  └─ plugin_core_* run store：过程、交付与用量事实
                 │
                 ├─ DeepSeek Provider
                 └─ 安装式 ggb-construct 插件：四工具、Worker Skill、Playwright + GeoGebra
```

浏览器不运行模型循环，也不执行模型生成的任意 GeoGebra 命令。Provider Key 只在本次服务端执行期间
持有，不落盘、不进入日志。API 与 Worker 通过内部 Unix socket 协作；runToken 只授权对应 run。

详细数据边界、API 和设计取舍见 [plugin-core 采用方案](docs/ggb-dsh-plugin-core-adoption.md)。
当前 release 的已验证范围、风险和换机步骤见 [切换交接](docs/ggb-dsh-plugin-core-cutover-handoff.md)。

## 代码仓结构

`ggb-dsh/` 是唯一的 pnpm workspace。模块职责如下：

| 路径 | 职责 |
| --- | --- |
| `ggb-dsh/apps/client/` | PWA、UI、本地 Session、IndexedDB/OPFS、BYOK Vault、applet 画布交互与 HTTP/SSE 适配。 |
| `ggb-dsh/apps/api/` | HTTP/SSE、run 生命周期、产物鉴权、静态资源、TTL 清理、metrics 和退役 run 的拒绝式探针。 |
| `ggb-dsh/apps/worker/` | plugin-core runner、DSH 执行、受限工具网关和内部通信。 |
| `ggb-dsh/packages/application/` | 跨进程契约、错误码、toolkit 协议与摘要工具。 |
| `ggb-dsh/packages/run-persistence/` | plugin-core store 和数据库 schema admission。 |
| `ggb-dsh/packages/` 中的 knowledge、geometry 等领域包 | 浏览器安全的共享知识、几何契约、编译和校验能力。 |
| `ggb-dsh/vendor/` | 插件发行包、文件摘要及完整兼容组合锁。 |
| `ggb-dsh/deploy/` | 本地启动、部署和迁移资产。 |
| `docs/` | 设计、决策、工作清单、验收与部署资料。 |
| `tools/check-workspace.mjs` | 从仓库根目录调用工作区检查并记录耗时。 |
| `AGENTS.md` | Coding Agent 的工作契约；不另维护项目结构、技术栈或架构说明。 |

`ggb-plugins` 是独立插件依赖。开发默认链路从固定 TGZ 安装，不依赖源码 checkout 或桌面插件缓存。
宿主只通过公开入口加载四工具、Worker Skill 和执行器；新 run 固定使用可信回执交付。
共享领域包与服务端 runtime 包保持独立边界；详见 [共享内核设计](docs/ggb-shared-tech.md)。

## 技术栈

| 领域 | 技术 |
| --- | --- |
| 前端 | TypeScript、Vue 3、Vite、PWA、GeoGebra applet；IndexedDB / OPFS 保存本地数据。 |
| 服务端 | Node.js、TypeScript、DeepSeek Harness、plugin-core；HTTP/SSE 与 Unix socket。 |
| 持久化 | 本地开发默认 SQLite，生产使用 PostgreSQL；Memory store 用于测试。 |
| 插件执行 | Playwright Chromium、GeoGebra runtime、受限工具协议。 |
| 开发与验证 | pnpm workspace、TypeScript project references、Vitest、Node test runner、ESLint。 |

版本以 [运行时配置](ggb-dsh/config/runtime-versions.json)、各包的 `package.json` 和 lockfile 为准，
本文不重复固定版本号。

## 本地运行

准备 Node、pnpm 和 `unzip`。Node 的兼容范围和 pnpm 版本见上方配置。
首次供应 runtime 需要取得依赖和运行时资源，并运行 doctor。离线协议检查可以只安装依赖；
该模式不能启动业务 Worker，详见 [安装与兼容组合](ggb-dsh/docs/dsh-sdk-compatibility.md)。

在仓库根目录执行：

```bash
cd ggb-dsh
pnpm install --frozen-lockfile --ignore-scripts
# 缓存完整时，可用 pnpm run install:offline 替代上一条
pnpm run provision:plugin-core
pnpm run provision:geogebra
```

然后打开两个终端，均进入 `ggb-dsh/`：

```bash
# 终端 1：API (:8081) 与 DSH Worker；默认使用本地 SQLite
# 默认读取 .plugin-core-runtime/<发行包 SHA-256>；无需设置 GGB_PLUGIN_ROOT
sh deploy/local/dev.sh

# 终端 2：Client Vite 开发服务器 (:5173)
pnpm run dev
```

打开 <http://localhost:5173>，在 Settings 中保存自己的 DeepSeek API Key，再新建会话并发送构图任务。
只运行 Client 时，页面可以打开，但构图任务无法执行。开发启动脚本默认监听源码变更并重启服务。

依赖供应、热更新、环境变量和故障排查见 [工作区运行说明](ggb-dsh/README.md#快速开始本机双进程)。
生产数据库需要单独完成迁移，开发启动脚本不会代为执行；生产操作见 [部署指南](docs/deploy-dsh.md)。

## 验证

以下命令从仓库根目录执行；按修改范围选择检查：

```bash
# 指定测试文件
node tools/check-workspace.mjs ggb-dsh test apps/client/tests/plugin-core-runtime.test.ts

# 按模块检查：可选 check:client、check:api、check:worker
node tools/check-workspace.mjs ggb-dsh check:worker

# 浏览器安全共享包及受影响消费者分别检查
node tools/check-workspace.mjs ggb-dsh check:package geometry-validation

# 全量：构建、共享包 lint、全部测试与质量检查
node tools/check-workspace.mjs ggb-dsh check
```

计时报告保存在已忽略的 `output/checks/`。更多命令见
[检查计时与局部验证](ggb-dsh/README.md#检查计时与局部验证)。
离线检查不需要真实 Provider 或浏览器中的 API Key；真实 Provider、GeoGebra 和浏览器回归需要明确授权。

## 文档导航

| 目的 | 入口 |
| --- | --- |
| Agent 如何开发、验证和交付 | [AGENTS.md](AGENTS.md) |
| 完整文档索引与职责 | [文档导航](docs/README.md) |
| 目标架构、取舍和冻结决策 | [plugin-core 采用方案](docs/ggb-dsh-plugin-core-adoption.md) |
| 当前 release、证据和换机步骤 | [切换交接](docs/ggb-dsh-plugin-core-cutover-handoff.md) |
| 剩余工作、根因和退出条件 | [统一 Backlog](docs/ggb-dsh-backlog.md) |
| 发布、迁移、运维和回滚 | [部署指南](docs/deploy-dsh.md) |
| 包边界与 workspace 构建规则 | [共享内核技术设计](docs/ggb-shared-tech.md)、[共享内核 ADR](docs/adr/001-shared-kernel-two-runtimes.md) |

README 维护项目结构、技术栈和架构概览。专题文档维护精确契约，Backlog 维护进度与验收状态。
README 和 AGENTS 引用这些资料，不复制第二份契约或进度表。
