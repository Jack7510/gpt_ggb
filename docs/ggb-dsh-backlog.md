# GGB DSH 统一 Backlog

更新：2026-10-24。当前引擎为 plugin-core；Native 九阶段已删除，删除前代码保存在标签
`archive/native-nine-stage-pre-plugin-core`。本文只维护未完成工作、根因、依赖与退出条件；
设计取舍见 [采用方案](ggb-dsh-plugin-core-adoption.md)，已验证证据见
[切换交接](ggb-dsh-plugin-core-cutover-handoff.md)。

状态口径：

- **待开始**：未实施。
- **实施中**：已有代码改动但未通过对应验证。
- **待验证**：离线检查通过，真实环境或部署验证未完成。
- **阻塞**：需要外部授权、目标机或第三方条件。
- **历史记录口径**：已完成批次中的协议版本（例如 receipt 1、channel 4）记录当时状态；当前版本以[协议版本规则](../ggb-dsh/docs/protocol-versioning.md)为准。

## 1. 未完成工作

| ID | 优先级 | 状态 | 工作项 | 根因/说明 | 退出条件 |
| --- | --- | --- | --- | --- | --- |
| PC-01 | P1 | 待验证 | 目标机器 Docker/PWA 部署验证 | 原切换批次的本机真实 Provider 验证已完成，当前安装包已完成本机真实 GeoGebra 构建、取消及一次真实 Provider 正多边形交付验收；目标机镜像构建、静态资源、systemd/Edge 与 017/018 应用尚未在目标环境验证 | 目标机构建镜像、应用 017/018、启动 API/Worker、PWA 完成一轮已授权构图并下载/续做成功 |
| PC-02 | P2 | 观察 | `general-horse-explanation` 未交付 | 本机集成批次模型侧 `plugin_core_no_delivery`；最终重试仍未交付 | 该案例在授权真实 Provider 运行中交付，且交付 GGB 通过插件核验与 Client 加载 |
| PC-03 | P2 | 观察 | `ellipse-foci` 未交付 | 同上 | 同上 |
| PC-04 | P1 | 阻塞 | 目标环境 PostgreSQL 备份与 017/018 演练 | 需要目标数据库、备份窗口与明确授权 | 备份完成、018 已在目标库记录、API/Worker 启动通过 schema admission |
| PC-05 | P3 | 待开始 | 目标环境真实 Provider 批量复跑 | 本机仅完成 5/7；目标环境尚未复跑 | 明确授权后，在目标环境以新 `output/` 目录完成批次并保留证据 |
| PC-06 | P1 | 待验证 | 首次 MALFORMED_RESPONSE 的历史归因 | 已补齐双侧流证据并通过一次真实 PWA 画圆；本次参数合法且 SDK 组装一致。首次失败没有原始流，无法最终归因，不能宣称修复了已证实的 SDK 组装错误 | 发生下一次已授权运行时用新证据定位；只允许无 build 的安全重试，不修补非法 JSON |
| IP-C | P0 | 待验证 | 部署层 Worker 崩溃后的资源回收 | 本机真实 GeoGebra 交付和主动取消已验收；容器/cgroup/systemd 崩溃回收尚未验收 | 在授权目标环境终止 Worker，证明部署层回收其浏览器子树且不自动重放 |
| IP-E | P1 | 待验证 | 安装插件真实 Provider 与部署验收 | 本机完整供应、doctor、真实构图/取消及 mock Harness 的 PWA 全链已通过；一次真实 PWA 画圆已通过；两轮正多边形失败已定位到 Provider 非法 JSON，当前包一次真实正多边形交付通过；生产环境未验收 | 分别授权后完成复杂题回归、目标环境发布与部署层回收验收 |

## 2. 已完成（不再作为当前工作）

- 发布收尾与批量参考（2026-10-24）：修复 vendor sidecar，更新工具同步 TGZ/sidecar/锁/配置，
  发布 gate、默认测试准入与供应器核对四者摘要；篡改与更新反例 6 项通过。
  两个 PWA 脚本从配置读取版本；当前说明引用固定组合，历史 929.3 验收不改写。
  Client 真实测试覆盖 p/d 标签逐项 true→false、重载、鼠标拖动、父参数变化、缩放及隐藏状态保持；
  分别从 active v1 Worker、历史真实 v2 Worker 升级到 v3 并校验缓存实际字节。
  原子 rename 后父目录打开/同步失败明确为已替换、持久性未确认，不自动回滚。
  新增 references 批量读取，最多 6 个固定主题、去重、互斥参数与序列化结果 24 KiB 上限；
  超限普通拒绝，不截断参考。真实认证通道验证六主题一次读取、权限撤销与完整内容。
  check 数量错误透传检查身份与数量范围，CLI/executor/工具链完成拒绝后修复；
  参考中的五类最小示例均通过解析与编译。已有 dependsOn 复用为动态依赖检查，并补固定坐标反例。
  最终安装包及 Skill 已同步；默认空安装根完整供应和 doctor 通过，两个隔离 SDK home 验证四工具，
  Provider 请求 0、网络尝试 0。宿主完整 check 通过（702 项通过、5 项默认跳过），
  最后补充通道与准入定向 20 项通过；插件完整 181 项及原子/执行故障 14 项通过，补充示例 7 项通过。
  真实供应/Client 升级 5 项通过；真实引擎矩阵含独立上游 HTML 原始/修复对照共 14 项通过。
  最终包 mock Harness + 真实 GeoGebra 的 PWA 两轮交付、SSE 重连、下载、画布及基线续做通过。
  Directrix 动点已纳入实际交付 iframe，隐藏标签、重载、真实鼠标拖动、缩放和续做后的依赖均通过。
  证据：output/playwright/release-closeout-20261024/。CI 已接入，远程 CI 未执行。
  上游复现材料已准备但未对外提交；未调用真实 Provider、未部署生产，付费模型性能收益及目标环境回归仍待授权实测。

- 引擎兼容补丁供应与客户端验收（2026-10-24）：asset 与审计 manifest 改为原子写入，
  记录 patchId、sourceVersion、原始及修复后摘要。API 静态资源启动准入校验固定配方、manifest 和实际字节；
  Worker 校验安装包公开配方与 vendor lock。字段篡改、截断字节、符号链接逃逸均拒绝。
  按用户确认将 Client 与插件统一为 5.4.932.1，正式 vendor TGZ 及兼容组合已同步；
  新摘要默认安装根由空目录完成供应，真实 doctor（含 CAS 和路径点）通过，不使用源码 overlay。
  官方 ZIP 验证只修改目标 asset，覆盖重复供应、过期审计恢复和错误归档拒绝。
  真实 API + Client + Playwright 验证旧 v1 Worker 激活、v1/v2 缓存清理、v3 缓存真实补丁摘要，
  构造样式、GGB 重载、鼠标拖动、父参数变化、滚轮缩放及再次重载均保持依赖。
  插件完整测试 176 项及原子/执行故障回归 12 项通过；真实引擎对照 12 项通过。
  宿主完整 check 通过（692 项通过、5 项默认跳过），补充准入反例后定向 25 项通过；
  官方供应/doctor/Client 升级验收 4 项通过。CI 已接入真实 runtime job，但未在远程 CI 执行。
  证据保存在 output/runtime-release-20261024/；契约和命令见
  [引擎补丁供应](../ggb-dsh/docs/dsh-sdk-compatibility.md#引擎补丁的供应与启动准入)。
  未调用真实 Provider、未部署生产；Linux CI 和目标部署仍不属于本机验收。

- Malformed response 安全重试（2026-10-23）：`MALFORMED_RESPONSE` 且无 `ggb_build`、证据未截断时重跑一次模型 turn；
  `hasBuildCall` 取代任意 tool call 保护，只读 inspect/check 可重复；新增 `plugin_core_malformed_response` 错误码。
  已有构建事实或第二次 malformed 仍失败关闭；宿主测试覆盖只读重试、build 阻断和错误码。
- 单次完整 requestText（2026-10-23）：ggb_request 主路径改为一次提交完整 request body；
  `requestText` 只含 plan/clarifications，宿主注入 prompt/locale/base，图片 transcription 使用独立小字段。
  check 仍按 revision，build 仍使用 checkedRequestId；旧 section 操作保留为底层兼容。
  目的是把大 JSON 从多次 section 往返降为一次请求，减少 revision 冲突和模型调用数。
- 小块请求、局部修复和引用式构建（2026-10-23，兼容历史）：安装插件此前支持 ggb_request，每次参数上限 2048 UTF-8 字节，

  按完整条目追加、替换、删除和分页读取；原始 prompt 保留，图片文字可分段转写。
  check 检查完整组装请求并返回不可变检查句柄，build 使用该句柄；写入失败不改变版本，过期/跨 turn 句柄和并发版本冲突在构建配额预留前拒绝。
  成功修改同时撤销旧交付候选，防止未构建新草稿却交付旧文件；回执、可信交付及构造脚本绑定最终完整请求摘要。
  CAS、initial、嵌套独立 expected、原题 source、交互与完整核验均保留；不增加 shell、文件路径或非法 JSON 自动修补。
  工具协议升级至 3，API/Worker 内部通道为 8，executor/执行上下文/回执仍为 3/2/2；开发 TGZ 与完整文件摘要锁已同步。
  草稿仅在当前认证 run/turn/epoch 内存中保存，关闭后不恢复、不自动重放。
  `MALFORMED_RESPONSE` 的安全重试只覆盖“证据未截断、没有 ggb_build”的 turn；只读 inspect/check 可重复，已有 build 不重放。
  插件完整离线测试 175 项通过；宿主 683 项通过、5 项默认跳过。TypeScript、Client Vue/bundle、共享 lint、质量和工作区边界检查通过。
  最终 TGZ 在两个隔离真实 SDK Server 中发现准确四工具及 Worker Skill；Provider 请求 0、网络尝试 0、浏览器启动 0。
  证据：output/draft-plugin-tests.log、draft-offline-regression.log、draft-sdk/result.json 及其他 draft-*.log。
  本轮未调用真实 Provider、真实 GeoGebra 或部署生产；格式错误率、工具调用数与端到端耗时改善尚未实测。

- Review 四项修复（2026-10-23）：实时 SDK `step/start / step/end` 经 Worker、API、SSE 进入 Client；只显示执行事实，时间仅用于耗时显示。
  session/步号关联、重复与倒退、关闭后迟到通知有反例覆盖；SDK 返回的历史事件不补发为实时进度。
  内部通道升级为 7，API/Worker/Client 和兼容锁同步；旧 v6 握手拒绝，未新增数据库 DDL。
  构建结束、执行异常和后续读取/模型事实保留最近构建槽位；超额拒绝不借用前次构建身份。
  构造脚本绑定 accepted request 与已验证报告，保留 CAS 实际物化赋值及逐步骤 `SetCoords`；不从当前值反推依赖定义。
  自动标题保留数学表达式的逗号和冒号，手工命名优先；图片交付后的主题标题有运行时集成测试。
  最终离线回归 664 项通过、5 项默认跳过；包含 mock Harness 通知、真实本机 HTTP/Unix socket/SSE、
  构建开始及拒绝后的两次重连、终态保护、安装包执行器的合成可信交付和会话恢复。
  TypeScript、Client Vue 类型与 bundle、共享 lint、质量及工作区边界 2 项检查通过。
  证据在 `output/review-four-fixes-*.log`；未调用真实 Provider、真实 GeoGebra 或部署生产环境。

- 工具级真实进度（2026-10-23）：网关发布三工具的实际开始、接受、拒绝及执行异常，经认证 run 连接、API 事件存储和 SSE 进入 Client。
  内部通道升级为 6，握手双向验证版本；发行兼容锁同步。进度不会结束最终结果 waiter，不包含工具参数、模型文本或百分比。
  每 run 最多 128 条，连接积压时丢弃进度，观察异常不影响工具执行；配额拒绝不显示新构建，预检退款可复用预算槽位。
  Store 原子拒绝停止及终态后的进度；Client 拒绝其他 run、旧游标、倒退顺序和终态回退。
  ready 快照包含游标覆盖的最新工具事实；Client 对断线和提前 EOF 最多重连 4 次，不重建任务或重放构建。
  最终事件后的快照下载断线也可恢复交付，保持终态。
  本轮完整离线回归 642 项通过、5 项默认跳过；包括真实本机 Unix socket/HTTP/SSE、mock Harness/构建和 PWA 运行时的断线恢复。
  PostgreSQL 行锁分支使用离线驱动替身，未声称真实 PostgreSQL 并发验收。
  Worker/API/Client/Store TypeScript、Client Vue 类型与 bundle、共享 lint、质量及工作区边界检查通过。
  证据位于 `output/tool-progress-*.log`。未调用真实 Provider、真实 GeoGebra 或执行生产部署；未新增数据库 DDL。

- PC-07：两轮 MALFORMED_RESPONSE 定位与契约修复（2026-10-22）：
  两轮完整 wire 参数均含多余结束括号，与 SDK 最终参数 SHA-256 一致；SDK 没有制造非法 JSON。
  原始字节经实际固定版本适配器离线回放，仍原样拒绝；客户端证据不能区分模型生成与 Provider 内部兼容转换。
  修正 Worker 示例缺少工具根 request 的歧义，schema 常量改为显式类型/枚举，宿主 reasoning 改为 high。
  新增出站模型设置、schema 指纹及 system 示例形状证据，不保存 Key、历史或 system 原文，不修补非法 JSON。
  当前 TGZ SHA-256 为 c0bd9d50ae405683cc063c8373a6bcad91f67e80279ff7a9be81dc9b90f4faae。
  插件 128 项、宿主 Node 10 项和 Vitest 529 项通过；5 项默认跳过为真实 runtime/PG。
  完整 runtime/doctor 通过，另行运行 mock Harness + 真实 GeoGebra 4 项通过；两个隔离 SDK home 加载三工具/Skill，网络 0。
  只创建一次真实任务 run_10759312-e394-463a-a999-b4d82e651271，原始题目未追加边数；5 次模型请求、9 次工具参数均合法。
  check 的一次语义拒绝由模型自行修正，build 接受、SQLite completed、cleanup.confirmed=true。
  构造及重载各 20 项通过，交互 2 个样本通过；GGB 4694 字节，带 n=3..10 滑块。
  原 Chrome 已显示交付；验收脚本误将原生 triangle 排除于 polygon 外，原失败文件保留。
  随后仅用原 SQLite 产物经本机 fixture 下载并在 PWA 导入，切换 n=6 得到 hexagon；不是原任务鉴权下载端点的独立复验。
  补验没有 Worker、没有模型任务或 Provider 调用；产物字节数/摘要与原可信元数据一致。
  另修复 receipt 2 核验摘要重复投影导致模型反馈计数归零的问题；此项在真实任务后完成，以定向及完整离线回归验证。
  索引：output/malformed-response-fix/LOG-INDEX.md；根因边界：同目录 ROOT-CAUSE.md。
  无生产部署、无自动重放、无 JSON 修补；PC-06 缺少原始证据的历史归因仍保留。

- 最终安装包 runtime 完整供应与分阶段验收（2026-10-22，真实 Provider 未通过）：
  固定最终 TGZ `f2d83c594333daa48f659179e75466e47aac8a5633799160c3d40641403952c6`，
  在新的摘要安装根完整供应依赖、GeoGebra 5.4.932.1 和受管 Chromium；doctor smoke/CAS smoke 均通过。
  mock Harness + 真实 GeoGebra 4 项通过：公开圆示例、构建/修改/续做、可选 preview、取消进程树及槽位复用。
  可选 preview 使用验收专用适配层：调用真实公开 CLI，省略预览后由插件公开 executor 生成原始回执；
  不修改安装包。宿主接受 receipt 2，并在 SQLite 原子提交 GGB、报告和 manifest，没有 preview 产物。
  取消发生在观察到 renderer 之后；终态 cancelled、cleanup.confirmed=true、已观察 PID 无存活，下一构建成功。
  真实 PWA + mock Harness 全链通过，包含 SSE 刷新重连、两轮下载/摘要、画布加载、编辑基线续做。
  修复验收 socket 路径过长：Unix socket/home 使用短临时目录，证据继续保存到独立输出目录。
  两轮真实 Provider 使用 .env 中同一 Key，由 Playwright channel=chrome 驱动 Google Chrome。
  第一轮 `run_1caa5f03-be89-46d2-ba7a-9816f890acee` 在合法 check 后，build 参数末尾多一个 `}`；
  第二轮原始题目 `run_116fc649-4b20-49fe-9930-d27e9df374bc` 在 check 参数中出现多余结束括号。
  共观察到 5+4 次模型请求，属于两个独立任务，不是 9 次验收任务；均没有进入 build 网关。
  两轮均为 provider_tool_json_invalid、assembly=identical、message_stop 完整、无参数截断。
  此证据支持本次模型输出非法 JSON，不能据此反推 PC-06 首次历史失败。
  SDK 如实终止；没有修补参数，没有第三轮真实调用；两轮 Harness 均关闭，宿主确认清理且删除执行文件。
  各阶段日志、doctor、GGB、报告、截图、进程树及流对照索引见
  `output/installed-plugin-final-runtime/LOG-INDEX.md`；汇总见 stages.json。
  类型、fixture 语法、质量和 diff 检查通过。未部署生产、未提交代码。


- Review P1-3/P1-4 与其余本地修改（离线验收）：
  回执 schema 2 使用报告摘要、字节数和有界投影；完整报告只作为产物传输。
  统一原始产物上限 6/3/1/1 MiB，交付 JSON 16 MiB，响应帧 17 MiB；内部通道升级 5。
  每个 run 使用独立连接，超限帧不能关闭其他 run；UTF-8 分片按字节限额并正确解码。
  preview 可缺失；存在但非法时拒绝。完成提交保持报告/manifest 字节及回执绑定。
  其余本地 Review 修改包括确认清理后的执行文件删除、7 天诊断 retention、旧全局日志淘汰、
  构建后基线复核、较早 deadline、启动平台/ps 检查、精确交付契约、损坏交付错误分类、
  持久 epoch/独占 owner/重启隔离、清理结论入证据及结束时释放 quota Map。
  删除 admission.json 和 accepted/ 重复暂存写入；修正共享技术文档并显式忽略本地 symlink。
  开发包源码快照和全部指纹固定于供应锁，SHA-256 为 `f2d83c594333daa48f659179e75466e47aac8a5633799160c3d40641403952c6`。
  插件离线测试 128 项、最终封装测试 17 项、最终契约测试 14 项通过。
  宿主构建、lint、质量检查通过；最终 Node 10 项、Vitest 523 项通过，4 项真实 runtime/PG 跳过。
  另补通道 4 的显式拒绝反例并定向验证。长函数职责拆分后 Worker 离线 131 项通过、3 项真实 runtime 跳过，类型与质量检查通过。
  接受边界反例结果见本批证据。
  最终 TGZ 在两个隔离 SDK home 加载三工具和 Worker Skill，networkAttempts=0、browserStarted=false。
  证据见 output/installed-plugin-remaining/ 和 output/plugin-remaining-tests.log。
  本批未调用真实 Provider、未运行真实 GeoGebra、未供应新包完整 runtime/doctor、未部署生产。
  部署层崩溃回收、真实端到端及首次历史失败归因仍按上表保留，不冒充已完成。


- Review P1-1/P1-2（离线验收）：
  三工具统一使用插件公开 executor；执行响应升级 envelope 3，增加 operation、contextSha256、包身份及阶段绑定。
  当时工具/上下文协议 2、receipt 1、内部通道 4 不变。check 与桌面 CLI 共用插件 checkRequest；
  inspect 完整数据校验及有界投影、manifest 字段语义均由插件公开契约拥有，宿主删除 CLI envelope 1 解析。
  只有安全退出且绑定正确的 preflight 拒绝可退还 build 次数；执行阶段同码错误、缺失阶段及异常进程均不退款。
  安装包集成测试确认四次预检拒绝后仍可完成三次合成构建，执行阶段 invalid_input 三次后被配额拒绝。
  覆盖旧协议、上下文/包/操作替换、inspect 基线及截断范围外非法对象等反例。
  新开发包 SHA-256 为 `3723c46f7b85b52e872453c62f5fcba6d41628b58ce8176b76189e4b4735e337`。
  插件默认离线测试 127 项通过；宿主完整 pnpm run check 通过：Node 10 项、Vitest 506 项、构建/lint/质量检查通过。
  4 项真实 runtime/PG 按范围跳过。最终安装包在两个隔离 SDK home 初始化成功，三工具和 Skill 正确加载，网络尝试为 0。
  证据见 `output/installed-plugin-p1/`。本轮未运行真实 Provider、GeoGebra 或生产部署；未完成新包完整 runtime/doctor 验收。

- Review P0 后续批次修复（离线验收）：
  宿主提示区分空参数基线检查与 reference 主题读取，无基线不再禁用知识读取。
  API 将分发/握手/超时/协议异常及不匹配的清理身份归为 worker_unavailable；匹配 runId 且 confirmed=false
  仍归为 cleanup_failed。Memory、SQLite、PG Store 允许记录未知清理失败，并保留删除/TTL/取消守卫。
  默认 Vitest global setup 验证 TGZ、全部文件指纹和测试依赖版本，再供应测试安装根；CI 不再跳过安装式网关、回执和默认装配。
  宿主最后应用自己的权限 overlay，并通过 SDK 公开工具注册表、模型工具表及 tools.guard 限制三工具。
  真实 SDK 的本地 SSE 反例验证：插件省略权限禁用项仍可安全执行；额外工具使本轮在访问模拟端点前被拒绝。
  完整 `pnpm run check` 通过：构建、lint、Node 10 项、Vitest 491 项、质量检查。
  4 项按范围跳过：真实 GeoGebra runtime 3 项及真实 PG 契约 1 项；PG 新分支另有离线驱动边界测试，不冒充真实 SQL 验收。
  证据见 `output/installed-plugin-repair/p0-full-check.log`；本批未修改插件发行包、未调用真实 Provider、未部署生产。

- 诊断限额、工具失败反馈与受限知识读取修复（离线验证）：
  `run_bef1e884-bc23-4b89-bb5b-0ef075bc6b40` 在连续结构拒绝和三次构建失败后，
  被可选参数流诊断的第 17 次请求限额中断。采集器现只保留前 16 次请求并记录丢弃数量，
  写入失败不改变模型流；分片摘要限额与完整参数组装分离，32 KiB 内参数仍可比较。
  调用账本滚动保留最近 64 次，记录丢弃数量，不把采集限额作为执行限额；认证及持久化失败仍拒绝未执行工具。
  Worker 从本次构建目录的 CLI、run.json、verification.json 提取有界失败事实，脱敏后返回模型。
  认证 `ggb_inspect({reference})` 可读取当前安装包的六个固定主题，不接受路径或 URL；
  交互参数公开屏幕像素、分量上限、位移下限及重复点约束。
  插件 60 项定向离线检查通过；Worker 91 项通过，真实 runtime 的 3 项按范围跳过，类型及质量检查通过。
  认证网关连续完成 70 次参考调用，调用账本保持 64 条并记录 6 条丢弃。
  真实 SDK Server 对本机模拟 SSE 完成 18 次请求和 17 次工具调用，
  证据仅保留 16 次，不再中断任务。新包在两个隔离 SDK home 加载三工具和 Worker Skill，网络尝试为 0。
  三次历史失败报告的离线投影均返回 execution_failed、失败阶段及 poly 未创建的具体原因，未重执行构建。
  证据见 `output/installed-plugin-repair/`。本次未调用真实 Provider、未运行 GeoGebra、未部署生产。
  当前开发包仅供应依赖，doctor 未运行；此前真实 PWA/GeoGebra 验收仅对应下方旧包，不能移作新包验收。

- 参数流诊断修复及一次真实 Provider PWA 复测通过：
  Worker 在独立 SDK 子进程加载只观测的 fetch preload 与公开 llm/stream hook。
  Provider 响应字节和 SDK chunks 均原样传递；不修改 SDK 安装文件，不自动重试或修补非法 JSON。
  私有 `<turnId>.stream.json` 对照原始 SSE 工具参数与 SDK block-end 参数，保存有序分片长度/摘要、
  原始拼接与 SDK 结果摘要、JSON 合法性、限长脱敏预览及明确归因。正文、思考内容和请求头不保存。
  只有未截断、观察到 block-stop/message-stop 且 SDK 最终参数存在时才认定可比较；max_tokens 不作组装错误归因。
  离线实际 DeepSeekAdapter 回放确认合法 Unicode 分片逐字一致，非法 JSON 原样报错；真实 SDK Server 对本机 SSE fixture 的故障注入也保存双侧证据。
  最终 Worker 15 个测试文件、77 项通过，真实 runtime 的 3 项默认跳过；类型与质量检查通过。
  本轮仅创建一个真实 PWA 任务：`run_314e6a99-b9d8-4696-88d7-4f3cdbf20e74`。
  该任务包含正常的 3 次模型请求（check、build、最终报告），不是 3 次复测；没有追加第二个付费任务。
  模型 ggb_check、ggb_build 均 accepted，两次参数流均为合法 JSON，wire/SDK SHA-256 完全一致。
  真实 GeoGebra 完成构造、核验及重载，可信回执接受，PWA applet 5.4.929.3 加载 O 与 c。
  下载 4383 字节，SHA-256 `83265214081f146aa0b092f7340e7fdf261b8452087bcaf3990121af7d7e999d`，
  与卡片和服务端元数据一致。截图已检查；回执及 cleanup.confirmed 也由验收工具核对。
  证据：`output/playwright/installed-plugin-e-real-provider-circle-stream/evidence.json`、`stream-comparison.json`、
  `round-1.ggb`、`round-1.png` 及 `runs/*/diagnostics/*.stream.json`。
  日志：`output/installed-plugin-e/stream-final-worker-tests.log`、`stream-final-types.log`、`stream-quality.log`、`real-provider-stream-pwa.log`。
  真实诊断文件权限 0600，逐文件检查未包含当前 Provider Key。
  本次未复现 MALFORMED_RESPONSE；新证据证明本次 SDK 没有破坏参数，不能据此证明首次失败必然来自模型。
  首次原始参数流已无法恢复，因此 PC-06 历史归因仍待确认；修复的是诊断缺口，而非未经证实的 SDK 算法错误。
  未部署生产、未提交代码，隔离浏览器、SDK 与本机 API/Worker 已关闭。


- 真实 Provider 单次复测已执行，结论为失败，不能认定 PWA 真实模型链已通过：
  使用当前固定插件包 `f0d87b1e719b6aac057b823476ed8aeab71163d31595268ec2db3f6727b15447`，
  在新的隔离 API/Worker/PWA 中只发送一个 draw a circle 任务。
  run 为 `run_c11969fb-3f63-4e32-9d34-0f886f08bf89`。SDK 观察到一个 request/header、一个 assistant/attempt，
  随后返回 `MALFORMED_RESPONSE: DeepSeek Messages stream: tool input is invalid JSON`；网关工具调用 0 次，
  未执行构建、未交付 GGB。Harness 已关闭，隔离服务及浏览器均已停止，没有自动发起第二个付费任务。
  这是在 SDK 的 Provider 工具 JSON 解析边界失败，与上一轮非法 step/command 字段的领域拒绝不同。
  当前证据没有原始参数流，不能断言模型生成错误或 SDK 拼接错误，PC-06 保留待定位。
  证据：`output/playwright/installed-plugin-e-real-provider-circle/failure.json`、其 `runs/*/diagnostics/*.json`，
  以及 `output/installed-plugin-e/real-provider-pwa.log`。
  真实 PWA 验收工具补充完成回执、下载完整摘要及实际画布对象核对，失败时自动保存结果与截图。
  新增失败保存逻辑未再次调用 Provider；只做语法与 lint 检查。未部署生产，未提交代码。


- 本机真实任务 `run_6e780e57-709c-4435-a3ce-e541a32418f0` 的参数契约缺口修复：
  诊断记录三次 ggb_check 分别因 step、program 非数组、command 等非法字段拒绝，未调用 ggb_build，
  因而正确拒绝无回执交付；不是 GGB 文件丢失或浏览器加载故障。
  插件原模型参数只公开泛 request 对象，Skill 没有可执行字段示例。现由插件发布嵌套的 program/native、
  requirements/checks、styles、edits、updates 和 interactions 结构；禁止模型指定宿主路径。
  Skill 补充字段规则及经真实解析器检查的画圆示例。没有加入参数猜测修补、自动重放或交付门槛降级。
  新开发包 SHA-256 为 `f0d87b1e719b6aac057b823476ed8aeab71163d31595268ec2db3f6727b15447`，
  Skill SHA-256 为 `46093ace89896e6deab0750fabe50a219e27e8c60f0070083e9fc01edd9d9c37`。
  已更新 vendor、文件摘要、runtime 兼容配置并完整供应到新的默认摘要根；旧安装保留供在途任务使用。
  doctor 通过；插件 19 项离线测试通过；真实隔离 SDK 不仅检查三工具，还断言模型工具列表中的 native 必需字段和 subjects。
  SDK 初始化 Provider 请求 0、网络尝试 0；Worker 68 项测试通过（真实 runtime 的 3 项在普通回归中跳过）。
  另以 mock Harness 执行新发布的画圆示例，真实 GeoGebra 构建与可信交付 1 项通过。
  证据在 `output/installed-plugin-e/model-contract-*.log`、`model-contract-sdk/result.json` 和 `model-contract-circle/`。
  本次没有重放付费任务，没有真实 Provider 复测。已运行的开发 Server 须重启后加载新组合；前端无需为本次插件修复重建。


- 批次 E 的 PWA 全链验收（mock Harness + 真实 GeoGebra）：新增显式授权入口
  `tools/plugin-core-pwa-mock.mjs`，使用构建后的真实 PWA、Service Worker、HTTP/SSE、默认 Worker 装配、
  安装包 executor 和独立 SQLite；不直接调用 API Service 代替浏览器动作，也不实例化真实模型 Harness。
  真实浏览器依次保存假 Key、创建会话、通过发送按钮创建首个任务。运行中刷新页面，断开并恢复 SSE；
  同一 run 从 `after=0` 恢复为 `after=2`，服务端记录一次 sse_reconnects，刷新期间 Harness 调用仍为 1，
  没有第二次 POST create。该场景是页面刷新恢复，不声称静默断流后会自动重试。
  验收发现 ready 快照覆盖的持久事件游标未保存到本地 binding，已补齐恢复点保存并加入定向回归。
  ready 仍是非持久快照，没有产生新事件 ID；保存的是其覆盖的持久事件高水位。
  首轮交付在 Client applet 5.4.929.3 加载为 P；通过真实 applet 坐标 API 模拟画布编辑，将 P 改为 (2,3)。
  第二轮从页面提交续做，POST 携带当前画布基线；其 SHA-256 与回执 binding.baseSha256 一致，且不同于首轮原始交付。
  第二轮真实 GeoGebra 生成 Q，PWA 加载 P、Q 并保留 P=(2,3)，证明使用的是修改后的当前画布。
  两轮下载分别为 4212、4222 字节，SHA-256 与 HTTP 元数据、交付卡片一致；回执绑定正确，cleanup.confirmed=true。
  共两次任务创建、两次 mock Harness 调用。Service Worker 实际控制页面，pageErrors 与外部浏览器请求均为 0。
  成功证据：`output/playwright/installed-plugin-e-pwa/run-6p6xmG/result.json`、`round-1.ggb`、`round-2.ggb`、
  `round-1.png`、`round-2.png`。截图已检查，画布显示 P=(2,3)、Q=(1,1) 及第二轮交付卡片。
  初次因恢复游标未持久化而超时的证据保留在另一目录，未用作成功证据。
  Client 7 个文件、34 项测试通过；TypeScript、Vue 类型与 PWA bundle、工具 lint、质量检查通过。
  日志：`output/installed-plugin-e/pwa-acceptance.log`、`pwa-client-tests.log`、`pwa-bundle.log`、`pwa-final-types.log`、`pwa-quality.log`。
  Provider 请求 0；未部署生产，未提交代码。复杂题、网络静默断流自动恢复、交付加载失败分支、
  Worker 崩溃部署回收及真实模型仍不属于这次成功结论。


- 安装式插件批次 E 的开发环境验收（本次授权范围）：固定 0.8.3 TGZ 与包摘要保持不变。
  官方 HTTPS 归档连接超时后，从同一官方 HTTP 地址下载 GeoGebra 归档；安装前实际计算 SHA-256，
  与固定 `c139f3edb51c004ec67d83226a1f1215486f8559ad98ee37e9e775aac278e96e` 完全一致。
  离线安装依赖、解压完整 runtime，使用 Playwright 1.64.1 缓存 Chromium 1248（浏览器 156.0.8078.4）。
  doctor 的代数、CAS、GGB 导出和重载均通过。修复供应器及两个浏览器工具对 Playwright CommonJS 默认导出的读取。
  已将完整安装切入开发默认 `.plugin-core-runtime/<包摘要>`，原依赖安装保留在 `<包摘要>-dependencies-only`。
  新 opt-in `plugin-core-real-runtime.test.ts` 使用真实资源准入、默认 Worker 装配、协议 2、channel 4 和 SQLite，
  仅注入 mock Harness。真实新建、基线显示修改、基线续构及取消后新建均完成构造、核验和重载。
  API Service 接收原始回执，SQLite 原子提交 receipt-v1、GGB、报告、manifest、预览；产物读取字节逐项核对大小及 SHA-256。
  输入基线字节不变。最终正式验收命令的 2 项测试通过，取消事件唯一且携带 confirmed=true。
  最后一次取消观察到执行器、Chromium 主进程、renderer/GPU/utility 等 9 个进程，取消结算时存活数为 0；
  未交付取消结果，同一 Worker 随后成功构建，证明正常取消后可复用槽位。未以调用 kill/close 代替退出观察。
  常规回归 51 个 Vitest 文件、447 项测试及 10 项 Node 检查通过；3 项显式跳过为真实 runtime 的 2 项和临时 PG 迁移的 1 项。
  本次没有重跑 PostgreSQL；批次 D 的 PG 证据仍只属于 D。Worker/API 类型、工具 lint、质量与文档链接检查通过。
  证据在 `output/installed-plugin-e/`：`provision.log`、`runtime-final.log`、`verification-final/`、
  `verification-final/cancel-processes.json`、`regression-tests.log`、`typecheck.log`、`lint.log`、`quality.log`。
  首次测试因夹具缺少必要 requirement 被结构拒绝，旧证据未用于本次成功认定；成功验收使用新的输出目录。
  Provider 请求为 0（仅 mock Harness），未运行真实模型，也未验收真实 DSH 模型任务、PWA HTTP/UI 全链（已由上述后续验收补齐）、
  复杂题覆盖、Worker 崩溃部署回收、生产镜像或目标数据库；这些范围仍由 IP-C/IP-E 与部署条目维护。


- 安装式插件批次 D：开发默认装配改为已安装插件，SDK 0.2.1-rc.2、Cordis 4.0.5、group 1.0.5、
  pi-ai 1.3.0 与统一 workspace lock 固定。供应锁同时固定插件 0.8.3、Playwright 1.64.1、
  GeoGebra 5.4.932.1、Worker Skill 摘要、工具协议 2、回执 1 和内部通道 4。
  发行包来自本地修改源码，标记 development-build/sourceDirty，不宣称已发布。
  SHA-256：`49d13b82ad40394b039c87de667302c8b7767fa8a8d3377d9b80fb207ff3776a`。
  Worker 在导入前校验文件摘要和完整组合；默认使用包摘要目录，不回退到源码 checkout 或桌面缓存。
  删除宿主重复工具包、旧 profile、Prompt loader、专属包装器、旧协议和独立 SDK 验证依赖锁。
  新 API/Store run 固定 receipt-v1；不能通过无回执结果或固定目录认定完成。
  实际插件 CLI 的拒绝保留结构化 issues；非零退出不能由成功 JSON 覆盖。
  默认 API→channel 4→Worker→安装包工具客户端的离线集成只替换 SDK 与资源准备检查。
  临时 PostgreSQL 验证 017→018、缺迁移拒绝、重复应用无操作、历史 legacy 行保留及新行 receipt-v1；
  Memory、SQLite、PostgreSQL 原子提交契约和旧通道 1、3 拒绝均通过。
  宿主 52 个 Vitest 文件、457 项测试通过，另有 10 项 Node 检查通过；插件 28 项离线测试通过。
  Worker/API/Client TypeScript、Client Vue 类型、共享 lint、质量、工具语法和文档链接检查通过。
  固定 TGZ 在两个真实隔离 SDK Server 中发现准确三工具、加载完整 Worker Skill，删除首个 home 后仍可加载；
  Provider 请求 0、网络尝试 0、浏览器启动 0。
  依赖从离线缓存安装，未运行 doctor、未准备本轮 GeoGebra runtime；不满足业务 Worker 资源准入。
  完整供应须使用新目标目录，成功后切换 GGB_PLUGIN_ROOT。临时 PostgreSQL 已停止并删除；没有修改目标数据库。
  证据在 `output/installed-plugin-d/`：`final-tests.log`、`plugin-tests.log`、`typecheck.log`、
  `worker-final-types.log`、`client-types.log`、`quality.log`、`lint.log`、`provision.log`、`sdk/result.json`。
  Docker/systemd 资产已同步，但未构建镜像、未部署生产、未运行真实 Provider、GeoGebra 或浏览器回归。


- 安装式插件批次 C 的离线实施：公开 executor 产生关联回执；宿主按 buildId 隔离输出、清空旧候选，
  检查原始报告/manifest、身份、字节数、摘要、路径与 runtime 后复制已核对字节。SDK 异常或无正常结束
  证据不能交付。API 保留原始字节与回执；run 创建时固定 deliveryContract，receipt-v1 不得降级。
  Memory、SQLite、PostgreSQL 共用完整性与清理守卫；SQLite 串行写入，PG 使用事务和 run 行锁。
  stop 与完成/失败并发只写一个终态，清理失败不转取消；活动记录和清理失败证据不被 TTL/删除提前移除。
  POSIX 受控进程树退出后才释放槽位，失败标记重启后仍隔离；API 关闭等待取消及断连结算后才关闭数据库。
  批次 C 当时仍用原 SDK、原 patch、协议 1 和 legacy；该状态已由批次 D 的开发切换取代。
  该批次开发树要求内部通道 4、迁移 018；未部署、未修改已有数据库，目标环境迁移仍需授权。
  Worker/API/Client TypeScript 与 Client Vue 类型检查通过。31 个受影响测试文件、209 项测试通过，
  包含三种 Store 的真实并发与临时本机 PostgreSQL；最后补强同一 run 重复占槽的拒绝证明后，Worker
  类型检查和 Service 的 10 项定向测试通过。插件公开协议、打包与纯依赖相关 41 项测试通过。
  最终 TGZ 在两个隔离 SDK home 中发现三工具、加载 Worker Skill 并关闭；Provider 请求 0、网络尝试 0、
  浏览器启动 0。精确包 SHA-256 为 `1fc1aa8582094448b51e0ef97508aafabb96f947721c84cedcc423b0b1beb9b8`。
  本轮证据：`output/installed-plugin-c/final-tests.log`、`service-final-tests.log`、`worker-final-types.log`、
  `typecheck.log`、`client-types.log`、`plugin-tests.log`、`final-sdk/result.json`（均相对本轮 output 目录）。
  回执成功用合成事实与字节，执行器的真实入口另测结构拒绝；真实 GeoGebra、真实浏览器子树、Worker
  崩溃后的部署回收、镜像发布与目标环境仍未验收。接口与复现见
  [可信交付与取消结算](../ggb-dsh/docs/dsh-sdk-compatibility.md#可信交付与取消结算)。

- 安装式插件批次 B：SDK 失败前事件和白名单异常在关闭前持久化；逐调用参数、issues、原始结果、
  退出状态和关联身份进入有界脱敏账本。SDK 错误终态不再作为空 turn 重试；持久化故障可观察。
  增加从安装包公开 schema 加载的协议 2 宿主适配；批次 B 当时未改变默认装配。
  Worker 类型检查通过；启用实际 TGZ 安装包后，11 个 Worker 测试文件、70 项测试通过，证据为
  `output/installed-plugin-b/worker-tests.log`。含真实 SDK Client + 测试 stdio 子进程退出、实际插件
  客户端到宿主 Unix socket、拒绝与脱敏、防重放、并发配额、存储失败等检查；未调用 Provider 或浏览器。
  接口、预算与复现见 [SDK 诊断与协议适配](../ggb-dsh/docs/dsh-sdk-compatibility.md#sdk-失败诊断与宿主协议适配)。
- 安装式插件批次 A：独立插件增加受限服务端入口、安装描述、纯协议解析与类型声明；固定 SDK
  `0.2.1-rc.2` 的独立验证锁（已在批次 D 合并到 workspace lock）。实际 TGZ 在两个隔离 SDK Server 中发现三工具并加载准确 Worker Skill，
  删除首个 home 后第二个仍可加载；无凭据、无模型任务、无网络尝试、无浏览器启动。实际运行版本和
  包摘要记录在忽略目录 `output/installed-plugin-a/evidence/result.json`。公开入口和复现方式见
  [SDK 兼容性](../ggb-dsh/docs/dsh-sdk-compatibility.md#安装式插件的隔离验证组合)。生产链未切换。
- plugin-core 默认引擎接入 API/Worker/PWA；独立 `plugin_core_*` store、SSE 与产物鉴权。
- PWA 三轮复跑：下载字节数/SHA-256 与交付卡片一致，续做基线正确。
- 5 个交付文件在 Client applet 5.4.929.3 加载通过。
- `ggb_inspect` 插件根缺陷修复（`--plugin`）与回归测试。
- Native 九阶段代码、包、测试、工具、文档、profiles/skills 删除。
- 旧 Native run 的拒绝式探针：创建 409 `engine_not_supported`；其他路径在 token 验证后
  409 `checkpoint_incompatible` 或 404；不读取 checkpoint、不创建表。
- 原切换批次仅要求 017；该批次开发树新增 018 和内部通道 4，尚未部署。迁移 001–016 保留为历史。
- Client `journal` IndexedDB store 删除，schema 升到 v2 并清理旧库。

## 3. 约束

- 真实 Provider/GeoGebra 调用必须在离线检查通过并获明确授权后执行；不得复用旧 `output/`
  或 SQLite 证据。
- 不提交 `.env`、Provider Key、数据库、运行日志或用户数据。
- 旧 Native 表/行只读保留；不得删除或做破坏性迁移。
- 部署与迁移需要目标机、备份和授权；离线检查不代表生产验收。
