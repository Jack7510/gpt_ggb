# 浏览器 BYOK 凭据威胁模型

## 结论

DeepSeek Provider Key 由用户在浏览器中保存，使用 Web Crypto AES-GCM 和非导出包装密钥加密后写入
同源 IndexedDB 的 `secrets` store。Server 不保存 Key；Worker 只在一次 plugin-core run 期间在内存中
持有它。该设计降低明文配置、普通日志、数据库、Session 导出和误备份泄露的风险，但不把同源 XSS、
恶意浏览器扩展或已攻陷的浏览器 profile 当作可防御边界。

## 资产与信任边界

- 受保护资产是 DeepSeek Provider Key。
- 浏览器 Vault：
  - 包装密钥为 `AES-GCM 256`、`extractable: false`，与密文一起保存在同源 IndexedDB。
  - 密文格式为 `v1.<base64url(iv || ciphertext)>`；加密时使用 12 字节随机 IV。
  - `ByokController` 只在页面内存中持有解密后的 Key；可随时 Forget。
- 传输：每次 run 通过 `X-GGB-Provider-Key` 请求头发送；不进入 URL、查询参数、SSE、日志或数据库。
- Worker：Key 只存在于本次 plugin-core run 的进程内；run 结束、取消或失败后释放。Provider 地址
  由服务端固定，客户端不能覆盖。
- Server 不保存用户账户、浏览器 Session、画布快照或 Provider Key；数据库只保存 run 的题目、
  交付事实和用量。

## 能防御与不能防御的场景

| 场景 | 结论 | 控制 |
| --- | --- | --- |
| IndexedDB 被单独复制 | 防御密文可读、明文不可读 | AES-GCM；包装密钥不可导出但仍在同一 profile |
| 日志、SQLite、SSE 或 `.ggb` 导出被复制 | 防御 | Key 不进入这些通道 |
| 密文或 Vault 记录被篡改 | 失败关闭 | GCM 认证；格式/版本检查 |
| 浏览器崩溃或刷新 | Key 仍可恢复 | 加密 Vault；用户可 Forget |
| 同源 XSS、恶意扩展、已攻陷浏览器 profile | 不防御 | 可读取解密后的页面内存或调用 Web Crypto |
| Server 进程内存被读取（run 期间） | 部分防御 | Key 只在 run 期间存在；不落盘、不进日志 |
| 整机或用户目录失窃 | 不单独防御 | 依赖 FileVault/BitLocker/LUKS 等整盘加密 |
| 共享电脑上的其他浏览器用户 | 部分防御 | 同源 IndexedDB 按 profile 隔离；建议使用独立 profile |

## 验收与升级条件

自动化测试覆盖密文不含明文、错误版本/损坏密文失败、Forget 清除记录，以及 run 请求头不进入
日志/数据库。若产品改为多用户、服务端代持 Key、远程 vault 或声称可抵御同源 XSS，本结论失效，
必须重新做威胁建模并采用系统密钥环或外部 credential broker。
