import type { RenewalResult } from "./alpha-auth"
import { refreshDueAt } from "./alpha-auth-clock"
import type { SidecarRespawnReason } from "./sidecar-lifecycle"

export const BOOT_RENEWAL_GRACE_MS = 1_200
export const AUTH_RENEWAL_MIN_INTERVAL_MS = 30_000
/** #600 B3:上一次续期「成功但结果不可用」时的降频节奏(≈一个 token TTL)。按 30s 最小间隔
 *  重刷会把一个给不出可用有效期的签发端变成永久重刷循环;降频续跑既不进无定时器终局,
 *  也不制造风暴(③′3)。 */
export const AUTH_RENEWAL_DEGRADED_INTERVAL_MS = 15 * 60_000
/** #600:换血失败后重试同一 pending generation 的封顶低频节奏(降频续跑,不自旋、不进无定时器终局)。 */
export const TOKEN_ROTATION_RETRY_MS = 60_000

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
  // #600 B3:上一次续期结果不可用 ⇒ 下一次按降频节奏,不按 refreshDueAt 的最小间隔。
  let degraded = false

  const rearm = (reason: string) => {
    if (timer) clearTimer(timer)
    timer = undefined
    if (stopped) return
    const base = authRenewalDelayMs(deps.timing(), now())
    const delayMs = base === null || !degraded ? base : Math.max(base, AUTH_RENEWAL_DEGRADED_INTERVAL_MS)
    deps.onArm?.(reason, delayMs)
    if (delayMs === null) return
    timer = setTimer(() => {
      timer = undefined
      if (running || stopped) return rearm("coalesced")
      running = true
      void deps
        .renew()
        .then((result) => {
          degraded = result.outcome === "unusable-response"
          deps.onResult?.(result)
        })
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
  /** 该 generation 真正被健康换血采用时回调 —— 平台面「恢复中 → ready」的唯一解除点,
   *  低频重试成功时同样触发(alpha-auth.markTokenGenerationApplied)。 */
  onApplied?: (generation: number) => void
  setTimer?: SetTimer
  clearTimer?: ClearTimer
}) {
  const setTimer = deps.setTimer ?? setTimeout
  const clearTimer = deps.clearTimer ?? clearTimeout
  let requestedGeneration = 0
  let handledGeneration = 0
  let active: Promise<boolean> | null = null
  let retryTimer: Timer | undefined
  let retryingGeneration = 0

  const clearRetry = () => {
    if (retryTimer) clearTimer(retryTimer)
    retryTimer = undefined
  }

  // #600 B1:失败不是终局。保留单飞、保留 pending generation,用封顶低频 timer 重试
  // (③′3:不得进入无定时器终局;也不得同步自旋 —— timer 独占下一次尝试)。
  const scheduleRetry = () => {
    if (retryTimer) return
    retryTimer = setTimer(() => {
      retryTimer = undefined
      void flush()
    }, TOKEN_ROTATION_RETRY_MS)
    retryTimer.unref?.()
  }

  const flush = (): Promise<boolean> => {
    if (active) return active
    if (requestedGeneration <= Math.max(handledGeneration, deps.forkedGeneration())) {
      clearRetry()
      return Promise.resolve(false)
    }
    // 失败后由 timer 独占重试该代:重复 accept / 其它触发不得就地再试(否则退化成自旋);
    // 更新的 generation 允许立刻尝试。
    if (retryTimer && requestedGeneration <= retryingGeneration) return Promise.resolve(false)
    // 没有可换血的 sidecar(spawn 失败后 server 为 null)恰恰是必须继续重试的时刻:
    // 只回 false 会让 pending generation 永远等一个不会到来的外部触发。
    if (!deps.canRespawn()) {
      scheduleRetry()
      return Promise.resolve(false)
    }

    active = (async () => {
      while (requestedGeneration > Math.max(handledGeneration, deps.forkedGeneration())) {
        const target = requestedGeneration
        // respawn 入口自身抛出(publish 异常等)必须收敛成一次失败,否则 latch 连同重试
        // 定时器一起被 rejection 带走 —— 那正是 ③′3 禁止的无定时器终局。
        const healthy = await deps.respawn("token-only").catch((error: unknown) => {
          deps.mark?.({ outcome: "transient-failure", generation: target }, "rotation", `threw:${String(error)}`)
          return false
        })
        if (!healthy) {
          // handledGeneration 只在健康换血成功后推进 —— 旧接线在 respawn 之前就推进,
          // 失败即把该代标记为「已处理」,同代永不再试(#600 的悬崖)。
          retryingGeneration = target
          scheduleRetry()
          return false
        }
        handledGeneration = Math.max(handledGeneration, target)
        deps.onApplied?.(target)
      }
      clearRetry()
      return true
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
