---
title: 打包首启 sidecar-ready 之后的目录就绪成本（归因）
kind: architecture
status: active
owners:
  - alpha-code desktop maintainers
last_reviewed: 2026-08-10
review_after: 2026-11-10
---

# 那十八秒是什么

`alpha-code#881` 要归因的是打包签名 app **首次启动**时,从 sidecar 报 ready 到目录真正
可操作之间那一段。REQ-109/110 T7 的五样本里,它是最大的一个数字,也是唯一一个至今没有
成因的。

本文分三层,层与层之间**不许混着读**：

1. **已成立的分账** —— 每一项都能从已入库的证据里逐条对上账;
2. **本轮修掉的观测缺陷** —— 归因需要的分项,此前在仪表下结构上产不出来;
3. **未验证的候选** —— 机制清楚但**一次都没实测过**,以及各自的判别实验。

第 3 层的每一条都标着「未验证」。照 `2026-08-10-catalog-readiness-signals.md` 已立的
口径:凡未跑的一律标未验证,论证充分不等于事实成立。

## 0. 口径

| | |
| --- | --- |
| 证据 | `docs/verification/2026-08-06-req109-110-t7-runtime/results/byok-only-f991100a.json` |
| 采集于 | 2026-08-07T08:49:39Z |
| 被测构建 | `alpha-code@8f023b7c`,app SHA-256 `f991100a…` |
| 场景 | `byok-only`,5 个样本(样本 1 = 干净用户目录的**首启**) |
| 时间原点 | main 模块装载(`main.timeline.epoch`) |

**这份证据已经过期。** 它采集之后,`#870`(bound the first governed model catalog)与
`#882`(屏障改由 `catalog.updated` 唤醒、去掉 1.5s 自超时与指数退避)都改了这条路径。
本文第 1 层说的是「那一版当时确实发生了什么」,以及「哪些部分 `#882` 结构上削不掉」;
**第 1 层的数字不能当作今天的性能**,重测的前置见第 4 节。

## 1. 已成立的分账

### 1.1 样本 1（首启）：18139.0ms 的六段拆解

`bootReadyMs = 1912.9`(`main.sidecar.generation.emit phase=ready reason=boot`),
目录可操作 `startupMs = 20051.9`(首条 `renderer.home.model_list.end outcome=ok`),
差 **18139.0ms**。逐段：

| 段 | 起 → 止 | 耗时 | 是什么 |
| --- | --- | ---: | --- |
| A | ready 1912.9 → `renderer.root.mount` 2467.0 | 554.2 | 窗口/渲染进程起来 |
| B | 2467.0 → 首次 `model_list.start` 2699.0 | 232.0 | renderer 走到首屏取数 |
| C | 4 次探测窗口(各 ~1501ms) | 5991.6 | 屏障在探 marker |
| D | 3 段退避空窗(1003.1 + 2003.4 + 4002.5) | 7009.0 | **一个探针都不发** |
| E | 第 4 次失败 15699.7 → 胜出请求发起 20047.3 | 4347.7 | 见 §1.3 |
| F | 胜出的 `v2.model.list` 往返 | 5.1 | 热路径 |

合计 554.2 + 232.0 + 5991.6 + 7009.0 + 4347.7 + 5.1 = **18139.6ms**(与 18139.0 的
0.6ms 差来自各段各自四舍五入)。

### 1.2 真收敛耗时的下界：≥13786.8ms —— 以及它依赖的那个前提

第 4 次探测窗口在 **15699.7ms** 仍未就绪。该版屏障(`8f023b7c` 的
`model-contract.ts`)的兜底轮询档位是 **`catalogReadyPollMs ?? 10`** —— 窗口内每 10ms
重探一次。若窗口内探针**真的在连续发**,那么 15699.7ms 的「未就绪」是**被测方的回答**,
不是客户端计时器的自述:

> 真收敛时刻 ≥ 15699.7ms ⇒ **sidecar ready 之后至少还要 15699.7 − 1912.9 = 13786.8ms**。

**这个下界有一个前提,而现有证据判不了它**:窗口内也可能是**一次探针悬挂了整整 1.5s**
(该版给每个探针配的 deadline 就是窗口剩余时间),那样「1501ms 未就绪」就退回成客户端
计时器的自述,下界不成立。两种形态在时间线上**产生完全相同的记录**,因为当时没有任何
一条标记录探针轮数。

⇒ 这正是本轮补的 `renderer.home.catalog_ready.probes` 存在的理由(§2)。重测那一刻,
`probes` 是几,这条下界就自己成立或自己作废,不再需要论证。

**第 4 次失败之后没有第 5 次**:该链(`chain=2`)的下一次退避排在 15699.7 + 8000 ≈
23.7s,而窗口在那之前就结束了(§1.3)。

### 1.3 `startupMs = 20051.9` 有一部分是运气

胜出的那次读取**不是**一直在等的那条链。时间线上 20047.3ms 发起的是
`attempt=1 chain=1` —— 另一个 home composer 实例的首次取数,5.1ms 返回。真就绪时刻
只知道落在 **(15699.7, 20047.3]** 这个区间内的某处,再窄不了。

所以 20051.9 这个数字**高估了目录就绪时刻**,高估幅度取决于真就绪落在区间的哪里。
`#882` 之后等待链自己会在真就绪那一刻返回,这个偏差自然消失 —— 这是「必须在 `#882`
之后重测」的又一条理由。

### 1.4 样本 2–5：退避空窗一毫秒延迟都没造成

| 样本 | ready | 首次探测窗口 | 退避空窗 | 第 2 次尝试 | 就绪 | 差 |
| ---: | ---: | --- | ---: | --- | ---: | ---: |
| 2 | 1103.5 | 1479.9 → 2973.1 | 1002.7 | 3975.8,`durationMs=359.0` | 4333.8 | 3230.3 |
| 3 | 1088.3 | 1554.1 → 3043.8 | 1003.6 | 4047.3,`durationMs=453.6` | 4499.8 | 3411.5 |
| 4 | 1097.6 | 1484.4 → 2974.8 | 1003.2 | 3978.0,`durationMs=459.3` | 4436.1 | 3338.6 |
| 5 | 1109.5 | 1485.7 → 2974.9 | 1003.5 | 3978.5,`durationMs=1012.7` | 4989.8 | 3880.3 |

四个样本同一形态:第 2 次尝试**自己又轮询了几百毫秒到一秒**才拿到 200 ⇒ 真就绪时刻
落在**退避空窗结束之后**。空窗全部落在真就绪之前 ⇒ 它一毫秒延迟都没造成。

### 1.5 由此可以断言的一件事

`#882` 削掉的是**计时器伪影**:退避空窗 + 「等待方比被等待方先放弃」的那段。按上面的
分账,伪影的**上界**是:

- 样本 1：只有段 E 的 4347.7ms(段 D 的 7009.0ms 全部落在真就绪之前,削不掉);
- 样本 2–5：≈ 0。

⇒ **`#882` 单独最多把首启从约 20.0s 改善到约 15.7s。`#857` 的「≤2s」闸依旧红,而 `#881`
要归因的那 ≥13.8s(若 §1.2 的前提成立)原封不动。** `#882` 是把这块**显式交接**给 `#881`
的,不是吃掉它 —— `2026-08-10-catalog-readiness-signals.md` §2/§4 已经写明这一点。

## 2. 本轮修掉的观测缺陷（票面写死的前置）

票面说「现有探针测不到真就绪时刻」,并给了两条备选补救:去掉自超时,或补一条带时间戳的
就绪事件。**第一条已由 `#882` 落地**(屏障今天只有三个退出条件:marker 答了 / 真实故障 /
调用方取消,没有任何 deadline)。剩下的一半没做,而且 `#882` 之后**分辨率反而降了** ——
旧版屏障每 1.5s 自己失败一次,反倒在时间线上留下 4 组 start/end + 3 个 retry_tick;
`#882` 之后同一次首启只剩一对 start/end 和一个标量 `durationMs`。

| 缺陷 | 后果 | 本轮 |
| --- | --- | --- |
| 「目录真就绪时刻」在系统里**没有表示**。最接近的载体 `renderer.home.model_list.end.durationMs` 把三个成因不同的量压成一个标量:屏障等待(冷启动十几秒,不是故障)、唤醒来自事件还是 250ms 兜底、随后的 `v2.model.list` 往返(热路径 5–50ms)。 | 归因要的分项结构上产不出来 | 新标 `renderer.home.catalog_ready`,带 `barrierMs` / `probes` / `pollWaits` / `wake` |
| `prewarmInitialLocation` 算出了结局与耗时,`sidecar.ts` 把它消费进 `console.log`/`console.warn` 就丢掉:**不进 ready IPC、不进 startup timeline**。而 `phase=ready` 结构上不等于「目录已收敛」——非 ready 也照发 ready。 | 「ready 为什么早了十几秒」在打包证据里没有任何字段可以回答 | ready IPC 带 `prewarmOutcome` / `prewarmMs` / `prewarmStatus`,落到 `main.sidecar.ready_ipc` |
| 2s 硬顶到期被折进 `{outcome:"failed", error:"…timed out"}` 的**自由文本** | 「ready 是等满硬顶照发的」不可判 | 升成自己的一格 `timed-out` |
| 取证侧 `probe.ts` 的 `MAX_WAIT_MS = 25_000` 与被测量**同量级**(样本 1 已用掉 20.05s) | 首启若更慢,一次数字取证会变成 `timeout after 25000ms` —— 与本票要消灭的「客户端计时器冒充被测方答复」同源,只是搬到了取证侧 | 抬到 60_000 |
| `probe.ts` 落库时有一张事件**允许清单**,`main.sidecar.ready_ipc` 与 `main.sidecar.boot.fork.*` 不在其中 | 数据当时就在盘上的时间线文件里,却没进证据文件 ⇒ 归因时结构上无从查起 | 三条标补进清单;证据 `schema` 升 `…/v2` |

**刻意不做**:每轮探针一条标。首启收敛实测约 16s,250ms 一档就是约 64 条标,每条都过
IPC + sanitize + 落盘 —— 观测自己会污染要归因的那一段(`#882` 已经为同一理由把兜底从
10ms 放宽到 250ms)。一条**汇总**标加三个计数已经够拆分项。

## 3. 已被排除的候选（实读代码，不需真机）

### 3.1 models.dev 的冷取**不在**打包关键路径上

- 打包 sidecar 走 `packages/opencode/script/build-node.ts` 的 `define: { OPENCODE_MODELS_DEV: … }`;
- `packages/core/src/models-dev.ts` 的 `populate` 顺序是 `loadFromDisk → loadSnapshot → fetch`。
  冷 cache 时 `loadFromDisk` 落空、`loadSnapshot` 命中 ⇒ **`populate` 不联网**;
- 联网只发生在同文件里 `Effect.forkScoped` 的**后台** `refresh()`。

### 3.2 成本不在引擎的目录逻辑本身

旁证来自 `2026-08-10-catalog-readiness-signals.md` 的实跑:**裸引擎**(无 snapshot、
冷 cache、真联网)在 700–874ms 就发 `catalog.updated`,marker 在 **669.5ms** 就绪,
`/api/model` 在 725.2ms 给出 26 个模型。与打包首启的 ≥13.8s 差**20 倍**。

⇒ 打包首启的成本不是「引擎算目录慢」。它落在打包/首启**独有**的某件事上,而那件事在
裸引擎的实跑里不存在。

## 4. 未验证的候选，以及各自的判别实验

**以下全部未验证。** 列出它们是为了让下一轮真机取证有**可判别的题目**,不是结论。

### 4.1 首启独有的一次 catalog 全量 reload（未验证）

机制:冷 cache ⇒ `models-dev.ts` 的 `fresh()` 为假 ⇒ 后台 `refresh()` 联网(`fetchApi`
自带 `Effect.timeout("10 seconds")`)⇒ 成功后 `invalidate` 并发 `Event.Refreshed` ⇒
`packages/core/src/plugin/models-dev.ts` 订阅它并触发 `ctx.integration.reload()` +
`ctx.catalog.reload()`。TTL 是 **5 分钟**,而 T7 的样本 2–5 是连跑 ⇒ 它们**结构上跳过**
这次 reload。

这是目前唯一能解释「首启与后续差在**种类**而不是程度」的机制,而且 `fetchApi` 的 10s
超时与 §1.2 的 ≥13.8s 量级相当。**但它一次都没实测过。**

判别实验(**不需要真机窗口**):裸引擎 + 冷 `XDG_CACHE_HOME`,`OPENCODE_DISABLE_MODELS_FETCH`
开/关各跑 N 次,量 marker first-ready。注意裸引擎没有 `OPENCODE_MODELS_DEV` define,要用
`OPENCODE_MODELS_PATH` 指一份快照来复现「snapshot 命中 + cache 冷 + 后台 refresh 照跑」
这个打包形状,否则关掉 fetch 时 `populate` 会返回 `{}`,量到的是另一件事。

### 4.2 macOS 首次启动不可避免项（未验证，且**本机测不了**）

Gatekeeper 首次校验、dyld 闭包构建、首次 Keychain 解锁、模块解析。app 自己的时间线
**结构上看不见**它们:它们全部发生在我们第一条标之前或之外。要测须外部观测
(`log stream --predicate 'subsystem == "com.apple.syspolicy"'` 之类)+ 一台从未装过
该签名版本的干净机器。

⇒ 票的退出条件第三条「哪些是 macOS 首次启动不可避免的」**本轮给不出**。

### 4.3 prewarm 的 2s 硬顶在首启是否到期（未验证，但已可读出）

§2 做完之后,`main.sidecar.ready_ipc` 会直接给出 `prewarmOutcome` 与 `prewarmMs`,
三种结局各自可判:`ready` / `unavailable`(引擎答了非 2xx)/ `timed-out`(我们自己的
硬顶把它掐了)。

一条**反向**的间接旁证:样本 1 的 ready 在 1912.9ms,而 sidecar 在 681.4ms 才报
recovering ⇒ prewarm 大概率在 2s 硬顶**之前**就收场了。若属实,那么让 `phase=ready`
早于真就绪的机制**不是硬顶到期**,而是「marker 答了非 2xx 也照发 ready」——
`prewarmOutcome` 一读便知。这条同样未验证。

### 4.4 `INITIAL_LOCATION_PREWARM_TIMEOUT_MS` 是不是一个**真的**硬顶（未验证）

现实现把硬顶做成 `AbortController` + `new Request(url, { signal })`,靠被调方观察
`request.signal` 才生效。**内嵌 app 的处理器是否观察它,没有实测过。** 若不观察,则
「ready 最多等待 2s」这条已登记的保证在「处理器悬挂」这一形态下不成立(表现是 sidecar
一直不 ready,直到 `SIDECAR_START_STALL_TIMEOUT`)。

本轮**没有**改这个语义(那是行为变更,不是观测),只把结局做成可判。**这是一条独立的
待验事实,不属于 `#881` 的归因结论。**

## 5. 票的退出条件，现在各欠什么

| 退出条件 | 状态 |
| --- | --- |
| 一条能测到真就绪时刻的探针,证据入库 | 探针**已具备**(§2);「证据入库」欠一次真机打包首启 —— bun 测试证明得了发标逻辑,证明不了它穿过 preload IPC → main sanitize → 落盘 |
| 首启那 ~16 秒的分项归因,每项带实测数字 | §1 给出了**旧构建**的六段分账与下界推导;`#870`/`#882` 之后还剩多少,只能真机测 |
| 可压缩到多少 / 哪些是 macOS 首启不可避免的 | **欠着**。前者依赖上一行,后者依赖 §4.2 的外部观测 + 一台干净机器 |

重测的硬前置:重新打包 → codesign/notarize/staple → 干净用户目录 → `probe.ts` 起 CDP
驱动真实窗口。旧五样本**作废**,不能与新样本混着算(证据 `schema` 已因此升 v2)。
