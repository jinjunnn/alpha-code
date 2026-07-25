import { afterEach, describe, expect, test, vi } from "bun:test"
import {
  accountResultState,
  createRetryWakeup,
  loadEngineModelsWithRetry,
  resolveAccountWithRetry,
  shouldApplySidecarState,
} from "./model-recovery"

/** 假时钟下把退避循环推进到下一次 wait 注册(纯微任务,不依赖真实定时器)。 */
const drain = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

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
    // 防御性断言:按 producer exactly-once 契约,同代 failed 之后不会再产生 ready /
    // recovering、ready 之后不会再产生 failed —— 这三条锁的是「若 producer 违约,
    // consumer 侧过滤器仍拒绝回退/二次终态」的防线,不是真实可达序列。
    expect(shouldApplySidecarState(failed, ready)).toBe(false)
    expect(shouldApplySidecarState(failed, recovering)).toBe(false)
    expect(shouldApplySidecarState(ready, failed)).toBe(false)
    expect(shouldApplySidecarState(failed, { status: "recovering", generation: 7, reason: "structural" })).toBe(true)
    expect(shouldApplySidecarState(failed, { status: "ready", generation: 7, reason: "structural" })).toBe(true)
  })
})

describe("engine model list retry (#594 闩死点二)", () => {
  // R1 加固(item 7):按 rev2b 修订 6,退避语义用假时钟 + 真实 createRetryWakeup 定时器锁,
  // 不再把 wait mock 成立即 resolve。
  test("无预算悬崖(假时钟):超过旧 20 次预算后仍持续 1s/2s/4s/8s 封顶退避,传输恢复唤醒即 loaded", async () => {
    vi.useFakeTimers()
    const wakeup = createRetryWakeup()
    const delays: number[] = []
    let attempts = 0
    // 前 25 次失败(> 旧 20 次预算),第 26 次成功 = 传输恢复后的下一个 attempt
    const read = () => {
      attempts++
      return attempts >= 26 ? Promise.resolve(["m1"]) : Promise.reject(new Error("transport down"))
    }
    let recoveringSignals = 0
    const resultPromise = loadEngineModelsWithRetry({
      initial: read(),
      read,
      wait: (delayMs) => {
        delays.push(delayMs)
        return wakeup.wait(delayMs)
      },
      clearWake: () => wakeup.clear(),
      isStale: () => false,
      onAttemptFailed: () => recoveringSignals++,
    })
    // 前 24 轮由真实定时器 + 假时钟推进(每轮步进 8s = 跨过任意封顶内退避)
    for (let round = 0; round < 24; round++) {
      await drain()
      vi.advanceTimersByTime(8_000)
    }
    // 第 25 轮等待中注入传输恢复(wake),不推时钟 —— 唤醒必须立即打断退避
    await drain()
    wakeup.wake("sse-reconnected")
    const result = await resultPromise
    expect(result).toEqual({ status: "loaded", data: ["m1"] })
    expect(recoveringSignals).toBe(25)
    // 1s/2s/4s/8s 封顶退避;耗尽后绝不出现「不再安排任何定时器」
    expect(delays).toHaveLength(25)
    expect(delays.slice(0, 4)).toEqual([1000, 2000, 4000, 8000])
    expect(Math.max(...delays)).toBe(8000)
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

describe("account summary retry (#594 R1 第 4 实例)", () => {
  // 同类第 4 个预算悬崖:模型链已 ready 而 account 摘要 20 次耗尽后返回 recovering 且
  // 不再安排定时器;wake 落在无人等待的 wakeup 上是空操作,epoch 重启又只看 model 链
  // ⇒ 代理节点永久不可用。修法与 list 同构:无上限封顶退避。
  test("超过旧 20 次预算仍有下一次重试(假时钟),传输恢复唤醒后返回 ready", async () => {
    vi.useFakeTimers()
    const wakeup = createRetryWakeup()
    const delays: number[] = []
    let recovering = 0
    let attempts = 0
    const resultPromise = resolveAccountWithRetry({
      read: async () => {
        attempts++
        return attempts >= 26 ? { plan: "active" } : { error: "network" }
      },
      classify: (result) => ("error" in result ? "recovering" : "ready"),
      wait: (delayMs) => {
        delays.push(delayMs)
        return wakeup.wait(delayMs)
      },
      isStale: () => false,
      onRecovering: () => recovering++,
    })
    for (let round = 0; round < 24; round++) {
      await drain()
      vi.advanceTimersByTime(8_000)
    }
    await drain()
    // 传输恢复注入(生产由 generation-ready / SSE 重连 / 自探通知触发 accountRetryWakeup.wake)
    wakeup.wake("sse-reconnected")
    const result = await resultPromise
    // ready 返回后 composer 直线执行 setPlatformPermission(usable ? "ready" : "failed")
    // (alpha-composer.tsx accountResolution),platformPermission 由此回 ready。
    expect(result).toEqual({ status: "ready", data: { plan: "active" } })
    expect(recovering).toBe(25)
    expect(delays).toHaveLength(25)
    expect(delays.slice(0, 4)).toEqual([1000, 2000, 4000, 8000])
    expect(Math.max(...delays)).toBe(8000)
  })

  test("classify=failed 立即终止并返回 failed(entitlement 否定不重试)", async () => {
    const result = await resolveAccountWithRetry({
      read: async () => ({ error: "contract-incompatible" }),
      classify: (r) => (r.error === "contract-incompatible" ? "failed" : "recovering"),
      wait: () => Promise.resolve("elapsed"),
      isStale: () => false,
      onRecovering: () => {},
    })
    expect(result).toEqual({ status: "failed" })
  })
})

describe("retry wakeup 单槽所有权 (R1 Minor1)", () => {
  test("旧链定时器到期不得抹掉新链的等待:wake 仍能立刻取消 supersede 后的真实定时器", async () => {
    vi.useFakeTimers()
    const wakeup = createRetryWakeup()
    const oldWait = wakeup.wait(1_000) // 链 A(将被 supersede,isStale 会拦下它的结果)
    const newWait = wakeup.wait(8_000) // 链 B 覆盖单槽指针
    vi.advanceTimersByTime(1_000) // A 的旧定时器回调触发 —— 修复前会把 B 的槽位清空
    expect(await oldWait).toBe("elapsed")
    wakeup.wake("generation-ready") // 修复前:槽已空,wake 只能排队,B 残留满 8s
    expect(await newWait).toBe("cancelled")
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
