---
title: 两处网络等待形态到底会挂多久（勘破）
kind: architecture
status: active
owners:
  - alpha-code desktop maintainers
last_reviewed: 2026-08-23
review_after: 2026-11-23
---

# 一个有 10 秒超时、一个没有，跑出来的结论跟读代码猜的不一样

`packages/core` 里有两条对外抓取链，读代码时形态可疑：

- `models-dev.ts:169-176` 把 `Effect.timeout("10 seconds")` 罩在**重试外面**——
  罩的是「3 次尝试的总和」，不是每次；
- `skill/discovery.ts:76-83` 用同一份 `retryTransient({ times: 2 })`，
  但整条 `download` / `pull` 链**没有任何 `Effect.timeout`**。

票面引的那条全仓事实本次复跑过，但要说准一点：
`grep -rna 'Effect\.timeout(' packages/core/src packages/opencode/src` 命中 **8 处**
（watcher、websocket-tracker、proxy、pty、account、instruction、processor 各一，
外加 `models-dev.ts:174`）；票面那个更窄的 `"[0-9]* seconds"` 字面量模式才是
「只有 `models-dev.ts:174`」。**两种读法都指向同一件事：`skill/discovery.ts`
的整条链上一处都没有。**

本文只回答一个问题：**这两处在真实运行里会不会产生用户可见的挂起。**
每条断言都来自本机装着的那份代码的一次真实执行；凡未实跑的一律标「未验证」（§7）。

结论先写：**①不是缺陷（但票面「结构上不可能超过 10s」这句前提是错的）；
②是缺陷，但不是「无限等」——它被运行时 `fetch` 的默认超时兜在 300 秒一次、
三次共约 900 秒，而且这 900 秒是用户可观察的阻塞。**

## 0. 测量口径

| | |
| --- | --- |
| 仓 | `alpha-code@aded4ed59`（`origin/alpha`） |
| 宿主 | macOS 26.3.1 (25D2128) / Darwin 25.3.0 arm64（xnu-12377.91.3） |
| 运行时 | bun 1.3.14（被测进程）；node v22.22.3（可控 endpoint + 对照探针）；`effect@4.0.0-beta.83` |
| 被测对象 | `packages/core/src/models-dev.ts` 与 `packages/core/src/skill/discovery.ts` 的**真模块真 Layer**（`AppNodeBuilder.build` + `Layer.fresh`，真 `FetchHttpClient`）。隔离只做两件事：models-dev 侧用 `XDG_CACHE_HOME`/`XDG_STATE_HOME` 等把 `Global.Path.*` 指到每次运行新建的临时目录；discovery 侧把 `Global.node` 换成 `Global.layerWith({ cache })`（与 `packages/core/test/skill-discovery.test.ts` 同法） |
| 可控 endpoint | 自建 `node:http` 服务，按首段路径分流：`fast` 立即 200 / `hang` 永不回包 / `slow30` 30s 后 200 / `e500` 立即 500 / `e500s5` 5s 后 503；`requestTimeout`、`headersTimeout`、`keepAliveTimeout`、`timeout` 全部置 0 |
| 观测面 | 客户端墙钟 + 服务端每条请求的**到达 / 被 abort / 关闭**时刻。墙钟有两个取法：`runPromise` 外侧（含 Layer 拆除开销）与 effect 内侧（不含），差别与后果见 §2.4 的「注」 |
| 机器负载 | 采样时同机另有 5 条 lane 在跑，`load average` 记在每行样本上（2.95–9.30） |
| 日期 | 2026-08-23 |

取证脚本是一次性的、不入仓；结论以下面的原始输出为准。

**判据分辨率**：`≤10s` vs `>10s`、`有界` vs `无界`、`socket 被 abort` vs `socket 还开着`。
几百毫秒噪声翻不动这几条；贴 10s 边界的样本另见 §2.3 的处理。

## 1. 先证明手段能测出「快」

「量到很慢」在没有反向对照时可能只是量错了。两条链都先打立即回 200 的
endpoint，各两轮：

| 样本 | 墙钟 | 服务端看到的请求 | 结果 |
| --- | --- | --- | --- |
| `md-fast-r1` | **50 ms** | 1（`/fast/api.json` 200） | `success keys=acme` |
| `md-fast-r2` | **43 ms** | 1 | `success keys=acme` |
| `sk-fast-r1` | **19 ms** | 2（`index.json` + `deploy/SKILL.md`） | 返回 1 个技能目录 |
| `sk-fast-r2` | **18 ms** | 2 | 同上 |

`keys=acme` 是我在 endpoint 里放的 provider 名——说明走的是生产的 `JSON.parse(text)`，
不是我在旁边模拟的东西。这一步同时证明：服务端日志确实记得下请求（后面「0 次请求」的
断言才有意义）。

## 2. ① `models-dev.ts` 的 10 秒超时：真的中断

### 2.1 三种慢法，九个样本，全部 10.0 秒

`OPENCODE_MODELS_URL` 指向可控 endpoint，进程 argv 带 `--get-yargs-completions`——
那是 `models-dev.ts:249` 的**生产分支**，跳过后台 refresh fork，因此恰好只跑一次
`populate()`。

| 样本 | endpoint | 墙钟 | 服务端尝试数 | 服务端观测 | load |
| --- | --- | --- | --- | --- | --- |
| `md-hang-r1` | 永不回包 | **10,032 ms** | 1 | 到达后 **9,997 ms** 被 abort | 5.11 |
| `md-hang-r2` | 永不回包 | **10,055 ms** | 1 | 9,996 ms 被 abort | 4.28 |
| `md-hang-r3` | 永不回包 | **10,052 ms** | 1 | 9,999 ms 被 abort | 4.15 |
| `md-slow30-r1` | 30s 后 200 | **10,036 ms** | 1 | 9,998 ms 被 abort | 5.30 |
| `md-slow30-r2` | 30s 后 200 | **10,062 ms** | 1 | 9,999 ms 被 abort | 4.33 |
| `md-slow30-r3` | 30s 后 200 | **10,041 ms** | 1 | 9,999 ms 被 abort | 3.90 |
| `md-e500s5-r1` | 5s 后 503 | **10,044 ms** | 2 | 第 2 次到达后 4,802 ms 被 abort | 7.16 |
| `md-e500s5-r2` | 5s 后 503 | **10,049 ms** | 2 | 4,791 ms 被 abort | 4.35 |
| `md-e500s5-r3` | 5s 后 503 | **10,047 ms** | 2 | 4,804 ms 被 abort | 3.99 |

九个样本全部以 `Cause([Die(TimeoutError)])` 收场。

**关键判据不是那个 10,0xx 的数字，是服务端看到 socket 被 abort。**
墙钟只能说明「effect 放弃了等」；`req_aborted` 说明**连接真的被 AbortController 掐了**——
`Effect.timeout` 的中断确实穿透到了 fetch 层，没有留下一条无人认领的在飞请求。

### 2.2 超时罩的确实是「三次尝试的总和」

`md-e500s5` 那一组把这件事拆开了：

```
req        id=1  /e500s5/api.json      rel=+351 ms
res_sent   id=1  status=503            rel=+5,353 ms      ← 第 1 次尝试，花掉 5.0s
req        id=2  /e500s5/api.json      rel=+5,547 ms      ← 退避 194 ms 后第 2 次
req_aborted id=2                       rel=+10,349 ms     ← 在飞状态下被掐断
```

即：超时**不是**每次尝试各给 10 秒，而是罩住整条重试阶梯，到点从半路掐断。
**推算**（非实测）：按这里实测的每次 5.0 s 与 §3.3 实测的三级阶梯，
没有这道超时时同一 endpoint 要花 ≥15 s。

### 2.3 关于 10 秒边界的负载敏感性

本机采样时另有 5 条 lane 在跑（load 3.0–9.3）。九个样本的墙钟落在
**10,032–10,062 ms**，离散 30 ms；服务端侧的单次尝试寿命落在
**9,996–10,008 ms**，离散 12 ms。这个量级下 CPU 饥饿不足以把结论从
「超时生效」翻成「超时没生效」，而且结论主要挂在 §2.1 那条结构性证据
（socket 被 abort）上，不挂在阈值比较上。

### 2.4 但「结构上不可能超过 10s」这句是错的

票面写「`Effect.timeout` 若真中断，这条路径结构上不可能超过 10s」。
去掉 `--get-yargs-completions`（= 生产默认 argv，`models-dev.ts:249-251` 的后台
refresh fork 会起）之后，**首次 `get()` 会和那条 fork 抢同一把 `Flock`**：
抢输的一方等锁，等到之后再自己跑一轮 10 秒。15 个样本，分两批（两批的差别只是
计时位置，见下面的「注」）：

| 批 | 计时位置 | 单轮（1 次请求） | 双轮（2 次请求） |
| --- | --- | --- | --- |
| r1–r7 | `runPromise` **外**侧 | 6 个：10,205 / 10,538 / 11,151 / 11,218 / 11,343 / 11,370 ms | 1 个：**21,772 ms** |
| r8–r15 | effect **内**侧 | 4 个：10,007 / 10,008 / 10,019 / 10,023 ms | 4 个：**20,615 / 20,662 / 21,018 / 21,464 ms** |

即**双轮形态 5/15**。双轮那一支的服务端时序（`md-hang-forked-r1`，相对 `t0`）：

```
req         +57 ms        req_aborted  +10,054 ms
req      +11,753 ms       req_aborted  +21,755 ms
```

两轮各自都被 10 秒超时准时掐断（单次尝试寿命 9,997 / 10,002 ms）。
**所以上界是 ~2×10s + 中间那段等待，不是 10s。** 它仍然是**有界**的，
超时本身没有失效——错的是「只会有一轮 fetch」这个隐含前提。

中间那 1,699 ms 落在 `flock.ts` 的退避区间内
（`baseDelayMs:100 / maxDelayMs:2000` 指数退避），这是最直接的解释，
但本次**没有单独证伪其它成因**（例如 effect 的 fiber 调度）。

> **注（观测手段自己有盲区）**：r1–r7 在 `runPromise` 外侧计时，单轮读出
> 10.2–11.4 s；r8–r15 把计时挪进 effect 内部后，单轮一律 10,007–10,023 ms。
> 多出来的 0.9–2.5 秒是 **Layer scope 拆除**时中断那条 fork 纤程的开销
> ——是我的取证脚本的成本，不是用户的等待。若不改计时位置，这一节会写出
> 一个偏大 10%~24% 的数字，并且看起来完全合理。

### 2.5 出货形态里这条路根本不 fetch

上面的 10 秒 / 21 秒只在「无快照 + 无磁盘缓存 + 允许 fetch」时才付得出去。
两条出货路径各自实跑过：

| 形态 | 依据 | 实测墙钟 | 服务端请求数 | 返回 |
| --- | --- | --- | --- | --- |
| Alpha 桌面（默认） | `packages/ui-mac/src/main/server.ts:227` 把 `OPENCODE_DISABLE_MODELS_FETCH` 默认置 `"1"` | **39 ms** | **0** | `{}` |
| 编译产物带快照 | `packages/opencode/script/build.ts:195` 把 `OPENCODE_MODELS_DEV` define 进二进制 | **28 ms** | **0** | `keys=snapshotProvider` |

第一行的「0 次请求」是**代码级保证 + 实测**：`OPENCODE_DISABLE_MODELS_FETCH`
为真时 `populate` 直接 `return {}`（`models-dev.ts:216`），后台 refresh fork
也整段不起（`models-dev.ts:249`），实测服务端一条请求都没收到。

第二行用 `bun --define OPENCODE_MODELS_DEV=...` 复现 build 时的 define，
走的是 `models-dev.ts:192-194` 的 `loadSnapshot` 分支；`populate` 在
`loadFromDisk → loadSnapshot → fetch` 的顺序下**够不到 fetch**。
**这一行只证明「阻塞路径不 fetch」**：该进程在 28 ms 后就 `process.exit(0)` 了，
后台 refresh fork 有没有发请求本次没测到。那条 fork 本身的行为就是 §2.1 量到的
「10 秒有界」，而且它是 `Effect.forkScoped` + `Effect.ignore`，不挡任何调用方。

**⇒ ① 判定：不是缺陷。** 超时真中断（§2.1/2.2），最坏形态有界（§2.4），
而两条出货形态里这段网络等待压根不在用户路径上（§2.5）。

## 3. ② `skill/discovery.ts`：不是无限等，是 15 分钟

### 3.1 四个样本，两轮独立采样，全部 900.5–900.7 秒

| 样本 | 挂的是哪一跳 | `pull()` 墙钟 | 尝试数 | 每次尝试寿命 | 返回 |
| --- | --- | --- | --- | --- | --- |
| `sk-hangidx-r1` | `index.json` | **900,655 ms** | 3 | 300,008 / 300,008 / 300,008 | `[]` |
| `sk-hangidx-r2` | `index.json` | **900,588 ms** | 3 | 300,008 / 300,009 / 300,009 | `[]` |
| `sk-hangfile-r1` | `SKILL.md`（index 正常 200） | 400 s 处被我截断 | ≥2 | 299,999 / … | —（截断） |
| `sk-hangfile-r2` | `SKILL.md`（index 正常 200） | **900,536 ms** | 3 | 300,001 / 300,010 / 300,008 | `[]` |

`sk-hangidx-r1` 的服务端时序（相对服务器启动）：

```
req          id=1  /hang/index.json   rel=+353 ms
req_aborted  id=1                     rel=+300,361 ms     ← 第 1 次，活了 300,008 ms
req          id=2                     rel=+300,594 ms
req_aborted  id=2                     rel=+600,602 ms     ← 第 2 次，300,008 ms
req          id=3                     rel=+600,988 ms
req_aborted  id=3                     rel=+900,996 ms     ← 第 3 次，300,008 ms
```

客户端：`elapsedMs 900,655`，`outcome success`，`detail []`，
并打出 `ERROR failed to fetch skill index`，`_tag: "TransportError"`，
`cause: DOMException { name: "TimeoutError", code: 23 }`。

即：**每次尝试被运行时的 `fetch` 默认超时兜在 300 秒**，
`retryTransient({ times: 2 })` 把它乘成 3 次，
总计 **约 900.6 秒 ≈ 15 分 1 秒**，然后吞掉错误返回空列表。

两轮相隔约 7 分钟启动，端口与临时缓存目录都不同；三个跑完的样本离散 119 ms。
（`sk-hangfile-r1` 是第一轮，被我设的 400 s 上限截断——它只用来证明
「400 秒时还没放弃」，完整阶梯由第二轮跑出。）

### 3.2 文件下载同形，而且技能整个丢掉

index 正常 200、技能文件永不回包时，`download` 走同一条阶梯
（`sk-hangfile-r2`，相对服务器启动）：

```
req  id=1  /idxfast-filehang/index.json        rel=+351 ms   → 200
req  id=2  /idxfast-filehang/deploy/SKILL.md   rel=+359 ms
req_aborted id=2                               rel=+300,360 ms
req  id=3  （同一文件，第 2 次尝试）            rel=+300,527 ms
req_aborted id=3                               rel=+600,537 ms
req  id=4  （第 3 次尝试）                      rel=+600,864 ms
req_aborted id=4                               rel=+900,872 ms
```

`pull()` 在 900,536 ms 后返回 **`[]`**：`download` 的失败被
`discovery.ts:92-94` 的 `Effect.logError(...).pipe(Effect.as(false))` 吞掉，
但 `discovery.ts:201-204` 最后要 `fs.exists(root/SKILL.md)`，文件没落盘 ⇒
这个技能不进结果。**用户付了 15 分钟，什么也没拿到，界面上只是「没有这个技能」。**

### 3.3 5xx 会走满三级阶梯

`retryOn: "errors-and-responses"` 对状态码也重试——手测「能不能连上」看不出这条：

| 样本 | 服务端请求数 | 墙钟 | 返回 |
| --- | --- | --- | --- |
| `sk-e500idx-r1` | **3** | 650 ms | `[]` |
| `sk-e500idx-r2` | **3** | 598 ms | `[]` |
| `md-e500-r1` | **3** | 618 ms | `Die(StatusCodeError 500)` |
| `md-e500-r2` | **3** | 549 ms | 同上 |

退避实测 ≈ 200 ms、≈ 460 ms（`Schedule.exponential(200).jittered`）。

## 4. 那道 300 秒的天花板是谁的

「每次尝试恰好 300 秒」这个数字，必须先排除「是我的测试服务器把连接掐了」。
同一台服务器、同一时刻，两个**独立客户端**并发打同一个 `hang` 路径：

```
{"client":"bun-fetch","elapsedMs":300011,"error":"TimeoutError: The operation timed out."}
{"client":"curl","elapsedSec":420,"out":"000","err":"curl: (28) Operation timed out after 420005 milliseconds with 0 bytes received"}
```

服务端侧：

```
req         id=1 /hang/probe-curl   rel=+40 ms
req         id=2 /hang/probe-bun    rel=+42 ms
req_aborted id=2                    rel=+300,050 ms    ← bun 自己放弃
req_aborted id=1                    rel=+420,044 ms    ← curl 自己到 --max-time
```

`curl` 在同一台服务器上**挂了 420 秒、0 字节、服务端一直没关**——
所以 300 秒是**客户端 `fetch` 的默认超时**，不是这台测试服务器的行为。

换 node v22.22.3 再打一次同样的 `hang` 路径（独立服务器实例）：

```
{"client":"node-fetch","elapsedMs":301448,"error":"TypeError: fetch failed","cause":"HeadersTimeoutError: Headers Timeout Error"}
req_aborted  id=1  /hang/probe-node   rel=+301,507 ms
```

即 undici 的 `headersTimeout` 默认值，也是 300 秒量级——**错误的类型不同
（bun 抛 `DOMException TimeoutError`，node 抛 `TypeError: fetch failed` /
`HeadersTimeoutError`），但两者都会被 `FetchHttpClient` 包成
`HttpClientError{reason: TransportError}`**（`FetchHttpClient.ts` 的
`Effect.tryPromise` catch 分支），而 `HttpClient.ts:1974-1979` 的
`isTransientError` 对 `TransportError` 判 transient ⇒ 两个运行时都会走满 3 次。

**这一条决定了 ② 的措辞**：`discovery.ts` 不是「无限等」，而是
「把上界完全交给了运行时默认值」。上界因此**随运行时而变**，见 §7。

## 5. 走我们自己的代码，到得了 ② 这个状态吗

到得了，而且不需要任何非常规部署形态：

| 环节 | 坐标 |
| --- | --- |
| 配置字段 | `packages/core/src/config.ts:90-91` —— `skills: string[]`，描述原文 "Additional paths or URLs to discover skills from" |
| v1 同款 | `packages/core/src/v1/config/skills.ts:10` —— "URLs to fetch skills from" |
| 变成 URL 源 | `packages/core/src/config/plugin/skill.ts:35-36` —— 条目能 `URL.canParse` 且协议是 `http(s)` ⇒ `UrlSource` |
| 阻塞点 | `packages/core/src/skill.ts:76` —— `SkillV2.load` 内联 `yield* discovery.pull(source.url)` |
| 谁在等 | `packages/server/src/handlers/skill.ts:7`（`skill.list` RPC）、`packages/core/src/tool/skill.ts:72`（skill 工具）、`packages/core/src/skill/guidance.ts:49`（提示词组装） |

即：用户在配置里写一条会黑洞掉的 `https://…` 技能源，
`skill.list` 与提示词组装会阻塞约 15 分钟（每进程首次；`skill.ts:109` 的
`cache` Map 之后不再重复付）。

**但 Alpha 自己不产生这种配置**：`engine-config-truth.ts:34-45` 与
`factory-skills.ts` 只往 `skills.paths` 写**绝对本地目录**；
全仓 `grep -rna 'type: "url"' --include='*.ts'` 在非测试代码里共 3 处命中，
其中只有 `config/plugin/skill.ts:36` 是技能源的构造点，
另两处是生成的 SDK 类型声明（`packages/sdk/js/src/v2/gen/types.gen.ts:7199`）
与 console 里 anthropic provider 的同名字段（无关）。

**⇒ ② 判定：是缺陷（有界，但界大到用户可观察），可达路径只有「用户手写配置」。**
是否要修、修成什么样，不在本勘破票内（生产代码未改，见 §8）。

## 6. 覆盖边界

| 面 | 状态 |
| --- | --- |
| `models-dev.ts` 的 `fetchApi` 超时行为 | 覆盖（§2.1–2.3，9 样本 ×3 endpoint 形态） |
| `models-dev.ts` 首次 `get()` 与后台 fork 的锁竞争 | 覆盖（§2.4，15 样本） |
| `models-dev.ts` 的 disable / snapshot 两条出货分支 | 覆盖（§2.5，各 1 样本，判据是「服务端 0 次请求」而非耗时） |
| `discovery.ts` index / 文件下载的挂起上界 | 覆盖（§3.1/3.2） |
| `discovery.ts` 的 5xx 阶梯 | 覆盖（§3.3） |
| 300 秒天花板的归属 | 覆盖（§4，双客户端独立对照） |
| `Flock` 自身的 `timeoutMs: 5 * 60_000` 到期行为 | **不覆盖**——本次没有构造「另一进程长期持锁」的场景 |
| DNS 解析阶段的挂起 | **不覆盖**——全部打 `127.0.0.1` |
| TLS 握手阶段的挂起 | **不覆盖**——全部走明文 http |
| 「回了 header 但 body 慢慢滴」的形态 | **不覆盖**——`hang` 是 header 都不回 |
| Windows / Linux | 不覆盖 |

## 7. 未验证 / 残余风险

- **未验证：Electron utilityProcess（= Alpha 出货引擎）里的 900 秒。**
  §3 的四个 `pull()` 样本全部在 **bun 1.3.14** 下跑，而 Alpha 桌面的引擎是
  `utilityProcess.fork(sidecar.js)`（`packages/ui-mac/src/main/server.ts:290`），
  跑的是 **Electron 的 Node**（`sidecar.ts` 顶部注释自述 "the packaged Electron-Node
  sidecar"）。已做的对齐只有两条：裸 node v22.22.3 的单跳天花板实测 301,448 ms（§4），
  以及重试分类的**源码读数**（`HttpClient.ts:1974-1979` + `FetchHttpClient.ts` 的
  catch 分支）。**没有在 node 下端到端跑过 `SkillDiscovery.pull`，更没有在打包产物里跑过。**
  要拿「15 分钟」这个数去做产品决策，先在打包 sidecar 上复跑 §3。
- **未验证：Electron 是否覆盖 undici 的 `headersTimeout` 默认值。** Electron 的
  net 栈与 Node 的 undici 不是同一份配置，本次未测。
- **未验证：§2.4 双轮形态的触发率对机器负载的依赖。** 5/15 是本机在
  load 2.95–9.30 下的观测，不是一个稳定的概率。
- **未验证：`OPENCODE_MODELS_PATH` 分支。** `populate` 的 `loadFromDisk` 会优先读它，
  本次没有构造这条路径。
- 本文所有 endpoint 都是本机 `127.0.0.1` 明文 http，与真实网络（DNS、TLS、
  中间设备、代理）之间的差异未测。

## 8. 本票没有做的事

- **没有改任何生产代码。** `packages/core/src/models-dev.ts` 与
  `packages/core/src/skill/discovery.ts` 都在收编白名单之外，未被触碰；
  取证脚本一次性、不入仓。
- 没有给 ② 提修法。§5 的判定只说「是缺陷」，修不修、怎么修，另开票裁决。
