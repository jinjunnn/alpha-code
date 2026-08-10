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
import { commitForkedTokenGeneration, createSidecarRespawnQueue } from "./sidecar-lifecycle"
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

  test("five in-flight boot forks suppress duplicate rotation without claiming applied", async () => {
    for (let sample = 1; sample <= 5; sample++) {
      let forked = 1
      let pendingFork = 2
      let respawns = 0
      const applied: number[] = []
      const latch = createTokenRotationLatch({
        forkedGeneration: () => forked,
        pendingForkGeneration: () => pendingFork,
        canRespawn: () => true,
        respawn: async () => {
          respawns++
          return true
        },
        onApplied: (generation) => applied.push(generation),
      })

      expect(await latch.accept(result("refreshed", 2), `boot-grace-${sample}`)).toBe(false)
      expect(respawns).toBe(0)
      expect(applied).toEqual([])

      forked = 2
      pendingFork = 0
      expect(await latch.flush()).toBe(true)
      expect(respawns).toBe(0)
      expect(applied).toEqual([2])
    }
  })

  test("a failed in-flight boot fork releases the pending generation for one reliable rotation", async () => {
    let forked = 1
    let pendingFork = 2
    let respawns = 0
    const latch = createTokenRotationLatch({
      forkedGeneration: () => forked,
      pendingForkGeneration: () => pendingFork,
      canRespawn: () => true,
      respawn: async () => {
        respawns++
        forked = 2
        return true
      },
    })

    expect(await latch.accept(result("refreshed", 2), "boot-grace")).toBe(false)
    expect(respawns).toBe(0)

    pendingFork = 0
    expect(await latch.flush()).toBe(true)
    expect(respawns).toBe(1)
  })

  test("a newer generation rotates once while an older boot fork is still in flight", async () => {
    let forked = 1
    const applied: number[] = []
    let respawns = 0
    const latch = createTokenRotationLatch({
      forkedGeneration: () => forked,
      pendingForkGeneration: () => 2,
      canRespawn: () => true,
      respawn: async () => {
        respawns++
        forked = 3
        return true
      },
      onApplied: (generation) => applied.push(generation),
    })

    expect(await latch.accept(result("refreshed", 3), "newer-than-boot")).toBe(true)
    expect(respawns).toBe(1)
    expect(applied).toEqual([3])
    expect(await latch.flush()).toBe(true)
    expect(respawns).toBe(1)
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

  // R3 要求的组合覆盖:latch + respawn 队列 + 每次 fork 的 capture-then-commit 一起跑。
  // 队列会把在途请求合并成一个 composite —— latch 等到的 true 对应的是**最终那次健康
  // follow-up**,onApplied 必须报它实际携带的代。
  test("queue + health commit + latch: the coalesced follow-up decides the reported generation", async () => {
    let committed = 0 // = index.ts 的 sidecarTokenGeneration(只由健康确认推进)
    let tokenGeneration = 2 // = alpha-auth 的当前凭证代
    const forks: number[] = []
    const applied: number[] = []
    let releaseFirstFork!: () => void
    const firstFork = new Promise<void>((resolve) => {
      releaseFirstFork = resolve
    })

    const request = createSidecarRespawnQueue(async () => {
      const captured = tokenGeneration // fork 时捕获
      if (forks.length === 0) await firstFork
      forks.push(captured)
      committed = commitForkedTokenGeneration(committed, captured, true) // 健康后提交
      return true
    })
    const latch = createTokenRotationLatch({
      forkedGeneration: () => committed,
      canRespawn: () => true,
      respawn: (reason) => request(reason),
      onApplied: (generation) => applied.push(generation),
    })

    const rotated = latch.accept(result("refreshed", 2), "renewal")
    // R4 假闸门 B:只断言终局的话,把 commit 挪到 health 之前照样全绿 —— 而时序正是本轮修的
    // 东西。在**第一个 fork 仍卡在健康握手上**的这一刻锁住:既不得提交,也不得报 applied。
    await settleRenewal()
    expect(forks).toEqual([])
    expect(committed).toBe(0)
    expect(applied).toEqual([])

    // 第一次 fork 还在途:一次成功续期把凭证推到 G3,随后的登录/模式切换直接进队列,
    // 被合并成一次 structural follow-up。
    tokenGeneration = 3
    void request("structural")
    releaseFirstFork()

    expect(await rotated).toBe(true)
    expect(forks).toEqual([2, 3])
    expect(committed).toBe(3)
    expect(applied).toEqual([3]) // 报最终健康实例携带的代,不是本次请求的 target(2)
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
