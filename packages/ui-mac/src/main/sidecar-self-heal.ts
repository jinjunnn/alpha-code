// B5 sidecar crash self-heal — pure decision logic (electron-free, unit-tested). index.ts owns the
// wiring: it tracks a spawn generation to tell "this child crashed" from "stale child of an earlier
// generation" and calls planSelfHeal only for unexpected exits (intentional kills null `server` first).
//
// Policy (B5 验收①): exponential backoff 1s → 2s → 4s → 8s → 16s, then give up (crash-loop storm
// guard); a spell of healthy uptime (60s) resets the ladder so isolated crashes days apart each heal
// on the fast path.

export type SelfHealState = { attempts: number; lastSpawnAt: number }

export const SELF_HEAL_MAX_ATTEMPTS = 5
export const SELF_HEAL_RESET_UPTIME_MS = 60_000
export const SELF_HEAL_MAX_DELAY_MS = 30_000

export function initialSelfHealState(): SelfHealState {
  return { attempts: 0, lastSpawnAt: 0 }
}

/** Record a (re)spawn moment — uptime measured from here. */
export function noteSpawn(state: SelfHealState, now: number): SelfHealState {
  return { ...state, lastSpawnAt: now }
}

export type SelfHealPlan =
  | { action: "heal"; delayMs: number; state: SelfHealState }
  | { action: "give-up"; state: SelfHealState }

/** Decide how to react to an unexpected sidecar exit at `now`. */
export function planSelfHeal(state: SelfHealState, now: number): SelfHealPlan {
  const attempts = now - state.lastSpawnAt >= SELF_HEAL_RESET_UPTIME_MS ? 0 : state.attempts
  if (attempts >= SELF_HEAL_MAX_ATTEMPTS) return { action: "give-up", state: { ...state, attempts } }
  const delayMs = Math.min(1000 * 2 ** attempts, SELF_HEAL_MAX_DELAY_MS)
  return { action: "heal", delayMs, state: { ...state, attempts: attempts + 1 } }
}
