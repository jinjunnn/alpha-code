import { describe, expect, test } from "bun:test"
import {
  ENGINE_RUNAWAY_ABSOLUTE_BYTES,
  ENGINE_RUNAWAY_RATE_BYTES,
  ENGINE_RUNAWAY_STRIKE_DECAY_MS,
  armEngineRunawayGuard,
  decideEngineRunawayGuard,
  disarmEngineRunawayGuard,
  initialEngineRunawayGuardState,
  resetEngineRunawayGuard,
  type EngineRunawayGuardState,
} from "./engine-runaway-guard"

const T0 = 1_000_000
const MB = 1024 * 1024

function sample(state: EngineRunawayGuardState, now: number, size: number) {
  return decideEngineRunawayGuard(now, { status: "available", size }, state)
}

function absoluteVerdict(state: EngineRunawayGuardState, now: number) {
  const baseline = sample(armEngineRunawayGuard(state, now), now, 0)
  return sample(baseline.state, now + 60_000, ENGINE_RUNAWAY_ABSOLUTE_BYTES + 1)
}

function modelRunaway(rateMBPerMinute: number, minutes = 10 * 60) {
  let state = sample(armEngineRunawayGuard(initialEngineRunawayGuardState(), T0), T0, 0).state
  let size = 0
  const verdicts: { action: "kill-and-respawn" | "stop-and-report"; minute: number }[] = []

  for (let minute = 1; minute <= minutes; minute++) {
    size += Math.round(rateMBPerMinute * MB)
    const decision = sample(state, T0 + minute * 60_000, size)
    state = decision.state
    if (decision.action === "none") continue
    verdicts.push({ action: decision.action, minute })
    if (decision.action === "stop-and-report") break
    size = 0
    state = sample(armEngineRunawayGuard(state, T0 + minute * 60_000), T0 + minute * 60_000, size).state
  }

  return verdicts
}

describe("engine runaway guard", () => {
  test("stays inert until armed and uses the first ready-time window as a baseline (W3)", () => {
    const unarmed = sample(initialEngineRunawayGuardState(), T0, ENGINE_RUNAWAY_ABSOLUTE_BYTES + 1)
    expect(unarmed.action).toBe("none")
    expect(unarmed.state.previousSize).toBeNull()

    const baseline = sample(
      armEngineRunawayGuard(unarmed.state, T0 + 60_000),
      T0 + 60_000,
      ENGINE_RUNAWAY_ABSOLUTE_BYTES + 1,
    )
    expect(baseline.action).toBe("none")
    expect(baseline.state.previousSize).toBe(ENGINE_RUNAWAY_ABSOLUTE_BYTES + 1)
  })

  test("rate decisions use delta rather than the existing file size (W2)", () => {
    const baseline = sample(armEngineRunawayGuard(initialEngineRunawayGuardState(), T0), T0, 400 * MB)
    const growth = sample(baseline.state, T0 + 60_000, 465 * MB)
    const normal = sample(growth.state, T0 + 120_000, 466 * MB)
    expect(growth.action).toBe("none")
    expect(normal.action).toBe("none")
    expect(normal.state.strikes).toBe(0)
  })

  test("a single fast window is not a verdict and a normal window breaks the chain (W1)", () => {
    const baseline = sample(armEngineRunawayGuard(initialEngineRunawayGuardState(), T0), T0, 0)
    const spike = sample(baseline.state, T0 + 60_000, ENGINE_RUNAWAY_RATE_BYTES + 1)
    expect(spike.action).toBe("none")
    expect(spike.state.strikes).toBe(0)

    const normal = sample(spike.state, T0 + 120_000, ENGINE_RUNAWAY_RATE_BYTES + 2)
    expect(normal.action).toBe("none")
    expect(normal.state.fastWindows).toBe(0)
  })

  test("two consecutive windows above 64MB produce one strike (W1)", () => {
    const baseline = sample(armEngineRunawayGuard(initialEngineRunawayGuardState(), T0), T0, 0)
    const first = sample(baseline.state, T0 + 60_000, ENGINE_RUNAWAY_RATE_BYTES + 1)
    const second = sample(first.state, T0 + 120_000, 2 * (ENGINE_RUNAWAY_RATE_BYTES + 1))
    expect(second.action).toBe("kill-and-respawn")
    expect(second.state.strikes).toBe(1)
  })

  test("an absolute size above 512MB produces one strike", () => {
    const verdict = absoluteVerdict(initialEngineRunawayGuardState(), T0)
    expect(verdict.action).toBe("kill-and-respawn")
    expect(verdict.state.strikes).toBe(1)
  })

  test("strikes one and two kill for the existing respawn ladder; strike three stops for an incident (W4/W5)", () => {
    const first = absoluteVerdict(initialEngineRunawayGuardState(), T0)
    const second = absoluteVerdict(first.state, T0 + 120_000)
    const third = absoluteVerdict(second.state, T0 + 240_000)
    expect([first.action, second.action, third.action]).toEqual([
      "kill-and-respawn",
      "kill-and-respawn",
      "stop-and-report",
    ])
    expect(third.state.strikes).toBe(3)
    expect(third.state.armed).toBeFalse()
  })

  test.each([
    [17.6, 90],
    [15, 105],
    [10, 156],
  ])("a %p MB/min slow burn stops at minute %p within the ten-hour model", (rate, stopMinute) => {
    expect(modelRunaway(rate)).toEqual([
      { action: "kill-and-respawn", minute: stopMinute / 3 },
      { action: "kill-and-respawn", minute: (stopMinute / 3) * 2 },
      { action: "stop-and-report", minute: stopMinute },
    ])
  })

  test("the existing 30 MB/min path still stops at minute 54", () => {
    expect(modelRunaway(30)).toEqual([
      { action: "kill-and-respawn", minute: 18 },
      { action: "kill-and-respawn", minute: 36 },
      { action: "stop-and-report", minute: 54 },
    ])
  })

  test("an unavailable stat sample is no verdict and breaks rate continuity (W4)", () => {
    const baseline = sample(armEngineRunawayGuard(initialEngineRunawayGuardState(), T0), T0, 0)
    const first = sample(baseline.state, T0 + 60_000, ENGINE_RUNAWAY_RATE_BYTES + 1)
    const unavailable = decideEngineRunawayGuard(T0 + 120_000, { status: "unavailable" }, first.state)
    const next = sample(unavailable.state, T0 + 180_000, 2 * (ENGINE_RUNAWAY_RATE_BYTES + 1))
    expect(unavailable.action).toBe("none")
    expect(unavailable.state.previousSize).toBeNull()
    expect(next.action).toBe("none")
    expect(next.state.strikes).toBe(0)
  })

  test("only a completed healthy generation decays strikes (W5)", () => {
    const verdict = absoluteVerdict(initialEngineRunawayGuardState(), T0)
    const armedAt = verdict.state.lastVerdictAt! + 60_000
    const generation = armEngineRunawayGuard(verdict.state, armedAt)
    const stillArmed = sample(generation, armedAt + ENGINE_RUNAWAY_STRIKE_DECAY_MS, 0)
    const short = disarmEngineRunawayGuard(generation, armedAt + ENGINE_RUNAWAY_STRIKE_DECAY_MS - 1)
    const healthy = disarmEngineRunawayGuard(stillArmed.state, armedAt + ENGINE_RUNAWAY_STRIKE_DECAY_MS)

    expect(stillArmed.state.strikes).toBe(1)
    expect(short.strikes).toBe(1)
    expect(healthy.strikes).toBe(0)
    expect(healthy.lastVerdictAt).toBeNull()
  })

  test("retry-engine reset clears strikes and requires a new ready-time arm (W5)", () => {
    const second = absoluteVerdict(absoluteVerdict(initialEngineRunawayGuardState(), T0).state, T0 + 120_000)
    const reset = resetEngineRunawayGuard()
    expect(second.state.strikes).toBe(2)
    expect(reset).toEqual(initialEngineRunawayGuardState())
    expect(sample(reset, T0 + 300_000, ENGINE_RUNAWAY_ABSOLUTE_BYTES + 1).action).toBe("none")
  })
})

// AC4「每次 spawn 前轮转」的判据**不在本文件**,在 `req053-spawn-rotation.test.ts`
// (它起子进程跑生产 `spawnLocalServer`,由注入的 fork 桩在被调用的那一刻观察真实文件系统)。
//
// 这里原先有一条 `serverSource.indexOf("rotateServerLogs()") < indexOf("utilityProcess.fork")`
// 的断言,`#966` 把它删了而不是留着当「双保险」:它只比较源码字符串下标 —— 把轮转**挪到**
// fork 之后、把 `pruneServerArchives` 删掉、把归档改成截断,它一条都不会红,而留着它会让
// 下一个人以为这处接线有守。本文件从此只负责 `decideEngineRunawayGuard` 纯决策核的 W1–W5。
