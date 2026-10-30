import type { RenewalResult } from "./alpha-auth"
import { MIN_USABLE_TOKEN_LIFETIME_MS, refreshDueAt } from "./alpha-auth-clock"

export const BOOT_RENEWAL_GRACE_MS = 1_200
// 调度器的唤醒地板 = 「可用寿命」的下界,同一个常量派生,两者不可能漂移
// (alpha-auth-clock.MIN_USABLE_TOKEN_LIFETIME_MS 的注释解释了为什么是同一个数)。
export const AUTH_RENEWAL_MIN_INTERVAL_MS = MIN_USABLE_TOKEN_LIFETIME_MS
/** #600 B3:上一次续期「成功但结果不可用」时的降频节奏(≈一个 token TTL)。按 30s 最小间隔
 *  重刷会把一个给不出可用有效期的签发端变成永久重刷循环;降频续跑既不进无定时器终局,
 *  也不制造风暴(③′3)。 */
export const AUTH_RENEWAL_DEGRADED_INTERVAL_MS = 15 * 60_000

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
//  ① `timing.expiresAt` 有两个来源,**强度不同**,不要混为一谈:
//     (a) **网络响应**写入的,经 alpha-auth.usableExpiresAt(hasUsableLifetime)验证过余量
//         —— 登录与续期两个提交点都走它;
//     (b) **持久化来源恢复**的(load() 直接接受落盘字段),本次 load **不做**余量验证,
//         只在读取时过 isTokenExpired 的过期性检查:未来时刻的 expiresAt 直接按 ready 处理
//         (既有契约,alpha-auth.cases.ts 有闸门),未知/已过期才 fail-closed 成 recovering。
//     本判据只对 (a) 声称"已验证还有余量";(b) 只声称"做过过期性检查"。
//     (变异:把 usableExpiresAt 换回 `expires_in ? ... : undefined` → cases.ts 的 6 种
//      不可用 expires_in 用例转红[实测 3 个用例红];把 isTokenExpired 的 fail-closed 去掉
//      → clock 用例转红[实测红]。)
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
//     **强制手段是直接别名**(`= MIN_USABLE_TOKEN_LIFETIME_MS`,结构上不可能不等),不是测试。
//     那条相等断言只是回归锁:改动任一侧的**数值**会转红;把别名改回同值字面量 30_000
//     **不会**转红(实测 GREEN)—— 如实记在这里,别把它当成防重新内联的闸门。
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
      // R4:「该凭证过期后已经尝试过」必须在**起手**时按 generation 记账 —— 尝试从这一刻
      // 就开始了。只在 .then 里记会漏两条路,两条都会退化成 0ms 自旋:
      //  ① renewal 在途时的 coalesced rearm(resume/auth-change 连来)仍读到 false → 又武装 0ms;
      //  ② renewal reject 时 .then 被整段跳过 → finally 的 rearm 仍读到 false → 立刻再发一次。
      // 记账按 generation:续期成功换代后这条记录自然失配,新凭证不会继承它。
      const attempting = deps.timing()
      if (attempting.expiresAt === undefined || attempting.expiresAt <= now())
        attemptedForExpired = attempting.generation
      void deps
        .renew()
        .then(
          (result) => {
            degraded = result.outcome === "unusable-response"
            degradedFor = degraded ? deps.timing().generation : undefined
            deps.onResult?.(result)
          },
          // renew 自身抛出:尝试已在起手记账,降级状态维持原样,由 finally 的 rearm 按当前
          // 判据排下一次。这里必须有 handler —— 否则 `void ....then(onFulfilled)` 会在 main
          // 进程留下 unhandled rejection。
          () => {},
        )
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
