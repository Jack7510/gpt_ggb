# GGB DSH 部署指南

本文定义 `ggb-dsh/` 的本地验证、生产发布、运行与回滚边界。它适用于本仓库的两进程服务
（`apps/api` + `apps/worker`）与唯一的 **plugin-core** 执行引擎。

架构与取舍见 [plugin-core 采用方案](ggb-dsh-plugin-core-adoption.md) 与
[切换交接](ggb-dsh-plugin-core-cutover-handoff.md)；日常本地开发与调试见
[ggb-dsh README](../ggb-dsh/README.md)。本文不记录真实主机地址、数据库 URL、TLS 私钥或任何 API Key。

## 1. 生产拓扑

```text
Browser PWA
  │ same-origin HTTPS, Authorization: Bearer <runToken>
  │ X-GGB-Provider-Key only while submitting a run
  ▼
Edge Nginx (TLS, public Host allowlist, SSE proxying, no request-body logging)
  │ 127.0.0.1:8080
  ▼
ggb-dsh-server container (non-root)
  ├─ apps/api     HTTP/SSE, static PWA/GeoGebra assets, plugin-core runs, TTL janitor
  ├─ apps/worker  plugin-core runner, DSH turn, tool gateway
  ├─ tmpfs Unix sockets and per-run scratch / DSH home
  └─ PostgreSQL   plugin_core_runs/events/artifacts/usage
```

- 首版使用一个镜像、一个容器、两个进程（`entrypoint.sh both`）。API 与 Worker 通过容器内 tmpfs Unix
  socket 通信。
- PostgreSQL 是生产 plugin-core run/event/artifact/usage 的事实源；SQLite 仅用于本机验证，
  Memory store 仅用于测试。
- 浏览器的 Session、消息历史、画布快照和加密 BYOK vault 不上传。Server 不保存 Provider Key、
  用户账户或产品 Session。
- 公网只暴露 Edge。容器 API 端口只绑定 loopback 或私有网络；不可直接暴露 `:8080`。

## 2. 发布前条件

1. 使用 `ggb-dsh/config/runtime-versions.json` 指定的 Node、pnpm、DSH 与 GeoGebra 兼容版本。
2. 使用专用 PostgreSQL 数据库与最小权限的发布账号；发布前完成备份和恢复演练。
3. 配置单一 HTTPS 域名、DNS 和证书。PWA、API、SSE 与 GeoGebra runtime 必须同源。
4. 准备两个不同的 32-byte 随机 secret 文件，权限为 `0600`：
   `server-pepper`、`worker-secret`。内容必须是 64 位小写十六进制。
5. 在一个可审计的 release checkout 中构建统一的 `ggb-dsh/` workspace。内部包使用本地链接，
   外部依赖由 `pnpm-lock.yaml` 固定。镜像必须使用同一 Git revision 的应用、共享领域包和 lockfile。
6. 确认 GeoGebra 5.4.929.3 的同源分发许可适用于目标部署；商业用途须先完成独立许可审查。
7. 供应 plugin-core runtime 与固定 GeoGebra runtime；缺资源时 Worker 在监听前失败。

生产环境不需要、也不得配置 DeepSeek 平台 API Key。它由最终用户在浏览器中保存，并仅按 run 通过
`X-GGB-Provider-Key` 短暂传给 Worker。

## 3. 构建与离线验证

```bash
(cd ggb-dsh && pnpm install --frozen-lockfile && pnpm run provision:geogebra && pnpm run provision:plugin-core)
(cd ggb-dsh && pnpm run check)

docker build -f ggb-dsh/deploy/container/Dockerfile \
  -t ggb-dsh-server:<release-id> .
```

`provision:geogebra` 会写入受 Git 忽略的固定 runtime 与 manifest；API 会在启动前核验 manifest、
版本和必要文件。`provision:plugin-core` 从 vendored TGZ 供应插件依赖、Chromium 和固定 GeoGebra
runtime，并运行插件 `doctor`。两者都必须在 Docker build 前完成。

运行镜像包含固定插件安装根、`vendor/plugin-core.lock.json`、`knowledge/` 与 `tools/`。
Worker 校验包文件摘要和兼容组合后，从插件公开 server patch 加载三工具和 Worker Skill。
旧宿主 profile、工具包和专属包装器已删除。将本次 release 的 Git revision、容器 image digest、`pnpm-lock.yaml`、
`config/runtime-versions.json` 与 `vendor/plugin-core.lock.json` 一并留存在发布系统。

当前批次只更新部署资产，未构建镜像或部署生产。供应器拒绝覆盖已有目标；每次发布使用新的安装根，
完整供应成功后再切换配置。`--dependencies-only` 仅供离线协议检查，不能用于业务启动。

插件源码改动尚未进入 vendor TGZ 时，使用[插件源码手工验证](ggb-dsh-plugin-manual-verification.md)启动本地测试安装；该流程不更新 vendor 锁或生产发行包。

## 4. 生产配置

从 [server.env.example](../ggb-dsh/deploy/systemd/server.env.example) 建立仅部署环境可读的配置文件。
该文件不能提交、复制到镜像或暴露给浏览器。

至少设置：

```dotenv
NODE_ENV=production
PORT=8080
GGB_AGENT_ENGINE=plugin_core

GGB_V3_DATABASE_URL=postgres://<user>:<password>@<db-host>:5432/<database>
GGB_V3_AUTO_MIGRATE=0
GGB_V3_MIGRATIONS_DIR=packages/run-persistence/migrations

GGB_V3_ALLOWED_ORIGIN=https://<public-host>
GGB_V3_ALLOWED_HOSTS=<public-host>
GGB_V3_CLIENT_DIST_DIR=/app/apps/client/dist
GGB_V3_GEOGEBRA_ROOT=/app/apps/client/dist/geogebra
GGB_V3_RUNTIME_VERSIONS_PATH=/app/config/runtime-versions.json

GGB_V3_SERVER_PEPPER_FILE=/run/ggb/server-pepper
GGB_V3_WORKER_SECRET_FILE=/run/ggb/worker-secret
GGB_V3_WORKER_SOCKET_PATH=/run/ggb/worker.sock

GGB_V3_DSH_HOME_ROOT=/dsh-home
GGB_V3_PROVIDER_BASE_URL=https://api.deepseek.com/anthropic
GGB_PLUGIN_ROOT=/opt/ggb-plugin
GGB_PLUGIN_CORE_OUTPUT_ROOT=/var/lib/ggb-dsh/plugin-core-runs
GGB_PLUGIN_CORE_MAX_CONCURRENT_RUNS=1
```

同时根据容量设定 body 限额、run/artifact TTL、drain grace 和 plugin-core 并发。API admission 上限与
Worker 并发必须共同评估；不要以无限排队替代过载拒绝。

## 5. 数据库迁移

每次包含迁移的发布必须先备份 PostgreSQL，并在 API admission 打开前执行一次性迁移：

```bash
cd ggb-dsh
GGB_V3_DATABASE_URL='postgres://<user>:<password>@<db-host>:5432/<database>' \
  node deploy/migrations/apply.mjs
```

`apply.mjs` 只应用 `017_plugin_core.sql` 和 `018_plugin_core_delivery_contract.sql`。017 创建 `plugin_core_runs`、`plugin_core_events`、
`plugin_core_artifacts` 与 `plugin_core_usage`；018 固定每个 run 的 `delivery_contract`，SQL 默认值 legacy 用于保留历史行；新应用显式写入 receipt-v1。迁移文件 001–016 保留为历史，不会被启动流程或
迁移 job 应用；它们不创建 Native 表。

API 与 Worker 启动时通过 `assertPluginCoreSchema` 确认 ledger 已记录 018；缺失或 ledger 不存在时
在监听前拒绝启动，不回退到 Native。API/Worker 必须一起升级至内部通道 6。生产保持 `GGB_V3_AUTO_MIGRATE=0`，避免 API 与 Worker 启动竞态。
若迁移失败，停止发布，核对 ledger 与备份后按授权的恢复方案处置；不要通过修改 `schema_migrations`
或跳过 migration 来强行启动服务。

旧 Native 表/行保留为证据，不做破坏性迁移。需要审计时直接读取旧表或旧 SQLite 快照，不通过当前 API。

## 6. 启动服务

首版容器以只读根文件系统运行；必须为 sockets、plugin-core 输出和 DSH home 提供可写 tmpfs，并只读挂载
secret 文件。以下是运行形态示例，实际编排系统应采用等价的 secret store、health check、日志收集和
restart policy：

```bash
docker run -d --name ggb-dsh-server --restart unless-stopped \
  --read-only \
  -p 127.0.0.1:8080:8080 \
  --env-file /etc/ggb-dsh/server.env \
  --tmpfs /run/ggb:rw,noexec,nosuid,size=16m \
  --tmpfs /dsh-home:rw,noexec,nosuid,size=512m \
  -v /etc/ggb-dsh/secrets/server-pepper:/run/ggb/server-pepper:ro \
  -v /etc/ggb-dsh/secrets/worker-secret:/run/ggb/worker-secret:ro \
  -v /var/lib/ggb-dsh/plugin-core-runs:/var/lib/ggb-dsh/plugin-core-runs:rw \
  ggb-dsh-server:<release-id> both
```

镜像内进程以 UID 10001 运行。挂载点及 secret 文件必须可被该 UID 读取；不要用 `--privileged`、
宿主 home 挂载或可写镜像层来规避权限问题。

如需将 API 与 Worker 拆为独立 workload，必须让两者安全共享同一个 Unix socket namespace、
对应 secret 和同一个 PostgreSQL 事实源，并先通过 drain、重复请求与 stop 的故障矩阵验证。
首版默认不采用此拓扑。

### 无 Docker 的 Node + systemd 部署

目标主机缺少 Docker 时，可使用仓库受控的
[`deploy/systemd/`](../ggb-dsh/deploy/systemd/) 单元。它在同一主机上以两个受限的 Node 进程运行 API 与
Worker，共享 `RuntimeDirectory=ggb-dsh` 的 0750 Unix socket/scratch 目录；仍然需要 PostgreSQL，
不能退回 SQLite。

在安装前，以 [`server.env.example`](../ggb-dsh/deploy/systemd/server.env.example) 建立
`/etc/ggb-dsh/server.env`（权限 0600），将 `GGB_V3_DSH_HOME_ROOT`、`GGB_V3_WORKER_SOCKET_PATH`
与 `GGB_PLUGIN_CORE_OUTPUT_ROOT` 指到 `/run/ggb-dsh/` 下，并将两份 0600 secret 文件放入
`/etc/ggb-dsh/secrets/`。安装 unit 后，再依次启动 Worker、API：

```bash
sudo sh ggb-dsh/deploy/systemd/install.sh
sudo systemctl start ggb-dsh-worker.service
sudo systemctl start ggb-dsh-api.service
sudo systemctl status ggb-dsh-worker.service ggb-dsh-api.service --no-pager
```

unit 的 `WorkingDirectory` 固定为当前正式 checkout
`/home/admin/work/ggb-dsh/ggb_copilot/ggb-dsh`；迁移到其他主机路径时，先在 Git 中调整模板并审查后再安装，
不要在 `/etc/systemd/system` 直接维护不可追踪的副本。

### plugin-core 运行时（systemd）

插件核心需要独立的 Chromium、GeoGebra runtime 和插件依赖。发布前以 root 从 vendored TGZ
供应到只读目录：

```bash
cd /home/admin/work/ggb-dsh/ggb_copilot/ggb-dsh
sudo env PLAYWRIGHT_BROWSERS_PATH=/opt/ggb-plugin/ms-playwright \
  node tools/provision-plugin-core.mjs --target /opt/ggb-plugin
sudo chown -R root:root /opt/ggb-plugin
```

`provision-plugin-core.mjs` 先核对 `vendor/plugin-core.lock.json` 与 TGZ 的 SHA-256，再安装生产依赖、
Playwright Chromium、固定 GeoGebra runtime，并运行插件 `doctor`。缺少任一资源时 Worker 启动失败，
不会把请求转发到不完整的插件树。`GGB_PLUGIN_ROOT`、`PLAYWRIGHT_BROWSERS_PATH`、
`GGB_PLUGIN_CORE_OUTPUT_ROOT` 必须与供应目录一致；`GGB_PLUGIN_CORE_MAX_CONCURRENT_RUNS`
限制同时执行的插件 run，缺省为 1。`/run/ggb-dsh` 由 service 用户写入，`/opt/ggb-plugin` 只读。
Playwright 默认以 `chromiumSandbox: false` 启动；如需启用内核沙箱，应在目标主机单独验证后再改动。

**历史本机静态验证（2026-10-17，旧发行包）：** 用 vendored TGZ 供应到 `.plugin-core-runtime`，插件 `doctor`
通过（Chromium、GeoGebra 5.4.932.1、CAS/native smoke）。这些结果不代表当前固定发行包已通过 doctor 或浏览器回归。Dockerfile 与 `server.env.example` 的插件路径已静态核对；
本机无 Docker daemon，镜像构建、容器内 Chromium 启动和 `/opt/ggb-plugin` 只读挂载仍需在目标环境执行。
systemd unit 在本机用现有 node 路径替换后 `systemd-analyze verify` 无告警；目标机需确认
`/usr/bin/node` 存在，并按第 5 节确认 `018_plugin_core_delivery_contract.sql` 已登记。

## 7. Edge 与 TLS

以 [Edge Nginx 配置](../ggb-dsh/deploy/edge/nginx.conf) 为起点，替换示例域名与证书路径后安装。若使用
cpolar 在公网终止 TLS 并转发至本机 HTTP 80，则使用
[`deploy/systemd/nginx-ggb-app.conf`](../ggb-dsh/deploy/systemd/nginx-ggb-app.conf)，不要在该主机重复配置证书。
Edge 必须：

- 只接受配置的 HTTPS Host，并将请求代理到 `127.0.0.1:8080`；
- 对 `/api/` 关闭 proxy buffering/cache，设置足够的 SSE `proxy_read_timeout`；
- 透传 `Authorization`，但日志、WAF、APM 和错误转储不得记录它或 `X-GGB-Provider-Key`；
- 不额外下发 CSP，主 UI 与 GeoGebra 专用 document 的 CSP 由 API 分别下发；
- 不添加跨域 CORS 头，不把 API 改写为静态 PWA fallback，不开启反向代理重试；
- 将 `client_max_body_size` 与 `GGB_V3_MAX_BODY_BYTES` 保持一致。

修改 Edge 后执行 `nginx -t` 再 reload。公网防火墙不得直接开放容器 API 端口。

## 8. 发布验收

先进行无需 Provider Key 的健康和静态资源验证：

```bash
curl -fsS -H 'Host: <public-host>' http://127.0.0.1:8080/api/v3/health/live
curl -fsS -H 'Host: <public-host>' http://127.0.0.1:8080/api/v3/health/ready
curl -fsS -H 'Host: <public-host>' http://127.0.0.1:8080/api/v3/bootstrap
curl -fsSI https://<public-host>/
curl -fsSI https://<public-host>/geogebra/deployggb.js
```

再检查：

1. 未知 `/api/` 路径返回 JSON 404，而不是 `index.html`；`/api/v3/health/ready` 在 drain 时拒绝新 run。
2. 响应头分别符合 shell 与 GeoGebra document 的 CSP，且 API/SSE 为 `no-store`。
3. Edge 日志不含 Authorization、Provider Key、prompt、Canvas XML 或 runToken。
4. PostgreSQL 中不存在 users、tenants、Session、credential 或 Provider Key 字段；TTL janitor 可处理过期
   plugin-core run 与 artifact。
5. 旧 Native 请求语义正确：`POST /api/v3/runs` → 409 `engine_not_supported`；其他旧路径在 token
   验证后 409 `checkpoint_incompatible` 或 404。
6. fake Provider/plugin 集成与 channel 测试通过；真实 Provider smoke 只在明确授权后执行。

真实 DeepSeek + GeoGebra smoke 会产生费用并处理用户题目，只能在明确授权的预发或发布门禁执行。
不得使用生产用户 Key、Prompt、截图或 runToken 作为测试样本。

## 9. 监控、排障与保留

- 采集 API/Worker stdout 的结构化摘要：request/run ID、耗时、token、稳定错误码和安全指标。
  禁止采集 prompt 全文、模型全文、图片、画布 XML、Key 或 token。
- 关注 admission reject、plugin-core capacity、plugin runner failure、Provider latency、SSE
  reconnect/backpressure、artifact orphan 与 TTL cleanup failure。
- 先用 `health/live` 区分进程存活，再用 `health/ready` 判断是否可接新 run。
- 排障优先读取脱敏 diagnostics 与 `GGB_PLUGIN_CORE_OUTPUT_ROOT` 下的 runner 产物；
  不通过开启请求体日志来收集 Key 或题目。

## 10. 更新、缩容与回滚

发布和缩容必须遵循：停止 admission → Worker 停止接收新 run → 在配置窗口内完成/取消 → 关闭 SSE/HTTP
→ 关闭插件进程、socket 和数据库连接。Worker 的 `GGB_V3_WORKER_DRAIN_MS` 默认 15000 毫秒；
超时会非零退出，未清理 run 由持久状态和 janitor 处理。缩容时需等待该窗口，并检查 plugin-core
活跃 run。

建议的镜像更新顺序：

1. 记录当前 image digest、`pnpm-lock.yaml`、plugin-core lock 与数据库 migration revision。
2. 备份数据库；执行并核对一次性 migration。
3. 构建并验证新 image；在预发执行健康、静态资源、fake integration 和 channel 测试。
4. 将旧容器 drain 后替换为新 image；等待 `/health/ready` 成功，再切换或 reload Edge。
5. 观察 admission、plugin-core、SSE 与 artifact 指标；确认后才清理旧 image。

若新镜像失败，先停止 admission。数据库不自动逆迁移；恢复备份须按单独授权的恢复方案执行。
不要删除 PostgreSQL、artifact、secret 或浏览器本地数据来“修复”发布。

回滚代码可使用标签 `archive/native-nine-stage-pre-plugin-core`；该标签是删除前 Native 代码的
完整快照。当前数据库已包含 plugin_core_* 表；旧镜像若要求 Native schema，需先确认旧表仍在
（本次删除没有删除它们），并按旧镜像的迁移要求单独核对。不得删除任何旧表或旧行。

## 11. 禁止事项

- 部署只使用 `ggb-dsh/deploy/` 和本文规定的入口。
- 不提交或同步 `.env`、secret 文件、数据库、artifact、scratch、日志、浏览器 Session 或用户数据。
- 不让 Edge、APM、WAF、debug proxy 或容器命令行记录 `X-GGB-Provider-Key`、Authorization 或 runToken。
- 不把 SQLite、Memory store、临时 Vite server 或本地测试 secret 用作生产方案。
- 不在未授权情况下对真实 Provider、真实 GeoGebra 或生产数据库进行 smoke、迁移、回滚或清理操作。
