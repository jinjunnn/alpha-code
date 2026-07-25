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
  /** 凭证身份(alpha-auth 的 tokenGeneration:登录/续期/登出/恢复都推进)。
   *  R3 Minor1:降级与「过期后已尝试」的记账一律按它判定 —— **不得用 expiresAt 代理**,
   *  换账号完全可能拿到相同的绝对到期时刻。必填,少给一个生产者就编译不过。 */
  generation: number
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

// 上一次续期「成功但结果不可用」后的降频节奏。**两条规则都在函数内强制**,不靠调用方自觉:
//
//  规则一(凭证还活着,untilExpiry > 0):下一次唤醒**必须落在到期点或之前** ——
//    即使这意味着早于唤醒地板(只剩 10 秒就 10 秒后醒)。地板防的是无限重刷;而每份凭证
//    最多只会有这一次亚地板唤醒(醒来即到期,随后走规则二),不构成风暴。
//    R3 反例:旧实现 `Math.max(base, 降频)` 在剩 10 秒时返回 30 秒 —— 被地板推过到期点 20 秒,
//    那 20 秒里没有任何 timer 触发发布,renderer 继续持有 ready。
//
//  规则二(已过期,或有效期未知):**只有该凭证过期后已经真的跑过一次续期尝试**
//    (那次尝试自身以 refreshTokens() 起手的 publish() 发出 recovering)之后,才允许进入
//    完整降频节奏;否则立刻尝试(返回 0)。
//    R3 反例:睡眠越过到期点后 resume 先 rearm 清掉过期 timer,旧实现直接返回 900000 ——
//    静默沉默 15 分钟(③″2-4:owner 不得静默退场)。
//
// 依赖的不变量与强制手段见文件末尾的 createAuthRenewalScheduler 注释。
export function degradedRenewalDelayMs(
  timing: AuthRenewalTiming,
  now: number,
  attemptedSinceExpiry: boolean,
): number | null {
  const base = authRenewalDelayMs(timing, now)
  if (base === null) return null
  const untilExpiry = timing.expiresAt === undefined ? 0 : timing.expiresAt - now
  if (untilExpiry > 0) return Math.min(Math.max(base, AUTH_RENEWAL_DEGRADED_INTERVAL_MS), untilExpiry)
  return attemptedSinceExpiry ? AUTH_RENEWAL_DEGRADED_INTERVAL_MS : 0
}

// 平台 token 的恢复 owner(rev2c ③″2-1:任一时刻至多一个、且可被观察)。
//
// 依赖的不变量与各自的强制手段(③″1;每条后面括号里是「什么变异会让它转红」):
//  ① `timing.expiresAt` 是**网络响应**写入的已验证期限 —— 登录与续期两个提交点都经
//     alpha-auth.usableExpiresAt(hasUsableLifetime)。持久态由 load() 直接恢复,**不经**
//     该入口,故恢复的期限一律按 isTokenExpired fail-closed 处理(未知/已过期 ⇒ recovering
//     + 启动续期),不被当作"已验证还有余量"。
//     (变异:把 usableExpiresAt 换回 `expires_in ? ... : undefined` → cases.ts 的 6 种
//      不可用 expires_in 用例转红;把 isTokenExpired 的 fail-closed 去掉 → clock 用例转红。)
//  ② rearm 是全函数:除 stop 外必然再武装一次,且 renew 的 finally 一定 rearm。
//     (变异:删掉 finally 里的 rearm → 「fires once at refreshDueAt and re-arms」转红;
//      让 rearm 在 degraded 时提前 return → 「降频后仍有下一次」转红。)
//  ③ 降频不得越过已验证 expiresAt,且过期后未尝试过就不得进入完整降频节奏
//     —— 由 degradedRenewalDelayMs 两条规则在函数内强制。
//     (变异:把规则一换回 `Math.max(base, 降频)` → 「剩 10 秒」用例转红;
//      把规则二的 attemptedSinceExpiry 恒当 true → 「resume-after-expiry」用例转红。)
//  ④ 凭证身份 = `timing.generation`,不得用 expiresAt 代理。
//     (变异:把 degradedFor 改回记 expiresAt → 「同一到期时刻的新凭证」用例转红。)
//  ⑤ 唤醒地板与「可用寿命」下界是同一个常量(否则 ①③ 会各自漂移)。
//     (变异:把 AUTH_RENEWAL_MIN_INTERVAL_MS 改成字面量 30_000 也仍相等 —— 故断言写成
//      `toBe(MIN_USABLE_TOKEN_LIFETIME_MS)`,改动任一侧数值即转红。)
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
  // 降级与「过期后已尝试」都记在**凭证身份(generation)**上,不是 expiresAt(R3 Minor1:
  // 换账号可能拿到相同的绝对到期时刻,用 expiresAt 代理会让新凭证继承旧凭证的降级)。
  let degraded = false
  let degradedFor: number | undefined
  let attemptedForExpired: number | undefined

  const rearm = (reason: string) => {
    if (timer) clearTimer(timer)
    timer = undefined
    if (stopped) return
    const timing = deps.timing()
    if (degraded && timing.generation !== degradedFor) degraded = false
    const delayMs = degraded
      ? degradedRenewalDelayMs(timing, now(), attemptedForExpired === timing.generation)
      : authRenewalDelayMs(timing, now())
    deps.onArm?.(reason, delayMs)
    if (delayMs === null) return
    timer = setTimer(() => {
      timer = undefined
      if (running || stopped) return rearm("coalesced")
      running = true
      void deps
        .renew()
        .then((result) => {
          const settled = deps.timing()
          degraded = result.outcome === "unusable-response"
          degradedFor = degraded ? settled.generation : undefined
          // 这次尝试跑完时凭证仍是过期/未知 ⇒ 记账「该凭证过期后已经尝试过、也已经发过
          // recovering」,规则二据此才允许进入完整降频节奏。
          const expired = settled.expiresAt === undefined || settled.expiresAt <= now()
          attemptedForExpired = expired ? settled.generation : undefined
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
