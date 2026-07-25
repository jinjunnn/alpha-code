import type { RenewalResult } from "./alpha-auth"
import { MIN_USABLE_TOKEN_LIFETIME_MS, refreshDueAt } from "./alpha-auth-clock"
import type { SidecarRespawnReason } from "./sidecar-lifecycle"

export const BOOT_RENEWAL_GRACE_MS = 1_200
// 调度器的唤醒地板 = 「可用寿命」的下界,同一个常量派生,两者不可能漂移
// (alpha-auth-clock.MIN_USABLE_TOKEN_LIFETIME_MS 的注释解释了为什么是同一个数)。
export const AUTH_RENEWAL_MIN_INTERVAL_MS = MIN_USABLE_TOKEN_LIFETIME_MS
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

// 上一次续期「成功但结果不可用」后的降频节奏。
//
// 依赖的不变量与各自的强制手段(rev2c ③″1):
//  ① `timing.expiresAt` 是**已验证**的绝对期限 —— 只有通过 hasUsableLifetime 的响应才会被
//     提交(alpha-auth 的 usableExpiresAt 是唯一写入口);强制手段 = alpha-auth.cases.ts
//     「不可用有效期不提交」用例 + alpha-auth-clock 的 hasUsableLifetime 单测。
//  ② 续期调度器是平台 token 唯一的恢复 owner(③″2-1),且 rearm 是全函数(除 stop 外必然
//     再武装);强制手段 = 本文件「结果后必 rearm」与「降频后仍有下一次」两条用例。
//  ③ 降频**不得**把下一次唤醒排到当前已验证 expiresAt 之后 —— 否则旧凭证在窗口中间过期,
//     而那一刻没有任何 timer 触发 auth-state 发布,renderer 会继续显示 ready
//     (③″2-4:owner 不得静默退场,到期那一刻必须有人在场);强制手段 = 下面的封顶 +
//     「10 分钟时降频不得越过 15 分钟到期点」用例。
// 已到期(没有余量可保护)后才允许用完整降频节奏 —— 此时平台已 fail-closed 为 recovering,
// 继续每 30 秒重刷就是 #600 B3 要消灭的那条循环。
export function degradedRenewalDelayMs(timing: AuthRenewalTiming, now: number): number | null {
  const base = authRenewalDelayMs(timing, now)
  if (base === null) return null
  const untilExpiry = timing.expiresAt === undefined ? 0 : timing.expiresAt - now
  const degraded =
    untilExpiry > 0 ? Math.min(AUTH_RENEWAL_DEGRADED_INTERVAL_MS, untilExpiry) : AUTH_RENEWAL_DEGRADED_INTERVAL_MS
  return Math.max(base, degraded)
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
  // 降频只对**当时那份凭证**成立:凭证一换(登录、或任何路径上一次成功续期都会改写
  // expiresAt),降频立即作废 —— 否则新拿到的正常 token 会白白损失提前量。
  let degraded = false
  let degradedFor: number | undefined
  const currentDegraded = (timing: AuthRenewalTiming) => {
    if (degraded && timing.expiresAt !== degradedFor) degraded = false
    return degraded
  }

  const rearm = (reason: string) => {
    if (timer) clearTimer(timer)
    timer = undefined
    if (stopped) return
    const timing = deps.timing()
    const delayMs = currentDegraded(timing) ? degradedRenewalDelayMs(timing, now()) : authRenewalDelayMs(timing, now())
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
          degradedFor = degraded ? deps.timing().expiresAt : undefined
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
  /** 通知「当前活着的 sidecar 实际携带的那一代」—— 平台面「恢复中 → ready」的唯一解除点。
   *  参数必须是 `forkedGeneration()`(实际健康 fork 的代),不是本次请求的 target:
   *  respawn 队列合并时,一次 composite 可能实际 fork 了比 target 更新的代,报 target 会让
   *  更新的那代永远等不到解除(rev2c ③″2-4:owner 不得静默退场)。 */
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

  /** 「请求的代已经在效力中」——三条路都要走它:换血成功、accept 时已是当前代、
   *  flush 时发现外部(boot fork / 队列 follow-up)已经带上了。消费方回调抛出不得
   *  derail latch(Minor2:auth publish 仍可能抛)。 */
  const notifyApplied = () => {
    try {
      deps.onApplied?.(deps.forkedGeneration())
    } catch (error) {
      deps.mark?.(
        { outcome: "transient-failure", generation: deps.forkedGeneration() },
        "rotation",
        `applied-notify-threw:${String(error)}`,
      )
    }
  }
  const inEffect = () => requestedGeneration <= Math.max(handledGeneration, deps.forkedGeneration())

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
    if (inEffect()) {
      clearRetry()
      // 曾经 pending、现在已在效力中(boot fork 抢先采用 / 队列 follow-up 带上了更新的代)
      // ⇒ 它就是「已应用」。少了这一步,平台面会永远停在 recovering。
      if (requestedGeneration > 0) {
        notifyApplied()
        return Promise.resolve(true)
      }
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
        notifyApplied()
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
      // 已经是当前代(boot fork 直接带上了 / 上一次换血已覆盖)⇒ 这一代**就是已应用**,
      // 不是「什么都没发生」。返回 false 会让调用方(refreshTokens)判 applied:false,
      // 平台面永远停在 recovering。accept 的布尔语义 = 「请求的代现在是否在效力中」。
      if (result.generation <= Math.max(handledGeneration, deps.forkedGeneration())) {
        deps.mark?.(result, trigger, "already-current")
        notifyApplied()
        return Promise.resolve(true)
      }
      requestedGeneration = Math.max(requestedGeneration, result.generation)
      deps.mark?.(result, trigger, deps.canRespawn() ? "requested" : "pending")
      return flush()
    },
    flush,
  }
}
