---
title: REQ-159 方案基线:引擎进程自打沙箱(路一)
kind: design
status: accepted
owners:
  - alpha-code desktop maintainers
last_reviewed: 2026-09-09
review_after: 2026-12-09
---

# REQ-159 方案基线 —— 引擎进程自打沙箱

需求与验收在票面(`alpha-code#1286`)。本基线是**升 Ready 的门**与子票切分的依据。

**读法**:本基线**不重述勘破**。全部地面真相在
[`../architecture/2026-09-08-derived-process-spawn-paths.md`](../architecture/2026-09-08-derived-process-spawn-paths.md)
(四轮,§1–§8),下文只引 §号。**可写集以 §8.2 为准,不要引 §7.6 原文** —— 照抄会当场报错(zsh
存历史走 `.zsh_history.new` 再改名,§7.6 的枚举里没有它)。

## 一、只读勘破(已完成,四轮)

- **§1–§3 通路枚举**:MCP stdio / LSP / PTY / formatter / shell 分属**三种互不相干的创建原语**,
  没有任何单点能同时罩住 ⇒ 层覆盖(C3)覆盖面为零。
- **§6 继承与落点**:seatbelt 由子进程继承,五种派生原语实测全罩;`sidecar.ts` **不是**启动点
  (`server.ts:295` 是 `utilityProcess.fork`,`ForkOptions` 无可执行文件字段)⇒ 外部 `sandbox-exec`
  接不上,落点只能是**进程内自打沙箱**。
- **§6.4 互斥**:嵌套 seatbelt 仅在编译后策略完全相同时放行,否则 `sandbox_apply: Operation not
  permitted` 且**零执行**。
- **§7 写入面**:alpha 自己 13 条落在三个固定根下;随工作区变化的**只有 `<workspace>/` 一条前缀**;
  清单可从**出货 bundle** 派生(70 签名 / 85 调用点,含改名与新增两条反向臂)。
- **§8 合成验证**:F2 臂(围栏 + ext,内层拆掉)五步工作负载全过,escape 目录 count=0。

**已被推翻、不得再引用的旧断言**:PTY 缺省被 REQ-138 罩住(§3 表第 6 行已划掉,真因见 §7.7);
`/usr/lib/libsandbox.1.dylib` 在盘上(实为 dyld 共享缓存);`.zsh_sessions` 是产品行为(实为夹具)。

## 二、选定方案与被否决的替代

**选定:进程内自打沙箱。** 引擎进程启动第一步经 FFI 调用系统沙箱接口把自己关进 seatbelt,
之后派生的一切继承。收编面为零、新增 ADR 为零,并连带关掉 §3 认定「结构上罩不住」的两个口子
(`POST /pty` 带 command、`POST /mcp` 的 `MCP.add`)。

被否决:

| 替代 | 否决依据 |
|---|---|
| C3 层覆盖 | 覆盖面为零(§2 实测:MCP/LSP/PTY 都不经 `ChildProcessSpawner`) |
| 逐条收编 | 覆盖按文件点名,上游新增派生路径**默认放行**;且 `lsp/launch.ts` 需 +1 ADR。保留为路一地基塌陷时的回滚目标 |
| `ELECTRON_RUN_AS_NODE` + 外部 `sandbox-exec` | 开发版通、**出货二进制不通**(实测忽略该变量);走它 = 反转一条既有安全决定 + 换掉 `parentPort` IPC |

**owner 裁决(2026-09-09):终端配置降级走「如实披露」**,不放宽 `$HOME` 下目录、不改 PTY 起
登录 shell 的行为。理由与被否决的两条见 `#1286` 评论。

## 三、安全面:整类边界与必须守住的不变量

**I1 — 可写集是唯一权威,且只能收紧不能加宽。** seatbelt 装上之后无法放宽(§6.5)。可写集以
§8.2 的 19 行为准;其中 7 行经逐行消融证明**不放行即致命**(4 行让引擎起不来 · `<alphaGlobalRoot>`
让注入整份丢失 · `/dev/ptmx` 让终端 500 · `<HOME>/.npm` **静默失败**:provider 装不上而 health 仍 200)。
另 6 行本轮**未证伪 ≠ 可删**,删减需各自出实测。

**I1 补注(`#1317`):可写集里每个工作区一条 `(subpath …)`,而 seatbelt 编译有一道硬上限(`data object length … exceeds maximum (65535)`,越过即编译失败、零执行)⇒ 工作区并集**必须封顶**,且封的是估算字节而非条数;封顶失败要 fail-closed 到「少放几个工作区」,不是「引擎起不来」。

**I2 — 装外层与拆 REQ-138 必须同一次变更。** F1 臂实测:两层并存时每次 shell 工具
`sandbox_apply: Operation not permitted`、**HTTP 仍 200 而零执行**。分两次做会开出一个
「工具全废而接口报成功」的窗口。

**I3 — 按文件放行 ≠ 按目录放行,且失败静默。** 任何 `access(W_OK)` 预检目录的消费方在围栏下
静默降级(`compdump:22`)。登录 shell 执行用户自己的 rc,该通路写入面**结构上不可从出货 bundle
派生** ⇒ 归 owner 裁决的披露路径,不靠放宽解决。

**I4 — 披露必须有判据守着。** 「如实告诉用户」是 owner 裁决的产物,不是散文承诺:披露文案的
存在与位置要有判据,否则下一次改 UI 会把它删掉而无人知道。

**I5 — set-ID 不可 exec 的辖区从「shell 工具」扩到「整个引擎进程」**(`#1149` K1 需重新定价):
`/bin/ps`、`/usr/bin/top` 围栏内 `execvp` 直接失败;`pgrep` 不是 set-ID,`mcp/index.ts:459` 不受影响。

## 四、显式未闭合项(**不得当成已解决**)

| # | 未闭合 | 现状 |
|---|---|---|
| U1 | 原生模块在**签名包内**能否加载 | **已闭合(2026-09-09,`#1316`)= 能加载。** 自己写的最小 N-API 模块由发版命令自己签,在出货包的引擎 sidecar 与主进程各加载成功、三个符号全解析到;三条反例臂(ad-hoc / 别的 Team / 去签名)在同一进程里被库校验拒掉。不需要开 `cs.disable-library-validation`。读数与未测项见 [`../architecture/2026-09-09-req159-u1-native-addon-signed-load.md`](../architecture/2026-09-09-req159-u1-native-addon-signed-load.md) |
| U2 | 多工作区 vs 可写集不能加宽 | **已闭合(2026-09-09,`#1317`)= 取启动时并集,不把「打开新目录」接成 respawn 触发器。** 真引擎实跑 5 个工作区全可写、集合外 0 落盘;并集有一道 `data object length …(65535)` 硬天花板 ⇒ **必须封顶,且封字节不封条数**;集合来源是 `opencode.global.dat` 的 `tabs`/`tabs.info`(main 今天就在读,零新增 IPC)。respawn 被否决的是**方向**不是耗时:重载后的落地点恒是默认工作区 ⇒ 「打开新文件夹」会把用户弹回 `~/Alpha`;附带代价是终端全灭 + 工具子进程变孤儿 + 会话永远 `running`。定价、可观察面设计与未测项见 [`../architecture/2026-09-09-multi-workspace-fence-decision.md`](../architecture/2026-09-09-multi-workspace-fence-decision.md) |
| U3 | 出货形态(node + 打包产物 + 围栏)未合成 | **已闭合(2026-09-10,`#1323`)= 装上 §8.2 全量可写集,出货 `.app` 的引擎活着。** 本机用发版命令打出的 Developer ID + hardened runtime 签名包(`flags=0x10000(runtime)`,`RQX6X6A635`,fat `.node`),sidecar 日志 `process fence applied: addon=fence-… profile=2068B`;六格(冷启动 / 装连接器含两处 provider 目录真装出 26 包 / 开终端 / shell 工具 / 写配置 / 三工作区并集)正向臂界内全落盘、集合外 0 落盘,同签名对照包同一探针全落盘。没测的:真模型请求、公证、x86_64 片、W4 的 sqlite 文件(`:memory:`)。读数与布局的坑见 [`../verification/2026-09-10-req159-1323-packaged-fence/README.md`](../verification/2026-09-10-req159-1323-packaged-fence/README.md) |

U1 已于 2026-09-09 闭合(`#1316`),U2 已于 2026-09-09 闭合(`#1317`)⇒ 子票 3(围栏落地)的两条前置都已解除。
U3 已于 2026-09-10 闭合(`#1323`):`#1316` 只证明「模块加载得了、SPI 调得动、一条窄 deny 真生效」,
`#1323` 才把 node 运行时 + 打包产物 + §8.2 全量可写集 + 真实工作负载合成一次跑通(正反两臂)。

## 五、子票切分

1. **`[REQ-159][DECIDE]` U1 原生模块签名加载** —— 写一个最小 addon、签、在打包 app 里加载。
   结论为否 ⇒ 路一出局,转逐条收编。
2. **`[REQ-159][DECIDE]` U2 多工作区策略** —— 取并集 vs 打开新目录即 respawn,各自定价并裁决。
3. **`[REQ-159][CODE]` 围栏落地** —— 装外层 + **同一次变更**拆 REQ-138(I2);可写集照 §8.2;
   前置 U1、U2。**已落地(`#1321`)**,形状与判据见
   [`../architecture/2026-09-09-req159-process-fence.md`](../architecture/2026-09-09-req159-process-fence.md);
   并集裁剪规则(K=32、排序、试编译丢尾)定在 U2 决定书 §8。
4. **`[REQ-159][CODE]` 披露面** —— 沙箱下终端配置可能部分不生效的如实告知 + 守着它的判据(I4)。
5. **`[REQ-159][VERIFY]` 出货形态合成** —— node 运行时 + 打包产物 + 围栏三者一次跑通(U3)。

子票在本基线批准后切,各自引本基线小节;基线随 checkout 即达,不搬运进 issue 正文。
