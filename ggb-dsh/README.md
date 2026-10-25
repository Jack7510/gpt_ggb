# GGB DSH 工作区运行说明

本文维护工作区的依赖更新、增量构建、启动配置、检查命令、调试与部署操作。
项目概览、项目结构、技术栈及架构统一见 [根 README](../README.md)，本文不重复维护。
Agent 的修改、验证与安全工作规则见 [AGENTS.md](../AGENTS.md)。

| 需要了解的内容 | 入口 |
| --- | --- |
| 产品与退役引擎的处理方式 | [项目概览](../README.md#项目概览) |
| 进程关系与数据边界概览 | [当前架构](../README.md#当前架构) |
| 目录与组件职责 | [代码仓结构](../README.md#代码仓结构) |
| 技术栈与版本来源 | [技术栈](../README.md#技术栈) |
| 精确设计与接口契约 | [plugin-core 采用方案](../docs/ggb-dsh-plugin-core-adoption.md) |
| 当前 release 的已验证范围和风险 | [切换交接](../docs/ggb-dsh-plugin-core-cutover-handoff.md) |
| 工作优先级与验收状态 | [Backlog](../docs/ggb-dsh-backlog.md) |

## 依赖更新与增量构建

包边界见 [根 README 代码仓结构](../README.md#代码仓结构)；本节只说明修改后如何更新构建产物。

内部源码修改不需要打包、修改包版本或重新安装。`tsc -b` 按 project references 先构建依赖，
再构建消费者。`dev.sh` 监听整个构建图；内部包的 `lib/` 变化会触发使用该模块的 API/Worker 重启。
只启动 Client 时，另运行 `pnpm exec tsc -b --watch`，使内部包输出保持更新。

修改依赖声明后，在本目录运行 `pnpm install --no-frozen-lockfile` 并提交更新后的 lockfile。

## 快速开始（本机双进程）

首次安装、供应 runtime 和双终端启动步骤见 [根 README 本地运行](../README.md#本地运行)。
本节中的命令在 `ggb-dsh/` 运行；下方检查计时与部署命令会单独标明仓库根目录。

- 单独生成完整构建产物：`pnpm run build`。
- `dev.sh` 默认读取 `.plugin-core-runtime/<vendor 锁中 archiveSha256>`。`GGB_PLUGIN_ROOT` 可指定另一安装根，
  但包文件与版本必须匹配同一锁；不回退到源码 checkout。完整供应后才可启动 Worker。
- `dev.sh` 默认是 **watch 模式**：`tsc -b --watch` 持续编译，`node --watch` 在重建后重启 API/Worker。
  `GGB_V3_WATCH=0 sh deploy/local/dev.sh` 可退回一次性启动。
- `pnpm run dev` **只启动客户端**；没有 `dev.sh` 时页面能打开但所有 run 都会失败。
- `dev.sh` 默认使用 API 端口 `8081`；Vite 把 `/api/v3` 代理到 `http://127.0.0.1:8081`，
  本地与生产使用同一路径形状。
- Settings 中没有保存 Provider Key 时，发送会提示先保存；可使用 Forget 清除已保存的 Key。
- `dev.sh` 默认使用 `.local/runs.sqlite`，由 API 保存本地开发数据；设置
  `GGB_V3_DATABASE_URL` 时改用 PostgreSQL。PG 须先应用 `017_plugin_core.sql` 和 `018_plugin_core_delivery_contract.sql`；授权、备份后单独运行
  迁移 job。默认 `GGB_V3_AUTO_MIGRATE=0`。

只验证安装、SDK 初始化和协议时，按 [兼容性文档](docs/dsh-sdk-compatibility.md) 使用
`--offline --dependencies-only`。此模式不运行 doctor，也不满足业务启动条件。供应器拒绝覆盖已有安装根；
完整供应应选择新的 `--target`，成功后用 `GGB_PLUGIN_ROOT` 指向该根。

## 常用命令

### 检查计时与局部验证

常用计时命令见 [根 README 验证](../README.md#验证)，均从仓库根目录运行。
执行器从自身路径确定工作区，不需要在根目录安装依赖。验证范围按
[AGENTS 验证策略](../AGENTS.md#验证策略) 选择，不要求每次修改都运行全量检查。

执行器顺序运行脚本中的各阶段，保留终端输出。首个失败阶段使执行器返回非零退出码，
后续阶段不运行，也不自动重试。每阶段输出耗时和退出码；JSON 报告写入仓库 `output/checks/`，
记录阶段开始/结束时间、耗时、退出码、信号及启动错误码；不复制测试输出或环境变量。

### 工作区命令

| 命令 | 用途 |
| --- | --- |
| `pnpm run check` | `build`、Node/Vitest 测试、质量检查 |
| `pnpm run check:fast` | `typecheck` + 测试 |
| `pnpm run check:client` | Client 构建、bundle 与测试 |
| `pnpm run check:api` / `check:worker` | 对应应用构建与测试 |
| `pnpm run verify:plugin-core` | 对已启动的本地 API 逐例发送 plugin-core 案例（付费，需授权与 Key） |
| `pnpm run verify:plugin-core:integrated` | 启动隔离 API/Worker 后跑批处理 |
| `pnpm run verify:plugin-core:pwa:mock --authorized` | mock Harness + 真实 PWA/GeoGebra 全链；需完整 runtime，不调用 Provider |
| `pnpm run verify:plugin-core-ui` | 真实浏览器 PWA 端到端（需 Playwright 与授权） |
| `pnpm run provision:plugin-core` | 从 vendor TGZ 供应插件运行时 |
| `pnpm run verify:runtime-release` | 固定官方 ZIP、空默认安装 doctor、真实 Client runtime 与旧 Service Worker 升级；需浏览器授权，归档与证据参数见 [兼容契约](docs/dsh-sdk-compatibility.md#引擎补丁的供应与启动准入) |
| `pnpm run verify:plugin-core:runtime` | 真实 GeoGebra、可信回执与进程树取消；使用 mock Harness，需浏览器执行授权；参数见 [兼容契约](docs/dsh-sdk-compatibility.md#真实-runtime-验收无-provider) |

真实 Provider/GeoGebra 命令在离线检查通过并获明确授权后单独执行；结果写入 `output/`，
不进入 Git。

## 环境变量

完整示例见 `deploy/local/env.example` 与 `deploy/systemd/server.env.example`。

### API

| 变量 | 说明 |
| --- | --- |
| `GGB_AGENT_ENGINE` | 缺省为 `plugin_core`；其他值在启动时拒绝 |
| `PORT` / `GGB_V3_LISTEN_HOST` | HTTP 监听端口与地址 |
| `GGB_V3_SERVER_PEPPER` / `_FILE` | run token verifier 的服务端 pepper（64 hex） |
| `GGB_V3_WORKER_SOCKET_PATH` | 与 Worker 共享的 Unix socket |
| `GGB_V3_WORKER_SECRET` / `_FILE` | 内部 channel HMAC secret（64 hex） |
| `GGB_V3_DATABASE_URL` / `GGB_V3_SQLITE_PATH` | PostgreSQL 或本地 SQLite |
| `GGB_V3_AUTO_MIGRATE` / `GGB_V3_MIGRATIONS_DIR` | 启动时应用 017、018 插件迁移 |
| `GGB_V3_CLIENT_DIST_DIR` / `GGB_V3_GEOGEBRA_ROOT` | 静态 PWA 与 GeoGebra runtime |
| `GGB_V3_RUNTIME_VERSIONS_PATH` | 固定 runtime 版本与摘要 |
| `GGB_V3_ALLOWED_ORIGIN` / `GGB_V3_ALLOWED_HOSTS` | 同源 CORS 与 Host allowlist |
| `GGB_V3_TTL_*` / `GGB_V3_JANITOR_*` | plugin-core run/artifact retention 与清理节奏 |
| `GGB_V3_DRAIN_GRACE_MS` | SIGTERM 后停止准入并等待在途请求的窗口 |
| `GGB_PLUGIN_CORE_MAX_CONCURRENT_RUNS` | API 准入并发的 plugin-core run 数 |

### Worker

| 变量 | 说明 |
| --- | --- |
| `GGB_V3_WORKER_INSTANCE_ID` | channel 握手中的 Worker 标识 |
| `GGB_V3_WORKER_SECRET` / `_FILE` | 与 API 相同的内部 channel secret |
| `GGB_V3_WORKER_SOCKET_PATH` | 与 API 共享的 Unix socket |
| `GGB_V3_DSH_WORKSPACE_ROOT` / `GGB_V3_DSH_HOME_ROOT` | DSH 工作区与每次 run 的 home 根 |
| `GGB_V3_PROVIDER_BASE_URL` | 服务端固定的 Provider Messages 根 |
| `GGB_PLUGIN_ROOT` | 已准备的固定发行包安装根；默认使用包摘要目录 |
| `GGB_PLUGIN_CORE_OUTPUT_ROOT` | 插件运行产物根（Git 忽略） |
| `GGB_PLUGIN_CORE_TOOL_SOCKET` | Worker 内部工具网关 socket |
| `GGB_PLUGIN_CORE_MAX_CONCURRENT_RUNS` | Worker 并发上限 |
| `PLAYWRIGHT_BROWSERS_PATH` / `HOME` / `TMPDIR` | 插件运行环境 |
| `GGB_V3_DSH_TRACE_ROOT` | 仅调试；覆盖 DSH home 根并保留纯文本 run 的 home；生产禁用 |

## 调试

- **run 状态**：`GET /api/v3/plugin-core/runs/:id` 返回 phase、事件游标、交付与失败事实。
  SSE 使用 `/events?after=<cursor>`，首帧 `plugin_core.ready` 是快照，不写入事件表。
- **进程日志**：`dev.sh` 在启动时打印日志目录。默认目录是 `.local/logs/<UTC 时间>-<PID>/`，
  包含 `build.log`、`api.log`、`worker.log`；watch 模式还包含 `tsc.log`。
  `GGB_V3_LOG_DIR` 可以指定目录。使用 `tail -f <目录>/worker.log <目录>/api.log` 查看实时输出。
  仓库根目录的 `tools/deploy-ggb-dsh.sh` 直接使用插件源码构建及源码依赖/runtime，不受已安装插件版本影响；进程日志写入 `output/deploy-ggb-dsh/<启动批次>/`。
- **数据库**：SQLite 的 `plugin_core_store_snapshot` 单行保存 run、事件和交付快照；
  `dev.sh` 默认使用 `.local/runs.sqlite`，部署工具使用 `.local/deploy/runs.sqlite`。
  PG 使用 `GGB_V3_DATABASE_URL`。旧 `runs`/`run_events` 表不再由当前代码写入。
- **插件失败**：检查 `plugin_core_failed` 事件的 code/message，以及
  `GGB_PLUGIN_CORE_OUTPUT_ROOT` 下的 runner 产物；不要记录 Provider Key 或用户画布正文。
- **验证插件源码改动**：见[插件源码手工验证](../docs/ggb-dsh-plugin-manual-verification.md)；
  使用 `tools/manual-verify-plugin.sh` 启动测试安装，脚本在 Worker 就绪后恢复 release lock。
- **run 诊断**：Worker 始终写入 `GGB_PLUGIN_CORE_OUTPUT_ROOT/<runId>/`，并在启动时打印根目录。
  `dev.sh` 默认使用 `.local/plugin-core-runs`；部署工具使用 `.local/deploy/runs`。
  `usage.json` 保存用量摘要；`diagnostics/<turnId>.json` 保存带时间戳的 SDK 生命周期、用量和脱敏工具参数、结果、错误。
  `diagnostics/<turnId>.stream.json` 保存每次模型请求的起止时间、耗时、Token 用量、上下文字节数、HTTP 状态及工具流诊断。
  每个 turn 最多保留 64 次 Provider 请求；超限记录 `droppedRequests`。这些字节数用于比较上下文大小，不是 Token 估算。
  诊断省略完整提示词、消息历史、模型文本回答和推理正文。确认清理完成后，Worker 删除输入 GGB 和 build 目录，
  保留诊断 7 天；清扫时删除到期且不活跃的目录。进程日志按启动批次保留，需要手动清理。
- **保留 DSH home**：执行 `GGB_V3_DSH_TRACE=1 sh deploy/local/dev.sh`，
  Worker 将纯文本 run 的 home 保留在 `.local/dsh-trace/<runId>/<turnId>/`。
  `GGB_V3_DSH_TRACE_ROOT` 可指定该根目录，并覆盖 `GGB_V3_DSH_HOME_ROOT`。
  此开关不提供完整模型请求或回答日志。带图片的 run 在确认清理后仍删除 home；保留的 home 需要手动清理。

### 使用 PostgreSQL

1. 备份并有明确授权后，运行 `node deploy/migrations/apply.mjs`（按顺序应用 017、018）。
2. 启动 API/Worker 时设置 `GGB_V3_DATABASE_URL`；`assertPluginCoreSchema` 会在监听前确认
   018 已记录。
3. 迁移文件 001–016 仅作为历史保留，不会被启动流程应用，也不创建 Native 表。
4. 旧 Native 数据不做破坏性迁移；需要审计时直接读取旧表/旧 SQLite 快照。

## 测试

- `pnpm exec vitest run` 跑 API、Client、Worker 与包的离线测试。
- Worker channel、API 路由、Client adapter/projector、store 与 schema admission 均有针对性测试。
- 真实 Provider 调用必须带 `--authorized` 和进程内 `DEEPSEEK_API_KEY`；Key 不进入日志、产物或 Git。
- GeoGebra/Playwright 验证需要完整安装的固定发行包、runtime 和受管 Chromium；无需源码 checkout。

## 云主机部署

当前云主机使用 Node + systemd，Worker 加载已安装的 DSH 插件。
路径沿用仓库启动器 `tools/deploy-ggb-dsh.sh` 的布局；该脚本只供本地源码安装与调试，不能直接启动生产服务。
生产使用 PostgreSQL 与构建后的 PWA。systemd 安装器从当前 checkout 推导工作区，并渲染运行账号与 Node 路径。
Edge 配置见 `deploy/edge/nginx.conf`，unit 模板见 `deploy/systemd/`。
构建、供应、配置、迁移与验收步骤见 [部署指南](../docs/deploy-dsh.md)。

## 模型配置

模型、推理强度与 token 上限由 `packages/application/src/plugin-core-model-policy.ts` 固定：

- `model: deepseek-flash`
- `reasoning: high`
- `maxTokens: 49_152`

API/Worker 不读取环境变量来选择模型；Provider 地址由服务端固定。插件核心自己的模型调用发生在
`ggb-plugins` runner 内，使用同一 Provider Key。

## 安全操作

项目数据与执行边界见 [根 README 架构说明](../README.md#当前架构)；提交、部署及外部调用权限见
[AGENTS 安全规则](../AGENTS.md#git并行与安全)。功能范围和精确限制见
[采用方案](../docs/ggb-dsh-plugin-core-adoption.md)。

本机调试时不要把 Provider Key 或用户画布正文写入日志。诊断、数据库和运行产物留在忽略目录，
不进入 Git；生产环境禁用 DSH 原始请求/回答采集。发布前核对
[GeoGebra 分发审查](docs/geogebra-distribution-review.md)。

## 进一步阅读

- [plugin-core 采用方案](../docs/ggb-dsh-plugin-core-adoption.md)
- [插件核心切换：当前状态与交接](../docs/ggb-dsh-plugin-core-cutover-handoff.md)
- [统一 Backlog](../docs/ggb-dsh-backlog.md)
- [部署指南](../docs/deploy-dsh.md)
