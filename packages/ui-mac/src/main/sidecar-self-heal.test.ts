// B5 crash self-heal decision logic — backoff ladder, crash-loop give-up, healthy-uptime reset.

import { describe, expect, test } from "bun:test"
import {
  initialSelfHealState,
  noteSpawn,
  planSelfHeal,
  SELF_HEAL_MAX_ATTEMPTS,
  SELF_HEAL_RESET_UPTIME_MS,
} from "./sidecar-self-heal"

const T0 = 1_000_000

describe("planSelfHeal", () => {
  test("crash-loop walks the backoff ladder then gives up", () => {
    // crash-loop: each respawn dies 1s later (well under the reset uptime)
    let state = noteSpawn(initialSelfHealState(), T0)
    const delays: number[] = []
    let now = T0 + 1000
    for (;;) {
      const plan = planSelfHeal(state, now)
      if (plan.action === "give-up") break
      delays.push(plan.delayMs)
      state = noteSpawn(plan.state, now + plan.delayMs)
      now = state.lastSpawnAt + 1000
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000])
    expect(delays.length).toBe(SELF_HEAL_MAX_ATTEMPTS)
  })

  test("first crash heals within 10s (验收①)", () => {
    const state = noteSpawn(initialSelfHealState(), T0)
    const plan = planSelfHeal(state, T0 + 5000)
    expect(plan.action).toBe("heal")
    if (plan.action === "heal") expect(plan.delayMs).toBeLessThanOrEqual(10_000)
  })

  test("healthy uptime resets the ladder", () => {
    let state = noteSpawn(initialSelfHealState(), T0)
    // burn 3 attempts in a quick loop
    for (let i = 0; i < 3; i++) {
      const plan = planSelfHeal(state, state.lastSpawnAt + 1000)
      if (plan.action !== "heal") throw new Error("unexpected give-up")
      state = noteSpawn(plan.state, state.lastSpawnAt + 1000 + plan.delayMs)
    }
    expect(state.attempts).toBe(3)
    // then the sidecar stays healthy past the reset window before dying again
    const plan = planSelfHeal(state, state.lastSpawnAt + SELF_HEAL_RESET_UPTIME_MS + 1)
    expect(plan.action).toBe("heal")
    if (plan.action === "heal") {
      expect(plan.delayMs).toBe(1000) // ladder restarted
      expect(plan.state.attempts).toBe(1)
    }
  })

  test("give-up state keeps refusing until a healthy spell", () => {
    let state = { attempts: SELF_HEAL_MAX_ATTEMPTS, lastSpawnAt: T0 }
    expect(planSelfHeal(state, T0 + 1000).action).toBe("give-up")
    // healthy uptime after a manual respawn unlocks healing again
    state = noteSpawn(state, T0 + 2000)
    expect(planSelfHeal(state, T0 + 2000 + SELF_HEAL_RESET_UPTIME_MS).action).toBe("heal")
  })
})
