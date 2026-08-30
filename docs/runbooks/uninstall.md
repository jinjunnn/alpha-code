# 卸载 alpha-code 与数据残留清单(C16)

> 单一真源声明:本清单与 app 内「数据 ▸ 清除数据…」的清除引擎同源
> (`packages/ui-mac/src/main/data-clear.ts` 的 manifest/planClear)。改引擎清单必须同步本文档。
> 最后更新:2026-07-31(#752)。

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
| `~/.local/share/opencode/mcp-auth.json`(或 `$XDG_DATA_HOME/opencode/mcp-auth.json`) | MCP 服务登录令牌(OAuth access/refresh token 与客户端注册)—— **与独立安装的 opencode CLI 共享**,删除后需重新授权各连接器 |

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
| 你的项目文件、各项目内 `.code-puppy/` 目录 | ADR-019 §4:项目级产物属用户项目(云任务 run 记录、项目偏好);清理=进各项目手删 `.code-puppy/` |
| `~/Library/Application Support/alpha-code-state/cas/` | dev/prod/beta 共享的可重建 CAS，由 GC 管理；app 内 data-clear 不删除，避免跨环境误删。彻底卸载全部 channel 后可手动删除整个 `alpha-code-state/` |
| `~/Library/Application Support/alpha-code-state/env/<其它环境>/` | 其它 channel 的 mutable root；必须从对应 channel 清除，或在全部 channel 均卸载后手动删除共享 base |
| `~/.alpha/` | 已退休旧根；当前版本零读取、零迁移、零 dual-read，也不会替用户删除其中历史内容 |
| `~/.opencode/opencode.jsonc` | 引擎共享配置。经定制中心装过连接器/插件的,**建议卸载前先在定制中心逐项卸载**(会净除对应条目);~~历史悬空引用需手动删除对应 `mcp.*` / `plugin[]` 条目~~ —— 见下方「悬空引用:什么自动、什么必须手动」订正块 |
| `~/.opencode/` 内你自建的 skill/agent/command 等 | 用户内容红线,永不代删 |
| 钥匙串 safeStorage 密钥项 | macOS 管理的加密密钥(Electron safeStorage),无 API 可代删。加密文件删除后该项已无泄密面;要彻底清可打开「钥匙串访问」搜索 `alpha-code` 手动删除 |
| `/Applications/alpha-code.app` | 应用本体,拖废纸篓 |

### 悬空引用:什么自动、什么必须手动

> **订正(2026-08-14,REQ-053 `#966`)**:上表原来那句「历史悬空引用需手动删除对应 `mcp.*` / `plugin[]` 条目」
> 写于产品还不会自动剥离的时候,今天**过宽**。但也**不能简单改成「无需手动」** —— 产品是按**两条轴**分流的
> (`engine-config-dangling.ts:188-242`),只看其中一条会在最需要这段文字的那个状态下给出错误指引。

**自动剥离(无需手动)** —— 必须**同时**满足两条:

1. **引用目标**解析后落在四个守卫根内:`~/Library/Application Support/alpha-code/`(userData)、
   当前环境 root(`alpha-code-state/env/<环境>/`)、引擎数据目录(`~/.local/share/opencode/` 或 `$XDG_DATA_HOME/opencode/`)、
   退休根 `~/.alpha/`;**且**
2. **该引用所在的配置文件**是 alpha 拥有的:`<当前环境 root>/alpha.jsonc`(恒),
   或 legacy `~/.opencode/opencode.jsonc` **且**该文件的顶层键全部 ∈ `$schema` / `mcp` / `plugin` / `agent` / `permission` / `command` / `provider`。

满足这两条的悬空 `mcp.<名>.environment/headers` 的 `{file:}` 值与 `plugin[]` 绝对路径条目,会在
**清除凭证 / 清除全部数据 / 每次开机 / 每次引擎重启**四个时机自动剥掉(只删那一个叶键或那一个数组元素,
连接器条目本身、注释、npm 包名 plugin 条目一律保留)。

**产品不代改(必须手动)** —— 下面四种情形产品**一个字节都不写**。其中前三种还会让开机
**直接拒绝启动**(弹「扩展安全状态无法确保」并退出;这是有意的 fail-closed:宁可不启动,也不进死循环。
唯一的例外是「XDG 用户配置**读不出**」—— 那一种只记警告,不拒启):

| 情形 | 为什么 | 你要做什么 |
|---|---|---|
| 引用写在 XDG 用户配置(`~/.config/opencode/opencode.jsonc` 或 `$XDG_CONFIG_HOME/opencode/*`)里 | 用户外来配置恒为只读,哪怕引用目标就在守卫根里也永不代改 | 手动删掉该 `mcp.*` / `plugin[]` 条目 |
| 引用写在 `~/.opencode/opencode.jsonc`,但该文件含 `theme` / `model` / `keybinds` / `share` 等**上面白名单之外的顶层键** | 判定为用户手写混入 ⇒ 整份文件所有权 bail-out、零剥离。**单独装过 opencode CLI 的机器几乎必然落进这一格** | 手动删掉该条目(或先把非 alpha 顶层键挪走) |
| 配置文件读不出(权限/IO 错误)、或 JSONC 解析失败(半截文件、非法语法) | 以残基底重写会抹掉未解析出的内容,比留着悬空引用更危险 ⇒ 该文件本轮零写入 | 先修好该文件的权限/语法,再重启 |
| **引用目标**落在四个守卫根**之外**(例如 `~/dev/myplugin/index.js`) | 那是你自己的路径,产品无权判定它「该不该在」 | 目标确实不要了就手动删掉该条目 |

## 复核(验收③:清除后残留归零)

「全部数据」清除(勾选引擎数据)+ 删除 app 本体后:

```bash
du -sh ~/Library/Application\ Support/alpha-code ~/.local/share/opencode 2>/dev/null
# 期望:上面两项 No such file or directory
du -sh ~/Library/Application\ Support/alpha-code-state 2>/dev/null
# 可能仍存在:共享 CAS 或其它 channel 的环境根；只有全部 channel 均卸载后才手动删除整个 base
ls -la ~/.opencode 2>/dev/null   # 只应剩你自建的内容与 opencode.jsonc(见上表)
```

保留项(设计内不归零):各项目 `.code-puppy/`、退休根 `~/.alpha` 的历史内容、`~/.opencode`
用户自建内容与 opencode.jsonc、钥匙串项。共享 `alpha-code-state/cas` 和其它环境根仅在所有
channel 均卸载后手动整 base 清理。
