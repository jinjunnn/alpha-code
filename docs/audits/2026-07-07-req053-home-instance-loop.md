# REQ-053 事故档 — C16 清除残留悬空引用 → 引擎 home 实例 bootstrap 死循环

> 2026-07-07,真机(prod 签名包 v0.1.0,`/Applications/alpha-code.app`)。
> 用户报障:「发了个板到处都是bug」+ 截图(侧栏「项目加载失败」、首页「项目列表加载失败 / 引擎连接异常或尚未就绪」)。
> 登记行:BACKLOG REQ-053;关联:C16(残留清除,已 archived,本项为其清除逻辑的补全缺陷)、C3(轮转失效证据)、B11(静默失败呈现)。

## 时间线

| 时刻(本地) | 事件 |
|---|---|
| 7-6 ~21:16 | C16 全部级清除误执行(REQ-050 已登记):删除登录凭证、`~/.alpha`(含 opencode-notify plugin.js)、userData `alpha-mcp-secrets/`、引擎会话库 |
| 7-6 21:31 | 事故后首次启动 app。**引擎自此进入死循环**(`opencode.20260707T012845.log` 首行 2026-07-06T13:31:01Z)。当晚「干净重启」核验只查了 shell-env 探测与 server ready,未看引擎日志尾部/CPU → 循环未被发现 |
| 7-6 夜 → 7-7 晨 | 循环烧一整夜:该日志 **21,138,015,296 字节(21GB)** |
| 7-7 09:28 | 用户晨间重启 app,循环立刻复现:新日志 1 小时 **17,067,135 行 / 1.8GB**;sidecar CPU 84.5%、renderer 83.0%、main 66.5% |
| 7-7 ~10:25 | 用户发截图报障。诊断:引擎 HTTP 存活(/api/health 401 正常),但日志尾部为纯三行循环 |
| 7-7 10:29 | **现场处置**:备份 `~/.opencode/opencode.jsonc`(`opencode.jsonc.alpha-bak-102952`)→ 删除两条悬空引用 → 重启 app |
| 7-7 10:31 | **恢复确认**:引擎日志全量 32 行、`creating instance` 恰 1 次、全进程 CPU <10%、技能扫描正常(init count=17) |

## 根因

C16「全部数据」清除删除了资产本体,但**没有清理引擎 config(`~/.opencode/opencode.jsonc`)里指向这些资产的引用**,留下两条悬空:

1. `plugin[0] = /Users/tide/.alpha/plugins/opencode-notify/plugin.js`(文件已删);
2. `mcp.dbhub.environment.DSN = {file:…/alpha-mcp-secrets/dbhub/DSN}`(密钥文件已删)。

引擎为 `/Users/tide`(home)创建 Instance 时加载该 config 失败 → 创建中断 → 调用侧立即重试,无退避 → 纯三行死循环(`fromDirectory → bootstrapping → creating instance`,10 万行采样中 100% 为该三行,~1600 次/秒)。

**移除两条引用后循环消失** = 根因实证(单变量)。

## 证据(样本)

```
timestamp=2026-07-07T01:36:20.177Z level=INFO run=5b36665a message=fromDirectory directory=/Users/tide
timestamp=2026-07-07T01:36:20.177Z level=INFO run=5b36665a message=bootstrapping directory=/Users/tide
timestamp=2026-07-07T01:36:20.178Z level=INFO run=5b36665a message="creating instance" directory=/Users/tide
(…同三行以 ~5,000 行/秒 重复;INFO 级,全程零 error/warn)
```

- 洪泛日志:`opencode.20260707T012845.log` 21GB(7-6 晚 → 7-7 晨)、`opencode.20260707T023034.log` 1.8GB(7-7 晨 1 小时)。**均已核样本后删除**(纯重复三行,共回收 ~23GB;当前 `opencode.log` 保留)。
- 修复前进程:sidecar utility 84.5% / renderer 83.0% / main 66.5% CPU。
- 修复后:日志 32 行;仅 7 条良性 `duplicate skill name` WARN(用户 `~/.claude/skills` 与 `~/.config/opencode/skills` 同名,上游行为);CPU 正常。

## 产品侧待修(REQ-053 范围)

1. **C16 清除补全**:删除资产时同步清理/修复 jsonc 内指向被删路径的引用(plugin 数组条目、`{file:}` env);或清除完成后跑一次 config 悬空引用校验并 loud 提示。残留引用 = 下次启动砖机。
2. **失败实例创建的守护与呈现**:循环本体在上游(instance 创建失败即时重试、无退避、INFO 级零报错——alpha 不改上游源码),alpha 侧评估:main 进程对引擎子进程 CPU/日志增速的看门狗 + B11 统一呈现(「引擎连接异常」应能区分「未就绪」与「反复崩溃」)。
3. **C3 轮转失效证据**:轮转仅在进程重启时发生,运行时单 run 无尺寸帽(21GB 一夜)。C3 已 shipped 未 verified —— 验证时以本档为反例重点复核,必要时重开。

## 教训(流程)

- **「干净重启」验证清单必须包含:引擎日志尾部(最后 ~20 行)+ 进程 CPU 快照**。7-6 晚只验 shell-env/server-ready,循环当时已在跑而未被发现,多烧一夜 21GB。
- C16 类破坏性操作的「删除边界」要按**引用闭包**算,不只按文件树算:删 `~/.alpha` 时,`~/.opencode/opencode.jsonc` 里指向它的引用同属清除责任(与 REQ-052「.opencode 只放指向 .alpha 的指针」不变量同根——指针的生命周期必须跟随真源)。
