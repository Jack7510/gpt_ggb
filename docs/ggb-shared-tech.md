# GGB 共享内核技术设计

适用范围：`ggb-dsh/packages/` 中的浏览器安全共享领域包及其当前消费者。当前产品入口为
`ggb-dsh/`，唯一执行引擎为 plugin-core。plugin-core 的编排、模型循环与交付由
`ggb-plugins` 和 `apps/worker` 拥有；共享包只保留仍被当前代码引用的契约与纯函数。

## 1. 结论

共享包只拥有浏览器安全的契约和纯逻辑。DSH Harness 拥有模型与工具循环；plugin-core
拥有 `ggb_check`／`ggb_build`、真实 applet 执行与 GGB 交付。Shared 不拥有第二套 Agent loop、
阶段路由、Prompt、修复控制器或 run store。

共享包不能导入应用源码、Node 内置模块、Provider、DSH SDK 或凭据实现。

## 2. 背景与现状

所有包属于 `ggb-dsh/` 的单一 pnpm workspace。内部依赖使用 `workspace:*`；外部依赖由同一个
lockfile 固定。包导出指向本包的 `lib/`，消费者不跨包导入源码。Native 九阶段引擎及其专用包
已删除；不存在为旧应用保留的运行入口或兼容路径。

## 3. 当前包与职责

| 包 | 职责 | 当前消费者 |
| --- | --- | --- |
| `app-protocol` | Intake 内容契约与语料标识 | `knowledge` 的资料检索输入 |
| `geometry-contract` | 几何对象、计划、事务、验证程序与错误码 schema | `geometry-*` 包 |
| `geometry-geogebra` | GeoGebra adapter、命令编码、compiler、受控查询、canonical XML 与 renderer | Client 画布快照/恢复；`geometry-validation` |
| `geometry-validation` | 断言能力与静态校验 | `geometry-geogebra` |
| `knowledge` | 固定官方手册索引、命令检索、MathCard 与 release corpus | 可选的知识工具；不进入 plugin-core run 主路径 |

`packages/application` 与 `packages/run-persistence` 是 runtime 包，不属于 browser-safe shared
集合；它们的边界由 API/Worker/Client 的调用方决定。GeoGebra 三工具由安装式 `ggb-plugins-dsh` 插件提供。Worker 通过插件公开入口执行和校验。

## 4. 设计原则

- 几何 schema、compiler、validator 和 applet adapter 各有一个共享 owner。
- 应用负责身份、鉴权、模型调用、持久事实和副作用。
- 共享包保留独立职责和测试；TypeScript project references 统一构建依赖与消费者。
- 无当前生产者的 schema、控制器、测试和兼容读取一起删除。版本名和旧夹具不能作为保留理由。
- 生成数据只读；官方手册索引按命令或 signature 检索，不整表注入模型上下文。

## 5. 依赖方向

```text
app-protocol ──> knowledge
geometry-contract ──> geometry-validation ──> geometry-geogebra
       │                    │
       └────────────────────┴──> Client / optional tools

application ──> api / worker / client
run-persistence ──> api / worker
installed ggb-plugins-dsh ──> worker
```

箭头从能力提供方指向消费方。Shared 不反向依赖 API、Worker、Client、application 或
run-persistence。

## 6. 几何内核边界

- `geometry-contract` 拥有内容 schema；字段、版本和错误码以源码为准。
- `geometry-geogebra` 的 compiler 只接受通过 schema 的结构化计划；受控查询在隔离 applet 中
  执行，不接受任意脚本。Client 只用 renderer 的 canonical XML 摘要与 applet 端口。
- `geometry-validation` 做静态能力和断言校验；真实执行与核验由 plugin-core runner 负责。
- 二维 Cartesian 视图、由 runtime-versions.json 固定的 GeoGebra runtime 与同源分发要求不变。

## 7. 持久化与安全边界

- 浏览器 IndexedDB 保存 Session、消息、run binding、画布引用和密封 run token；OPFS 保存
  画布快照与 plugin 交付 GGB。Server 不保存这些浏览器本地数据。
- Server 的 plugin-core store 保存 run、事件、artifact 元数据与用量；不保存 Provider Key。
- Shared 包不得包含 Node built-ins、`process`、`Buffer`、文件系统、网络或凭据代码。
- 质量门禁拒绝 Shared 包中的应用/服务端反向依赖、跨包源码导入和无源码生成模块。

## 8. 测试与一致性门禁

- `pnpm exec vitest run packages/...` 运行包级测试；`pnpm run check:package <name>` 运行
  typecheck、lint、测试与质量检查。
- 公共包测试不能替代 Client/API/Worker 的调用方验证；最终全量检查覆盖两者。
- 修改共享包后先跑 `check:package`，再跑受影响消费者和 `pnpm run check`。
- 生成索引由 `tools/build-ggb-manual-index.mjs` 构建；不手工修改生成文件。

## 9. 版本与兼容性

- 跨时间读取和跨进程发布的 schema 使用明确的 `schemaVersion`／`protocolVersion`；
  同一 release 内一起发布、一起消费的类型不需要版本号。
- 新增版本时同时给出旧版本删除条件；本项目按可达性删除，不保留仅供旧夹具使用的读取路径。
- 详见 [协议版本规则](../ggb-dsh/docs/protocol-versioning.md)。

## 10. 修改流程

1. 确定包边界与当前消费者；搜索现有 schema、函数和测试。
2. 只改受影响包与调用方，同步更新测试和引用。
3. 先 `check:package`，再验证消费者；最后运行全量 `pnpm run check`。
4. 删除不再可达的旧 schema、测试和文档，不保留兼容分支。

架构决策见 [ADR-001](adr/001-shared-kernel-two-runtimes.md) 与
[ADR-002](adr/002-shared-workspace-packaging.md)。
