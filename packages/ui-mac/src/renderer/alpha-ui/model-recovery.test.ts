import { afterEach, describe, expect, test, vi } from "bun:test"
import {
  accountResultState,
  createRetryWakeup,
  loadEngineModelsWithRetry,
  shouldApplySidecarState,
} from "./model-recovery"

afterEach(() => vi.useRealTimers())

describe("model recovery state semantics", () => {
  test("distinguishes loading, transient recovery, hard failure, and success", () => {
    const initial = "loading"
    expect(initial).toBe("loading")
    expect(accountResultState({ error: "network" })).toBe("recovering")
    expect(accountResultState({ error: "http-503" })).toBe("recovering")
    expect(accountResultState({ error: "contract-incompatible" })).toBe("failed")
    expect(accountResultState({ balanceFen: 0 })).toBe("ready")
  })
})

describe("sidecar generation ordering", () => {
  test("accepts recovering to ready and rejects stale snapshot regressions", () => {
    const recovering = { status: "recovering", generation: 4, reason: "token-only" } as const
    const ready = { status: "ready", generation: 4, reason: "token-only" } as const

    expect(shouldApplySidecarState(undefined, recovering)).toBe(true)
    expect(shouldApplySidecarState(recovering, ready)).toBe(true)
    expect(shouldApplySidecarState(ready, recovering)).toBe(false)
    expect(shouldApplySidecarState(ready, { status: "ready", generation: 3, reason: "boot" })).toBe(false)
    expect(shouldApplySidecarState(ready, { status: "recovering", generation: 5, reason: "structural" })).toBe(true)
  })

  // #577:failed 是同代第二种终态 —— recovering → failed 必须放行(否则 live 事件被静默
  // 丢弃),终态恰好一次:同代 failed 之后不得再变 ready(迟到恢复走自探或新 generation),
  // ready 也不得回退成 failed;新 generation 一律放行。
  test("failed 终态:recovering→failed 放行,同代终态之间互不转换,新代放行", () => {
    const recovering = { status: "recovering", generation: 6, reason: "boot" } as const
    const failed = { status: "failed", generation: 6, reason: "boot" } as const
    const ready = { status: "ready", generation: 6, reason: "boot" } as const

    expect(shouldApplySidecarState(undefined, failed)).toBe(true)
    expect(shouldApplySidecarState(recovering, failed)).toBe(true)
    expect(shouldApplySidecarState(failed, ready)).toBe(false)
    expect(shouldApplySidecarState(failed, recovering)).toBe(false)
    expect(shouldApplySidecarState(ready, failed)).toBe(false)
    expect(shouldApplySidecarState(failed, { status: "recovering", generation: 7, reason: "structural" })).toBe(true)
    expect(shouldApplySidecarState(failed, { status: "ready", generation: 7, reason: "structural" })).toBe(true)
  })
})

describe("engine model list retry (#594 闩死点二)", () => {
  test("无预算悬崖:超过旧 20 次预算后仍持续退避,传输恢复即 loaded", async () => {
    const delays: number[] = []
    let attempts = 0
    // 前 25 次失败(> 旧 20 次预算),第 26 次成功 = 传输恢复后的下一个 tick
    const read = () => {
      attempts++
      return attempts >= 26 ? Promise.resolve(["m1"]) : Promise.reject(new Error("transport down"))
    }
    let recoveringSignals = 0
    let cleared = 0
    const result = await loadEngineModelsWithRetry({
      initial: read(),
      read,
      wait: (delayMs) => {
        delays.push(delayMs)
        return Promise.resolve("elapsed")
      },
      clearWake: () => cleared++,
      isStale: () => false,
      onAttemptFailed: () => recoveringSignals++,
    })
    expect(result).toEqual({ status: "loaded", data: ["m1"] })
    expect(recoveringSignals).toBe(25)
    expect(delays.length).toBe(25)
    // 1s/2s/4s/8s 封顶退避;耗尽后绝不出现「不再安排任何定时器」
    expect(delays.slice(0, 4)).toEqual([1000, 2000, 4000, 8000])
    expect(Math.max(...delays)).toBe(8000)
    expect(cleared).toBe(1)
  })

  test("唤醒信号(wait=cancelled)同样推进重试并透传给 retry tick", async () => {
    let attempts = 0
    const read = () => {
      attempts++
      return attempts >= 2 ? Promise.resolve("ok") : Promise.reject(new Error("down"))
    }
    const ticks: Array<{ attempt: number; wait: string }> = []
    const result = await loadEngineModelsWithRetry({
      initial: read(),
      read,
      wait: () => Promise.resolve("cancelled"),
      clearWake: () => {},
      isStale: () => false,
      onAttemptFailed: () => {},
      onRetryTick: ({ attempt, wait }) => ticks.push({ attempt, wait }),
    })
    expect(result).toEqual({ status: "loaded", data: "ok" })
    expect(ticks).toEqual([{ attempt: 2, wait: "cancelled" }])
  })

  test("链被 supersede/卸载时循环立即退出(stale)", async () => {
    let stale = false
    const result = await loadEngineModelsWithRetry({
      initial: Promise.reject(new Error("down")),
      read: () => Promise.reject(new Error("down")),
      wait: () => {
        stale = true
        return Promise.resolve("elapsed")
      },
      clearWake: () => {},
      isStale: () => stale,
      onAttemptFailed: () => {},
    })
    expect(result).toEqual({ status: "stale" })
  })
})

describe("retry wakeup", () => {
  test("generation-ready cancels backoff residue immediately and only settles once", async () => {
    vi.useFakeTimers()
    const cancellations: string[] = []
    const wakeup = createRetryWakeup({
      onCancel: (reason) => cancellations.push(reason),
    })
    const waiting = wakeup.wait(8_000)

    vi.advanceTimersByTime(4_000)
    wakeup.wake("generation-ready")
    wakeup.wake("generation-ready")
    expect(await waiting).toBe("cancelled")
    expect(cancellations).toEqual(["generation-ready"])
    wakeup.dispose()
  })

  test("a signal arriving during an in-flight request cancels the next scheduled residue", async () => {
    const cancellations: string[] = []
    const wakeup = createRetryWakeup({
      onCancel: (reason, outcome) => cancellations.push(`${reason}:${outcome}`),
    })
    wakeup.wake("sse-reconnected")

    expect(await wakeup.wait(8_000)).toBe("cancelled")
    expect(cancellations).toEqual(["sse-reconnected:queued"])
    wakeup.dispose()
  })

  test("a successful request can discard a queued recovery signal", async () => {
    const wakeup = createRetryWakeup()
    wakeup.wake("generation-ready")
    wakeup.clear()

    const waiting = wakeup.wait(1)
    expect(await waiting).toBe("elapsed")
    wakeup.dispose()
  })
})
