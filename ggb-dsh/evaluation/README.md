# 评测资产

当前保留以下评测与离线验证资产：

| 文件 | 用途 |
| --- | --- |
| `plugin-core-minimal-v1.cases.json` | plugin-core 真实构图案例。`plugin-core-batch.mjs` 读取 prompt 并逐例请求本地 API；案例带出处与核验要点，不含 Key、runToken、画布 XML 或用户数据。 |
| `geometry-m0-v1.json` | 共享几何内核的 M0 覆盖集合；`tools/quality-check.mjs` 校验分类与断言结构。 |
| 安装式插件 SDK 检查 | 复用工作区 Worker 的 SDK 和统一 lockfile；入口为 `tools/verify-installed-plugin-sdk.mjs`。运行与边界见 [SDK 兼容性](../docs/dsh-sdk-compatibility.md#安装式插件的隔离验证组合)。 |

## plugin-core 案例

运行前必须启动隔离的本地 API/Worker，并取得真实 Provider 调用授权：

```bash
cd ggb-dsh
node tools/plugin-core-integrated-batch.mjs --authorized --out ../output/plugin-core-batch
```

`plugin-core-batch.mjs` 直接请求 `POST /api/v3/plugin-core/runs?wait=1`，把交付 GGB/截图与有界
证据写入 `--out`。Key 只从进程环境 `DEEPSEEK_API_KEY` 读取，不进入产物。没有 `--authorized` 时
脚本拒绝运行。

续做提示词 `thenPrompt` 只记录在案例中，批处理不发送；需要验证续做时使用真实 PWA 流程。

## 历史

Native Q3、homework2、agent-loop 与 m1 资产已随 Native 引擎删除。历史证据通过 Git 历史或
`output/` 中的已忽略产物追溯，不恢复为当前评测依据。
