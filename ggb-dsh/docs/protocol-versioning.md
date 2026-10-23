# GGB 协议版本与标识规则

状态：Active

## 摘要

持久化 JSON 和跨进程消息使用数字型 `schemaVersion` 或 `protocolVersion`。接收端只接受自己明确支持的
版本；未知版本立即失败，不做猜测性降级。

## 版本规则

**何时需要版本号**：只有跨两类边界的契约才需要版本号。

1. **跨时间读取**：写入持久化、以后由另一个 release 读回的格式（run 事件、交付 artifact、数据库列）。
2. **跨进程发布**：两侧可以独立升级的线上边界（`API↔Worker` channel、`Client↔API`）。

同一 release 内一起发布、一起消费的类型不需要版本号，也不需要旧版本接受分支。

**何时删除版本**：新增版本时同时给出旧版本的删除条件与负责工作项。只递增不删除会使版本号失去含义。

本项目是 prototype，删除条件按**可达性**判定：

- 当前 release 没有代码能产生它要读的东西就删，包括读取路径。
- 不得用测试夹具当保留理由；旧测试随旧设计一起删。
- 删除时一次删到底：接受入口、读取器、只能由旧输入进入的下游路径和旧断言。
- 版本号不是删除依据；先确认 schema 是当前契约、外部协议还是纯 envelope。

## 当前版本

| 边界 | 版本 | 说明 |
| --- | --- | --- |
| 几何领域 JSON | `schemaVersion: 1` | 几何对象、计划、验证程序与错误码 |
| Client ↔ API plugin-core run | `schemaVersion: 1` | HTTP body、run view、SSE 事件 |
| API ↔ Worker channel | `protocolVersion: 8` | 独立 run 连接与统一字节上限；有界 SDK 模型步号与工具进度帧不结束结果等待；固定交付契约；结果携带清理确认及可选可信回执；cancel ack 仅表示请求已接收 |
| DSH 工具 ↔ Worker | `protocolVersion: 3` | 解析、认证和工具客户端由安装包公开 schemas 提供；分段草稿与已检查版本引用；不接受协议 1/2 |
| 插件 executor / 构建回执 | envelope `3` / receipt schema `2` | check/inspect/build 统一公开响应；绑定操作、上下文摘要、包身份及执行阶段；桌面 CLI 保持 envelope 1 |
| plugin-core store | `017_plugin_core.sql` + `018_plugin_core_delivery_contract.sql` | 表、事件游标与每 run 固定的交付契约 |
| 浏览器本地会话 | IndexedDB schema v2 | 删除 Native `journal` store |

- `plugin_core.ready` 是 SSE 首帧快照，不是持久事件；其 cursor 指向快照已覆盖的持久事件高水位。
  Client 保存该值作为恢复点，不为 ready 生成新事件 ID；`after` 始终引用持久事件。
- API/Worker 必须使用同一 channel 版本；当前只接受 v8；v1、v3、v4、v5、v6、v7 握手和剩余 Native 报文在 handler 之前拒绝。
- 增加可选字段且旧接收端可安全忽略时可以保留版本；删除字段、改变含义、收紧合法值或改变安全语义时
  必须增加版本。
- Socket 握手遇到未知版本时返回错误并关闭连接，不发送执行请求。

## 标识规则

应用生成的标识使用固定前缀加 UUID v4：`run_`、`canvas_`、`obj_` 等。显示标签不作为对象标识。
TypeScript 使用 branded type 区分不同标识；JSON 接收端先用所属 Zod schema 验证字符串。

## 兼容性

当前只提供 plugin-core 的当前版本，不保留 Native checkpoint、v2 channel 或旧 store 的兼容读取。
旧 Native run 的数据库行保留为证据，但只通过拒绝式探针访问：合法 token 得到
`409 checkpoint_incompatible`，其余得到 `404`，不读取 checkpoint。

## Dev Note

几何计划、事务和观察结果的完整字段以 `packages/geometry-contract/src` 的当前 schema 为准；
不要从历史文档或旧夹具推定字段。

版本 8 不接受版本 7 及更早握手；握手应答也必须声明版本 8。API 停止后继续等待最终结果；未取得清理确认时不得结算 cancelled。
`deliveryContract=receipt-v1` 在创建 run 时持久化，缺回执或与 Worker 契约不匹配时失败，不回退到 legacy。

回执 2 用报告字节摘要/长度和简短摘要替换完整报告；新完成提交不接受回执 1。
