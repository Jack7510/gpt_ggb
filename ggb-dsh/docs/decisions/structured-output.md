# 决策：数学规划阶段不采用 SDK 结构化输出（已废止）

状态：Superseded

版本：1

> 2026-09-12：本文记录的 `MathPlanningPlanV1` 模型输出与解释器已经删除。当前 Plan action 输出
> revision-scoped `SemanticPlanPatchV2`，本地 apply/preflight 后才确定性投影为 Code/tool 的稳定执行载体。
> 格式与 schema 修复使用同一 base revision/digest，并关闭 reasoning。以下内容仅保留历史背景。

## 背景

数学规划阶段需要模型输出一个可被 `MathPlanningPlanV1` Zod schema 严格校验的 JSON 对象。自然的方向是让
模型在结构化输出（JSON mode / `response_format: json_schema`）下生成，从而免去桥接层的围栏代码块剥离、关系
别名归一化和局部 ID 水合，并减少 `math_plan_invalid` 的修复路径。

## 评估结论

在 `@deepseek-ai/dsh-sdk-client` `0.1.5-rc.2` 中，`GenerateOptions` 没有
`response_format`、JSON mode 或任意结构化输出字段；它只暴露 `provider`、`model`、`reasoningEffort`、
`messages`、`system`、`tools`、`temperature`、`maxTokens`、`stop`、`signal`、`sessionId`、`purpose`。
高层 `DeepSeekHarness.run()` 也不提供按请求的输出约束。因此当前 SDK 版本**无法**为普通 assistant 消息打开
严格 JSON 输出。

两个可选替代方案及其代价：

| 方案 | 可行性 | 代价 / 放弃 |
| --- | --- | --- |
| 保持 prompt-only JSON + 确定性归一化（当前） | 已实现 | 保留围栏剥离、别名归一化、局部 ID 水合，以及 `math_plan_invalid` 修复路径 |
| 把 MathPlanningPlan 建模为一次 tool call（像 codegen 那样） | SDK 支持 tool 参数 JSON schema | 改变 planner 语义：模型可能调用错误工具、多次调用，或把自然语言伪装成工具结果；需要额外的调用计数与恢复逻辑 |

## 决策

保持数学规划阶段为 prompt-only JSON，继续使用 `parsePlanningPlan` 的确定性归一化。codegen 阶段已经通过
`geometry_apply_plan` 工具的 JSON schema 参数获得结构化参数，因此只有数学规划这一阶段受此限制。

## 触发重审的条件

- 升级到提供 `response_format` / JSON mode / 结构化输出的 DSH SDK 版本；
- 或采用「planner 输出为 tool call」的第二阶段实验，并在固定评测集上证明其降低 `math_plan_invalid` 率、
  缩短修复路径，同时不增加无效工具调用。
