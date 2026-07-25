import { afterEach, describe, expect, test, vi } from "bun:test"
import {
  AUTH_RENEWAL_MIN_INTERVAL_MS,
  awaitBootRenewalGrace,
  authRenewalDelayMs,
  createAuthRenewalScheduler,
  createTokenRotationLatch,
  TOKEN_ROTATION_RETRY_MS,
} from "./auth-renewal"
import type { RenewalResult } from "./alpha-auth"

const result = (outcome: RenewalResult["outcome"], generation = 1): RenewalResult => ({
  outcome,
  generation,
})

afterEach(() => vi.useRealTimers())

describe("boot renewal grace", () => {
  test("fast renewal wins the 1.2s grace", async () => {
    vi.useFakeTimers()
    let resolve!: (value: RenewalResult) => void
    const renewal = new Promise<RenewalResult>((next) => {
      resolve = next
    })
    const raced = awaitBootRenewalGrace(renewal)
    vi.advanceTimersByTime(1_199)
    resolve(result("refreshed"))

    expect(await raced).toEqual({ completed: true, result: result("refreshed") })
  })

  test("slow renewal releases boot and preserves the background result", async () => {
    vi.useFakeTimers()
    let resolve!: (value: RenewalResult) => void
    const renewal = new Promise<RenewalResult>((next) => {
      resolve = next
    })
    const raced = awaitBootRenewalGrace(renewal)
    vi.advanceTimersByTime(1_200)
    const timeout = await raced

    expect(timeout.completed).toBe(false)
    if (timeout.completed) throw new Error("expected timeout")
    resolve(result("refreshed", 2))
    expect(await timeout.pending).toEqual(result("refreshed", 2))
  })
})

describe("expiresAt scheduler", () => {
  test("uses the 15min TTL due time and enforces the minimum wake interval", () => {
    const now = 1_000_000
    expect(
      authRenewalDelayMs({ active: true, expiresAt: now + 15 * 60_000, lifetimeMs: 15 * 60_000 }, now),
    ).toBe(10 * 60_000)
    expect(authRenewalDelayMs({ active: true, expiresAt: now - 1, lifetimeMs: 15 * 60_000 }, now)).toBe(
      AUTH_RENEWAL_MIN_INTERVAL_MS,
    )
    expect(authRenewalDelayMs({ active: false }, now)).toBeNull()
  })

  test("fires once at refreshDueAt and re-arms on result/resume/login change", async () => {
    vi.useFakeTimers()
    let now = 1_000_000
    let expiresAt = now + 15 * 60_000
    let renewals = 0
    const arms: string[] = []
    const scheduler = createAuthRenewalScheduler({
      timing: () => ({ active: true, expiresAt, lifetimeMs: 15 * 60_000 }),
      now: () => now,
      renew: async () => {
        renewals++
        expiresAt = now + 15 * 60_000
        return result("refreshed", renewals + 1)
      },
      onArm: (reason) => arms.push(reason),
    })

    scheduler.rearm("startup")
    vi.advanceTimersByTime(10 * 60_000)
    now += 10 * 60_000
    await Promise.resolve()
    await Promise.resolve()
    expect(renewals).toBe(1)
    expect(arms).toContain("result")

    scheduler.rearm("resume")
    scheduler.rearm("auth-change")
    expect(arms.slice(-2)).toEqual(["resume", "auth-change"])
    scheduler.stop()
  })
})

describe("token rotation latch", () => {
  test("rotates at most once per refreshed generation", async () => {
    let forked = 1
    let respawns = 0
    const latch = createTokenRotationLatch({
      forkedGeneration: () => forked,
      canRespawn: () => true,
      respawn: async () => {
        respawns++
        forked = 2
        return true
      },
    })

    await Promise.all([
      latch.accept(result("refreshed", 2), "scheduled"),
      latch.accept(result("refreshed", 2), "account-401"),
    ])
    await latch.accept(result("refreshed", 2), "duplicate")
    expect(respawns).toBe(1)
  })

  // #600 B1:失败的 token-only 换血曾是终局(handledGeneration 在 respawn 之前就推进,
  // 同代永不再试)。正确行为 = 该代仍然 pending,由封顶低频 timer 重试,成功后才推进。
  test("a failed token-only respawn keeps the generation pending and retries it on a capped low-frequency timer", async () => {
    let forked = 1
    let healthy = false
    let respawns = 0
    const timers: Array<{ run: () => void; delayMs: number }> = []
    const latch = createTokenRotationLatch({
      forkedGeneration: () => forked,
      canRespawn: () => true,
      // 生产语义:只有健康换血成功才认「当前 sidecar 携带该代」(index.ts 在 healthy 时才提交快照)。
      respawn: async () => {
        respawns++
        if (!healthy) return false
        forked = 2
        return true
      },
      setTimer: (run, delayMs) => {
        timers.push({ run, delayMs })
        return setTimeout(() => {}, 0) // 真 Timer 句柄;重试由测试显式驱动
      },
      clearTimer: (timer) => clearTimeout(timer),
    })

    expect(await latch.accept(result("refreshed", 2), "scheduled")).toBe(false)
    expect(respawns).toBe(1)
    expect(timers.map((timer) => timer.delayMs)).toEqual([TOKEN_ROTATION_RETRY_MS])

    // 不自旋:没有 timer 触发时,重复 accept / 额外 flush 都不得就地再试。
    await latch.accept(result("refreshed", 2), "duplicate")
    await latch.flush()
    expect(respawns).toBe(1)

    // 低频重试:同一 pending generation 再试,成功后回到 ready 语义(healthy=true → forked 推进)。
    healthy = true
    timers[0].run()
    expect(await latch.flush()).toBe(true)
    expect(respawns).toBe(2)
    expect(forked).toBe(2)

    // 成功后不再留悬挂定时器,也不再重试该代。
    expect(timers).toHaveLength(1)
    await latch.accept(result("refreshed", 2), "after-success")
    expect(respawns).toBe(2)
  })

  // ③′3:重试预算耗尽不得进入无定时器终局。sidecar 已死(canRespawn=false)正是那个终局。
  test("a pending generation keeps a capped retry armed even when nothing can be respawned yet", async () => {
    const timers: Array<{ run: () => void; delayMs: number }> = []
    let respawns = 0
    let respawnable = false
    const latch = createTokenRotationLatch({
      forkedGeneration: () => 1,
      canRespawn: () => respawnable,
      respawn: async () => {
        respawns++
        return true
      },
      setTimer: (run, delayMs) => {
        timers.push({ run, delayMs })
        return setTimeout(() => {}, 0) // 真 Timer 句柄;重试由测试显式驱动
      },
      clearTimer: (timer) => clearTimeout(timer),
    })

    await latch.accept(result("refreshed", 2), "renewal")
    expect(respawns).toBe(0)
    expect(timers.map((timer) => timer.delayMs)).toEqual([TOKEN_ROTATION_RETRY_MS])

    respawnable = true
    timers[0].run()
    expect(await latch.flush()).toBe(true)
    expect(respawns).toBe(1)
  })

  test.each(["still-valid", "transient-failure", "invalid-grant"] as const)(
    "%s never requests token-only respawn",
    async (outcome) => {
      let respawns = 0
      const latch = createTokenRotationLatch({
        forkedGeneration: () => 1,
        canRespawn: () => true,
        respawn: async () => {
          respawns++
          return true
        },
      })
      await latch.accept(result(outcome, 2), "test")
      expect(respawns).toBe(0)
    },
  )
})
