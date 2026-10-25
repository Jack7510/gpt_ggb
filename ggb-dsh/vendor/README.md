# 固定插件发行包

`ggb-plugins-dsh-0.8.4.tgz` 由插件仓库的 `node scripts/package-plugin.mjs --target=dsh <output>` 生成。
本包是尚未发布的本地 development-build，来源提交及 dirty 标记记录在 `plugin-core.lock.json`。
不能仅凭版本号认定它与上游同名版本一致。

供应锁固定 TGZ SHA-256、发行文件摘要、Worker Skill、SDK、Cordis、工具协议、执行器协议、回执、内部通道、
Playwright 和 GeoGebra。精确值与使用边界见 [兼容契约](../docs/dsh-sdk-compatibility.md)。
启动时先核对发行文件，再导入公开安装入口；不得直接替换安装目录中的代码。

归档包含编译 CLI、执行器、服务端入口、协议、Worker Skill、viewer、安装脚本及 source/ 构建输入快照。
供应锁逐文件固定源码快照；sourceSnapshotSha256 是按路径排序的源码摘要映射的 SHA-256。
source/dependencies.lock 是原始 pnpm-lock.yaml，重建源码前需恢复文件名。
归档不包含 node_modules、浏览器或 GeoGebra runtime。供应器在新的安装根准备这些资源，
完整模式运行 doctor；`--dependencies-only` 只供离线协议验证。

在本目录验证归档：

```bash
shasum -a 256 -c ggb-plugins-dsh-0.8.4.tgz.sha256
```
