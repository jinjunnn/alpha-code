# 卸载 alpha-code 与数据残留清单(C16)

> 单一真源声明:本清单与 app 内「数据 ▸ 清除数据…」的清除引擎同源
> (`packages/ui-mac/src/main/data-clear.ts` 的 manifest/planClear)。改引擎清单必须同步本文档。
> 最后更新:2026-07-19(#428)。

拖 app 进废纸篓**只删除应用本体**,不清除任何数据(macOS 无标准卸载 hook)。完整卸载 = 两步:

1. **先在 app 内清除数据**:菜单 **数据 ▸ 清除数据… ▸ 全部数据(为卸载做准备)**。
   会依次:提示先导出会话数据库 → 列出将删内容与体积、红色终确认(引擎数据共享面单独勾选)→
   停止内嵌引擎 → 删除 → 退出应用。逐项结果留痕 main.log(`[c16-data-clear]`,日志目录最后删)。
2. **再把 alpha-code.app 拖进废纸篓**。

## 残留路径清单(app 内清除各级覆盖范围)

### 「仅凭证」级(登出并删除密钥;会话数据保留)

| 路径 | 内容 |
|---|---|
| `~/Library/Application Support/alpha-code/alpha-auth.json` | 平台登录 token(safeStorage 加密) |
| `~/Library/Application Support/alpha-code/alpha-pkce.json` | 登录握手临时凭证(短命) |
| `~/Library/Application Support/alpha-code/alpha-byok-keys.json` | BYOK 密钥库(safeStorage 加密) |
| `~/Library/Application Support/alpha-code/alpha-secrets/` | 密钥文件通道(A6 {file:},0600) |
| `~/Library/Application Support/alpha-code/alpha-mcp-secrets/` | 连接器(MCP)密钥({file:} 通道) |
| `~/Library/Application Support/alpha-code/alpha.env` | 手写密钥 env 文件 |
| `~/.local/share/opencode/auth.json`(或 `$XDG_DATA_HOME/opencode/auth.json`) | 引擎凭证存储 —— **与独立安装的 opencode CLI 共享**,删除后 CLI 侧需重新登录 |

### 「全部数据」级(为卸载做准备;含上表全部)

| 路径 | 内容 | 备注 |
|---|---|---|
| `~/Library/Application Support/alpha-code/` 整目录 | 设置(opencode.settings)、日志(logs/)、DB 备份(alpha-db-backups/)、端点/模型缓存、远程 catalog 缓存等 | 全删 |
| `~/Library/Application Support/alpha-code-state/env/<当前环境>/` | 当前 dev/prod/beta 环境的安装物(installs.json 账本、skills/agents/plugins)、自动化任务与状态 | 只删当前 frozen 环境 root；不会删另外两个环境或共享 CAS |
| `~/.opencode/` 内 **alpha 自有 symlink** | 指向当前环境 root 的历史桥接链(kind 级整目录链 + 条目级链) | **只摘链**;你自建的真实文件/目录、指向别处的链一律不碰 |
| `~/.local/share/opencode/`(或 `$XDG_DATA_HOME/opencode/`) | 会话数据库(opencode.db 及 -wal/-shm)、项目元数据、快照、引擎凭证 | **与独立安装的 opencode CLI 共享** —— 终确认对话框单独勾选;单独使用 opencode 的用户请勿勾选 |

### 清除**不会**触碰的内容(如需清理须手动)

| 路径 | 说明 |
|---|---|
| 你的项目文件、各项目内 `.alpha/` 目录 | ADR-019 §4:项目级产物属用户项目(云任务 run 记录、项目偏好);清理=进各项目手删 `.alpha/` |
| `~/Library/Application Support/alpha-code-state/cas/` | dev/prod/beta 共享的可重建 CAS，由 GC 管理；app 内 data-clear 不删除，避免跨环境误删。彻底卸载全部 channel 后可手动删除整个 `alpha-code-state/` |
| `~/Library/Application Support/alpha-code-state/env/<其它环境>/` | 其它 channel 的 mutable root；必须从对应 channel 清除，或在全部 channel 均卸载后手动删除共享 base |
| `~/.alpha/` | 已退休旧根；当前版本零读取、零迁移、零 dual-read，也不会替用户删除其中历史内容 |
| `~/.opencode/opencode.jsonc` | 引擎共享配置。经定制中心装过连接器/插件的,**建议卸载前先在定制中心逐项卸载**(会净除对应条目);历史悬空引用需手动删除对应 `mcp.*` / `plugin[]` 条目 |
| `~/.opencode/` 内你自建的 skill/agent/command 等 | 用户内容红线,永不代删 |
| 钥匙串 safeStorage 密钥项 | macOS 管理的加密密钥(Electron safeStorage),无 API 可代删。加密文件删除后该项已无泄密面;要彻底清可打开「钥匙串访问」搜索 `alpha-code` 手动删除 |
| `/Applications/alpha-code.app` | 应用本体,拖废纸篓 |

## 复核(验收③:清除后残留归零)

「全部数据」清除(勾选引擎数据)+ 删除 app 本体后:

```bash
du -sh ~/Library/Application\ Support/alpha-code ~/.local/share/opencode 2>/dev/null
# 期望:上面两项 No such file or directory
du -sh ~/Library/Application\ Support/alpha-code-state 2>/dev/null
# 可能仍存在:共享 CAS 或其它 channel 的环境根；只有全部 channel 均卸载后才手动删除整个 base
ls -la ~/.opencode 2>/dev/null   # 只应剩你自建的内容与 opencode.jsonc(见上表)
```

保留项(设计内不归零):各项目 `.alpha/`、退休根 `~/.alpha` 的历史内容、`~/.opencode`
用户自建内容与 opencode.jsonc、钥匙串项。共享 `alpha-code-state/cas` 和其它环境根仅在所有
channel 均卸载后手动整 base 清理。
