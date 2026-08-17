export const ENGINE_RUNAWAY_WINDOW_MS = 60_000
export const ENGINE_RUNAWAY_RATE_BYTES = 64 * 1024 * 1024
export const ENGINE_RUNAWAY_ABSOLUTE_BYTES = 512 * 1024 * 1024
export const ENGINE_RUNAWAY_STRIKE_DECAY_MS = 30 * 60 * 1000

export type EngineRunawaySample = { status: "available"; size: number } | { status: "unavailable" }

export type EngineRunawayGuardState = {
  armed: boolean
  armedAt: number | null
  strikes: number
  previousSize: number | null
  fastWindows: number
  lastVerdictAt: number | null
}

export type EngineRunawayGuardAction = "none" | "kill-and-respawn" | "stop-and-report"

export function initialEngineRunawayGuardState(): EngineRunawayGuardState {
  return {
    armed: false,
    armedAt: null,
    strikes: 0,
    previousSize: null,
    fastWindows: 0,
    lastVerdictAt: null,
  }
}

export function armEngineRunawayGuard(state: EngineRunawayGuardState, now: number): EngineRunawayGuardState {
  return { ...state, armed: true, armedAt: now, previousSize: null, fastWindows: 0 }
}

export function disarmEngineRunawayGuard(state: EngineRunawayGuardState, now: number): EngineRunawayGuardState {
  // Commit health only when a generation ends without a verdict. Eager decay while armed would
  // erase a slow burn's strikes before the absolute cap can prove that generation was runaway.
  const healthy = state.armed && state.armedAt !== null && now - state.armedAt >= ENGINE_RUNAWAY_STRIKE_DECAY_MS
  return {
    ...state,
    armed: false,
    armedAt: null,
    strikes: healthy ? 0 : state.strikes,
    previousSize: null,
    fastWindows: 0,
    lastVerdictAt: healthy ? null : state.lastVerdictAt,
  }
}

export function resetEngineRunawayGuard(): EngineRunawayGuardState {
  return initialEngineRunawayGuardState()
}

export function decideEngineRunawayGuard(
  now: number,
  sample: EngineRunawaySample,
  state: EngineRunawayGuardState,
): { state: EngineRunawayGuardState; action: EngineRunawayGuardAction } {
  if (!state.armed) return { state, action: "none" }
  if (sample.status === "unavailable") {
    return { state: { ...state, previousSize: null, fastWindows: 0 }, action: "none" }
  }
  if (state.previousSize === null) {
    return { state: { ...state, previousSize: sample.size, fastWindows: 0 }, action: "none" }
  }

  const delta = sample.size - state.previousSize
  const fastWindows = delta > ENGINE_RUNAWAY_RATE_BYTES ? state.fastWindows + 1 : 0
  const runaway = fastWindows >= 2 || sample.size > ENGINE_RUNAWAY_ABSOLUTE_BYTES
  if (!runaway) {
    return { state: { ...state, previousSize: sample.size, fastWindows }, action: "none" }
  }

  const strikes = Math.min(state.strikes + 1, 3)
  return {
    state: {
      armed: false,
      armedAt: null,
      strikes,
      previousSize: null,
      fastWindows: 0,
      lastVerdictAt: now,
    },
    action: strikes < 3 ? "kill-and-respawn" : "stop-and-report",
  }
}
