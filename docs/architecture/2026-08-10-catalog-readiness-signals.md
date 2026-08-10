---
title: 目录目录就绪有哪些信号（勘破）
kind: architecture
status: active
owners:
  - alpha-code desktop maintainers
last_reviewed: 2026-08-10
review_after: 2026-11-10
---

# 首屏在等的那件事，到底有没有信号

`alpha-code#882` 的题目是「首屏目录改为消费既有就绪事件」。动笔前必须先回答一个
只能靠**跑**回答的问题：**引擎到底发不发一条能用来唤醒首屏的事件？**

本仓记录在案最贵的返工形态是「手写一个别人文法的替身」。所以下面每条关于引擎的
断言，都来自**本机装着的那份引擎**（`packages/opencode/src/index.ts serve`）的一次
真实执行，不是官网、不是记忆、不是读代码推断。凡未实跑的一律标「未验证」。

## 0. 测量口径

| | |
| --- | --- |
| 仓 | `alpha-code@ec6eb4e1`（`origin/alpha`） |
| 被测对象 | `bun run packages/opencode/src/index.ts serve --hostname 127.0.0.1` |
| 隔离 | `XDG_{CONFIG,DATA,STATE,CACHE}_HOME` 全部指向临时目录；trial 2/3 另设 `OPENCODE_CONFIG_DIR` |
| 观测面 | `GET /global/event`（SSE 火喉）+ `GET /api/provider/{id}?location[directory]=…` + `GET /api/model?location[directory]=…` |
| 日期 | 2026-08-10 |

三次 trial 的脚本是一次性取证脚本，不入仓；结论以下面的原始时间线为准。

## 1. 三条实跑事实

### 1.1 `catalog.updated` 真的到得了 renderer，并且带 `directory`

`CatalogV2.finalize` 里 `events.publish(Event.Updated, {})`（`packages/core/src/catalog.ts`）
经 `packages/opencode/src/event-v2-bridge.ts` 补上 `directory` 进 `GlobalBus`，再由
`/global/event` 吐给订阅者。实跑（trial 1，目录冷启动）：

```
[  6.8ms] SSE connected 200
[506.2ms] → GET /api/provider/alpha-internal-catalog-ready   (冷,触发该 directory 的实例引导)
[636.7ms] ← 404
[636.7ms] → GET /api/model
[639.6ms] ← 200  count 0            ← 目录还没收敛,引擎照样 200
[700.1ms] EVENT catalog.updated  directory="…/proj"
[840.7ms] ← 热 /api/model 200  count 6229
[874.4ms] EVENT catalog.updated  directory="…/proj"
```

两条结论：
- 事件到得了，`directory` 是原样回显的字符串。
- **首个 `/api/model` 拿到的是 `count 0`，而热读是 `6229`** —— `#857` 说的那个中间态
  在这次实跑里以「空集」和「未治理全集」两种形态都出现了。屏障不是可选的。

### 1.2 它是**唤醒**，不是**证明**

trial 2 把 `alpha-internal-catalog-ready` 这个 marker provider 写进 `OPENCODE_CONFIG_DIR`
的 `opencode.jsonc`（生产由 `packages/ui-mac/src/main/alpha-config-injection.ts` 写同一形状），
然后一边收事件、一边按 `model-contract.ts` 的方式轮询 marker：

```
[550.5ms] marker probe #1 → 404
[613.6ms] EVENT catalog.updated #1
[614.2ms] marker probe #2 → 404      ← 事件落地 0.6ms 之后,marker 仍然不在
[661.2ms] EVENT catalog.updated #2
[669.5ms] marker probe #3 → 200      ← FIRST READY
[725.2ms] /api/model → count 26

catalog.updated 落在 first-ready 之前的条数：2
```

- **一次冷启动会发多条**，其中包含未治理的中间态提交。
- **事件 #1 之后 0.6ms 的探针仍是 404** —— 把事件当就绪证明，会把 `#857` 修好的东西
  原样打回去。
- 但**至少有一条落在就绪之前**（这里两条），所以它可以当唤醒。

`state.ts` 的 `commit()` 先 `finalize()`（发事件）后 `state = next`（新状态可见），
这条顺序本身也说明事件不能当证明。判据不变：**marker 探针是唯一的就绪证明。**

### 1.3 事件唯一化 = 新的死信道

directory 的实例是**首次请求时懒引导**的。生产里 main 进程的
`sidecar-location-prewarm.ts` 会在 renderer 窗口存在之前就对首页目录发 marker/model 请求 ——
也就是说该目录的全部 `catalog.updated` 都可能在 renderer 连上 `/global/event` **之前**发完。

trial 3 直接构造这个形态：先在**无任何订阅者**的情况下把目录轮询到 ready，再连 SSE。

```
[95.9ms] warmed (marker ready=true) with NO subscriber attached
[98.0ms] SSE connected (late)
==== late subscriber received 0 catalog.updated in 4s
```

**零条。** 只认事件的实现会在这个形态下永久停在 loading —— 比它要替换掉的
「1.5s 自超时 + 指数退避」更坏。**兜底轮询是承重项，不是冗余。**

## 2. 票面前提的一处更正

`#882` 正文说「主进程广播 `main.sidecar.generation.emit phase=ready` 而渲染层不消费它」。
前半句为真，后半句不成立：`alpha-composer.tsx` 一直在订阅 `subscribeRuntimeRecovery`。

真正的问题是**那条事件不是这件事的信号**。`packages/ui-mac/src/main/sidecar.ts` 把 sidecar 的
ready 上报压在 `prewarmInitialLocation` 之后，而后者硬顶 2s
（`sidecar-location-prewarm.ts` 的 `INITIAL_LOCATION_PREWARM_TIMEOUT_MS = 2_000`），
**超时只 `console.warn` 照发 ready**。于是 `phase=ready` 结构上不等于「目录已收敛」——
T7 样本 1 里 ready 在 1912.9ms，而同一个 marker 端点到 15699.7ms 仍不答。

照票面字面实现「就绪事件到达即发起」，只会把第 1 次请求从 2699ms 提前到约 1913ms，
然后以同样的方式失败，而 AC 会以假绿通过。`#882` 因此改为消费**另一条**既有事件
`catalog.updated`；`phase=ready` 的语义与 prewarm 的 2s 硬顶属 `#881` 的归因面，本文不动它。

## 3. 由此定下的设计（`#882` 实现照此）

1. `catalog.updated` 只当**唤醒**：`use-projects.ts` 的 `/global/event` switch 新增一个
   case → `notifyCatalogUpdated(directory)`（`renderer/runtime-recovery.ts`）。
2. marker 探针仍是**唯一的就绪证明**，`#857` 的屏障一字不动。
3. 屏障不再有独立 deadline。旧实现在 1.5s 处把「还没收敛」抛成一次请求失败，交给
   1/2/4/8s 指数退避，而**退避窗口内一个探针都不发**。现在退出条件只剩两个：marker 答了，
   或调用方取消。
4. **兜底轮询保留**（§1.3），节奏从 10ms 放宽到 250ms：首启收敛实测约 16s，10ms 一档
   意味着约 1600 次进程内 HTTP，兜底自己会拖慢 `#881` 要归因的那段。
5. 每次网络往返各自带硬超时（悬挂防御，2026-07-12），**不再**从一个总 deadline 里切；
   调用方传的是**链的生命期**信号，不是一个固定预算。

报数时事件路径与兜底路径必须分开说：事件路径的「事件到达 → 请求发起」是 0 个计时器 tick，
兜底路径最坏是一个轮询周期。混成一个 P95 就看不出信道是不是死的。

## 4. 已知未验证

- 本文全部数据来自**裸引擎**（`packages/opencode` serve）。打包 Electron sidecar 上的
  真实时间线没有在本票内复测 —— 那需要真机启动，属 `#881`/L2 的取证面。
- `directory` 字符串在 renderer 与引擎之间是否恒等（软链/`/private` 前缀/尾斜杠）未穷举。
  实跑里是原样回显；不等也只退化成兜底轮询（§1.3 已保证不会因此永久 loading）。
