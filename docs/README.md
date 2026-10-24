# 文档导航

本文维护专题资料的阅读顺序、入口与归属，不维护项目结构、技术栈或架构说明。
这些项目说明统一见 [根 README](../README.md)。Agent 工作契约见 [AGENTS.md](../AGENTS.md)。

建议先读根 README，按需查看工作区运行说明，再读任务相关专题。修改部署、内部包或协议时，
只读取对应章节；当前任务与验收进展从 Backlog 查询。

## 阅读入口与文档归属

| 目的 | 入口与职责 |
| --- | --- |
| 理解项目与首次运行 | [根 README](../README.md)：项目概览、结构、技术栈、架构概览与快速开始 |
| Agent 如何执行开发任务 | [AGENTS.md](../AGENTS.md)：工作流程、代码质量、验证、Git、安全与交付规则 |
| 工作区运行与排障 | [工作区 README](../ggb-dsh/README.md)：增量构建、启动配置、检查、环境变量与调试 |
| 插件源码改动的手工验证 | [插件源码手工验证](ggb-dsh-plugin-manual-verification.md)：构建插件、覆盖固定安装、启动 API/Worker 与 Vite、检查锁恢复和 GGB |
| 设计取舍与精确契约 | [plugin-core 采用方案](ggb-dsh-plugin-core-adoption.md)：目标设计、取舍和已冻结决策；不记录逐次运行结果 |
| 演进回顾与开发分享 | [从一个问题到 Agent 交付](ggb-agent-evolution-timeline.md)：Pipeline、plugin-core、标准 DSH 插件的演进，以及问题实验、插件开发、Agent 验证与用户交付的方法；区分历史事实和拟议方案 |
| 方法分享与案例讲述 | [从一个问题到插件与 Agent](question-plugin-agent.md)：结合多次会话的开发过程、真实故障、分层验证、讲述提纲与教学示例 |
| 安装式插件解耦设计 | [安装式 DSH 插件设计](ggb-dsh-installed-plugin-design.md)：目标职责、协议、代码迁移、实施顺序与验收条件；实施状态见 Backlog |
| release 与换机交接 | [切换交接](ggb-dsh-plugin-core-cutover-handoff.md)：当前引擎、已验证范围、风险、旧 run 处理与换机步骤 |
| 当前工作与缺陷 | [统一 Backlog](ggb-dsh-backlog.md)：工作项、根因、优先级、依赖和退出条件；实施、离线验证与真实验收分列 |
| 部署与运维 | [部署指南](deploy-dsh.md)：生产配置、迁移、Edge、验收、运维与回滚；不记录真实主机地址或密钥 |
| 评测 | [evaluation](../ggb-dsh/evaluation/README.md)：plugin-core 案例与运行边界 |
| 凭据与协议 | [凭据威胁模型](../ggb-dsh/docs/credential-threat-model.md)、[协议版本规则](../ggb-dsh/docs/protocol-versioning.md) |
| runtime 分发与兼容性 | [GeoGebra 分发审查](../ggb-dsh/docs/geogebra-distribution-review.md)、[兼容矩阵](../ggb-dsh/docs/compatibility-matrix.md)、[DSH SDK 兼容性](../ggb-dsh/docs/dsh-sdk-compatibility.md) |

## 目录边界

- 根 `docs/` 维护跨组件、release、部署、Backlog 和跨仓库验收。
- `ggb-dsh/docs/` 维护与 workspace 代码、runtime 和协议强绑定的契约。
- 两处目录不物理合并。根导航负责统一入口，各专题只维护自己的正文。
- 新增跨 `ggb-plugins` 与 `ggb-dsh` 的验证流程时，文档放在根 `docs/`；新增只属于 `ggb-dsh` 的协议或 runtime 契约时，文档放在 `ggb-dsh/docs/`。

## 维护规则

同一需求、契约或状态只在归属文件维护；其他文档引用，不复制正文。项目结构、技术栈与架构概览
只在根 README 更新，本导航和工作区 README 通过链接引用。专题中的精确设计仍由对应专题维护。
历史批次记录中的协议版本必须标明“当时”或“历史”；当前版本只以[协议版本规则](../ggb-dsh/docs/protocol-versioning.md)为准。

Backlog 是进度事实的唯一入口，采用方案、交接文档及各 README 不维护第二份进度表。
历史证据通过 Git 历史或 `output/` 中的已忽略产物追溯，不恢复为当前契约。
