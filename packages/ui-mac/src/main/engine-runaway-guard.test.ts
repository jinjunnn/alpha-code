import { describe, expect, test } from "bun:test"
import {
  ENGINE_RUNAWAY_ABSOLUTE_BYTES,
  ENGINE_RUNAWAY_RATE_BYTES,
  ENGINE_RUNAWAY_STRIKE_DECAY_MS,
  armEngineRunawayGuard,
  decideEngineRunawayGuard,
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
  const baseline = sample(armEngineRunawayGuard(state), now, 0)
  return sample(baseline.state, now + 60_000, ENGINE_RUNAWAY_ABSOLUTE_BYTES + 1)
}

describe("engine runaway guard", () => {
  test("stays inert until armed and uses the first ready-time window as a baseline (W3)", () => {
    const unarmed = sample(initialEngineRunawayGuardState(), T0, ENGINE_RUNAWAY_ABSOLUTE_BYTES + 1)
    expect(unarmed.action).toBe("none")
    expect(unarmed.state.previousSize).toBeNull()

    const baseline = sample(
      armEngineRunawayGuard(unarmed.state),
      T0 + 60_000,
      ENGINE_RUNAWAY_ABSOLUTE_BYTES + 1,
    )
    expect(baseline.action).toBe("none")
    expect(baseline.state.previousSize).toBe(ENGINE_RUNAWAY_ABSOLUTE_BYTES + 1)
  })

  test("rate decisions use delta rather than the existing file size (W2)", () => {
    const baseline = sample(armEngineRunawayGuard(initialEngineRunawayGuardState()), T0, 400 * MB)
    const growth = sample(baseline.state, T0 + 60_000, 465 * MB)
    const normal = sample(growth.state, T0 + 120_000, 466 * MB)
    expect(growth.action).toBe("none")
    expect(normal.action).toBe("none")
    expect(normal.state.strikes).toBe(0)
  })

  test("a single fast window is not a verdict and a normal window breaks the chain (W1)", () => {
    const baseline = sample(armEngineRunawayGuard(initialEngineRunawayGuardState()), T0, 0)
    const spike = sample(baseline.state, T0 + 60_000, ENGINE_RUNAWAY_RATE_BYTES + 1)
    expect(spike.action).toBe("none")
    expect(spike.state.strikes).toBe(0)

    const normal = sample(spike.state, T0 + 120_000, ENGINE_RUNAWAY_RATE_BYTES + 2)
    expect(normal.action).toBe("none")
    expect(normal.state.fastWindows).toBe(0)
  })

  test("two consecutive windows above 64MB produce one strike (W1)", () => {
    const baseline = sample(armEngineRunawayGuard(initialEngineRunawayGuardState()), T0, 0)
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

  test("an unavailable stat sample is no verdict and breaks rate continuity (W4)", () => {
    const baseline = sample(armEngineRunawayGuard(initialEngineRunawayGuardState()), T0, 0)
    const first = sample(baseline.state, T0 + 60_000, ENGINE_RUNAWAY_RATE_BYTES + 1)
    const unavailable = decideEngineRunawayGuard(T0 + 120_000, { status: "unavailable" }, first.state)
    const next = sample(unavailable.state, T0 + 180_000, 2 * (ENGINE_RUNAWAY_RATE_BYTES + 1))
    expect(unavailable.action).toBe("none")
    expect(unavailable.state.previousSize).toBeNull()
    expect(next.action).toBe("none")
    expect(next.state.strikes).toBe(0)
  })

  test("strikes decay after 30 minutes without another verdict (W5)", () => {
    const verdict = absoluteVerdict(initialEngineRunawayGuardState(), T0)
    const decayed = decideEngineRunawayGuard(
      verdict.state.lastVerdictAt! + ENGINE_RUNAWAY_STRIKE_DECAY_MS,
      { status: "unavailable" },
      armEngineRunawayGuard(verdict.state),
    )
    expect(decayed.action).toBe("none")
    expect(decayed.state.strikes).toBe(0)
    expect(decayed.state.lastVerdictAt).toBeNull()
  })

  test("retry-engine reset clears strikes and requires a new ready-time arm (W5)", () => {
    const second = absoluteVerdict(absoluteVerdict(initialEngineRunawayGuardState(), T0).state, T0 + 120_000)
    const reset = resetEngineRunawayGuard()
    expect(second.state.strikes).toBe(2)
    expect(reset).toEqual(initialEngineRunawayGuardState())
    expect(sample(reset, T0 + 300_000, ENGINE_RUNAWAY_ABSOLUTE_BYTES + 1).action).toBe("none")
  })
})

describe("spawn log rotation wiring", () => {
  test("exports rotation and calls it inside spawnLocalServer before utilityProcess.fork", async () => {
    const serverSource = await Bun.file(new URL("./server.ts", import.meta.url)).text()
    const loggingSource = await Bun.file(new URL("./logging.ts", import.meta.url)).text()
    const spawn = serverSource.indexOf("export async function spawnLocalServer")
    const rotate = serverSource.indexOf("rotateServerLogs()", spawn)
    const fork = serverSource.indexOf("utilityProcess.fork", spawn)

    expect(loggingSource).toContain("export function rotateServerLogs()")
    expect(spawn).toBeGreaterThanOrEqual(0)
    expect(rotate).toBeGreaterThan(spawn)
    expect(fork).toBeGreaterThan(rotate)
  })
})
