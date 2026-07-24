import type { RenewalResult } from "./alpha-auth"
import { refreshDueAt } from "./alpha-auth-clock"
import type { SidecarRespawnReason } from "./sidecar-lifecycle"

export const BOOT_RENEWAL_GRACE_MS = 1_200
export const AUTH_RENEWAL_MIN_INTERVAL_MS = 30_000

type Timer = ReturnType<typeof setTimeout>
type SetTimer = (run: () => void, delayMs: number) => Timer
type ClearTimer = (timer: Timer) => void

export type BootRenewalRace =
  | { completed: true; result: RenewalResult }
  | { completed: false; pending: Promise<RenewalResult> }

export async function awaitBootRenewalGrace(
  pending: Promise<RenewalResult>,
  graceMs = BOOT_RENEWAL_GRACE_MS,
  setTimer: SetTimer = setTimeout,
  clearTimer: ClearTimer = clearTimeout,
): Promise<BootRenewalRace> {
  let timer: Timer | undefined
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimer(() => resolve("timeout"), graceMs)
  })
  const winner = await Promise.race([pending, timeout])
  if (timer) clearTimer(timer)
  if (winner === "timeout") return { completed: false, pending }
  return { completed: true, result: winner }
}

export type AuthRenewalTiming = {
  active: boolean
  expiresAt?: number
  lifetimeMs?: number
}

export function authRenewalDelayMs(timing: AuthRenewalTiming, now: number): number | null {
  if (!timing.active) return null
  return Math.max(
    AUTH_RENEWAL_MIN_INTERVAL_MS,
    refreshDueAt(timing.expiresAt, timing.lifetimeMs, now) - now,
  )
}

export function createAuthRenewalScheduler(deps: {
  timing: () => AuthRenewalTiming
  renew: () => Promise<RenewalResult>
  now?: () => number
  setTimer?: SetTimer
  clearTimer?: ClearTimer
  onArm?: (reason: string, delayMs: number | null) => void
  onResult?: (result: RenewalResult) => void
}) {
  const now = deps.now ?? Date.now
  const setTimer = deps.setTimer ?? setTimeout
  const clearTimer = deps.clearTimer ?? clearTimeout
  let timer: Timer | undefined
  let running = false
  let stopped = false

  const rearm = (reason: string) => {
    if (timer) clearTimer(timer)
    timer = undefined
    if (stopped) return
    const delayMs = authRenewalDelayMs(deps.timing(), now())
    deps.onArm?.(reason, delayMs)
    if (delayMs === null) return
    timer = setTimer(() => {
      timer = undefined
      if (running || stopped) return rearm("coalesced")
      running = true
      void deps
        .renew()
        .then((result) => deps.onResult?.(result))
        .finally(() => {
          running = false
          rearm("result")
        })
    }, delayMs)
    timer.unref?.()
  }

  return {
    rearm,
    stop() {
      stopped = true
      if (timer) clearTimer(timer)
      timer = undefined
    },
  }
}

export function createTokenRotationLatch(deps: {
  forkedGeneration: () => number
  canRespawn: () => boolean
  respawn: (reason: SidecarRespawnReason) => Promise<boolean>
  mark?: (result: RenewalResult, trigger: string, outcome: string) => void
}) {
  let requestedGeneration = 0
  let handledGeneration = 0
  let active: Promise<boolean> | null = null

  const flush = (): Promise<boolean> => {
    if (active) return active
    if (requestedGeneration <= Math.max(handledGeneration, deps.forkedGeneration())) return Promise.resolve(false)
    if (!deps.canRespawn()) return Promise.resolve(false)

    active = (async () => {
      let healthy = true
      while (requestedGeneration > Math.max(handledGeneration, deps.forkedGeneration())) {
        const target = requestedGeneration
        // A generation gets at most one re-fork attempt. A failed health gate stays degraded and waits
        // for an explicit structural recovery or a newer token generation; duplicate callbacks must
        // never turn one renewal into a respawn loop.
        handledGeneration = Math.max(handledGeneration, target)
        healthy = await deps.respawn("token-only")
        if (!healthy) return false
      }
      return healthy
    })().finally(() => {
      active = null
    })
    return active
  }

  return {
    accept(result: RenewalResult, trigger: string) {
      if (result.outcome !== "refreshed") {
        deps.mark?.(result, trigger, "kept")
        return Promise.resolve(false)
      }
      if (result.generation <= Math.max(handledGeneration, deps.forkedGeneration())) {
        deps.mark?.(result, trigger, "already-current")
        return Promise.resolve(false)
      }
      requestedGeneration = Math.max(requestedGeneration, result.generation)
      deps.mark?.(result, trigger, deps.canRespawn() ? "requested" : "pending")
      return flush()
    },
    flush,
  }
}
