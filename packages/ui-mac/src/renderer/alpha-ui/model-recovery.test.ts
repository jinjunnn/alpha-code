import { afterEach, describe, expect, test, vi } from "bun:test"
import { accountResultState, createRetryWakeup, shouldApplySidecarState } from "./model-recovery"

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
