# 插件核心切换：当前状态与交接

日期：2026-10-22。状态：**plugin-core 为唯一引擎；Native 九阶段已删除，删除前代码保存在标签
`archive/native-nine-stage-pre-plugin-core`（提交 `0dae5447`）。**

本文记录当前 release 的引擎、已验证范围、剩余风险、旧 Native run 的处理方式和换机步骤。
实施与取舍见 [采用方案](ggb-dsh-plugin-core-adoption.md)，未完成工作见 [Backlog](ggb-dsh-backlog.md)。

## 1. 当前引擎

- `GGB_AGENT_ENGINE` 只接受 `plugin_core`；缺省值即 `plugin_core`。`GGB_PIPELINE_MODE`、
  `GGB_NATIVE_*`、Native release vector、execution secret/socket 和 worker lease 配置已移除。
- 开发默认链路通过安装包公开入口加载三工具、Worker Skill 和执行器。SDK、插件摘要、
  Cordis、runtime、Playwright、工具协议 2、回执 2 与内部通道 6 一起固定；见 [兼容组合](../ggb-dsh/docs/dsh-sdk-compatibility.md)。
- API/Worker 使用独立的 `plugin_core_*` store、SSE 与产物鉴权。
- 模型固定为 `deepseek-flash`、reasoning high、49,152 max tokens
  （`packages/application/src/plugin-core-model-policy.ts`）。
- Worker 的模型提示词由插件包的 `skills/ggb-construction/worker.md` 提供，启动时校验
  `capabilities.json` 的请求协议、profile 版本和 SHA-256；ggb-dsh 不再保存第二份 Skill。
- 当前开发树要求迁移 017、018 和内部通道 6；新任务固定 `deliveryContract=receipt-v1`，旧入口已清理。
  批次 E 已在开发默认安装根完成完整供应和 doctor，并以 mock Harness 验证真实构图、可信交付及 renderer 出现后的取消清理。
  后续 mock Harness 的 PWA HTTP/SSE、下载、画布加载与编辑后基线续做也已通过。
  尚未调用真实 Provider 或部署生产。本次证据见 Backlog；下方 2026-10-17 的真实验收仍属于原切换批次。

## 2. 已验证范围（2026-10-17）

### 离线

- `pnpm run typecheck` 通过。
- `pnpm exec vitest run`：46 个测试文件、405 个测试通过（删除后基线）。
- `pnpm run quality` 通过：workspace 文件检查与 browser-safe 包检查。
- API 路由：plugin-core create/view/SSE/artifact/stop、旧 Native create 的 409
  `engine_not_supported`、旧 run 的 401/404/409 语义。
- Worker channel：plugin-core run/cancel、HMAC、nonce 重放、过期与 handler 失败。
- Client：plugin-core adapter/projector、session/canvas、delivery 下载与本地加载测试。

### 真实环境（已授权）

- PWA 三轮复跑通过：交付 GGB 的下载字节数与 SHA-256 与交付卡片一致；下一轮以当前画布为基线。
- 5 个交付文件在真实 Client applet（GeoGebra 5.4.929.3）中加载通过，对象集合与
  plugin `inspect` 一致。
- 本机集成批处理 5/7 交付。未交付：
  - `general-horse-explanation`：模型侧 `plugin_core_no_delivery`；
  - `ellipse-foci`：模型侧 `plugin_core_no_delivery`。
  最终重试仍未交付；两者不属于引擎或交付链路回归。
- 原链路曾修复 `ggb_inspect` 未传 `--plugin` 的缺陷；该旧 runner 已在批次 D 删除。当前安装适配器从安装根解析公开 CLI。
- 第一次 PWA 运行因上述 inspect 缺陷失败，证据保留在
  `output/plugin-core-ui-e2e-attempt1-inspect-bug/`；修复后复跑通过。

## 3. 旧 Native run 的处理

- 旧 Native 表与行保留为证据；没有破坏性迁移。
- Native 读取、执行、恢复、回执和 checkpoint 代码已删除。
- `POST /api/v3/runs` → `409 engine_not_supported`。
- 其他 `/api/v3/runs/*`：
  - 无 token → `401 unauthorized`；
  - token 不拥有该 run 或表/行不存在 → `404 not_found`；
  - token 拥有旧 run → `409 checkpoint_incompatible`。
- 探针只读取 `runs.token_verifier`（PG）或旧 SQLite 快照中的 `tokenVerifier`；
  不创建 Native 表、不读取 checkpoint、不修改旧行。
- 旧 run 的 SSE、resume、input、recovery、snapshot、observation、finalization 均不可用。

## 4. 数据库与迁移

- PostgreSQL：`plugin_core_runs`、`plugin_core_events`、`plugin_core_artifacts`、
  `plugin_core_usage` 由 `017_plugin_core.sql` 创建。
- SQLite：`SqlitePluginCoreStore` 使用独立表；本地开发默认 `.local/runs.sqlite`。
- `assertPluginCoreSchema` 在监听前确认 `schema_migrations` 已记录 018；缺失即拒绝启动。
- 部署迁移 job `deploy/migrations/apply.mjs` 按顺序应用 017、018。
- 旧 Native 数据审计直接读取旧表或旧 SQLite 快照；不通过当前 API。

## 5. 剩余风险与工作

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 目标机器 Docker/PWA 部署验证 | 未执行 | 需要目标机、镜像构建与部署授权 |
| `general-horse-explanation` / `ellipse-foci` | 未交付 | 模型侧无交付，非引擎回归；后续观察 |
| 目标 PostgreSQL 备份与 017/018 演练 | 未执行 | 需单独授权与备份 |
| 真实 Provider 批量复跑 | 已完成一次 | 5/7；不得把离线检查等同于产品验收 |

## 6. 换机步骤

1. 安装 Node/pnpm（版本见 `ggb-dsh/config/runtime-versions.json` 与 `package.json`）。
2. `cd ggb-dsh && pnpm run install:offline`。
3. 准备 GeoGebra runtime：`pnpm run provision:geogebra`。
4. 准备 plugin runtime：`pnpm run provision:plugin-core`，默认安装根由发行包摘要决定；自定义 `GGB_PLUGIN_ROOT` 时须与
   固定发行锁一致；完整 runtime、Chromium 和 doctor 准备成功后再启动。
5. 复制 `deploy/local/env.example` 为本地环境，填入两个 64-hex secret；不要提交。
6. 本地验证：`pnpm run check`，然后 `sh deploy/local/dev.sh` 与 `pnpm run dev`。
7. 生产：先备份 PostgreSQL，再运行 `node deploy/migrations/apply.mjs`；设置
   `GGB_V3_DATABASE_URL`，启动 API/Worker。
8. 真实 Provider 验证只在明确授权后运行；Key 只放在进程环境或浏览器 BYOK，不写入文件。

## 7. 回滚

- 代码回滚点：标签 `archive/native-nine-stage-pre-plugin-core`。
- 数据库不做破坏性回滚：Native 表仍在，plugin_core_* 表可保留或按 retention 清理。
- 回滚到旧镜像前必须确认其启动要求（001–016）与当前数据库状态兼容；不要删除任何旧表或旧行。
- 真实运行证据不复用旧 `output/` 或 SQLite；每次验收使用新的隔离目录。
