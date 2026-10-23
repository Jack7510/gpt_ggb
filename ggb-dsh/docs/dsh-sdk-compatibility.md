# DSH 安装式插件兼容契约

开发默认链路使用 `sdk-minimal`、安装包公开 server patch、可选流观测 patch 和最后应用的宿主权限 overlay。
宿主不再加载仓库工具实现、专属 CLI 包装器或相邻插件源码。工作区 `pnpm-lock.yaml` 是唯一 SDK 依赖锁。
本文件定义运行契约；实际检查结果与未验收项见 [Backlog](../../docs/ggb-dsh-backlog.md)。

## 宿主权限与提示边界

每次任务按顺序应用插件 server patch、可选流观测 patch、宿主 `host-policy.patch.json`。
宿主通过 [host-policy.ts](../apps/worker/src/plugin-core/host-policy.ts) 生成最后一层配置，
禁用通用 bash/PowerShell、文件、工作目录、文本编辑及原始日志插件。安装包不能移除这层宿主配置。

[宿主工具策略](../apps/worker/src/plugin-core/host-policy-plugin.ts) 使用 SDK 公开 tools.guard 执行单调拒绝：
只允许 `ggb_inspect / ggb_request / ggb_check / ggb_build`。每次模型流开始前，宿主同时校验实际工具注册表和
模型请求携带的工具表。缺少工具、出现其他工具或重复工具时，在调用 Provider 前拒绝本轮。
此检查不依赖流诊断采集器；诊断缺失或限额不会解除权限限制。

有无基线只决定能否调用 `ggb_inspect({})`。`ggb_inspect({reference: topic})` 在两种情况下均可读取固定参考，
宿主提示不能以无基线为理由禁止所有 inspect 调用。

## 安装式插件的隔离验证组合

| 项目 | 固定值或边界 |
| --- | --- |
| SDK Client / runtime / tools | `0.2.1-rc.2`；Worker、application 和 workspace overrides 一致 |
| Cordis / group / pi-ai | `4.0.5` / `1.0.5` / `1.3.0`；完整传递依赖由 workspace lock 固定 |
| 插件 | `ggb-plugins-dsh@0.8.3`；来自本地修改源码的 development-build，尚未发布 |
| 发行包 SHA-256 | `bf893c09090bfa4391378746530a0f74f96383b9deb067a8a3181365cc96580b` |
| Worker Skill SHA-256 | `3b1142c087949e52f61fed562defb0feb42abdc7e8299319037fffbb7ad33afa` |
| 工具 / executor / receipt / API↔Worker | 协议 `3` / envelope `3` / schema `2` / channel `8`；桌面 CLI 保持 envelope `1` |
| 插件 GeoGebra | `5.4.932.1`；归档 SHA-256 见 vendor lock |
| Playwright | `1.64.1`；执行器选择该包管理的 Chromium，不依赖系统 Chrome |
| Client applet | `5.4.932.1`；与插件统一官方归档，分别供应和校验 |
| 数据库 | 017 + 018；新 run 固定 `receipt-v1`，历史行保留 `legacy` |
| 实际离线环境 | Node `26.5.1`、pnpm `11.7.0`、macOS POSIX；不代表其他平台已验收 |

精确发行身份以 `vendor/plugin-core.lock.json` 为准；`config/runtime-versions.json` 记录相同组合。
Worker 在导入代码前核对发行文件摘要，再通过公开 `installation` 校验版本、协议、Skill 和 runtime 身份。
缺少安装包、包被改动或 SDK 组合不匹配时拒绝启动。`GGB_DSH_SDK_VERSION` 来自已核对的实际 SDK 包。

公开入口：`ggb-plugins-dsh/server`、`server.patch.yml`、`installation`、`schemas`、`cli`、
`executor`、`delivery-contract`、`drafts`、`runtime-compatibility`。四工具和 Worker Skill 的领域定义由插件拥有；宿主只拥有准入、
证据、进程监督、产物接收与原子提交。Client 不依赖 DSH SDK。

## 安装与启动

在 `ggb-dsh/` 运行：

```bash
pnpm install --frozen-lockfile --offline --ignore-scripts
# 完整供应会准备 runtime、Chromium，并运行 doctor；需相应资源和执行授权
pnpm run provision:plugin-core
# 默认读取 .plugin-core-runtime/<archiveSha256>
sh deploy/local/dev.sh
```

完整供应也可使用 `--offline --runtime-archive /absolute/verified-geogebra.zip`，
前提是 pnpm 与受管 Chromium 缓存已齐备。Worker 只检查资源，不在请求期间安装或下载。
插件安装根按只读方式使用，运行输出在独立的 `GGB_PLUGIN_CORE_OUTPUT_ROOT`。
供应器拒绝覆盖已有目标；资源准备失败后也不得把残留目录视为完整安装。
修复准备时选择新的 `--target /absolute/new-installation`，成功后将 `GGB_PLUGIN_ROOT` 指向该根。

只做本次授权的离线协议验证时，使用：

```bash
node tools/provision-plugin-core.mjs --offline --dependencies-only
node tools/verify-installed-plugin-sdk.mjs \
  --plugin-tgz vendor/ggb-plugins-dsh-0.8.3.tgz \
  --sdk-root apps/worker --output ../output/installed-plugin-d/sdk
```

依赖模式不运行 doctor、不准备 GeoGebra、不启动浏览器，标记为 `doctor: not_run`。
该安装可执行协议检查，业务 Worker 会在资源准入处拒绝启动。
验证器使用 canonical Worker SDK，离线安装本次 TGZ，只执行 initialize 和注册表/Prompt 检查。
SDK 子进程不继承凭据，测试 preload 拒绝 HTTP、fetch 和 socket 网络连接；关闭后再次核对尝试记录。
两个隔离 Harness 必须发现准确四工具和完整 Worker Skill，删除首个 home 后第二个仍能加载。
证据写入忽略目录 `result.json`。初始化通过不代表真实构图或浏览器清理通过。

## 引擎补丁的供应与启动准入

`runtime-compatibility` 公开入口返回 `patchId`、`sourceVersion`、`asset`、
`originalSha256` 和 `patchedSha256`。vendor lock 固定插件配方；runtime 配置固定 Client 配方。
供应 manifest 记录同样的审计身份。只有精确原始 asset 能应用补丁；已经修复的 asset 可幂等复用。
未知版本、不同字节或不同补丁结果均拒绝，不回退到原始引擎。

补丁 asset 和 manifest 均以同目录临时文件写入，先同步并关闭文件，再原子 rename。
POSIX 还同步父目录。写入、文件同步或 rename 失败不以部分内容替换旧文件。
manifest 更新失败后，旧 manifest 与已完整修复的 asset 可以重新供应；两文件之间不承诺跨文件原子事务。
API 提供 Client 静态资源时，在监听前比较固定配方、manifest 全部审计字段和实际 asset SHA-256，
拒绝原始、截断或符号链接逃逸的 asset。单纯修改 manifest 不能绕过准入。

默认供应使用 `.plugin-core-runtime/<archiveSha256>` 的公开模块，并核对兼容模块及原子写入模块摘要。
`--plugin-root` 只用于显式开发安装，验收不使用 overlay。离线真实归档供应：

```bash
pnpm run provision:plugin-core --offline --runtime-archive /absolute/geogebra-5.4.932.1.zip
pnpm run provision:geogebra --runtime-archive /absolute/geogebra-5.4.932.1.zip
pnpm run typecheck
pnpm --filter @ggb-copilot/client run bundle
GGB_RUNTIME_ARCHIVES=/absolute/archives GGB_RUNTIME_EVIDENCE=/absolute/evidence pnpm run verify:runtime-release
```

归档目录中的文件名必须是 `geogebra-5.4.932.1.zip`。两条供应命令仍检查官方 ZIP 摘要。
升级旧 Client 时先归档旧 public runtime 和 manifest，或在新 checkout 供应；供应器不覆盖版本冲突目录。
PWA 缓存升级到 `ggb-runtime-v3`，激活时删除 v1 和 v2，首次获取 runtime 绕过旧 HTTP cache。
验收使用实际 API 静态层、Client applet 文档和构建后的 Service Worker；先激活旧 v1 Worker，
验证原始引擎失效，再升级并验证缓存字节、依赖、样式、鼠标拖动、缩放和 GGB 重载。

宿主 CI 的 `runtime-release` job 从空默认安装开始，验证正式 vendor TGZ、doctor、真实官方 ZIP、
Client 供应和浏览器升级；证据通过 artifact 保存。插件 CI 另执行原始/修复引擎及其他圆锥曲线对照。
普通 `pnpm test` 包含模拟供应反例，不下载资源或调用真实 Provider。上述真实验收需浏览器授权。

本地同步新的 development-build 时，先在插件仓库执行 `pnpm pack:dsh`，再在宿主运行
`node tools/update-plugin-core.mjs --tgz /absolute/package.tgz --source /absolute/plugin-checkout`。
此命令同步 TGZ、文件摘要、源码快照、审计配方和 runtime 组合，不发布 npm 包或部署生产。

## Provider 与升级边界

Provider 使用 Messages API，默认根为 `https://api.deepseek.com/anthropic`。
Key 只在 run 期间存在，不写入数据库、日志或 DSH Session。Client 不能覆盖 Provider 地址。
升级时同时更新 SDK overrides、vendor lock、runtime 配置和消费方；重启本地 API/Worker。
回退使用上一个完整宿主与插件组合，不在同一个 run 中降级、重放或混用旧协议。
真实 Provider、GeoGebra、浏览器、镜像及目标数据库操作须另行授权。

## SDK 失败诊断与宿主协议适配

当前默认装配继承批次 B 的诊断行为，使用安装包协议 3；公开 HTTP/SSE schema 保持不变。

| 所有者 | 行为与可定位入口 |
| --- | --- |
| [Evidence owner](../apps/worker/src/plugin-core/evidence.ts) | SDK 与工具共享有界脱敏、私有持久化及逐调用账本，不保存原始模型正文 |
| [DSH runner](../apps/worker/src/plugin-core/dsh-runner.ts) | run 的 onNotification 回调收集失败前事件；异常、SDK 错误终态、关闭失败均保留诊断，不重放 |
| [Service](../apps/worker/src/plugin-core/service.ts) | 合并失败轮的有界 accounting 子集；未知 token 计数保留 null，截断时总用量标为不完整 |
| [Gateway](../apps/worker/src/plugin-core/gateway.ts) | 同一 run 串行准入，持久化后才执行，保留参数、issues、工具原结果和调用身份；模型只取得脱敏投影 |
| [协议适配](../apps/worker/src/plugin-core/tool-protocol.ts) | loadInstalledToolProtocol(pluginRoot) 从安装包公开 schemas 导出加载协议 3；拒绝协议 1/2 |
| [受控 Runner](../apps/worker/src/plugin-core/process-runner.ts) | 在 stdout/stderr 关闭后记录包装进程退出码、signal、字节数及尾部；异常退出和输出超限不能按成功解析 |

协议 3 必须在创建 ToolGatewayServer 时显式传入 options.protocol。它使用插件发布的解析与认证函数，
不在宿主复制第二份协议 3 schema。版本选择不从收到的报文推断，不回退到另一版协议。
现有业务 Gateway 消费解包后的领域 request，账本同时保留原始 wire arguments 与其摘要。
requestId、toolCallId、turnId、epoch 贯通认证和执行；实际进入 build 的调用另有宿主生成的 buildId。
同一 turn 的重复 requestId 即使换 nonce 也被拒绝；取消 capability 后不能继续准入。

SDK callId 与宿主 toolCallId 不是同一标识。诊断通过同一 turn、工具名和领域请求摘要关联；只有唯一且
尚未关联的 SDK 调用才能记为 matched，多候选记为 ambiguous，缺少证据记为 unavailable。
这不要求更改领域请求 2，也不要求模型提供身份。
失败轮没有任何可观察调用时 usage 为 null；已有调用的计数只表示已观察的事实，不把缺失的用量记成零。

### 私有证据与预算

生产装配将证据写入 `GGB_PLUGIN_CORE_OUTPUT_ROOT/<runId>/diagnostics/<turnId>.json`，
目录模式 0700、文件模式 0600，以串行临时写入和 rename 替换快照。诊断不进入 SSE 或正式产物列表。
SDK 原始消息正文、上传字节、Provider Key、capability、authentication 和 credential 字段不保留。

| 内容 | 固定预算及超限行为 |
| --- | --- |
| SDK 事件 | 最多 256 条、合计 256 KiB；单事件数据投影约 8 KiB，截断计入 sdkPayloadsTruncated；丢弃整条计入 sdkEventsDropped，单独保留异常根因 |
| 调用账本 | 滚动保留最近 64 次；达到上限后继续执行，记录 callLimitReached/callsDropped。淘汰后新调用的 SDK 关联标为 unavailable，避免误用旧调用身份 |
| 调用参数与插件结果 | 各自按 32 KiB 预算保存；过大则保存 truncated 及脱敏片段；原始大小分别由 argumentsBytes/pluginResultBytes 记录，摘要与身份独立保留 |
| 传输拒绝 | 最多 64 条有界身份与原因；超限保留早期条目和最新拒绝，并增加 rejectionsDropped |
| 包装进程输出 | 原有 stdout 上限 1 MiB，stderr 尾部 64 KiB；诊断再截取 stderr/stdout 最后 8,192/4,096 个 UTF-16 代码单元 |
| SDK 异常 | 白名单 name、message、code、位置、可取得的退出状态、stderr 及有限 cause；字段和嵌套内容均有截断上限 |

SDK TransportClosedError 的公开消息是当前版本暴露退出状态与 stderr 的方式；只解析其明确 header，
不从 stderr 内容猜退出码。SDK 未暴露的值保持未知，不读取 SDK 私有进程字段。
运行顺序为：收集 → 持久化 SDK 返回/失败事实 → 撤销工具 capability → close Harness →
补写关闭结果 → 确认关闭后删除临时 home。关闭失败时保留 home，不宣称清理已完成。
证据写入失败必须记录固定的持久化错误及 run/turn 身份，拒绝未执行的工具，仍继续关闭 Harness。

进程树所有权、槽位隔离、回执生成与原子交付见下文。不能只凭父进程 close 提前删除活跃资源。

### 离线复现与证据

从 ggb-dsh 目录运行，路径必须指向由本次 TGZ 安装得到的包根：

```bash
pnpm exec tsc -b apps/worker
GGB_PLUGIN_TEST_ROOT=/absolute/path/to/installed/ggb-plugins-dsh \
  pnpm exec vitest run apps/worker
```

默认 Vitest global setup 校验 vendor TGZ 摘要，解包后复用 loadInstalledPlugin 检查全部文件指纹及兼容组合。
它使用 frozen workspace 中与插件锁一致的 Playwright 测试依赖，不安装浏览器、不调用 doctor，也不访问网络。
验证后的安装根在测试收集前传给所有测试，安装包网关、可信回执及默认装配测试必须执行。
TGZ 损坏或指纹不一致时，整个测试启动失败；不得用跳过套件代替失败。
GGB_PLUGIN_TEST_ROOT 可以指定已有安装根，此时仍验证 TGZ 和该安装根。普通删除只清理测试自行创建的临时根。
该集成测试直接调用安装包的工具客户端和宿主 Unix socket，不发送 SDK 模型任务。
另有真实 SDK Client 加测试 stdio 子进程的故障注入：收到部分事件后子进程退出 23，
验证回调证据、stderr 脱敏、退出状态与关闭顺序；测试子进程不加载 Provider 或浏览器。
本轮实际结果与证据位置见 Backlog，不将离线测试当作真实 Provider 或 GeoGebra 验收。


## 三操作公开执行与构建额度

宿主 check/inspect/build 均调用安装包公开 executor，不解析桌面 CLI envelope。
`./execution-schemas` 拥有执行器 envelope 3 的完整解析、CheckData/InspectData 校验和 inspect 有界投影。
每份响应绑定 operation、contextSha256、packageIntegrity。宿主先确认正常退出、清理完成和绑定一致，再消费响应。
未知或旧执行器版本拒绝，不回退到 CLI。工具协议和上下文仍为 2，receipt 为 2，内部通道为 5。

| 操作 | 阶段与输出 | 宿主处理 |
| --- | --- | --- |
| check | preflight；插件与桌面 CLI 共用 checkRequest，输出 structural 数据 | 校验完整 schema，不占 build 次数 |
| inspect | execution；插件验证宿主基线并返回完整对象事实 | 校验完整 schema 和基线摘要，调用插件 projectInspect；不占 build 次数 |
| build | preflight 拒绝，或 execution 中的回执与核验事实 | 先预留次数；只有已验证的 preflight 拒绝可退款 |

插件在浏览器配置和 build 调用之前完成独立预检。宿主的退款判断同时要求：响应为本次已绑定的 build 拒绝、
phase=preflight、进程 completed 且退出码 0、没有 signal、清理已确认且未取消。
错误码不构成阶段证据。execution 中的 invalid_input、异常退出、超时、取消、输出超限及缺失清理证明均不退款。
候选失效、三次实际构建上限和清理隔离继续执行。

inspect 数据先逐对象校验，再由插件投影前 100 个对象和最长 500 字符定义；截断不能隐藏后续非法对象。
manifest 的文件名、runtime 和摘要语义由插件 validateHostMaterial 校验，宿主只提供从回执路径和实际字节测得的事实。
这不改变 receipt 2 的报告结构或持久交付格式。

## 可信交付与取消结算

开发默认装配使用安装插件和可信回执；API 与 Worker 必须一起使用内部通道 8。
没有保留旧固定目录交付入口，也不能从报文自动选择旧版本。

| 边界 | 执行契约 |
| --- | --- |
| 插件公开 `./executor` | 接收 `--operation check/inspect/build`、`--request`、`--context`、`--package-integrity`；输出 envelope 3；build 携带 receipt 2 |
| 插件公开 `./delivery-contract` | 导出 `validateHostDelivery`；build、preview 与宿主复用同一纯证据门禁；不启动浏览器 |
| [Installed runner](../apps/worker/src/plugin-core/installed-runner.ts) | 只解析包公开导出；发行包摘要由安装准入固定后传入；为每次执行创建新 buildId 目录，保存准入身份，再启动受控执行器 |
| [Execution state](../apps/worker/src/plugin-core/execution-state.ts) | 持有当前候选与隔离标记；新 build 被准入后先清空旧候选；失败不恢复旧候选，check/inspect 不替换候选 |
| [Service](../apps/worker/src/plugin-core/service.ts) | 只消费接受的候选，要求 SDK completed 与清理确认；不扫描固定 delivery，也不回退到旧文件 |
| [API](../apps/api/src/plugin-core/run-service.ts) | 保留原始 report/manifest 字节、回执和准入关联；消费 committed/cancelled/conflict；冲突仍为活动状态时提交失败结算 |
| [Store 共同校验](../packages/run-persistence/src/plugin-core-completion.ts) | 校验真实字节、大小、摘要、唯一 kind/引用、报告/manifest 与回执一致性；接收、产物和终态事件在同一次提交内保存 |

安装模式必须同时使用协议 3 网关、InstalledPluginCoreRunner、共享 ExecutionState 和可信交付 Service。
API 和 Store 创建新 run 时固定 `deliveryContract=receipt-v1`。
迁移 `018_plugin_core_delivery_contract.sql` 保存此事实；receipt-v1 缺少回执不能按 legacy 完成。
Worker 在 SDK 任务前拒绝非 receipt-v1 请求。018 的 SQL 默认 legacy 仅保留历史行语义，不能授权旧交付完成。

接收器在执行资源退出确认后才读取文件。它拒绝绝对或越界引用、符号链接和非普通文件，
按 kind 分配大小上限，并用 O_NOFOLLOW 打开、按上限读取、比较实际 bytes/SHA-256。
它将已检查的字节复制到宿主 accepted 目录，按 0600 保存；GGB 文件名由插件决定。
报告必须满足插件的完整证据门禁；报告、manifest 的请求摘要、runtime 版本、GGB 摘要和文件名必须一致。
这些检查不在宿主另写几何 checker。SDK 异常、取消、超时或缺正常结束证据均不能发布候选。

### 清理与资源保留

Worker 是插件执行进程组的唯一创建者；旧包装器内的 CLI 不再另建 detached 组。
POSIX 监督器跟踪进程组和已观察的后代，含另建组的后代；先 TERM，再 KILL，并观察退出。
流关闭、进程树退出与清理预算分别参与完成判定；只收到父进程 exit 或 cancel ack 不足以释放槽位。
该监督器适用于可信插件的受控执行树，不替代部署层对 Worker 崩溃的 cgroup/systemd/容器回收。
Windows 未实现 Job Object 所有权，不能获得 cleanupConfirmed=true，不应切换安装链路。

结束顺序为：保存 SDK 事实 → 撤销 capability 并中止工具 → SDK close/reap → 排空在途工具 →
写清理证据 → 清理临时 home → 返回最终结果。SDK close 和工具排空均有截止预算。
关闭/排空/进程树确认失败时，保留 home、基线与执行目录，写入 run/quarantine.json。
隔离标记在 Worker 重启后仍占用槽位；不自动清除，也不自动重放任务。

API 发送 stop 后继续等待最终结果。运行中的 cancel、complete 和普通 fail 都需要清理证明；
cleanup_failed 优先于 stop，不能转成 cancelled。取消证明写入原有事件表，完成证明写入 delivery JSON。
API→Worker 通道的连接、握手、超时和协议异常结算 worker_unavailable，清理状态保持未知。
Worker 缺失或返回不匹配的清理身份同样视为通道契约故障；只有匹配 runId 且 confirmed=false 才认定 cleanup_failed。
API 关闭时先停止任务并等待结算，关闭通道后仍等待断连失败写入，再关闭数据库。

到期清扫只给 running run 设置停止标记，由执行 owner 完成清理；无执行资源的 accepted 可失败或取消。
删除 running 时先停止并登记延后删除；running、cleanup_failed 和 worker_unavailable 记录不能由普通删除或 TTL 移除。
SQLite 仍为本机单 owner 快照存储，写队列串行处理并发请求；多实例部署使用 PostgreSQL。
PostgreSQL 使用行锁和事务，并在追加事件时锁定 run，避免终态与事件游标竞争。

### 离线验证入口

在 ggb-dsh 目录运行；安装根必须来自本次 TGZ，不指向源码 checkout：

```bash
pnpm exec tsc -b apps/worker apps/api apps/client
GGB_PLUGIN_TEST_ROOT=/absolute/installed/ggb-plugins-dsh \
GGB_C_TEST_PG_SOCKET=/absolute/disposable/postgresql/socket-directory \
  pnpm exec vitest run apps/worker apps/api apps/client packages/application packages/run-persistence
```

PG 参数只用于专用一次性本机数据库，不读取 DATABASE_URL；测试会初始化插件表并 TRUNCATE 测试表。
未设置该参数时不会运行 PostgreSQL 契约组，不能声称验证了三种 Store。
成功构建测试用合成点事实与字节，调用实际安装包的执行函数及公开门禁，替换构图操作，不启动浏览器。
另有实际公开执行入口的结构拒绝、真实本机进程树取消、能力撤销/排空和临时 PostgreSQL 事务测试。
本次包摘要、检查结果与未验收范围统一见 Backlog；真实 applet、浏览器清理及部署回收仍须授权验收。

## 默认装配与迁移离线验收

`plugin-core-default-composition.test.ts` 装配真实安装包、协议 3 网关和 channel 5，
以 mock Harness 驱动实际插件工具客户端；只替换 SDK 模型调用和资源准备检查。
检查 API 新 run 的 receipt-v1、公开 patch 选择、工具认证和无构建时的失败结算。
实际 SDK 初始化由上面的独立验证器覆盖。两种检查均不启动浏览器。

`plugin-core-migration-018.test.ts` 在一次性 PostgreSQL 内创建独立数据库，先应用 017 并写入历史行，
确认缺少 018 时 admission 拒绝；再执行迁移入口，确认只应用 018、重跑无操作、历史行保持 legacy，
新 run 为 receipt-v1。测试不读取现有 DATABASE_URL。内部通道测试拒绝旧版 1、3、4 握手。

## 真实 runtime 验收（无 Provider）

开发环境已将完整供应并通过 doctor 的安装放入默认包摘要目录。该事实不改变发行包摘要或 SDK 组合。
历史批次 D 的 `--dependencies-only` 说明仍描述该模式的限制，不能用其旧标记替代本次 doctor。
具体版本、证据与未验收范围见 Backlog。

在已获得真实 GeoGebra/浏览器执行授权后，于 `ggb-dsh/` 运行：

```bash
GGB_PLUGIN_TEST_ROOT="$PWD/.plugin-core-runtime/bf893c09090bfa4391378746530a0f74f96383b9deb067a8a3181365cc96580b" \
GGB_E_OUTPUT_ROOT="$PWD/../output/installed-plugin-e/recheck-$(date +%s)" \
  pnpm run verify:plugin-core:runtime
```

该入口要求新的证据目录。普通 `pnpm test` 不启用它。
真实资源准入、公开 executor、认证网关、内部通道、API Service 和 SQLite 均保留；只有 Harness 使用注入的确定性驱动。
测试不建立真实模型会话，不需要真实 Key。浏览器只允许插件本机资源，构建采用真实 GeoGebra。
成功路径核对原始产物字节与回执，并覆盖新建、显示修改和基线续构。
取消路径在观察到 renderer 后发送 API stop，要求无交付、终态 cancelled、已观察进程全部退出，随后新构建成功。
这不覆盖真实 Provider、真实 Harness 模型任务、PWA HTTP/UI 端到端或 Worker 崩溃后的部署层回收。

## PWA 全链验收（mock Harness + 真实 GeoGebra）

在已获得本机真实浏览器和 GeoGebra 执行授权后，于 `ggb-dsh/` 运行：

```bash
pnpm exec tsc -b apps/worker apps/api apps/client
pnpm --filter @ggb-copilot/client run bundle
pnpm run verify:plugin-core:pwa:mock --authorized
```

需要完整的默认插件安装和已供应的 Client applet，版本分别由 vendor lock 与 runtime 配置固定。
命令无需真实 Provider Key；页面中只输入专用假 Key。脚本仅注入 mock Harness，不实例化真实模型客户端，
Provider 地址固定为本机不可用端口。浏览器只允许访问本次本机 origin。
`--out /absolute/evidence-parent` 可指定证据父目录；每次自动创建新的 run 子目录。
默认写入仓库忽略目录 `output/playwright/installed-plugin-e-pwa/`。

脚本通过页面创建两轮任务，刷新活跃任务以重连 SSE，核对恢复游标和未重复创建/执行；
再检查真实下载、卡片/HTTP 摘要、Service Worker、画布对象、编辑后的基线摘要与续做坐标。
坐标 API 用作确定性的画布编辑刺激，不将其称为拖拽手势验收。
正常与失败证据均保存；最后关闭浏览器、HTTP、Worker 与临时 socket 目录。
该场景覆盖刷新恢复，不覆盖静默断流后的自动连接策略。实际结果和剩余验收范围见 Backlog。

## 模型参数契约检查

插件的服务端工具必须公开嵌套请求结构，不能只提供 `request: object`。
`native` 程序字段为 id、op、source、mode；可选 outputs 必须包含 id。
checks 使用 subjects、scope，styles 使用 properties；Worker Skill 中的完整示例须通过插件真实解析器。
宿主不将 step/command 等非法字段自动翻译为另一协议。
隔离 SDK 检查同时核对注册工具、模型工具参数和 Worker Skill，而不只计数工具名。
更换固定发行包后重启开发 Server；在途 run 继续使用原安装根，不热改其代码。
真实 Provider 的输出行为仍需独立复测，离线契约及真实执行器通过不等于模型已成功调用新契约。

## 工具参数流证据与归因

宿主在 SDK 子进程通过 `NODE_OPTIONS --import` 加载 response-body 观测器，并通过 SDK 公开 `llm/stream`
钩子观察译后的 chunks。原插件 patch 仍拥有工具与 Worker Skill；附加的宿主观测 patch 不注册工具或模型规则。
该组合按当前锁定 SDK 验证，不访问 SDK 私有进程字段，也不手改依赖。

每 turn 的 `diagnostics/<turnId>.stream.json` 由 SDK 子进程写入，目录 0700、文件 0600。
保存 Messages 响应中的 tool_use/input_json_delta 与 SDK 最终工具参数。
出站请求额外保存白名单模型设置、工具 schema 摘要/结构，以及 system 的字节数、摘要和 JSON 示例形状；
不保存 headers、会话历史、system 原文、正文或 reasoning。采集失败不改变请求或响应。
已知 Key、capability 及凭据字段被脱敏；残缺 JSON 也执行字符串凭据脱敏。
证据沿用同一 run/turn 目录关联，request 序号区分本轮模型步骤。

| 证据边界 | 固定预算 |
| --- | --- |
| 每 turn 模型请求 | 最多采集 16 次；后续只计 droppedRequests，继续模型执行 |
| 每请求工具块 | 8；超出计 dropped，不能完整归因 |
| 每工具参数 | 参数 32 KiB；超限标 truncated。仅保留前 256 个分片摘要，后续仍组装预算内参数；元数据限额不影响完整性归因 |
| 预览 | 每工具最多 8192 字符，只保存脱敏投影 |
| SSE 单帧缓冲 | 1 MiB；超限丢弃并标不可完整归因 |
| 文件 | 512 KiB 预算；超预算去掉预览/分片明细，保留摘要与分类，标 truncated |

原始参数和 SDK 参数均先计算摘要/JSON 合法性，再生成脱敏投影。
`classification=provider_tool_json_invalid` 要求完整 wire 参数本身非法且 SDK 最终参数逐字一致。
`classification=sdk_assembly_mismatch` 表示两个最终字符串不同，须结合合法性和版本分析，不能仅凭名称断定算法错误。
相同合法输入为 valid；截断、缺 stop 或缺 SDK 参数为 unavailable。max_tokens 不作为组装故障证据。
此可选参数流观测器的限额、缺失及写入失败均不改变模型流或任务结果。认证工具账本的持久化门禁仍按上文执行。
采集不重放请求，SDK 原始异常仍向上传递。

### 受限知识读取与失败反馈

`ggb_inspect({reference: topic})` 经过同一认证、撤销和逐调用账本，不要求存在基线。
固定主题为 `request / program / verification / interactions / patterns / naming`；省略参数时仍检查基线。
Worker 调用当前安装包的公开 `installation.loadReference()`，每次返回一个完整主题，最多 24 KiB。
工具不接受路径或 URL，不开放 shell、通用文件读取或其他任务目录。

Worker 在本次 build 的独立目录读取 CLI 失败、`run.json` 和 `verification.json`，拒绝符号链接及超过
1 MiB 的报告。模型响应保留错误码、失败阶段、对象及未通过检查的有界字段；路径、凭据和堆栈被移除。
目录扫描限本次根及最多 16 个一级子目录和其 delivery；最多提取 8 个未通过检查，结果上限 24 KiB。
报告缺失、损坏或超限时保留 CLI/进程错误，不能推断成功。超时、取消和未确认清理仍保留原进程分类与隔离门禁。

此前发行包的真实 PWA 画圆复测已通过；当前开发包的真实正多边形任务也已完成可信交付。
首次事故缺少 wire 证据，仍不能最终归因。
实际记录与待验证范围见 Backlog。未知模型用量仍保持未知，不从参数流估算账单。


## Review 后续兼容边界

回执 schema 2 只携带报告字节引用和 2 KiB 内的摘要。完整报告单独传输。
API 与 Worker 使用通道 8；不能与通道 7 及更早版本混用。执行器保持 3，工具升级为 3，上下文保持 2。
GGB/preview/报告/manifest 原始上限分别为 6/3/1/1 MiB；交付 JSON 为 16 MiB，响应帧为 17 MiB。
插件公开 LIMITS、宿主 schema、接受边界及原子提交共同执行这些上限。API 按 run 隔离连接。
预览缺失不影响 completed；存在但非法时拒绝。基线在插件执行前后及宿主接受时核对。
run 目录的执行文件在确认清理后删除，诊断保留 7 天；隔离和未知所有权不自动清除。
Windows 或 ps 不可用时，Worker 在监听前拒绝启动。

开发包包含 source/ 快照；供应锁固定每个源码与构建输入的摘要和快照总摘要。
sourceCommit 与 sourceDirty 仍描述本地开发基线，精确代码以归档和快照为准。
这不是已发布的上游 0.8.3；不得覆盖现有供应目录。本机最终包的完整 runtime/doctor、4 项 mock Harness + 真实 GeoGebra 及 PWA mock 全链已通过。
两轮旧任务的完整 wire 参数本身非法，且与 SDK 最终参数完全一致；历史原始字节离线回放仍按原样拒绝。
当前包使用完整 `{request: {...}}` 工具示例、带类型的枚举 schema 和宿主 reasoning high。
适配器将四工具 schema 原样传给 Messages input_schema；没有添加未经该接口支持的 strict 参数。
一次授权的真实 Chrome 正多边形任务完成，9 次工具参数均合法；详情、验收脚本类型别名误判及无 Provider 产物补验见 Backlog。
这些修改降低契约歧义，不保证 Provider 永远返回合法 JSON，也不自动修补非法参数。

## 分段请求契约

模型通过 ggb_request 一次提交完整 requestText；宿主注入原始 prompt，旧 section 操作仅保留底层兼容。
check 接收 revision，build 接收 checkedRequestId；均不再接收完整 request。
草稿组装和检查句柄由安装包 ./drafts 拥有，宿主只负责隔离、认证、串行准入及清理。
契约、状态机和拒绝规则见[小块请求与已检查版本](../../docs/ggb-dsh-installed-plugin-design.md#27-小块请求与已检查版本)。
