---
title: 网络轴在整进程围栏上重勘破:老裁决的那两行会让引擎起不来
kind: architecture
status: active
owners:
  - alpha-code desktop maintainers
last_reviewed: 2026-09-10
review_after: 2026-12-10
---

# 网络轴(第二轮):接缝从 shell wrapper 换成整进程之后,哪些老结论还成立

2026-08-25 的网络轴勘破 [`2026-08-25-network-egress-seam.md`](2026-08-25-network-egress-seam.md)(`#1077`)
是**对着 REQ-138 的 `cfg.shell` wrapper**做的 —— 被围栏的是一棵**叶子进程树**(shell 工具与
prompt `!command` 的子进程),它从不监听端口。`#1321` 把地基换了:围栏现在装在**引擎 sidecar 自己**
身上(`process-fence-apply.ts`,在 import 引擎之前 `sandbox_init`),而 sidecar **就是那个 HTTP 服务器**。
本文只回答「换了地基之后,网络轴的哪几条要改」,取证在
[`../verification/2026-09-10-req159-1334-packaged-network-fence/README.md`](../verification/2026-09-10-req159-1334-packaged-network-fence/README.md)。

**一句话:老勘破 §1(谓词粒度)/ §2(出网清单)/ §4(选型)照旧成立;§5 写下的那个 profile 形状
照抄到新接缝上会让引擎当场起不来;§7 的两条未验项本轮闭合了(打包态 env-proxy 成立、
`(deny network*)` 的 unix socket 覆盖面已枚举);§3 的咽喉点结论仍成立但覆盖面必须重画。**

## 0. 口径与手段自证

| | |
| --- | --- |
| 仓 | `alpha-code@6a6f4bd37`(`origin/alpha`,worktree `ac-1334`) |
| 宿主 | macOS Darwin 25.3.0 arm64 · `/usr/bin/sandbox-exec` · node v25.8.1(独立探针)/ Electron 42.3.3 内嵌 node(出货 sidecar) |
| 出货形态 | 本机发版命令打的 Developer ID + hardened runtime 签名包,`com.tide.alphacode` 0.1.12,fat `alpha_fence.node`,`codesign --verify --deep --strict` exit 0 |
| 观测面 | ①runner 进程 `existsSync` 实读落盘;②loopback CONNECT 代理的逐条请求日志;③内核 Sandbox 拒绝日志(`log show … eventMessage CONTAINS "deny("`);④真 `sandbox-exec` 试编译器的报错原文 |
| 日期 | 2026-09-10 |

三个手段各自先证明**测得出已知的坏**,再拿去判未知的好:

- 内核日志:`(deny network*)` 下 `nc -U /var/run/syslog` ⇒
  `Sandbox: nc(86248) deny(1) network-outbound /private/var/run/syslog`;同一 profile 下
  `touch /private/tmp/…` ⇒ `deny(1) file-write-create /private/tmp/ac1334-known-bad.txt`。
- 代理日志:控制臂(不追加任何网络行、不设代理 env)读数是 **0 条** —— 它不会幻觉命中。
- 试编译器:一份已知撞墙的 profile 报 `data object length … exceeds maximum (65535)`,一份语法坏的报
  `unbound variable: host`(见 §Q5)。

本轮也踩了两个本仓已登记的坑,一并留痕:zsh 不分词让第一版 unix-socket 探针把七个路径喂成一个参数
(读数 `ERR EINVAL`,看着像「都被拦了」);`log show --start` 认本地时区而 `toISOString()` 是 UTC,
用它做时间窗会得到恒空读数。两处都改掉后才取的数。

## Q1 整进程 network-deny 底座下,引擎还起得来、干得了活吗

### Q1.1 老勘破 §5 写下的那两行,照抄到新接缝上 ⇒ 引擎起不来

§5 的汇流层是:

```
(deny network*)
(allow network-outbound (remote ip "localhost:<chokePort>"))
```

**独立探针**(`fixture/seatbelt-listen-probe.mjs`,被围栏进程 `net.createServer().listen(0,"127.0.0.1")`,
外面一个未被围栏的客户端去连):

| profile 形状 | `listen()` | 外部客户端 |
| --- | --- | --- |
| `(allow default)` 基线 | ok(port 58327) | `CLIENT_GOT=SERVED` |
| **§5 逐字** | **`ERR EPERM`** | 连不上(根本没有端口) |
| §5 + `(allow network-bind (local ip "localhost:*"))` | **`ERR EPERM`** | 同上 |
| §5 + `(allow network-inbound (local ip "localhost:*"))` | ok(58333) | `CLIENT_GOT=SERVED` |
| §5 + inbound(**不加** bind) | ok(58351) | — |

⇒ 让 loopback 监听活下来的那条是 **`network-inbound`**,不是 `network-bind`;只给 `network-bind`
两次都是 `EPERM`。同一批探针里出网方向的读数:放行端口 `ok`、相邻端口 `EPERM`、`1.1.1.1:443` `EPERM`
—— 加法形状仍然精确到单端口(与老勘破 §1.3 一致)。

**出货形态复验**(`sec5` 臂,同一份签名包):围栏装上了 ——
`process fence applied: addon=fence-… profile=2174B` —— 然后引擎在 **560 ms** 内死掉:

```
03:40:55.268  process fence planned: workspaces=1 …, profile=2244B, compile attempts=1
03:40:55.371  (server) process fence applied: … profile=2244B — every process this engine spawns inherits it
03:40:55.816  sidecar spawn failed before health handshake
03:40:55.817  (utility) sidecar exited { code: 1 }
```

health **从来没有 200**;`main.log` / `server.log` / `utility.log` / `crash.log` / 引擎 `opencode.log`
里**没有任何一行点名原因**。这是本轮最贵的一条:**围栏「装上了」不等于引擎活着,而失败在今天是哑的**
—— AC4 那六条 fail-closed 路径覆盖的是「围栏装不上」,不覆盖「围栏装上了、引擎被自己的策略掐死」。

### Q1.2 能工作的最小形状

```
(deny network*)
(allow network-bind    (local  ip "localhost:*"))
(allow network-inbound (local  ip "localhost:*"))
(allow network-outbound (remote ip "localhost:<chokePort>"))
```

(`network-bind` 那行按 Q1.1 是冗余的,但它是 `bind()` 语义的显式声明;要删得自带实测。)
DNS 刻意不放行 —— 走代理的客户端由代理解析,想直连的死在解析这一步(§Q3 实证)。

### Q1.3 六格工作负载逐格(出货形态,`deny` 臂 = 上面这个形状 + **不设**任何代理 env)

| 格 | `open`(出货形状) | `deny` | `choke`(同 `deny` + `HTTP(S)_PROXY` 指向 loopback 代理) |
| --- | --- | --- | --- |
| 1 冷启动 health | 200 | **200** | 200 |
| 1 围栏自报 | `profile=2040B` | `2308B` | `2322B` |
| 2 连接器(MCP stdio) | connected | **connected** | connected |
| 2 **provider 安装** | 26 包 / 62 636 KB × 2 处,`~/.npm/_cacache` 在 | **0 包 × 2 处,`_cacache` 不在** | 26 包 / 62 636 KB × 2 处 |
| 3 开终端(登录 shell 里敲命令) | 通 | **通** | 通 |
| 4 shell 工具 | 通 | **通** | 通 |
| 5 写配置 + ext 装载(`alpha_register` 在) | 通 | **通** | 通 |
| 6 三工作区并集(SIGKILL → self-heal → 重算) | `workspaces=3` | **`workspaces=3`** | `workspaces=3` |
| 集合外落盘 | 0 | 0 | 0 |

**断的只有一格,而且断在最像绿的地方:** 引擎照常起、照常干活,只有 provider 安装死了 ——

```
NpmInstallFailedError (cause: FetchError: request to https://registry.npmjs.org/@opencode-ai%2fplugin
failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org)
```

**而 `/global/health` 仍然 200。** 这正是票面点名的那条静默路径,在新接缝上原样复现:
断的点名规则是 `(deny network*)` **连带拦掉 DNS**(mDNSResponder 的 unix socket,§Q2),
不是某一条端口规则。装上策略层(`choke` 臂)之后这一格 26 包全回来 —— 说明它可修,不是结构性损失。

同臂另外两条**观测**(不是判定,只跑了两轮、没做重复采样):并集重算之后第一条 shell 命令走满
120 s 预算超时、5 s 后重试 200;`renderer.home.catalog_ready` 的时间戳 488 223 ms
(`open`/`choke` 分别 23 402 / 23 541 ms),`main.sidecar.catalog_liveness.confirmed` 本次窗口内没出现。

### Q1.4 覆盖面必须重画:围栏只罩 sidecar 那棵树

Electron **main 不被围栏**(落地形状 §1)。所以整进程 network-deny 之后,
main 的 catalog / auth / updater 出网**一点没变**;renderer 是 Chromium 独立网络栈,同样没变。
老勘破 §6 那张表里「引擎进程内 HTTP(S) = 覆盖(自愿)」这一格现在要改成
**覆盖(强制)** —— 因为围栏就装在那个进程上;而「main / renderer / updater 不覆盖」照旧。

## Q2 `(deny network*)` 到底关掉了什么

老勘破 §1.4 只验了 mDNSResponder 一个例外。三条臂的矩阵(`fixture/unix-socket-probe.mjs`,
`connect()` 到七个系统 unix socket):

| socket | 无围栏 | `(deny network*)` | `(deny network*)` + 逐条 `(literal …)` 放行 |
| --- | --- | --- | --- |
| `/private/var/run/mDNSResponder` | CONNECTED | **EPERM** | CONNECTED |
| `/private/var/run/syslog` | `EPROTOTYPE`(它是 SOCK_DGRAM) | **EPERM** | `EPROTOTYPE` |
| `/private/var/run/systemkeychaincheck.socket` | CONNECTED | **EPERM** | CONNECTED |
| `/private/var/run/cupsd` | CONNECTED | **EPERM** | CONNECTED |
| `/private/var/run/usbmuxd` | CONNECTED | **EPERM** | CONNECTED |
| `/private/var/run/portmap.socket` | CONNECTED | **EPERM** | CONNECTED |
| `/private/var/run/filesystemui.socket` | CONNECTED | **EPERM** | CONNECTED |

⇒ **`(deny network*)` 对 AF_UNIX 是一刀切的,而每一条都能用一行 `(literal …)` 单独放回来**
—— mDNSResponder 不是特例,它只是**第一个被验的**。第三臂逐格回到第一臂读数,证明这不是探针坏了。

**它不覆盖 mach IPC。** 同一份 `(deny network*)` 下 `dscl . -read`、`security find-generic-password`、
`id -un` 读数与无围栏臂**逐字相同**;把 profile 换成 `(deny mach-lookup)` 之后同一组命令分别变成
`Operation failed with error: eServerError` / `parameters … were not valid` / `501`(降级成数字 uid)
—— 对照臂证明探针**看得见 mach 死掉**。所以钥匙串(securityd)、目录服务(opendirectoryd)、
`os_log` 在 deny-all 底座下照常工作;`sidecar.ts:236` 的 `useSystemCertificates()`(读系统钥匙串)
不受影响,`choke` 臂里隧道内的 HTTPS 全部校验通过就是它的正样本。

**引擎实际用到的是哪些**:六格工作负载跑完,`deny` 臂内核日志里我们这棵进程树的 `network-*` 拒绝行
共 **22 条,全部是同一条**:

```
Sandbox: Code Puppy Helper(PID) deny(1) network-outbound /private/var/run/mDNSResponder
Sandbox: curl(PID)              deny(1) network-outbound /private/var/run/mDNSResponder
Sandbox: node(PID)              deny(1) network-outbound /private/var/run/mDNSResponder
Sandbox: git-remote-http(PID)   deny(1) network-outbound /private/var/run/mDNSResponder
```

`open` 臂同一时间窗 **0 条**(手段的负样本)。**除 mDNSResponder 之外,没有任何一个系统 unix socket
被这套工作负载碰过。** 顺带一条:TCP 层的拒绝行一条也没有 —— 因为所有客户端都先死在解析这一步,
根本没走到 `connect()`。想看 TCP 层 EPERM 要用独立探针(§Q1.1 的第三列)。

## Q3 误伤语料在新底座上重跑

文件轴 §2.8 的九条(逐字照 `#1076` 的 `run.ts`)+ 本轴新增三条,全部经**出货 sidecar 的 shell 工具**跑:

| 语料 | `open` | `deny` | `choke` |
| --- | --- | --- | --- |
| 工作区内写 | ok | ok | ok |
| `/private/tmp` 写 | ok | ok | ok |
| `git init` + commit(40 位 sha) | ok | ok | ok |
| `node` 写 TMPDIR | ok | ok | ok |
| 读仓库文件 | ok | ok | ok |
| `mkdir -p d1/d2/d3/d4` | ok | ok | ok |
| `grep` | ok | ok | ok |
| `which git node` | ok | ok | ok |
| `curl https://example.com` | `CURL=200` | **`CURL=000`,`curl: (6) Could not resolve host`** | `CURL=200` |
| `npm view semver version` | `7.8.5` | **`npm error network …`** | `7.8.5` |
| `git ls-remote https://github.com/git/git` | `b8242b0…` | **`fatal: unable to access …: Could not resolve host: github.com`** | `b8242b0…` |
| `node dns.lookup("example.com")` | `198.18.7.158` | **`ENOTFOUND`** | `ENOTFOUND` |

**九条里八条与网络无关的在三条臂上逐格相同;唯一变的是 `curl` 那一条,而且它变的方式是「解析不了」
而不是「连不上」。** 加的三条把这句话钉死:装上策略层之后 npm 与 git 立刻回到 `open` 臂读数,
而 `dns.lookup` 仍然 `ENOTFOUND` —— **能干活不是因为 DNS 回来了,是因为解析被搬到了代理那一侧**。
这正是老勘破 §5「DNS 默认不放行」那句写法纪律在真工作负载上的第一次证实。

## Q4 引擎自身的出网现在从哪走(打包产物复验,老勘破 §7 首条闭合)

判据是**代理日志里有没有那条 CONNECT**,不是有没有报错。探针:注册一个远端 MCP,URL 指向
`http(s)://ac1334-probe.invalid/mcp` —— 结构上不可解析,而且**只有引擎进程内的 fetch 会发起它**。

| 臂 | 引擎侧读数 | 代理日志 |
| --- | --- | --- |
| `open`(无代理 env) | `fetch failed: getaddrinfo ENOTFOUND ac1334-probe.invalid` | **0 条**(直连) |
| `deny`(围栏在,无代理 env) | `fetch failed: getaddrinfo ENOTFOUND ac1334-probe.invalid` | **0 条** —— 流量不会自己汇过来 |
| `choke`(围栏在 + `HTTP(S)_PROXY`) | `fetch failed: Error: Request was cancelled.: Proxy response (502) !== 200 when HTTP Tunneling` | **`connect ac1334-probe.invalid:80` ×2、`:443` ×2** |

⇒ **打包产物里 `sidecar.ts:145` 的 `useEnvProxy()` 确实生效**:引擎进程内的 fetch(远端 MCP 这条路)
在 hardened runtime + `utilityProcess` 的 node 上照样被 `setGlobalProxyFromEnv()` 接管,
拒绝时**响亮**(`Request was cancelled.` + `Proxy response (502)`)。老勘破 §3.1 在 dev 二进制上
量到的三态,在出货形态成立。`deny` 臂那一行同样重要:**没有代理 env,seatbelt 只会把流量掐死,
不会把它汇到任何地方** —— 强制层与策略层缺一不可(老勘破 §5 的结论照旧)。

`choke` 臂代理日志共 32 条,还看到 `registry.npmjs.org:443`(sidecar 里的 `@npmcli/arborist`)、
`github.com:443` / `example.com:443` / `release-assets.githubusercontent.com:443`(shell 工具的子进程)。

**两条未验,不许从本轮读数外推:**

1. **代理日志不区分发起进程。** `codepuppy.cn:443`(catalog)与 `alpha-gateway.tidelabs.click:443`
   也出现在日志里,但 main 自己也调 `useEnvProxy()`(`index.ts:200`)且继承同一份 env
   —— 无法判断这两族是 main 发的还是 sidecar 发的。
2. **模型目录那条 fetch 本轮没有发生。** 引擎的目录源是 `https://models.opencode.ai`
   (`packages/core/src/models-dev.ts:160`,5 分钟 TTL,缓存在 `<XDG_CACHE_HOME>/opencode/models.json`);
   四条臂的代理日志里**一次都没有它**,四条臂的缓存文件**都不存在**。所以「models 目录拉取是否经代理」
   本轮**未验**;「没看见」不是结论。
3. **没有发过一次真的模型请求**(与 `#1321` / `#1323` 同一条)。

## Q5 profile 的字节上限还够吗

用**生产渲染器** + **真编译器**(`fixture/profile-byte-budget.ts`),根取本机生产值
(`~/Library/Application Support/…`):

| 工作区数 | 无网络行 | §5 两行 | 能工作的四行 | 四行 + mDNSResponder |
| --- | --- | --- | --- | --- |
| 1 | 1 353 B | 1 424 B | 1 519 B | 1 587 B |
| 3 | 1 587 B | 1 658 B | 1 753 B | 1 821 B |
| 5 | 1 821 B | 1 892 B | 1 987 B | 2 055 B |
| 32(`MAX_WORKSPACES`) | 4 980 B | 5 051 B | 5 146 B | 5 214 B |

出货形态实读(隔离布局下路径更长):`open` 2 040 B(1 ws)/ 2 218 B(3 ws);
加网络行后 2 308 B / 2 486 B;加网络行 + 代理端口 2 322 B / 2 502 B。**网络行的净成本 234–268 B。**

**墙在哪:四条臂完全一样。** 二分到第一条编不过的工作区数,四条臂都是 **1 264**,
且第 1 265 条时编译器报的数字**逐字相同**:`data object length 65574 exceeds maximum (65535)`。
每多一个工作区 +51 B(1265→65574、1266→65625、1267→65676)。
**⇒ 在 `MAX_WORKSPACES=32` 这个封顶下,离墙还有约 39 倍余量;网络行不改变这个余量。**

一条手段自证,不写下来就会误导下一个人:上面「四条臂数字相同」第一次量到时,我以为它证明
「网络行不喂那个数据对象」。**那是错的** —— 编译器在文件侧先撞墙就停了,网络侧的贡献根本没被算进去。
把工作区降到 1(远离文件侧的墙)再灌网络路径字面量,数字立刻动:400 条 180 字符的
`(literal …)` ⇒ `67450`;1 200 条 ⇒ `202279`(边际 ≈ 168 B/条 ≈ 字符串长度本身);
3 000 条时换成另一种失败 `Assertion failed: (diff <= INSTR_JUMP_NE_MAX_LENGTH) … serialize.c:240`。
**网络路径字面量与文件路径字面量喂的是同一个 65535 对象**;只是我们要加的那几行小到量不出来。

### 这对 `trimUntilCompiles` 意味着什么

裁剪器只丢工作区、网络行不可丢 —— 按上面的余量,这在字节维度上**不成问题**。
真问题在**归因**:网络行若写坏了(比如照老勘破 §1.1 已证不存在的 `(remote host "models.dev")`),
裁剪器会把工作区一路丢光再抛,而抛出来的话是:

```
process fence profile does not compile even with the minimum writable set
(1 workspace, 4 dropped, 5 attempts): sandbox-exec: unbound variable: host … line 25, column 33
```

**五次试编译、丢掉四个工作区,而错根本不在并集大小。** 运维读到的第一句是「最小可写集都编不过」,
下一步很容易去查工作区。实现票要么在渲染网络行之后**先单独试编一次**(把语法错与并集大小分开归因),
要么让裁剪器在丢第一个工作区之前先判「上一次失败原因是不是 `exceeds maximum`」。

## 老结论分档

### 仍然成立(本轮未重测,或重测后一致)

- §1.1 SBPL 写不出目的地(主机名 / IP / 网段),可表达粒度 = {any, loopback} × 端口 × {tcp,udp}。
  本轮反面证据:`(remote host "models.dev")` 仍报 `unbound variable: host`(§Q5)。
- §1.2 解析错误时进程不启动,空输出长得像「拦住了」——本轮 `sec5` 臂是它的升级版:
  **profile 解析通过、围栏装上了、进程照样没起来**,而且这次连报错都没有(§Q1.1)。
- §1.3 只写加法、不写减法;加法精确到单端口(本轮独立探针再证)。
- §1.5 端口白名单 host-blind ⇒ 单靠 seatbelt 的「网络闸门」是假闸门。
- §2 出网清单与 §2.1 的 fake-IP 拓扑(本轮 `open` 臂实读 `example.com` = `198.18.7.158`)。
- §4 选型:seatbelt 做强制汇流、本地 CONNECT 代理做目的地策略,两者缺一不可
  —— `deny` 臂(只有强制层)与 `choke` 臂(两层都有)的对照就是它的正反臂。
- §5 的**写法纪律**(只加法、禁 `localhost:*` + 端口特定 deny 的组合、DNS 默认不放行)。

### 已被推翻 / 必须改写

| 老结论 | 本轮读数 | 改写成 |
| --- | --- | --- |
| §5 的汇流层 profile 就是那两行 | 照抄到新接缝 ⇒ `listen()` `EPERM` ⇒ 引擎 560 ms 内 exit 1,health 从来没 200(§Q1.1) | 必须补 `(allow network-inbound (local ip "localhost:*"))`;`network-bind` 单独给不够 |
| §3.2「强制层不能罩在 sidecar 上,只能罩 C1 wrapper」 | `#1321` 已经罩在 sidecar 上了(`sandbox_init`,不需要 exec 缝) | 强制层的落点是 sidecar 自己;C1 wrapper 已随 `#1321` 拆除 |
| §6 表「引擎进程内 HTTP(S) = 覆盖(自愿)」 | 围栏就装在这个进程上 | 覆盖(**强制**);"自愿"只剩下「汇到哪」这一半(靠 env) |
| §6 表「MCP stdio / LSP 不覆盖(本轮)」 | 全部继承 sidecar 的围栏 | 覆盖(强制),无需逐个收编 |
| §7 首条「打包 sidecar 上未复跑 `useEnvProxy()`」 | 出货形态三臂对照成立(§Q4) | 闭合 |
| §7 末条「`(deny network*)` 对 unix socket 的覆盖范围未枚举」 | 七个 socket 三臂矩阵 + 真工作负载的内核日志枚举(§Q2) | 闭合:一刀切、逐条可放回、不覆盖 mach;引擎实际只碰 mDNSResponder |
| §7 「误伤语料要在 network-deny 底座上重跑」 | 九条 + 三条,三臂逐格(§Q3) | 闭合 |

### 仍未验(本轮**没有**改变这些的状态)

- **真模型请求一次都没发过** ⇒ 票面担心的「提问没反应」这条用户可观察面**没有直接测到**。
- **模型目录 `models.opencode.ai` 的 fetch 本轮没有发生** ⇒ 它是否经代理未验(§Q4)。
- **代理日志不区分 main 与 sidecar** ⇒ catalog / gateway 两族出网的归属未验(§Q4)。
- ssh 经 CONNECT 端到端(老 §7 第二条)、bun 作为运行时的完整代理语义(第三条)、
  拓扑 A(本机 7897 系统代理)下的复跑(第四条)、electron-updater 是否服从 env-proxy(第五条)。
- `deny` 臂的两条时序读数(并集重算后首条命令 120 s 超时、`catalog_ready` 488 s)只跑了两轮,
  按《时序门需 ≥3 轮采样》**不构成结论**。
- 公证 / staple;x86_64 那一片没有被执行过;单机单配置单拓扑。

## 用法

本文与老勘破一起,是 `#1073`(REQ-137)AC 与实现票的对照物。三条直接约束:

1. **AC 里凡是引用 §5 那个 profile 形状的地方,要按 §Q1.2 改写**,并且实现票必须自带
   「引擎在这张 profile 下真的能 listen 且 health 200」这条判据 —— `sec5` 臂证明了
   「围栏装上了」与「引擎活着」是两件事,而后者今天没有任何一条判据罩着。
2. **W7 那条静默路径要在网络轴上重新点名**:断的是 DNS,不是端口;而 health 仍 200。
3. **未验的三条(真模型请求 / models 目录 / 代理日志的进程归属)不许在 AC 里写成已知事实。**

任何与本文冲突的断言,先复跑再改文档,不要改实现去迁就散文。
