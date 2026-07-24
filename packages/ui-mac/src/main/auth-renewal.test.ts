import { afterEach, describe, expect, test, vi } from "bun:test"
import {
  AUTH_RENEWAL_MIN_INTERVAL_MS,
  awaitBootRenewalGrace,
  authRenewalDelayMs,
  createAuthRenewalScheduler,
  createTokenRotationLatch,
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

  test("a failed token-only respawn is not retried for the same generation", async () => {
    let respawns = 0
    const latch = createTokenRotationLatch({
      forkedGeneration: () => 1,
      canRespawn: () => true,
      respawn: async () => {
        respawns++
        return false
      },
    })

    await latch.accept(result("refreshed", 2), "scheduled")
    await latch.accept(result("refreshed", 2), "duplicate")
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
