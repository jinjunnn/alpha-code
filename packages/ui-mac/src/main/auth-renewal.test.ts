import { afterEach, describe, expect, test, vi } from "bun:test"
import {
  AUTH_RENEWAL_DEGRADED_INTERVAL_MS,
  AUTH_RENEWAL_MIN_INTERVAL_MS,
  awaitBootRenewalGrace,
  authRenewalDelayMs,
  createAuthRenewalScheduler,
  degradedRenewalDelayMs,
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
      authRenewalDelayMs({ active: true, generation: 1, expiresAt: now + 15 * 60_000, lifetimeMs: 15 * 60_000 }, now),
    ).toBe(10 * 60_000)
    expect(authRenewalDelayMs({ active: true, generation: 1, expiresAt: now - 1, lifetimeMs: 15 * 60_000 }, now)).toBe(
      AUTH_RENEWAL_MIN_INTERVAL_MS,
    )
    expect(authRenewalDelayMs({ active: false, generation: 1 }, now)).toBeNull()
  })

  test("fires once at refreshDueAt and re-arms on result/resume/login change", async () => {
    vi.useFakeTimers()
    let now = 1_000_000
    let expiresAt = now + 15 * 60_000
    let renewals = 0
    const arms: string[] = []
    const scheduler = createAuthRenewalScheduler({
      timing: () => ({ active: true, generation: 1, expiresAt, lifetimeMs: 15 * 60_000 }),
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

  // R3 判定:上一版这条测试**自身断言「剩 10 秒 → 30 秒后唤醒」**,正好允许越过到期点 20 秒 ——
  // 一个名字叫「绝不越过」的测试,断言的是越过(第十例假闸门)。重写为逐条锁真规则:
  // 凭证还活着时,返回值恒 ≤ 剩余寿命(即使因此低于唤醒地板)。
  test("while the credential is alive the degraded delay never lands after its expiry", () => {
    const now = 1_000_000
    const lifetimeMs = 15 * 60_000
    const timing = (untilExpiry: number) => ({ active: true, generation: 1, expiresAt: now + untilExpiry, lifetimeMs })

    // 覆盖「远早于到期 / 刚进续期窗口 / 只剩地板 / 远小于地板」四档,逐档锁不越过。
    for (const untilExpiry of [60 * 60_000, 5 * 60_000, 30_000, 10_000, 1]) {
      const delay = degradedRenewalDelayMs(timing(untilExpiry), now, false)
      expect(delay).not.toBeNull()
      expect(delay!).toBeLessThanOrEqual(untilExpiry)
    }

    // 逐档的精确值:第 10 分钟拿到 unusable(剩 5 分钟)→ 正好排在到期点;
    // 剩 10 秒 → 10 秒(**不是**被地板推成 30 秒);正常判据更晚时按正常判据(只推后不提前)。
    expect(degradedRenewalDelayMs(timing(5 * 60_000), now, false)).toBe(5 * 60_000)
    expect(degradedRenewalDelayMs(timing(10_000), now, false)).toBe(10_000)
    expect(degradedRenewalDelayMs(timing(60 * 60_000), now, false)).toBe(55 * 60_000)
    expect(degradedRenewalDelayMs({ active: false, generation: 1 }, now, false)).toBeNull()
  })

  // R3 反例二:睡眠越过到期点 → resume 先 rearm 清掉过期 timer → 旧实现直接返回 900000,
  // 期间没有任何 auth-state 发布,renderer 可继续持有 ready。过期后**尚未尝试过**必须立刻尝试
  // (那次尝试自身发布 recovering),只有尝试过了才允许进入完整降频节奏。
  test("an expired credential must be attempted immediately before the slow cadence may start", () => {
    const now = 1_000_000
    const lifetimeMs = 15 * 60_000
    const expired = { active: true, generation: 1, expiresAt: now - 1, lifetimeMs }
    const unknown = { active: true, generation: 1, lifetimeMs }

    expect(degradedRenewalDelayMs(expired, now, false)).toBe(0)
    expect(degradedRenewalDelayMs(unknown, now, false)).toBe(0)
    expect(degradedRenewalDelayMs(expired, now, true)).toBe(AUTH_RENEWAL_DEGRADED_INTERVAL_MS)
    expect(degradedRenewalDelayMs(unknown, now, true)).toBe(AUTH_RENEWAL_DEGRADED_INTERVAL_MS)
  })

  test("resume after sleeping past the expiry attempts at once instead of going quiet for 15 minutes", async () => {
    vi.useFakeTimers()
    let now = 1_000_000
    const expiresAt = now + 15 * 60_000
    const arms: Array<number | null> = []
    let renewals = 0
    const scheduler = createAuthRenewalScheduler({
      timing: () => ({ active: true, generation: 1, expiresAt, lifetimeMs: 15 * 60_000 }),
      now: () => now,
      renew: async () => {
        renewals++
        return { outcome: "unusable-response", generation: 1 }
      },
      onArm: (_reason, delayMs) => arms.push(delayMs),
    })

    scheduler.rearm("startup")
    now += 10 * 60_000
    vi.advanceTimersByTime(10 * 60_000)
    await settleRenewal()
    expect(arms.at(-1)).toBe(5 * 60_000) // 排在到期点
    expect(renewals).toBe(1)

    // 机器睡过去了:timer 没能在到期点触发,resume 先 rearm 清掉它。
    now += 3 * 60 * 60_000
    scheduler.rearm("resume")
    expect(arms.at(-1)).toBe(0) // 立刻尝试(这次尝试会发布 recovering),不是 900000

    vi.advanceTimersByTime(0)
    await settleRenewal()
    expect(renewals).toBe(2)
    expect(arms.at(-1)).toBe(AUTH_RENEWAL_DEGRADED_INTERVAL_MS) // 尝试过了才进入完整降频
    scheduler.stop()
  })

  // R4:「尝试过」若只记在 Promise 结算后,尝试**在途**与**reject** 两条路都会让 rearm
  // 继续读到 false,于是一次次重新武装 0ms —— 退化成自旋。
  // 复现必须是「先在凭证**还活着**时拿到 unusable(此时不该记账),再让它过期」——
  // 否则第一次尝试自己就把账记上了,变异根本不会露头(这一版之前正是这样写错的)。
  const degradedThenExpiredHarness = (renew: () => Promise<RenewalResult>) => {
    const state = { now: 1_000_000, expiresAt: 1_000_000 + 15 * 60_000 }
    const arms: Array<[string, number | null]> = []
    let pending: (() => void) | undefined
    const scheduler = createAuthRenewalScheduler({
      timing: () => ({ active: true, generation: 1, expiresAt: state.expiresAt, lifetimeMs: 15 * 60_000 }),
      now: () => state.now,
      renew,
      onArm: (reason, delayMs) => arms.push([reason, delayMs]),
      setTimer: (run) => {
        pending = run
        return setTimeout(() => {}, 0) // 真 Timer 句柄;触发由测试显式驱动
      },
      clearTimer: () => {},
    })
    return { state, arms, scheduler, fire: () => pending?.() }
  }

  test("a rearm while the overdue attempt is still in flight must not arm another immediate attempt", async () => {
    let renewals = 0
    let hang = false
    const harness = degradedThenExpiredHarness(async () => {
      renewals++
      if (hang) return new Promise<RenewalResult>(() => {}) // 在途:永不落定
      return { outcome: "unusable-response", generation: 1 }
    })

    // ① 凭证还活着时拿到 unusable → 进入降级,且**不**记「过期后已尝试」。
    harness.scheduler.rearm("startup")
    harness.state.now += 10 * 60_000
    harness.fire()
    await settleRenewal()
    expect(renewals).toBe(1)
    expect(harness.arms.at(-1)?.[1]).toBe(5 * 60_000) // 降频封顶到到期点

    // ② 凭证过期:首次 overdue 必须立刻尝试。
    harness.state.now += 5 * 60_000
    hang = true
    harness.scheduler.rearm("resume")
    expect(harness.arms.at(-1)?.[1]).toBe(0)
    harness.fire() // 起手第二次尝试,永不落定
    await settleRenewal()
    expect(renewals).toBe(2)

    // ③ 在途期间连续 resume:必须已经算「尝试过」,一律降频,不得再武装 0ms。
    const armedBefore = harness.arms.length
    for (let round = 0; round < 5; round++) {
      harness.scheduler.rearm("resume")
      harness.fire() // 命中 running → rearm("coalesced")
      await settleRenewal()
    }
    expect(renewals).toBe(2) // 在途期间不得再发起 renewal
    expect(harness.arms.slice(armedBefore).map(([, delayMs]) => delayMs)).toEqual(
      Array<number>(10).fill(AUTH_RENEWAL_DEGRADED_INTERVAL_MS),
    )
    harness.scheduler.stop()
  })

  test("a rejected renewal still counts as an attempt and must not arm an immediate retry", async () => {
    let renewals = 0
    let reject = false
    const harness = degradedThenExpiredHarness(async () => {
      renewals++
      if (reject) throw new Error("renewal blew up")
      return { outcome: "unusable-response", generation: 1 }
    })

    harness.scheduler.rearm("startup")
    harness.state.now += 10 * 60_000
    harness.fire()
    await settleRenewal()
    expect(renewals).toBe(1)

    harness.state.now += 5 * 60_000 // 过期
    reject = true
    harness.scheduler.rearm("resume")
    expect(harness.arms.at(-1)?.[1]).toBe(0) // 首次 overdue 立刻尝试
    const armedBefore = harness.arms.length

    harness.fire() // 这次 renew reject —— .then 被整段跳过
    await settleRenewal()
    expect(renewals).toBe(2)
    // 记账在起手,故 finally 的 rearm 仍按降频排,而不是又一次 0ms。
    expect(harness.arms.slice(armedBefore).map(([, delayMs]) => delayMs)).toEqual([
      AUTH_RENEWAL_DEGRADED_INTERVAL_MS,
    ])
    harness.scheduler.stop()
  })

  // R3 Minor1:凭证身份不能由 expiry 代理 —— 换账号完全可能拿到**相同**的绝对到期时刻。
  test("a new credential with the same absolute expiry still clears the degrade", async () => {
    vi.useFakeTimers()
    let now = 1_000_000
    let generation = 1
    let expiresAt = now + 15 * 60_000
    const arms: Array<number | null> = []
    const scheduler = createAuthRenewalScheduler({
      timing: () => ({ active: true, generation, expiresAt, lifetimeMs: 15 * 60_000 }),
      now: () => now,
      renew: async () => ({ outcome: "unusable-response", generation }),
      onArm: (_reason, delayMs) => arms.push(delayMs),
    })

    scheduler.rearm("startup")
    now += 10 * 60_000
    vi.advanceTimersByTime(10 * 60_000)
    await settleRenewal()
    expect(arms.at(-1)).toBe(5 * 60_000) // 降级中

    // 新账号登录:绝对到期时刻**恰好相同**,只有 generation 变了。
    generation = 2
    expiresAt = now + 5 * 60_000
    scheduler.rearm("auth-change")
    expect(arms.at(-1)).toBe(AUTH_RENEWAL_MIN_INTERVAL_MS) // 按正常判据,不继承旧凭证的降级

    // 同时也覆盖「expiry 变了」的老路径。
    generation = 3
    expiresAt = now + 15 * 60_000
    scheduler.rearm("auth-change")
    expect(arms.at(-1)).toBe(10 * 60_000)
    scheduler.stop()
  })

  test("an unusable-response arms the degraded interval and a usable one restores the normal cadence", async () => {
    vi.useFakeTimers()
    let now = 1_000_000
    let outcome: RenewalResult["outcome"] = "unusable-response"
    const expiresAt = now + 15 * 60_000
    const arms: Array<number | null> = []
    const scheduler = createAuthRenewalScheduler({
      timing: () => ({ active: true, generation: 1, expiresAt, lifetimeMs: 15 * 60_000 }),
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
