# 采用 plugin-core 作为唯一构图引擎

日期：2026-10-17。状态：**已实施并完成九阶段删除**。plugin-core 取代 Native 九阶段链路，
成为 PWA 的唯一引擎。本文保存取舍依据、目标架构和已冻结决策；当前证据与剩余工作见
[切换交接](ggb-dsh-plugin-core-cutover-handoff.md)，工作队列见 [Backlog](ggb-dsh-backlog.md)。
删除前代码保存在标签 `archive/native-nine-stage-pre-plugin-core`。

## 1. 背景

`ggb-plugins` 使用一条很短的真实链路完成构图：

1. 宿主模型读取题意，编写原生 GeoGebra 程序和检查。
2. 工具执行结构校验。
3. 真实 GeoGebra 执行程序、采集事实、核验检查。
4. 工具导出 `.ggb`，并在新 applet 中重载核验。
5. 失败时，宿主根据工具返回的证据修改程序并重新 build。

现有真实测试中，该链路明显优于 Native 九阶段协商链路。Native 的主要成本来自 Brief、Plan、
Manual、Review、Apply 之间的重复表达、严格 JSON schema、独立审查和显式恢复。继续维护两套
执行器会让 API、Worker、run store、SSE 和部署都保留双路径。

## 2. 目标

- 用户只输入提示词。
- 模型写一份原生程序 + 检查。
- Worker 调用插件核心执行并交付 `.ggb` 文件。
- 前端展示交付的 GGB 文件、核验结果和用量。
- 删除九阶段工具和不再可达的实现，包括其 run store、SSE、测试、文档和工具。

### 非目标

- 不恢复 Native 的 Brief／Plan／Manual／Review／Apply 九阶段。
- 不保留九阶段 checkpoint、事务、回执和 `recovery_required` 语义。
- 不开放任意 JavaScript、脚本、外部资源、文件或网络副作用。
- 不实现三维、一般数学证明或任意外部 GGB 导入。
- 不把模型输出直接作为浏览器可执行代码。

## 3. 目标架构

```text
Browser PWA (apps/client)
  ├─ 本地 Session / 消息 / 画布快照（IndexedDB / OPFS）
  ├─ 浏览器 BYOK Vault（非导出 CryptoKey）
  ├─ plugin-core HTTP/SSE adapter + projector
  └─ GeoGebra applet：snapshot / restore / context / selection
                 │ HTTPS + runToken + X-GGB-Provider-Key
                 ▼
apps/api
  ├─ /api/v3/plugin-core/*：create、view、SSE、stop、delete、artifact
  ├─ plugin-core run service + store + TTL janitor
  ├─ 静态 PWA/GeoGebra runtime、metrics、health
  └─ 旧 Native run 拒绝式探针（token 验证后 409）
                 │ Unix socket, HMAC + nonce, protocol v4
                 ▼
apps/worker
  ├─ plugin-core service（并发、deadline、stopAll）
  ├─ InstalledPluginCoreRunner → 安装包公开 executor / CLI
  ├─ DSH 单轮执行 + 受限工具网关
  └─ SDK Server：sdk-minimal + 安装包 server patch
```

### 责任边界

- **Client**：本地会话、画布副本、BYOK、插件交付展示与下载；不运行模型循环，不执行模型生成的
  任意 GeoGebra 命令。
- **API**：鉴权、幂等、run 生命周期、SSE 回放、产物读取、静态资源、retention。旧 Native run 只
  做最小 token verifier 探针，不读取 checkpoint。
- **Worker**：调用插件核心；模型与工具循环只存在于 Worker/DSH 内。Provider Key 只在本次执行期间
  存在于内存。
- **插件核心**：拥有 `ggb_check`／`ggb_build`、真实 applet 执行、核验和 `.ggb` 交付；
  由 `ggb-plugins` 作为独立 runtime 供应。

### 信任边界

- 浏览器只持有自己的 BYOK 和 run token；Server 不保存用户账户、Session 或 Provider Key。
- API→Worker 使用 0600 Unix socket、共享 64-hex secret、每消息 HMAC/nonce 和请求 ID 关联。
- 插件运行在隔离的 Playwright/GeoGebra 环境和每次 run 的 DSH home 中。
- 数据库只保存 run 所需的题目、交付事实和用量；不保存画布原文或 Provider Key。

## 4. 交互式修改（Phase 2）

1. 用户导入一个 `.ggb`，Client 将其作为当前本地画布。
2. 下一轮提示词把当前画布序列化为 base：`{dataBase64, name}`。
3. API 计算 base 的 SHA-256 并传给 Worker；Worker 保存基线文件后向插件注入
   `base:{path, sha256}`。
4. 模型只提交 `prompt`、`plan` 和检查，不接触基线路径或字节。
5. 插件支持：
   - `plan.program`：新增 native 对象；
   - `plan.updates`：独立数值／坐标修改；
   - `plan.styles`：基线与新对象的显示属性；
   - `plan.edits`：仅显示属性；两种模式不得混用。
6. 插件核验后交付新的 `.ggb`，不覆盖输入文件。Client 保存交付字节并重新加载 applet，
   下载文件的字节数与 SHA-256 必须与交付卡片一致。

## 5. 已冻结决策

| 主题 | 决策 |
| --- | --- |
| 引擎 | `GGB_AGENT_ENGINE` 只接受 `plugin_core`；其他值启动失败 |
| 模型 | `PLUGIN_CORE_MODEL_POLICY_V1`：`deepseek-flash`、reasoning high、49,152 max tokens |
| Provider | 地址由服务端固定；Client 只能提交 BYOK Key，不能覆盖地址或模型 |
| run store | 独立 `plugin_core_*` 表；迁移 017、018；018 固定每个 run 的交付契约，历史行保留 legacy，新 run 固定 receipt-v1 |
| 旧 Native 数据 | 保留表/行作为证据；不破坏性迁移；删除 Native 读取/执行代码 |
| 旧 Native 请求 | 创建 → `409 engine_not_supported`；其他路径验证 token 后 → `409 checkpoint_incompatible` 或 `404` |
| 并发 | API/Worker 各自限制 `GGB_PLUGIN_CORE_MAX_CONCURRENT_RUNS`，缺省 1 |
| 停止 | stop 只请求取消；终态由持久事件确认 |
| 交付 | GGB 与截图作为有界 base64 或 artifact 传递；路径不进入模型结果 |
| 基线 | 每次修改以 Client 当前画布为新 base；不保留 Native checkpoint |
| 删除 | Native 包、应用模块、测试、工具、文档和 `.agents` skills 一并删除 |

## 6. 删除范围

已删除：

- `apps/api` 的 admission、receipts、Native janitor、Native run-service 与路由。
- `apps/worker` 的 Native 九阶段、execution、scheduler、geometry/knowledge 运行时、Native
  tool/model gate 与 75 个 Native 测试。
- `packages/application`、`packages/run-persistence`、`packages/bundle-ggb` 中的 Native 契约、
  store、事务、证据与工具。
- `agent-workflow`、`agent-policy`、`tool-geometry`、`execution-client`、`execution-protocol`、
  `image-input` 六个 Native-only 包。
- Client 的 executor、pending journal、recovery、remote adapter、event projector、continuation、
  partial result、presentation、image attachment 与 `journal` IndexedDB store（schema v2 删除）。
- Native 文档、`docs/native-history/`、Native profiles/skills、Q3/homework2/agent-loop/m1
  评测资产、Native 故障演练与浏览器 e2e 工具。

保留：

- Client 的画布 XML 归一化与 applet 端口；实现位于 Client。无产品消费者的旧几何编译、
  校验与知识检索包及其专用测试已删除，相关能力由安装式插件提供。
- 迁移文件 001–016 作为历史；启动不应用、不创建 Native 表。
- 插件包内的 `skills/ggb-construction/worker.md`、服务端 patch、三工具与评测案例。
  宿主旧 profile、重复工具包和专属 CLI 包装器已删除。

## 7. 验收

离线：

- `pnpm run typecheck`、`pnpm exec vitest run`、`pnpm run quality`。
- 旧 Native 请求的 404/409 语义、plugin-core 创建/SSE/artifact、内部 channel 的
  plugin-core run/cancel。
- 启动要求 `018_plugin_core_delivery_contract.sql`，迁移入口按顺序应用 017、018。

历史真实环境（2026-10-17，已授权，属于安装链切换前，不能作为当前发行包验收）：

- PWA 三轮复跑通过：下载字节数／SHA-256 与交付卡片一致，续做基线正确。
- 5 个交付文件在 Client applet 5.4.929.3 中加载通过。
- 本机集成 5/7 交付；`general-horse-explanation`、`ellipse-foci` 两例为模型侧
  `plugin_core_no_delivery`，最终重试仍未交付。
- `ggb_inspect` 插件根缺陷已修复并加入回归测试。

## 8. 剩余工作

- 目标机器上的 Docker/PWA 部署验证。
- 两个模型侧未交付案例的后续观察；不属于引擎回归。
- 目标环境 PostgreSQL 备份与 017 应用演练（需单独授权）。

详细证据、命令与换机步骤见
[插件核心切换：当前状态与交接](ggb-dsh-plugin-core-cutover-handoff.md)。
