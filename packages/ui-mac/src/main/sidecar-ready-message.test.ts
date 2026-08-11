// #613(R1 Blocker 2)最后一英里的**运行时**反向闸门。R1 实证:把 sidecar.ts 的转发表达式
// 变异为 `injectionFailure: injection.error && undefined` 后,四条源码文本锚仍全绿,但实际
// IPC 丢失失败字段 —— 文本锚证明「字样在源码里」,证明不了「值真的上车」。
// 现在 ready 消息构造住在 bun 可真执行的 buildReadyMessage(sidecar.ts 唯一的 ready 通路,
// 接线锚见 alpha-config-injection.test.ts),这里对生产函数的输出做**整体深比较 + 属性存在性**
// 双断言:任何让 injectionFailure 变成 undefined / 缺失 / 改名 / 内容截断的等义改写都当场转红。
import { describe, expect, test } from "bun:test"
import type { LocationPrewarmResult } from "./sidecar-location-prewarm"
import { buildReadyMessage } from "./sidecar-ready-message"

/** 夹具用**独立字面量**,不从生产模块读回来(自指等价链一起改错就一起自洽)。 */
const prewarmUnavailable: LocationPrewarmResult = { outcome: "unavailable", status: 404, durationMs: 118.25 }

describe("buildReadyMessage —— ready IPC 的注入失败字段(#613 运行时闸门)", () => {
  test("失败结果必须整体上车:message/stack 原样挂在 injectionFailure 上", () => {
    const error = {
      message: "ENOSPC: no space left on device, write",
      stack: "Error: ENOSPC\n    at materializeV2EngineConfig",
    }
    // 深比较锁整条消息。R1 变异 `injection.error && undefined` 在此转红:
    // toEqual 期望的是 error 对象本体,undefined 顶不上。
    expect(buildReadyMessage({ ok: false, error }, prewarmUnavailable)).toEqual({
      type: "ready",
      injectionFailure: error,
      prewarmOutcome: "unavailable",
      prewarmMs: 118.25,
      prewarmStatus: 404,
    })
  })

  test("失败结果无 stack 时 message 仍原样上车(stack 可选,不得因缺席改形)", () => {
    const error = { message: "EEXIST: file already exists, mkdir" }
    expect(buildReadyMessage({ ok: false, error }, prewarmUnavailable)).toEqual({
      type: "ready",
      injectionFailure: error,
      prewarmOutcome: "unavailable",
      prewarmMs: 118.25,
      prewarmStatus: 404,
    })
  })

  test("成功结果不得携带 injectionFailure —— 连值为 undefined 的键也不行", () => {
    const msg = buildReadyMessage({ ok: true }, prewarmUnavailable)
    expect(msg).toEqual({
      type: "ready",
      prewarmOutcome: "unavailable",
      prewarmMs: 118.25,
      prewarmStatus: 404,
    })
    // toEqual 把「键缺失」与「键=undefined」视为相等,单靠它挡不住
    // `injectionFailure: injection.ok ? undefined : injection.error` 这类改形 —— 补属性级断言。
    expect("injectionFailure" in msg).toBe(false)
  })

  test("#881 prewarm 的结局与耗时整体随 ready 上车 —— 成功路径也必须带", () => {
    // sidecar 是独立 fork 进程,拿不到 main 的 markStartupTimeline:这条事实进时间线的唯一
    // 通路就是搭 ready 上车。只在失败时带 ⇒ 打包全绿那一次反而无从归因(而 T7 样本 1 恰恰是
    // 「prewarm 早早收场、ready 照发、目录再过 13.8s 才收敛」那一格)。
    const timedOut = buildReadyMessage({ ok: true }, { outcome: "timed-out", durationMs: 2001.5 })
    expect(timedOut).toEqual({ type: "ready", prewarmOutcome: "timed-out", prewarmMs: 2001.5 })
    // 无 status 的结局不得凭空长出一个 —— 写死 `prewarmStatus: 200` 在这里红。
    expect("prewarmStatus" in timedOut).toBe(false)

    // 两支的 outcome / ms / status 三者互不相同 ⇒ 任何写死常量的实现至少在一支上红。
    const ready = buildReadyMessage({ ok: true }, { outcome: "ready", status: 200, durationMs: 87.5 })
    expect(ready).toEqual({ type: "ready", prewarmOutcome: "ready", prewarmMs: 87.5, prewarmStatus: 200 })
  })
})
