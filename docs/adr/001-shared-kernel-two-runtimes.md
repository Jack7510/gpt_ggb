# ADR-001：共享内核与应用 runtime 隔离

状态：Accepted。适用于当前 plugin-core 产品。
依据：[共享内核技术设计](../ggb-shared-tech.md)。

## Context

plugin-core 产品同时使用浏览器和 Server。两侧需要一致的几何契约与纯逻辑，
但不能共享凭据、Provider 调用、数据库或进程副作用。

## Decision

1. `ggb-dsh/packages/` 中的共享领域包拥有浏览器安全的契约、compiler、validator、Manual 证据物化、知识纯逻辑。
2. `ggb-dsh` 应用拥有 UI、Harness loop、工具权限、鉴权、持久化和 plugin-core run 生命周期。
3. Shared 不拥有第二套 Agent loop、阶段 registry、Prompt 或修复控制器。
4. 应用通过同一 workspace 内的包导出消费共享包。Shared 不能导入应用源码或 runtime SDK。
5. 无当前生产者的旧格式、控制器、测试和兼容读取一起删除。

## Consequences

共享能力由当前消费者证明用途。版本名和旧测试不能作为保留理由。
Shared 局部检查与消费者检查覆盖不同边界；统一全量检查不能替代真实产品验收。
workspace 契约见 [ADR-002](./002-shared-workspace-packaging.md)。
