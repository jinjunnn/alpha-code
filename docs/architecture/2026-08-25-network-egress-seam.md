---
title: 本机出网要在哪一层拦住(勘破)
kind: architecture
status: active
owners:
  - alpha-code desktop maintainers
last_reviewed: 2026-08-25
review_after: 2026-11-25
---

# 网络轴:seatbelt 表达不了目的地,代理没有强制力,咽喉点是两者的组合

这是文件轴勘破([`2026-08-23-shell-sandbox-seam.md`](2026-08-23-shell-sandbox-seam.md))
的姊妹篇。那份文档的 §4 明确写着:该接缝的 profile 是 `(allow default)`,**网络不在
覆盖面内**。本文档回答网络轴的四个只能靠跑回答的问题:seatbelt 网络谓词的真实粒度、
本机出网的真实清单、咽喉点在不在、以及 seatbelt 网络策略与本地代理两条路各自的代价。

与文件轴同一条纪律:凡断言必来自本机装着的那份二进制的一次真实执行,凡未实跑一律标
「未验证」。**每个否定探针都先打 `STARTED` 标记再跑被测命令** —— 本轴有一个已实测的
陷阱专门伪装成「拦住了」(§1.2 的 exit 65),空输出不是结论。

## 0. 测量口径

| | |
| --- | --- |
| 仓 | `alpha-code@c3d0d0569`(`origin/alpha`,worktree `ac-1077`) |
| 宿主 | macOS 26.3.1 / Darwin 25.3.0 arm64 |
| 沙箱 | `/usr/bin/sandbox-exec`(随系统) |
| 客户端 | curl 8.7.1 · git 2.50.1 (Apple Git-155) · bun 1.3.14 · node v22.22.3 · npm 10.9.8 · uv 0.10.10 · gh 2.88.1 · OpenSSH 10.2p1 · /usr/bin/python3 3.9.6 |
| 引擎同款运行时 | Electron 42.3.3 的 `ELECTRON_RUN_AS_NODE`(= **node v24.15.0**,与打包 sidecar 同一二进制家族;取自主 checkout `packages/ui-mac/node_modules/electron/dist`,只读执行) |
| 观测面 | 自建三件套:**拒绝式日志代理**(记录 CONNECT 行、恒答 403)、**真隧道 CONNECT 代理**(双向转发)、loopback 靶站(47651/47652/47656);外加 seatbelt 探针的 `STARTED` 标记与 curl 的逐错误码输出 |
| 测量时刻拓扑 | 系统代理**关**(`scutil --proxy`:HTTPEnable 0)、本机无代理进程监听;DNS = 192.168.100.1,**答 fake-IP**(§2.1) |
| 日期 | 2026-08-25 |

取证脚本一次性,不入仓;结论以下面的原始输出为准。两条观测手段自纠记录:
①第一轮 curl 封装把 `--noproxy *` 写进未加引号的 bash 变量,`*` 被 glob 展开成 CWD
文件名列表混进 URL —— **该轮 E0 测量整批作废重跑**,本文档只引用修复后(函数封装 +
引号)的输出;②每个手段先对已知的「通」跑一遍拿到 200/`CONNECT` 日志,才拿它判「不通」。

## 1. seatbelt 网络谓词的真实粒度(勘破 1)

### 1.1 语法域:主机名与具体 IP 都不存在,只有 `*`/`localhost` + 端口

对 `sandbox-exec -p` 逐条投喂过滤器,原始 stderr:

| 过滤器 | 结果 |
| --- | --- |
| `(remote host "github.com")` | **解析错误** `unbound variable: host`,exit 65 |
| `(remote ip "140.82.121.6:443")` | **解析错误** `host must be * or localhost in network address`,exit 65 |
| `(remote ip "192.168.0.0/16:443")`(CIDR) | 同上,exit 65 |
| `(remote ip "*:443")` | 通过 |
| `(remote ip "localhost:47651")` | 通过 |
| `(remote tcp "*:443")` / `(remote udp "*:53")` | 通过 |
| `(deny network-outbound (remote ip "localhost:47651"))` | **通过解析**(语义见 §1.3) |
| `(deny network-outbound (remote ip "127.0.0.1:47651"))` | 解析错误(同 `host must be…`),exit 65 |

⇒ **Darwin 25.3 的 SBPL 结构上写不出目的地(主机名/IP/网段)白名单**。可表达的全部
粒度 = {any, loopback} × 端口 × {tcp, udp}。

### 1.2 陷阱指纹:解析错误时进程根本不启动,空输出长得像「拦住了」

```
$ sandbox-exec -f p5-deny-portA-127.sb /bin/bash -c 'echo STARTED; curl …'
sandbox-exec: host must be * or localhost in network address
sandbox-exec exit=65    ← 没有 STARTED 行 = 被测进程从未运行
```

判据:**每个否定探针必须自带进程已启动的证据**(`STARTED` 标记),
`sandbox-exec` 的 exit 65 + stderr 上的 `Backtrace` 是「profile 坏了」,不是「拦住了」。

### 1.3 行为语义:减法不可靠(有一个精确的失效组合),加法 8/8 精确

同一 loopback 靶站(127.0.0.1:47651,真实回 `target-47651`),八个最小 profile 的矩阵:

| # | profile(`(allow default)` 之后) | 结果 |
| --- | --- | --- |
| M1 | `deny network*` + `allow localhost:*` + `deny localhost:47651` | **200(deny 失效)** |
| M2 | 同 M1,deny 排在 allow 之前 | **200(deny 失效)** |
| M3 | `allow localhost:*` + `deny localhost:47651`(无 `deny network*`) | 000(deny 生效) |
| M4 | `deny network*` + `allow *:*` + `deny *:47651` | 000(deny 生效) |
| M5 | `deny network*` + `allow localhost:*` + `deny *:47651` | **200(deny 失效)** |
| M6 | `deny network*` + `allow *:*` + `deny localhost:47651` | 000(deny 生效) |
| M7 | 仅 `deny localhost:47651` | 000(deny 生效) |
| M8 | `deny network*` + allow 与 deny 同为 `localhost:47651` | 000(deny 生效) |

失效的充分条件恰好是一个组合:**`(deny network*)` 底座 + `(allow … "localhost:*")` +
端口特定 deny(host 写 `localhost` 还是 `*`、顺序先后均无关)**。此前 `ac#1108`
(2026-08-25,PR #1118 的 C3)记录的「deny 方向端口过滤不生效」正是在这个组合里测的
—— 他们的观察为真,我的 M3/M7 也为真,坑在组合语义而不在 deny 原语本身。

工程结论只有一句:**profile 只能写加法(deny-all 底座 + 逐端口 allow),
不能写减法(宽 allow 再想 deny 挖洞)** —— 加法形状在全部实验里(E4/E10.4/M4/M8)
精确到单端口:47651 放行时 `A47651=200 B47652=000`。

### 1.4 DNS 不走 TCP/UDP 谓词,走 mDNSResponder 的 unix socket,可独立开关

- `(deny network*)` 下 `getaddrinfo` 失败(`gaierror: nodename nor servname provided`),
  curl 报 `Could not resolve host`(exit 6)—— **deny-all 连带拦 DNS**;
- 只加一条 `(allow network-outbound (literal "/private/var/run/mDNSResponder"))`,
  `getaddrinfo` 恢复(`resolved: 198.18.0.76`)而 TCP 仍全拦(curl exit 7)——
  **DNS 判据与出网判据是两条,可独立放行**;
- 直发 UDP 的 DNS(`sendto 8.8.8.8:53`)受 `(remote udp "*:53")` 端口过滤管束,
  allow 方向精确(53 通、123 `PermissionError`)。

### 1.5 端口白名单是 host-blind 的 —— 这就是「假闸门」的形状

`deny network*` + `allow (remote ip "*:443")` + mDNSResponder:

```
https://api.github.com/      → 200
https://registry.npmjs.org/  → 200   ← 从没有任何规则点名过它
https://1.1.1.1/             → 301   ← 纯 raw-IP,无 DNS 也通
```

**「允许 443」= 允许互联网上所有 HTTPS 目的地。** 一个只有 seatbelt 的「网络闸门」
形式上有政策、实际不区分任何目的地 —— 按本仓判据这是前提为假的闸门,比没有更贵。

### 1.6 其余边界事实

- **继承**:profile 下 `sh → python3` 孙进程同样受限(靶 A 通、靶 B
  `urlopen error [Errno 1] Operation not permitted`)—— 与文件轴一致,围栏罩全子树。
- **IPv6**:`localhost` 类覆盖 `::1`(allow `localhost:47656` 时 `[::1]:47656` 通;
  deny-all 时 `::1` 拦)—— 无 v6 loopback 旁路。
- **inbound**:`(deny network*)` 连 `bind` 也拦(`PermissionError`),响亮。
- **loopback 放行整类 = 隔离归零**:`deny network*` + 仅放行本机真隧道代理端口,
  直连 `1.1.1.1` 拦死、`curl -x http://127.0.0.1:47654 https://api.github.com/` **200**。
  只要 loopback 上有一个会转发的进程,放行它的端口就放行了整个互联网 ——
  这不是缺陷,这正是 §5 咽喉点设计的支点:**转发者自己必须是策略执行者**。

## 2. 本机出网的真实清单(勘破 2)

### 2.1 先看拓扑:它不是常量,48 小时内换了两种形态

| 时刻 | 形态 | 证据 |
| --- | --- | --- |
| 2026-08-25(`ac#1108` 测量时) | 本机 Clash Verge 系统代理,`scutil --proxy` 显示 `127.0.0.1:7897` | PR #1118 C3 记录;DNS 已给 fake-IP `198.18.0.131` |
| 2026-08-25(本轮) | 系统代理**关**(HTTPEnable 0)、本机 7897 无监听、无 clash 核心进程;默认路由 en0 直出;DNS = 192.168.100.1 **仍答 fake-IP** | `getaddrinfo("api.github.com") = 198.18.0.76`,且 curl `Connected to api.github.com (198.18.0.76) port 443` 后 **200** —— 透明代理挪到了网关 |

两个直接推论,都对 #1073 的闸门设计构成硬约束:

1. **按 IP 授权在本机结构性无意义** —— 进程 `connect()` 到的是 fake-IP
   (198.18.0.0/15),真实目的地只在 DNS 查询名 / CONNECT 行 / TLS SNI 里存在。
   即使 SBPL 能写具体 IP(§1.1 它不能),写了也只是在匹配假地址。
2. **闸门不得把「代理在 127.0.0.1:7897」写成前提** —— 本轮它就不在。任何策略必须
   自带自己的汇流点,而不是假设环境替它汇流。

### 2.2 清单:一次典型会话会碰的目的地(类别 × 出处)

| 类别 | 目的地 | 出处(代码或实测) |
| --- | --- | --- |
| 引擎:模型目录 | `models.dev:443` | `packages/core/src/models-dev.ts:154`(`OPENCODE_MODELS_URL` 可覆写) |
| 引擎:平台(gateway/catalog/auth) | `alphacodeone.com:443`、`account.alphacodeone.com:443` | `packages/ui-mac/src/shared/alpha-config.ts:24,32`、`catalog-curation.ts:25`、`alpha-auth.ts:290` |
| 引擎:BYOK 模型 | 各 provider 的 `baseURL`(catalog 定义,直连不走 gateway) | `packages/ui-mac/src/main/alpha-models.ts:61-77` |
| 引擎:远程 MCP | 用户配置的任意 URL(Streamable HTTP / SSE) | `packages/opencode/src/mcp/index.ts:294,301,884`(SDK transport → 进程内全局 fetch) |
| 子进程:包管理 | `registry.npmjs.org:443`(npm/bun)、`pypi.org:443` + `files.pythonhosted.org:443`(uv) | E13 实测 CONNECT 日志(§4.2) |
| 子进程:git | `github.com:443`(本仓 remote 实拍为 https 形态);用户仓可能 `*:22`(ssh) | `git remote -v` + E13 |
| 子进程:gh | `api.github.com:443` | E13 |
| 子进程:LSP 自动下载 | `api.github.com` / `github.com` / `download-cdn.jetbrains.com` / `api.releases.hashicorp.com` | `packages/opencode/src/lsp/*.ts` 静态枚举 |
| 子进程:本机模型 | `127.0.0.1:11434`(ollama,测量时刻在监听) | `lsof` 实拍 |
| Electron main | catalog / auth(同上平台族);updater feed(包内 `app-update.yml`,electron-updater) | `packages/ui-mac/src/main/updater.ts` |
| renderer(Chromium) | 独立网络栈(系统代理语义),本轴不覆盖 | §6 |
| 遥测 | **未发现默认遥测端点**:engine 内 `telemetry` 命中均为 OpenTelemetry tracer(仅显式配置时导出)与 LSP 协议消息 | grep `posthog\|sentry\|telemetry` |

放行集里**没有一项能用「端口 ≠ 443」区分开** —— 全部是 443(加可选的 22)。
§1.5 的 host-blind 事实因此直接命中:**seatbelt 单独做不出这张表的任何一行。**

## 3. 咽喉点在不在(勘破 3)

出网路径分三类。答案:**A 与 B 可以合并到同一个咽喉;C 只有一半自愿汇入。**

### 3.1 A:引擎进程内(模型请求、远程 MCP、models.dev)

sidecar 启动序列(`packages/ui-mac/src/main/sidecar.ts`)自己接好了代理管线:
`ensureLoopbackNoProxy()` → `useSystemCertificates()`(`tls.setDefaultCACertificates`,
`:194`)→ `useEnvProxy()`(`http.setGlobalProxyFromEnv()`,`:204`)。Electron main
同款(`index.ts:200,557`)。用 sidecar 同款 node(v24.15.0)实测三态:

```
E14a 无代理环境                          → fetch 200(直连,基线)
E14b 设 HTTPS_PROXY、不调 setGlobalProxyFromEnv → fetch 200(直连!env 变量本身无效)
E14c 设 HTTPS_PROXY、调 setGlobalProxyFromEnv   → CONNECT example.com:443 落代理日志,
                                            拒绝时响亮:fetch FAILED: Request was cancelled.
```

补充探针:`node:https` 模块同被覆盖(拒绝时
`Failed to establish tunnel to example.com:443 …: HTTP/1.1 403 Forbidden`);
`NO_PROXY=localhost,127.0.0.1,::1` 时 loopback fetch 直连(正是
`ensureLoopbackNoProxy()` 的形状);**裸 `net.Socket` 完全绕过 env-proxy 直连成功**
(engine 是自有受信代码,此面见 §6)。

⇒ **引擎自身的全部 HTTP(S) 出网已经过一根由 alpha 代码显式接的管**:把
`HTTP(S)_PROXY` 指到哪,引擎的模型请求与远程 MCP 就汇到哪。
注意 E14b:**这不是 env 变量的功劳,是 `useEnvProxy()` 调用的功劳** ——
少了那一行,同样的 env 下 fetch 静默直连。

### 3.2 B:工具子进程(shell / MCP stdio / LSP)

- **env 通道已经存在**:`utilityProcess.fork(sidecar.js, [], { env: createSidecarEnv() })`
  (`packages/ui-mac/src/main/server.ts:292-296`),A6 白名单(`sidecar-env.ts:45-52`)
  显式放行整个代理变量族;上游以 `{ ...process.env }` spread 把 sidecar env 原样传给
  每个子进程(ADR-005)。⇒ 给 sidecar env 写一对 `HTTP(S)_PROXY`,所有**自愿服从**的
  子进程即汇入同一点(服从性矩阵见 §4.2)。
- **但 env 是自愿协议**:node v22 的 fetch 无视它(§4.2 实测直连 200)、裸 socket 无视它、
  恶意进程当然无视它。**强制层只能是 seatbelt**,而且不能罩在 sidecar 上 ——
  `utilityProcess.fork` 收 JS 模块路径,没有可垫 `sandbox-exec` 的 exec 缝;能罩的是
  文件轴已裁决的 C1 wrapper(shell 工具 + prompt `!command`):同一个 wrapper、
  同一张 profile,追加网络三行(§5)。继承语义 §1.6 已证:罩住 shell 即罩住其全子树。
- MCP stdio 与 LSP 是独立 spawn,不走 shell wrapper —— 与文件轴 §4 完全同格:
  MCP spawn 文件已收编(ADR-041,加围栏新增收编 0),LSP `launch.ts` 未收编(+1)。

### 3.3 C:Electron main 与 renderer

main 自己 `setGlobalProxyFromEnv()`(自愿汇入,同 A);renderer 是 Chromium 网络栈
(系统代理语义),updater 走 electron-updater —— 两者都不经 A/B 的任何一层,列为
本轴不覆盖面(§6)。它们不在 #1073 的结果定义(「工具派生的进程」)内。

## 4. 两条替代路径的代价(勘破 4)

### 4.1 纯 seatbelt 网络策略:否决(作为目的地策略)

| 判据 | 结果 |
| --- | --- |
| 能表达 §2.2 清单吗 | 不能:无主机名/IP 谓词(§1.1),端口 host-blind(§1.5),放行集全在 443(§2.2) |
| fake-IP 拓扑下有意义吗 | 无:匹配的是假地址(§2.1) |
| 造出来是什么 | 「允许 443」= 允许一切 HTTPS —— 形式政策、实际全通的假闸门 |

**保留价值恰好一项:强制汇流。** deny-all + 单端口 allow 是全部实验里唯一 8/8 精确、
fail-closed、且孙进程继承的原语 —— 它做不了策略,但能逼所有流量去见策略。

### 4.2 本地代理(codex 形态):策略粒度成立,TLS 无需证书注入,但单独没有强制力

**策略粒度**:CONNECT 行自带 `host:port` 明文(fake-IP 拓扑下唯一的目的地真相,§2.1),
按主机名授权在这里天然可判。实测各客户端对 env 代理的服从性与**拒绝时的失败形态**
(代理恒答 403 的拒绝式日志代理):

| 客户端 | 发 CONNECT? | 403 时的行为 |
| --- | --- | --- |
| curl 8.7.1 | 是(`CONNECT example.com:443` 落日志) | 响亮:`CONNECT tunnel failed, response 403`,exit 56 |
| git 2.50.1(https) | 是(`github.com:443`) | 响亮:`fatal: unable to access …: CONNECT tunnel failed, response 403` |
| npm 10.9.8 | 是(`registry.npmjs.org:443`) | 响亮:`npm error code E403` |
| uv 0.10.10 | 是(`pypi.org:443`,重试 4 次) | 响亮:`Request failed after 3 retries` |
| gh 2.88.1 | 是(`api.github.com:443`) | 响亮:`Forbidden` |
| bun 1.3.14 `fetch` | 是 | **怪癖:把代理的 403 CONNECT 应答当作目标响应返回**(`status 403`,不抛错)—— 策略可见,但应用侧归因混淆;策略代理的拒绝体要带可识别正文 |
| node v22 `fetch` | **否 —— 静默直连成功**(v22 无 `setGlobalProxyFromEnv`) | 逃逸类:证明代理单独不构成闸门 |
| ssh(ProxyCommand 显式指向) | 是(`CONNECT github.com:22` 落日志) | 端到端未走通(§7);策略面已可判 |

**TLS 与证书注入的回答**:目的地级管控只看 CONNECT 行,**隧道内 TLS 端到端不动**
—— E7.2 里 curl 经真隧道代理拿到 200,校验的是 github 的真证书,全程无任何 CA 注入。
需要 MITM CA 的只有**内容**审查,那不在 #1073 的结果定义里。(若将来要走到那一步,
引擎侧信任系统钥匙串的机制已存在:`index.ts:557` / `sidecar.ts:194` —— 是既有事实,
不是本轴的建议。)

**边界**:代理是 alpha-code 的本地组件(main 进程内或 main 拉起的 loopback 进程),
策略注册表在 alpha-code 配置里 —— **不跨 `alpha-platform` 边界**,不触发按 L 处理的
跨仓条件。

### 4.3 失败方向(两层合并后)

- 代理进程死:B 类直连被 seatbelt 即时拒(`Failed to connect … after 0 ms`,EPERM),
  A 类经代理失败响亮(§3.1)—— **fail-closed,不 fail-open**;
- 代理活着但目的地未登记:403,八个客户端里七个响亮报错、一个(bun)可见但归因混淆;
- seatbelt 在而代理白名单过宽:退化为今天的 env-proxy 现状,不比现状差。

## 5. 裁决

**混合咽喉:seatbelt(加法形状)做强制汇流,本地 CONNECT 代理做目的地策略。**
两者单独都不成立 —— seatbelt 表达不了目的地(§1),代理没有强制力(§4.2 的 node22 行)。

- 汇流层(C1 wrapper 的 profile 追加,与文件轴同一个 wrapper):

  ```
  (deny network*)
  (allow network-outbound (remote ip "localhost:<chokePort>"))
  ```

  写法纪律:**只加法**;禁止出现 `(allow … "localhost:*")` 与任何端口特定 deny
  (§1.3 的失效组合);DNS 默认不放行 —— 走代理的客户端由代理解析,试图直连的
  客户端死在解析这一步,更早更响。
- 策略层:loopback CONNECT 代理,按「host:port ∈ 注册表」放行/403;注册表是代码里
  单一权威,首轮默认集 = §2.2 清单。
- 引擎汇入:sidecar env 的 `HTTP(S)_PROXY` 指向同一 `<chokePort>`(接线已存在,§3.1)。

## 6. 本咽喉结构上管不到的面

| 面 | 状态 | 理由 |
| --- | --- | --- |
| shell 工具 / prompt `!command` 子进程树 | **覆盖(强制)** | C1 wrapper + §1.6 继承 |
| 引擎进程内 HTTP(S) | 覆盖(自愿,自有代码) | §3.1;`useEnvProxy()` 是 alpha 行为,不是可被子进程撤销的约定 |
| 引擎进程内裸 `net.Socket` | **不覆盖** | env-proxy 不经手(P2d 实测直连);engine 为受信面,列出以防未来引入 |
| MCP stdio 子进程 | 不覆盖(本轮) | 独立 spawn;加围栏落点在已收编的 MCP spawn 文件(ADR-041,+0) |
| LSP 子进程 | 不覆盖(本轮) | `lsp/launch.ts` 未收编,+1 |
| Electron main / renderer / updater | 不覆盖 | §3.3;不在 #1073 结果定义内 |
| ssh 出网(端口 22) | 不覆盖(响亮失败) | 默认死在 DNS/直连;可经 ProxyCommand 汇入(§7 端到端未验) |
| Windows | 不覆盖 | 无对应实现 |

## 7. 未验证 / 残余风险

- **打包 sidecar 上未复跑。** E14 用的是同版本 Electron 的 dev 二进制
  (`ELECTRON_RUN_AS_NODE`);「打包产物里 `useEnvProxy()` 同样生效」尚未在 packaged
  形态实跑。实现票必须在打包产物上复验 §3.1 三态。
- **ssh 经 CONNECT 的端到端未走通。** CONNECT 行已到达策略点(可判),但 macOS `nc -X
  connect` 对极简应答报 `Proxy error: "HTTP/1.1 200 Connection Established"` 后断开
  —— 是取证代理的兼容性问题还是 `nc` 的,未定;真代理实现需带 ssh 客户端实测。
- **bun 作为运行时的完整代理语义未展开。** 只测了「发 CONNECT + 403 映射为响应状态」;
  bun 子进程(bun 写的 MCP server)的 NO_PROXY/ALL_PROXY 细节未测。
- **拓扑 A(本机 7897 系统代理)下未复跑本轮矩阵。** 测量时刻该形态不在场;引用的是
  `ac#1108` 同日记录。两形态并存的事实本身已足以支撑 §2.1 的两条推论。
- **electron-updater 是否服从 env-proxy 未测**(不在结果定义内,列出防误引用)。
- **`(deny network*)` 对 unix socket 的完整覆盖范围未枚举** —— 只验证了
  mDNSResponder literal 这一个例外可独立放行;其它系统 unix socket(如 syslog)在
  deny-all 下的行为未逐一探测(文件轴 §2.5 的误伤检查 7/7 通过时用的是
  `allow default` 底座,不含 `deny network*`)。实现票的误伤语料必须在
  **network-deny 底座**上重跑一遍文件轴 §2.8 那组正常开发命令。

## 8. 用法

本文档是 REQ-137(`#1073`)AC 与实现票的对照物:AC 的咽喉点表述、profile 写法纪律
(§5)、放行集初值(§2.2)与未验证项(§7)都以此为基准。任何与 §1–§4 冲突的断言,
先复跑再改文档,不要改实现去迁就散文。
