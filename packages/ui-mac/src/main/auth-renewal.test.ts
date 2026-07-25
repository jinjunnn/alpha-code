import { afterEach, describe, expect, test, vi } from "bun:test"
import {
  AUTH_RENEWAL_DEGRADED_INTERVAL_MS,
  AUTH_RENEWAL_MIN_INTERVAL_MS,
  awaitBootRenewalGrace,
  authRenewalDelayMs,
  createAuthRenewalScheduler,
  createTokenRotationLatch,
  degradedRenewalDelayMs,
  TOKEN_ROTATION_RETRY_MS,
} from "./auth-renewal"
import { MIN_USABLE_TOKEN_LIFETIME_MS } from "./alpha-auth-clock"
import type { RenewalResult } from "./alpha-auth"

const result = (outcome: RenewalResult["outcome"], generation = 1): RenewalResult => ({
  outcome,
  generation,
})

afterEach(() => vi.useRealTimers())

/** 让 renew() 的 then/finally 链跑完(fake timers 下不能靠真实 setTimeout 让路)。 */
const settleRenewal = async () => {
  for (let tick = 0; tick < 5; tick++) await Promise.resolve()
}

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

// #600 B3:签发端返回 200 却给不出可用有效期时,按 refreshDueAt 的最小间隔重刷会变成永久
// 重刷循环(与 #601 同类)。结果不可用 ⇒ 降频续跑;恢复可用 ⇒ 立刻回到正常节奏。
describe("degraded renewal cadence after an unusable response", () => {
  // ③″1 强制手段:调度地板与「可用寿命」下界必须是同一个数,否则「寿命短于地板即不可用」
  // 这条判据会随任一侧改动悄悄失真。
  test("the scheduler wake floor is the same constant as the usable-lifetime floor", () => {
    expect(AUTH_RENEWAL_MIN_INTERVAL_MS).toBe(MIN_USABLE_TOKEN_LIFETIME_MS)
  })

  // R2 新 Major1:固定 15 分钟降频会从失败时刻重新计时,越过旧凭证真实到期点 ——
  // 15 分钟 token 在第 10 分钟拿到 unusable,旧 token 只剩 5 分钟,却被排到第 25 分钟:
  // 中间约 10 分钟不可用,且到期那一刻没有任何 timer 触发 auth-state 发布。
  test("the degraded delay never lands after the currently verified expiry", () => {
    const now = 1_000_000
    const lifetimeMs = 15 * 60_000
    // 第 10 分钟进入续期窗口,旧 token 还剩 5 分钟 → 下一次必须正好落在到期点。
    expect(degradedRenewalDelayMs({ active: true, expiresAt: now + 5 * 60_000, lifetimeMs }, now)).toBe(5 * 60_000)
    // 降频只会把下一次**推后**,不会提前:正常判据本来就要等 55 分钟时,按正常判据。
    // (推论:凭证还活着时,降频的实际效果恒为「最晚在到期点唤醒一次」——
    //  因为 base ≥ untilExpiry − 提前量,15 分钟节奏只有在到期后才真正生效。)
    expect(degradedRenewalDelayMs({ active: true, expiresAt: now + 60 * 60_000, lifetimeMs }, now)).toBe(55 * 60_000)
    // 余量比调度地板还短 → 地板兜底(只多一次,随后进入完整降频)。
    expect(degradedRenewalDelayMs({ active: true, expiresAt: now + 10_000, lifetimeMs }, now)).toBe(
      AUTH_RENEWAL_MIN_INTERVAL_MS,
    )
    // 已过期/有效期未知:没有余量可保护,用完整降频节奏(不得回到 30 秒重刷)。
    expect(degradedRenewalDelayMs({ active: true, expiresAt: now - 1, lifetimeMs }, now)).toBe(
      AUTH_RENEWAL_DEGRADED_INTERVAL_MS,
    )
    expect(degradedRenewalDelayMs({ active: true }, now)).toBe(AUTH_RENEWAL_DEGRADED_INTERVAL_MS)
    expect(degradedRenewalDelayMs({ active: false }, now)).toBeNull()
  })

  // R2 新 Minor1:降频只对当时那份凭证成立 —— 换了凭证(登录/任何路径的成功续期)必须立刻作废,
  // 否则新拿到的正常 token 白白损失提前量(15 分钟 token 被排到 900000 而不是 600000)。
  test("a new credential clears the degrade even before the next renewal runs", async () => {
    vi.useFakeTimers()
    let now = 1_000_000
    let expiresAt = now + 15 * 60_000
    const arms: Array<number | null> = []
    const scheduler = createAuthRenewalScheduler({
      timing: () => ({ active: true, expiresAt, lifetimeMs: 15 * 60_000 }),
      now: () => now,
      renew: async () => ({ outcome: "unusable-response", generation: 2 }),
      onArm: (_reason, delayMs) => arms.push(delayMs),
    })

    scheduler.rearm("startup")
    now += 10 * 60_000
    vi.advanceTimersByTime(10 * 60_000)
    await settleRenewal()
    expect(arms.at(-1)).toBe(5 * 60_000) // 降频但不越过到期点

    expiresAt = now + 15 * 60_000 // 新登录换来的正常凭证
    scheduler.rearm("auth-change")
    expect(arms.at(-1)).toBe(10 * 60_000) // 完整提前量,不是 900000
    scheduler.stop()
  })

  test("an unusable-response arms the degraded interval and a usable one restores the normal cadence", async () => {
    vi.useFakeTimers()
    let now = 1_000_000
    let outcome: RenewalResult["outcome"] = "unusable-response"
    const expiresAt = now + 15 * 60_000
    const arms: Array<number | null> = []
    const scheduler = createAuthRenewalScheduler({
      timing: () => ({ active: true, expiresAt, lifetimeMs: 15 * 60_000 }),
      now: () => now,
      renew: async () => ({ outcome, generation: 2 }),
      onArm: (_reason, delayMs) => arms.push(delayMs),
    })

    scheduler.rearm("startup")
    expect(arms.at(-1)).toBe(10 * 60_000) // 正常:按 refreshDueAt

    now += 10 * 60_000
    vi.advanceTimersByTime(10 * 60_000)
    await settleRenewal()
    // 不可用 ⇒ 降频;且封顶到当前已验证到期点(此刻旧 token 还剩 5 分钟)。
    expect(arms.at(-1)).toBe(5 * 60_000)
    expect(arms.at(-1)).toBeGreaterThan(AUTH_RENEWAL_MIN_INTERVAL_MS)

    outcome = "refreshed"
    now += 5 * 60_000
    vi.advanceTimersByTime(5 * 60_000)
    await settleRenewal()
    expect(arms.at(-1)).toBe(AUTH_RENEWAL_MIN_INTERVAL_MS) // 恢复可用 ⇒ 回到正常判据
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

  // R1 Major3:respawn 入口抛出(publish 异常等)必须收敛成一次失败并照常武装重试 ——
  // 否则 rejection 把 latch 连同重试定时器一起带走,正是 ③′3 禁止的无定时器终局。
  test("a respawn entry that throws is treated as a failed attempt and still arms the retry", async () => {
    const timers: Array<{ run: () => void; delayMs: number }> = []
    let attempts = 0
    let throwing = true
    let forked = 1
    const latch = createTokenRotationLatch({
      forkedGeneration: () => forked,
      canRespawn: () => true,
      respawn: async () => {
        attempts++
        if (throwing) throw new Error("publish exploded")
        forked = 2
        return true
      },
      setTimer: (run, delayMs) => {
        timers.push({ run, delayMs })
        return setTimeout(() => {}, 0)
      },
      clearTimer: (timer) => clearTimeout(timer),
    })

    expect(await latch.accept(result("refreshed", 2), "renewal")).toBe(false)
    expect(attempts).toBe(1)
    expect(timers.map((timer) => timer.delayMs)).toEqual([TOKEN_ROTATION_RETRY_MS])

    throwing = false
    timers[0].run()
    expect(await latch.flush()).toBe(true)
    expect(attempts).toBe(2)
  })

  // R2 新 Major2:onApplied 必须报「实际健康 fork 的那一代」。respawn 队列会把 token-only 请求
  // 与随后的 structural follow-up 合并成一个 composite:latch 等到的 true 可能对应一次实际
  // fork 了**更新**一代的换血。报 target 会让更新的那代永远等不到解除 ⇒ 平台永久 recovering。
  test("onApplied reports the generation the live sidecar actually carries, not the requested target", async () => {
    let forked = 1
    const applied: number[] = []
    const latch = createTokenRotationLatch({
      forkedGeneration: () => forked,
      canRespawn: () => true,
      // 队列 follow-up 实际 fork 了 G3,而本次请求的 target 是 G2。
      respawn: async () => {
        forked = 3
        return true
      },
      onApplied: (generation) => applied.push(generation),
    })

    expect(await latch.accept(result("refreshed", 2), "renewal")).toBe(true)
    expect(applied).toEqual([3])
  })

  // 同类的第二条路:accept 时该代已经在效力中(boot fork 直接带上了)。返回 false 会让
  // refreshTokens 判 applied:false,平台面永远停在 recovering。
  test("accepting a generation the sidecar already carries reports it as applied", async () => {
    const applied: number[] = []
    let respawns = 0
    const latch = createTokenRotationLatch({
      forkedGeneration: () => 5,
      canRespawn: () => true,
      respawn: async () => {
        respawns++
        return true
      },
      onApplied: (generation) => applied.push(generation),
    })

    expect(await latch.accept(result("refreshed", 5), "boot-grace")).toBe(true)
    expect(respawns).toBe(0)
    expect(applied).toEqual([5])
  })

  // 第三条路:pending 期间外部(boot fork / 队列)带上了该代,随后的 flush 必须解除。
  test("a pending generation adopted externally is reported applied on the next flush", async () => {
    let forked = 1
    let respawnable = false
    const applied: number[] = []
    const latch = createTokenRotationLatch({
      forkedGeneration: () => forked,
      canRespawn: () => respawnable,
      respawn: async () => true,
      onApplied: (generation) => applied.push(generation),
      setTimer: () => setTimeout(() => {}, 0),
      clearTimer: (timer) => clearTimeout(timer),
    })

    expect(await latch.accept(result("refreshed", 2), "boot-grace")).toBe(false)
    expect(applied).toEqual([])

    forked = 2 // boot fork 起来时就带上了这一代
    expect(await latch.flush()).toBe(true)
    expect(applied).toEqual([2])
  })

  // R2 新 Minor2:onApplied 的消费方(auth publish)仍可能抛;latch 不得被它 derail。
  test("an onApplied consumer that throws does not derail the latch", async () => {
    let forked = 1
    const latch = createTokenRotationLatch({
      forkedGeneration: () => forked,
      canRespawn: () => true,
      respawn: async () => {
        forked = 2
        return true
      },
      onApplied: () => {
        throw new Error("renderer gone")
      },
    })

    expect(await latch.accept(result("refreshed", 2), "renewal")).toBe(true)
  })

  // #600 M1:换血真正应用是「平台恢复中 → ready」的唯一解除点;失败不得回调。
  test("onApplied fires only when a generation is actually applied", async () => {
    const applied: number[] = []
    const timers: Array<{ run: () => void }> = []
    let healthy = false
    let forked = 1
    const latch = createTokenRotationLatch({
      forkedGeneration: () => forked,
      canRespawn: () => true,
      respawn: async () => {
        if (!healthy) return false
        forked = 2
        return true
      },
      onApplied: (generation) => applied.push(generation),
      setTimer: (run) => {
        timers.push({ run })
        return setTimeout(() => {}, 0)
      },
      clearTimer: (timer) => clearTimeout(timer),
    })

    await latch.accept(result("refreshed", 2), "renewal")
    expect(applied).toEqual([])

    healthy = true
    timers[0].run()
    await latch.flush()
    expect(applied).toEqual([2])
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
